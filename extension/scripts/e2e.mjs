#!/usr/bin/env node
/**
 * 端到端验证脚本：headless Edge 加载真实扩展 + 本地 mock LLM + 真实网页，检查双语翻译是否生效。
 *
 * 用法：
 *   node extension/scripts/e2e.mjs
 *   PORT_MOCK=9100 node extension/scripts/e2e.mjs   （可选：指定 mock 端口）
 *
 * 前置：本机安装 Microsoft Edge。
 * 产物：.tmp/e2e/shot-1440.png、.tmp/e2e/shot-480.png、控制台诊断报告。
 * 说明：脚本复制一份扩展到 .tmp/e2e/ext-copy，并在副本里把默认 API 指向本地 mock 服务、
 *       注入一个 E2E 探针脚本，用于区分「扩展没加载」和「翻译失败」。源码不受影响。
 */
import { spawn } from "node:child_process";
import fs from "node:fs";
import http from "node:http";
import net from "node:net";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, "..", "..");
const EXT_SRC = path.join(ROOT, "extension");
const OUT_DIR = path.join(ROOT, ".tmp", "e2e");
const RUN_ID = String(Date.now()).slice(-6) + "-" + Math.random().toString(36).slice(2, 6);
const EXT_COPY = path.join(OUT_DIR, "ext-" + RUN_ID);
const PROFILE = path.join(OUT_DIR, "profile-" + RUN_ID);
const EDGE_CANDIDATES = [
  "C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe",
  "C:/Program Files/Microsoft/Edge/Application/msedge.exe",
];

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function findEdge() {
  for (const candidate of EDGE_CANDIDATES) {
    if (fs.existsSync(candidate)) return candidate;
  }
  throw new Error("没有找到 Microsoft Edge，请修改 EDGE_CANDIDATES");
}

function freePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.unref();
    server.on("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const port = server.address().port;
      server.close(() => resolve(port));
    });
  });
}

async function waitJson(url, timeoutMs) {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    try {
      const res = await fetch(url);
      if (res.ok) return await res.json();
    } catch (_) {}
    await sleep(250);
  }
  throw new Error("等待超时: " + url);
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
        if (message.error) task.reject(new Error(JSON.stringify(message.error)));
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
      ws.addEventListener("error", reject, { once: true });
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
    try { this.ws.close(); } catch (_) {}
  }
}

function prepareExtension(mockPort) {
  fs.cpSync(EXT_SRC, EXT_COPY, { recursive: true });

  // 默认设置定义在 shared/config.js 的 DEFAULT_SETTINGS 里，必须改这个文件
  const config = path.join(EXT_COPY, "src/shared/config.js");
  let configSource = fs.readFileSync(config, "utf8");
  configSource = configSource.replace("https://api.deepseek.com/v1", "http://127.0.0.1:" + mockPort + "/v1");
  configSource = configSource.replace('apiKey: ""', 'apiKey: "mock-key"');
  configSource = configSource.replace('model: "deepseek-chat"', 'model: "mock-translator"');
  configSource = configSource.replace("autoTranslate: false", "autoTranslate: true");
  configSource = configSource.replace(
    "cache: { enabled: true, maxEntries: 2000, ttlDays: 30 }",
    "cache: { enabled: false, maxEntries: 2000, ttlDays: 30 }"
  );
  fs.writeFileSync(config, configSource, "utf8");

  // 探针：证明 content script 已注入（只在副本里）
  const probe = path.join(EXT_COPY, "src/content/99-e2e-probe.js");
  fs.writeFileSync(
    probe,
    '(() => { try { document.documentElement.setAttribute("data-ait-probe", "1"); } catch (_) {} })();\n',
    "utf8"
  );
  const manifestPath = path.join(EXT_COPY, "manifest.json");
  const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
  manifest.content_scripts[0].js.push("src/content/99-e2e-probe.js");
  fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2) + "\n", "utf8");
}

/** 清理上次运行留下的副本与 profile，占用中的目录静默跳过 */
function cleanupStale() {
  let entries = [];
  try {
    entries = fs.readdirSync(OUT_DIR);
  } catch (_) {
    return;
  }
  for (const entry of entries) {
    if (!entry.startsWith("ext-") && !entry.startsWith("profile-")) continue;
    try {
      fs.rmSync(path.join(OUT_DIR, entry), { recursive: true, force: true });
    } catch (_) {
      // 目录仍被占用，跳过即可
    }
  }
}

function startStaticServer(port) {
  const server = http.createServer((req, res) => {
    const file = path.join(HERE, "e2e-page.html");
    if (!fs.existsSync(file)) {
      res.writeHead(404);
      res.end("missing fixture");
      return;
    }
    const body = fs.readFileSync(file);
    res.writeHead(200, { "Content-Type": "text/html; charset=utf-8", "Content-Length": body.length });
    res.end(body);
  });
  return new Promise((resolve) => server.listen(port, "127.0.0.1", () => resolve(server)));
}

async function capture(cdp, width, height, file) {
  await cdp.send("Emulation.setDeviceMetricsOverride", { width, height, deviceScaleFactor: 1, mobile: false });
  await sleep(500);
  const shot = await cdp.send("Page.captureScreenshot", { format: "png" });
  fs.writeFileSync(file, Buffer.from(shot.data, "base64"));
  return file;
}

async function main() {
  fs.mkdirSync(OUT_DIR, { recursive: true });
  cleanupStale();

  const mockPort = Number(process.env.PORT_MOCK || (await freePort()));
  const pagePort = await freePort();
  const cdpPort = await freePort();
  prepareExtension(mockPort);

  const mockServer = spawn(process.execPath, [path.join(HERE, "mock-server.mjs")], {
    env: Object.assign({}, process.env, { PORT: String(mockPort) }),
    stdio: "ignore",
    windowsHide: true,
  });
  try {
    await waitJson("http://127.0.0.1:" + mockPort + "/health", 15000);
  } catch (_) {
    mockServer.kill();
    throw new Error("mock 服务启动失败（端口 " + mockPort + "）");
  }
  const staticServer = await startStaticServer(pagePort);

  const edge = findEdge();
  const proc = spawn(edge, [
    "--headless=new",
    "--disable-gpu",
    "--no-first-run",
    "--no-default-browser-check",
    "--user-data-dir=" + PROFILE,
    "--disable-extensions-except=" + EXT_COPY,
    "--load-extension=" + EXT_COPY,
    "--remote-debugging-port=" + cdpPort,
    "--remote-allow-origins=*",
    "about:blank",
  ], { stdio: "ignore", windowsHide: true });

  const failures = [];
  const report = { mockPort, pagePort, cdpPort, probe: false, translated: 0, targets: [], samples: [] };
  let cdp = null;
  try {
    const version = await waitJson("http://127.0.0.1:" + cdpPort + "/json/version", 30000);
    console.log("[e2e] 浏览器：" + version.Browser);

    const targets = await waitJson("http://127.0.0.1:" + cdpPort + "/json/list", 10000);
    report.targets = targets.map((target) => target.type + ":" + String(target.url || "").slice(0, 60));
    console.log("[e2e] targets：" + JSON.stringify(report.targets));
    const page = targets.find((target) => target.type === "page");
    if (!page) throw new Error("没有找到 page target");
    cdp = await Cdp.connect(page.webSocketDebuggerUrl);
    await cdp.send("Page.enable");
    await cdp.send("Runtime.enable");

    await cdp.send("Page.navigate", { url: "http://127.0.0.1:" + pagePort + "/" });
    let state = {};
    for (let i = 0; i < 30; i += 1) {
      await sleep(700);
      const result = await cdp.send("Runtime.evaluate", {
        expression: "JSON.stringify({ probe: document.documentElement.getAttribute('data-ait-probe') === '1', count: document.querySelectorAll('.ait-trans').length, texts: Array.from(document.querySelectorAll('.ait-trans')).slice(0, 3).map(function (el) { return el.textContent.trim().slice(0, 60); }), toast: !!document.querySelector('.ait-toast') })",
        returnByValue: true,
      });
      state = JSON.parse((result.result && result.result.value) || "{}");
      const diag = await cdp.send("Runtime.evaluate", {
        expression: "JSON.stringify({ toast: document.querySelector('.ait-toast') ? document.querySelector('.ait-toast').textContent.trim().slice(0, 120) : '', errors: Array.from(document.querySelectorAll('.ait-error')).length, probe: !!window.__AIT_DEBUG__ })",
        returnByValue: true,
      }).catch(() => null);
      if (diag) state.diag = JSON.parse((diag.result && diag.result.value) || "{}");
      report.probe = !!state.probe;
      report.translated = state.count || 0;
      report.samples = state.texts || [];
      if ((state.count || 0) >= 3) break;
    }
    console.log("[e2e] content 注入：" + report.probe + "，译文节点：" + report.translated);
    console.log("[e2e] 译文示例：" + JSON.stringify(report.samples));
    if (state.diag) console.log("[e2e] 页面诊断：" + JSON.stringify(state.diag));
    if (!report.probe) failures.push("content script 未注入（扩展可能未在 headless 下加载）");
    else if (report.translated < 3) failures.push("扩展已注入但译文节点不足（检查后台请求/渲染）");

    const toneEval = await cdp.send("Runtime.evaluate", {
      expression: "(function () {" +
        "function lum(rgb) { var m = String(rgb).match(/[0-9]+/g); if (!m) return null; var c = m.slice(0, 3).map(Number).map(function (v) { var s = v / 255; return s <= 0.03928 ? s / 12.92 : Math.pow((s + 0.055) / 1.055, 2.4); }); return 0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2]; }" +
        "var panel = document.querySelector('.dark-panel');" +
        "var darkTrans = panel ? panel.querySelector('.ait-trans') : null;" +
        "var lightTrans = document.querySelector('.ait-trans');" +
        "var darkLum = darkTrans ? lum(getComputedStyle(darkTrans).color) : null;" +
        "var lightLum = lightTrans ? lum(getComputedStyle(lightTrans).color) : null;" +
        "return JSON.stringify({" +
        "darkClass: !!(darkTrans && darkTrans.classList.contains('ait-trans--on-dark'))," +
        "darkLum: darkLum," +
        "lightClass: !!(lightTrans && lightTrans.classList.contains('ait-trans--on-light'))," +
        "lightLum: lightLum," +
        "darkOk: !!(darkTrans && darkTrans.classList.contains('ait-trans--on-dark') && darkLum !== null && darkLum > 0.45)," +
        "lightOk: !!(lightTrans && lightTrans.classList.contains('ait-trans--on-light') && lightLum !== null && lightLum < 0.45)" +
        "});" +
        "})()",
      returnByValue: true,
    });
    const tone = JSON.parse((toneEval.result && toneEval.result.value) || "{}");
    report.tone = tone;
    console.log("[e2e] 宿主背景配色：" + JSON.stringify(tone));
    if (!tone.darkOk) failures.push("深色宿主区块的译文没有切换为亮色文字");
    if (!tone.lightOk) failures.push("浅色宿主区块的译文配色异常");

    report.shot1440 = await capture(cdp, 1440, 900, path.join(OUT_DIR, "shot-1440.png"));
    await cdp.send("Runtime.evaluate", { expression: "var p = document.querySelector('.dark-panel'); if (p) p.scrollIntoView({ block: 'center' });" });
    await sleep(500);
    report.shotDark = await capture(cdp, 1440, 900, path.join(OUT_DIR, "shot-dark-tone.png"));
    report.shot480 = await capture(cdp, 480, 900, path.join(OUT_DIR, "shot-480.png"));
    console.log("[e2e] 截图：" + report.shot1440 + " , " + report.shotDark + " , " + report.shot480);

    const errors = cdp.events
      .filter((event) => event.method === "Runtime.exceptionThrown")
      .slice(0, 5)
      .map((event) => JSON.stringify(event.params).slice(0, 500));
    if (errors.length) {
      console.log("[e2e] 页面异常：" + JSON.stringify(errors, null, 2));
      failures.push("页面存在未捕获异常");
    }
  } finally {
    if (cdp) cdp.close();
    if (process.platform === "win32") spawn("taskkill", ["/PID", String(proc.pid), "/T", "/F"], { stdio: "ignore" });
    else proc.kill();
    staticServer.close();
    mockServer.kill();
    await sleep(500);
  }

  fs.writeFileSync(path.join(OUT_DIR, "report.json"), JSON.stringify(report, null, 2), "utf8");
  if (failures.length) {
    console.log("[e2e] FAIL：" + failures.join("；"));
    console.log("[e2e] 诊断报告：.tmp/e2e/report.json");
    process.exit(1);
  }
  console.log("[e2e] PASS");
}

main().catch((error) => {
  console.log("[e2e] 异常：" + (error && error.stack ? error.stack : error));
  process.exit(2);
});