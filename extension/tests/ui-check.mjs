#!/usr/bin/env node
/**
 * UI 截图复核工具（零依赖）：headless Edge + CDP。
 *
 * 能力：
 *   - 精确视口（Emulation.setDeviceMetricsOverride），默认 1440x900 与 480x900；
 *   - 亮色 / 暗色两套媒体偏好（Emulation.setEmulatedMedia prefers-color-scheme）；
 *   - 每个组合输出截图到 extension/tests/screenshots/；
 *   - 采集横向溢出（documentElement.scrollWidth vs innerWidth）与页面未捕获异常；
 *   - 输出人类可读结果 + 最后一行 UI_SUMMARY JSON，供验收报告引用。
 *
 * 用法：
 *   node extension/tests/ui-check.mjs                          # 默认页面（popup/options/fixtures）
 *   node extension/tests/ui-check.mjs --only popup,options
 *   node extension/tests/ui-check.mjs --themes light --viewport 1440x900,480x900
 *   node extension/tests/ui-check.mjs --base http://127.0.0.1:8765 --out extension/tests/screenshots
 *
 * 约定：页面通过 HTTP 访问（ES Module 在 file:// 下会被 CORS 拦截）；
 *       默认复用 127.0.0.1:8765 的静态服务，不可用时自动用 python 在 8799 起一个。
 */
import { spawn } from "node:child_process";
import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const EXT_ROOT = path.resolve(HERE, "..");
const REPO_ROOT = path.resolve(EXT_ROOT, "..");
const OUT_DIR = path.join(HERE, "screenshots");
const TMP_DIR = path.join(REPO_ROOT, ".tmp", "ui-check");
const RUN_ID = Date.now().toString(36) + "-" + Math.random().toString(36).slice(2, 6);
const PROFILE_DIR = path.join(TMP_DIR, "profile-" + RUN_ID);
const DEFAULT_CDP_PORT = 9444;
const DEFAULT_BASE_PORT = 8799;
const EDGE_CANDIDATES = [
  "C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe",
  "C:/Program Files/Microsoft/Edge/Application/msedge.exe",
];
const PYTHON_CANDIDATES = [
  "C:/Users/Mio/.dsh/dsh-runtimes/dsh-primary-runtime/dependencies/python/python.exe",
  "python",
];

const argv = process.argv.slice(2);
function argValue(name, fallback) {
  const index = argv.indexOf("--" + name);
  if (index >= 0 && argv[index + 1] && !argv[index + 1].startsWith("--")) return argv[index + 1];
  return fallback;
}
const ONLY = (argValue("only", "") || "").split(",").map((item) => item.trim()).filter(Boolean);
const THEMES = (argValue("themes", "light,dark") || "").split(",").map((item) => item.trim()).filter(Boolean);
const VIEWPORTS = (argValue("viewport", "1440x900,480x900") || "")
  .split(",")
  .map((item) => item.trim())
  .filter(Boolean)
  .map((item) => {
    const [width, height] = item.split("x").map(Number);
    return { width: width || 1440, height: height || 900 };
  });
let BASE = (argValue("base", "http://127.0.0.1:8765") || "").replace(/\/+$/, "");
const OUT = path.resolve(REPO_ROOT, argValue("out", path.relative(REPO_ROOT, OUT_DIR)));
const CDP_PORT = Number(argValue("cdp-port", DEFAULT_CDP_PORT)) || DEFAULT_CDP_PORT;

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function findEdge() {
  for (const candidate of EDGE_CANDIDATES) if (fs.existsSync(candidate)) return candidate;
  return null;
}

function buildPages() {
  const pages = [
    { id: "popup", url: "/extension/src/popup/popup.html?demo=1", file: "extension/src/popup/popup.html", required: true },
    { id: "options", url: "/extension/src/options/options.html?demo=1", file: "extension/src/options/options.html", required: true },
  ];
  const fixturesDir = path.join(HERE, "fixtures");
  if (fs.existsSync(fixturesDir)) {
    for (const name of fs.readdirSync(fixturesDir)) {
      if (!/\.html$/i.test(name)) continue;
      pages.push({
        id: "fixture-" + name.replace(/\.html$/i, ""),
        url: "/extension/tests/fixtures/" + name,
        file: "extension/tests/fixtures/" + name,
        required: false,
      });
    }
  }
  return pages.filter((page) => (ONLY.length ? ONLY.includes(page.id) : true));
}

/** 用 node:http 发 GET：避免 Node 24 undici 与 python http.server 的解析断言问题 */
function httpGet(url, timeoutMs) {
  return new Promise((resolve) => {
    const request = http.get(url, { timeout: timeoutMs || 5000 }, (response) => {
      let body = "";
      response.on("data", (chunk) => {
        if (body.length < 2 * 1024 * 1024) body += chunk;
      });
      response.on("end", () => resolve({ status: response.statusCode || 0, body }));
    });
    request.on("error", () => resolve({ status: 0, body: "" }));
    request.on("timeout", () => {
      request.destroy();
      resolve({ status: 0, body: "" });
    });
  });
}

async function waitForHttp(url, timeoutMs) {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    const response = await httpGet(url, 2000);
    if (response.status >= 200 && response.status < 400) return response;
    await sleep(250);
  }
  return null;
}

function startStaticServer(port) {
  const python = PYTHON_CANDIDATES.find((candidate) => candidate === "python" || fs.existsSync(candidate));
  if (!python) throw new Error("没有找到 python，无法启动静态服务器");
  const server = http.createServer((req, res) => {
    res.writeHead(500);
    res.end("placeholder");
  });
  server.close();
  const proc = spawn(python, ["-m", "http.server", String(port), "--bind", "127.0.0.1", "--directory", REPO_ROOT], {
    stdio: "ignore",
    windowsHide: true,
  });
  return proc;
}

class Cdp {
  constructor(ws) {
    this.ws = ws;
    this.seq = 0;
    this.pending = new Map();
    this.events = [];
    ws.addEventListener("message", (event) => {
      const message = JSON.parse(event.data);
      if (message.id && this.pending.has(message.id)) {
        const task = this.pending.get(message.id);
        this.pending.delete(message.id);
        if (message.error) task.reject(new Error(message.error.message || JSON.stringify(message.error)));
        else task.resolve(message.result);
        return;
      }
      if (message.method) this.events.push(message);
    });
  }
  static async connect(url) {
    const ws = new WebSocket(url);
    await new Promise((resolve, reject) => {
      ws.addEventListener("open", resolve, { once: true });
      ws.addEventListener("error", () => reject(new Error("CDP WebSocket 连接失败")), { once: true });
    });
    return new Cdp(ws);
  }
  send(method, params) {
    const id = (this.seq += 1);
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.ws.send(JSON.stringify({ id, method, params: params || {} }));
    });
  }
  close() {
    try {
      this.ws.close();
    } catch (_) {
      // 忽略
    }
  }
}

async function waitForTarget(cdpPort, timeoutMs) {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    try {
      const response = await fetch("http://127.0.0.1:" + cdpPort + "/json/list");
      if (response.ok) {
        const list = await response.json();
        const page = list.find((target) => target.type === "page");
        if (page && page.webSocketDebuggerUrl) return page;
      }
    } catch (_) {
      // 继续等待
    }
    await sleep(250);
  }
  return null;
}

async function evaluate(cdp, expression) {
  const result = await cdp.send("Runtime.evaluate", { expression, returnByValue: true, awaitPromise: true });
  if (result && result.exceptionDetails) {
    throw new Error("页面脚本执行异常：" + JSON.stringify(result.exceptionDetails).slice(0, 300));
  }
  return result && result.result ? result.result.value : undefined;
}

async function waitForReady(cdp, timeoutMs) {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    const state = await evaluate(cdp, "document.readyState").catch(() => "");
    if (state === "complete") return true;
    await sleep(150);
  }
  return false;
}

function metricsExpression() {
  return [
    "(() => {",
    "  const de = document.documentElement;",
    "  const vw = window.innerWidth;",
    "  const vh = window.innerHeight;",
    "  const isDark = window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches;",
    "  return JSON.stringify({",
    "    title: document.title || '',",
    "    readyState: document.readyState,",
    "    scrollWidth: de ? de.scrollWidth : 0,",
    "    clientWidth: de ? de.clientWidth : 0,",
    "    innerWidth: vw,",
    "    scrollHeight: de ? de.scrollHeight : 0,",
    "    innerHeight: vh,",
    "    hasHorizontalOverflow: !!de && de.scrollWidth > vw + 1,",
    "    bodyTextLength: document.body ? String(document.body.innerText || '').length : 0,",
    "    aitNodes: document.querySelectorAll('.ait-trans, .ait-sel-trigger, .ait-sel-card').length,",
    "    theme: isDark ? 'dark' : 'light'",
    "  });",
    "})()",
  ].join("\n");
}

async function capture(cdp, pageId, theme, viewport, report) {
  const name = pageId + "-" + theme + "-" + viewport.width + "x" + viewport.height;
  const file = path.join(OUT, name + ".png");
  const shot = await cdp.send("Page.captureScreenshot", { format: "png" });
  fs.writeFileSync(file, Buffer.from(shot.data, "base64"));
  report.screenshot = file;

  // 长页面额外输出整页截图，便于检查表单是否裁切
  try {
    const layout = await cdp.send("Page.getLayoutMetrics");
    const content = layout.cssContentSize || layout.contentSize || { width: viewport.width, height: viewport.height };
    if (content.height > viewport.height + 60) {
      const fullFile = path.join(OUT, name + "-full.png");
      const fullShot = await cdp.send("Page.captureScreenshot", {
        format: "png",
        captureBeyondViewport: true,
        clip: {
          x: 0,
          y: 0,
          width: Math.max(viewport.width, Math.min(content.width, 2400)),
          height: Math.min(content.height, 12000),
          scale: 1,
        },
      });
      fs.writeFileSync(fullFile, Buffer.from(fullShot.data, "base64"));
      report.screenshotFull = fullFile;
    }
  } catch (_) {
    // 整页截图失败不影响主流程
  }
}

/** 清理历史运行残留（占用中的目录静默跳过，避免 Windows EPERM） */
function cleanupStaleProfiles() {
  let entries = [];
  try {
    entries = fs.readdirSync(TMP_DIR);
  } catch (_) {
    return;
  }
  for (const entry of entries) {
    if (!entry.startsWith("profile")) continue;
    try {
      fs.rmSync(path.join(TMP_DIR, entry), { recursive: true, force: true });
    } catch (_) {
      // 仍被占用，跳过
    }
  }
}

async function main() {
  const edge = findEdge();
  if (!edge) throw new Error("没有找到 Microsoft Edge");

  const pages = buildPages();
  if (!pages.length) throw new Error("没有可检查的页面（检查 --only 参数）");

  // 1. 确认静态服务器可用，不可用则自动起一个
  let baseResponse = await waitForHttp(BASE + "/extension/manifest.json", 1500);
  let serverProc = null;
  if (!baseResponse) {
    BASE = "http://127.0.0.1:" + DEFAULT_BASE_PORT;
    serverProc = startStaticServer(DEFAULT_BASE_PORT);
    baseResponse = await waitForHttp(BASE + "/extension/manifest.json", 12000);
    if (!baseResponse) throw new Error("静态服务器启动失败：python -m http.server " + DEFAULT_BASE_PORT);
  }
  console.log("[ui-check] 静态服务：" + BASE);

  // 2. 启动 headless Edge + CDP
  fs.mkdirSync(OUT, { recursive: true });
  fs.mkdirSync(TMP_DIR, { recursive: true });
  cleanupStaleProfiles();
  const proc = spawn(edge, [
    "--headless=new",
    "--disable-gpu",
    "--no-first-run",
    "--no-default-browser-check",
    "--hide-scrollbars",
    "--user-data-dir=" + PROFILE_DIR,
    "--remote-debugging-port=" + CDP_PORT,
    "--remote-allow-origins=*",
    "about:blank",
  ], { stdio: "ignore", windowsHide: true });

  const failures = [];
  const warnings = [];
  const reports = [];
  let cdp = null;
  try {
    const page = await waitForTarget(CDP_PORT, 25000);
    if (!page) throw new Error("等待 CDP 目标超时（端口 " + CDP_PORT + "）");
    cdp = await Cdp.connect(page.webSocketDebuggerUrl);
    await cdp.send("Page.enable");
    await cdp.send("Runtime.enable");

    for (const item of pages) {
      const diskPath = path.join(REPO_ROOT, item.file);
      if (!fs.existsSync(diskPath)) {
        if (item.required) failures.push(item.id + "：页面文件不存在 " + item.file);
        else warnings.push(item.id + "：未实现或未落盘，跳过（" + item.file + "）");
        continue;
      }
      const check = await httpGet(BASE + item.url, 10000);
      if (check.status < 200 || check.status >= 400) {
        if (item.required) failures.push(item.id + "：HTTP " + check.status + " " + item.url);
        else warnings.push(item.id + "：HTTP " + check.status + "，跳过");
        continue;
      }

      for (const viewport of VIEWPORTS) {
        for (const theme of THEMES) {
          const report = {
            page: item.id,
            url: BASE + item.url,
            viewport: viewport.width + "x" + viewport.height,
            theme,
            screenshot: null,
            screenshotFull: null,
            title: "",
            hasHorizontalOverflow: false,
            scrollWidth: 0,
            innerWidth: 0,
            scrollHeight: 0,
            bodyTextLength: 0,
            aitNodes: 0,
            exceptions: [],
          };
          const eventStart = cdp.events.length;

          await cdp.send("Emulation.setDeviceMetricsOverride", {
            width: viewport.width,
            height: viewport.height,
            deviceScaleFactor: 1,
            mobile: false,
          });
          await cdp.send("Emulation.setEmulatedMedia", {
            features: [{ name: "prefers-color-scheme", value: theme }],
          });
          await cdp.send("Page.navigate", { url: BASE + item.url });
          const ready = await waitForReady(cdp, 15000);
          if (!ready) failures.push(item.id + " " + viewport.width + "x" + viewport.height + " " + theme + "：页面加载超时");
          await sleep(700);

          const metrics = JSON.parse(await evaluate(cdp, metricsExpression()));
          Object.assign(report, {
            title: metrics.title,
            hasHorizontalOverflow: metrics.hasHorizontalOverflow,
            scrollWidth: metrics.scrollWidth,
            innerWidth: metrics.innerWidth,
            scrollHeight: metrics.scrollHeight,
            bodyTextLength: metrics.bodyTextLength,
            aitNodes: metrics.aitNodes,
            themeActual: metrics.theme,
          });

          const errors = cdp.events
            .slice(eventStart)
            .filter((event) => event.method === "Runtime.exceptionThrown")
            .slice(0, 5)
            .map((event) => {
              const detail = event.params && event.params.exceptionDetails;
              return String((detail && (detail.exception && detail.exception.description)) || (detail && detail.text) || "unknown").slice(0, 300);
            });
          report.exceptions = errors;

          await capture(cdp, item.id, theme, viewport, report);
          reports.push(report);

          if (report.hasHorizontalOverflow) {
            failures.push(
              item.id + " " + viewport.width + "x" + viewport.height + " " + theme +
                "：横向溢出（scrollWidth " + report.scrollWidth + " > innerWidth " + report.innerWidth + "）"
            );
          }
          if (errors.length) failures.push(item.id + " " + viewport.width + "x" + viewport.height + " " + theme + "：页面异常 " + errors[0]);
          if (report.themeActual !== theme) {
            warnings.push(item.id + " " + viewport.width + "x" + viewport.height + "：主题模拟为 " + theme + "，页面实际 " + report.themeActual);
          }
          if (report.bodyTextLength < 20) {
            warnings.push(item.id + " " + viewport.width + "x" + viewport.height + " " + theme + "：正文过短（" + report.bodyTextLength + " 字符），可能没渲染出来");
          }
          console.log(
            "[ui-check] " + item.id + " " + viewport.width + "x" + viewport.height + " " + theme +
              " -> " + path.basename(report.screenshot || "") +
              "（overflow=" + report.hasHorizontalOverflow + "，异常=" + errors.length + "）"
          );
        }
      }
    }
  } finally {
    if (cdp) cdp.close();
    if (process.platform === "win32") spawn("taskkill", ["/PID", String(proc.pid), "/T", "/F"], { stdio: "ignore" });
    else proc.kill();
    if (serverProc) {
      if (process.platform === "win32") spawn("taskkill", ["/PID", String(serverProc.pid), "/T", "/F"], { stdio: "ignore" });
      else serverProc.kill();
    }
    await sleep(300);
    try {
      fs.rmSync(PROFILE_DIR, { recursive: true, force: true });
    } catch (_) {
      // Edge 进程可能尚未完全退出，残留目录下次运行会清理
    }
  }

  const summary = {
    base: BASE,
    screenshots: reports.filter((report) => report.screenshot).length,
    pages: reports.map((report) => ({
      page: report.page,
      viewport: report.viewport,
      theme: report.theme,
      overflow: report.hasHorizontalOverflow,
      scrollWidth: report.scrollWidth,
      innerWidth: report.innerWidth,
      exceptions: report.exceptions.length,
      screenshot: report.screenshot ? path.relative(REPO_ROOT, report.screenshot).split(path.sep).join("/") : null,
      screenshotFull: report.screenshotFull ? path.relative(REPO_ROOT, report.screenshotFull).split(path.sep).join("/") : null,
    })),
    failures,
    warnings,
  };
  console.log("");
  console.log("截图目录：" + OUT);
  console.log("失败 " + failures.length + " 项，警告 " + warnings.length + " 项");
  for (const failure of failures) console.log("[FAIL] " + failure);
  for (const warning of warnings) console.log("[WARN] " + warning);
  console.log("UI_SUMMARY " + JSON.stringify(summary));
  process.exitCode = failures.length ? 1 : 0;
}

main().catch((error) => {
  console.log("[ui-check] 异常：" + (error && error.stack ? error.stack : error));
  process.exit(2);
});
