/**
 * 动态注入验证（模拟「扩展安装/重载前已打开的标签页」场景）：
 * 1) 扩展副本的 content_scripts.matches 改成永不匹配 => 打开页面时不会自动注入；
 * 2) 在扩展自己的 options 页（扩展上下文，拥有 chrome.scripting 权限）里调用 shared/inject.js；
 * 3) 断言：探测失败 -> ensureContentScript 注入成功 -> ait:tab.pageState 正常响应；
 * 4) 再通过消息触发 toggleTranslate，页面完成 15 段翻译；
 * 5) 重复 ensure 幂等。
 * 运行：node extension/scripts/e2e-inject.mjs
 * 产物：.tmp/dyn-test/report.json、.tmp/dyn-test/dyn-inject.png
 */
import { spawn } from "node:child_process";
import fs from "node:fs";
import http from "node:http";
import net from "node:net";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, "..", "..");
const OUT = path.join(ROOT, ".tmp", "dyn-test");
const RUN = String(Date.now()).slice(-6) + "-" + Math.random().toString(36).slice(2, 6);
const EXT = path.join(OUT, "ext-" + RUN);
const PROFILE = path.join(OUT, "profile-" + RUN);
const EDGE = "C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe";
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function freePort() {
  return new Promise((resolve, reject) => {
    const s = net.createServer();
    s.unref();
    s.on("error", reject);
    s.listen(0, "127.0.0.1", () => {
      const p = s.address().port;
      s.close(() => resolve(p));
    });
  });
}
async function waitJson(url, timeout) {
  const t0 = Date.now();
  while (Date.now() - t0 < timeout) {
    try {
      const r = await fetch(url);
      if (r.ok) return await r.json();
    } catch (_) {}
    await sleep(250);
  }
  throw new Error("timeout " + url);
}
class Cdp {
  constructor(ws) {
    this.ws = ws; this.seq = 0; this.pending = new Map(); this.events = [];
    ws.addEventListener("message", (e) => {
      const m = JSON.parse(e.data);
      if (m.id && this.pending.has(m.id)) {
        const t = this.pending.get(m.id); this.pending.delete(m.id);
        if (m.error) t.reject(new Error(JSON.stringify(m.error))); else t.resolve(m.result);
        return;
      }
      if (m.method) this.events.push(m);
    });
  }
  static async connect(url) {
    const ws = new WebSocket(url);
    await new Promise((res, rej) => {
      ws.addEventListener("open", res, { once: true });
      ws.addEventListener("error", rej, { once: true });
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
  async eval(expression) {
    const r = await this.send("Runtime.evaluate", { expression, returnByValue: true, awaitPromise: true });
    if (r.exceptionDetails) throw new Error("evaluate failed: " + JSON.stringify(r.exceptionDetails).slice(0, 400));
    return r.result ? r.result.value : undefined;
  }
  close() { try { this.ws.close(); } catch (_) {} }
}

const MOCK_PORT = await freePort();
const PAGE_PORT = await freePort();
const CDP_PORT = await freePort();
const report = { steps: [], pass: false };
const step = (name, data) => {
  report.steps.push({ name, data });
  console.log("[dyn]", name, data === undefined ? "" : JSON.stringify(data));
};
const stateOk = (s) => !!(s && s.ok === true && typeof s.translated === "boolean");

function prepare() {
  fs.mkdirSync(OUT, { recursive: true });
  fs.cpSync(path.join(ROOT, "extension"), EXT, { recursive: true });
  const manifestPath = path.join(EXT, "manifest.json");
  const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
  manifest.content_scripts[0].matches = ["https://never-match.invalid/*"];
  fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2) + "\n", "utf8");

  const cfg = path.join(EXT, "src/shared/config.js");
  let src = fs.readFileSync(cfg, "utf8");
  src = src.replace("https://api.deepseek.com/v1", "http://127.0.0.1:" + MOCK_PORT + "/v1");
  src = src.replace('apiKey: ""', 'apiKey: "mock-key"');
  src = src.replace('model: "deepseek-chat"', 'model: "mock-translator"');
  src = src.replace("cache: { enabled: true, maxEntries: 2000, ttlDays: 30 }", "cache: { enabled: false, maxEntries: 2000, ttlDays: 30 }");
  fs.writeFileSync(cfg, src, "utf8");

  // 副本专用：启动后打开 options 页，作为测试控制台（扩展上下文）
  const worker = path.join(EXT, "src/background/service-worker.js");
  fs.appendFileSync(worker, "\n// [e2e] 打开扩展页面作为测试控制台\nsetTimeout(function () { chrome.tabs.create({ url: chrome.runtime.getURL('src/options/options.html') }).catch(function () {}); }, 400);\n", "utf8");
}

function staticServer() {
  return new Promise((resolve) => {
    const server = http.createServer((req, res) => {
      const body = fs.readFileSync(path.join(ROOT, "extension/scripts/e2e-page.html"));
      res.writeHead(200, { "Content-Type": "text/html; charset=utf-8", "Content-Length": body.length });
      res.end(body);
    });
    server.listen(PAGE_PORT, "127.0.0.1", () => resolve(server));
  });
}

async function main() {
  prepare();
  const mock = spawn(process.execPath, [path.join(ROOT, "extension/scripts/mock-server.mjs")], {
    env: Object.assign({}, process.env, { PORT: String(MOCK_PORT) }),
    stdio: "ignore",
  });
  await waitJson("http://127.0.0.1:" + MOCK_PORT + "/health", 15000);
  const staticSrv = await staticServer();
  const proc = spawn(EDGE, ["--headless=new", "--disable-gpu", "--no-first-run", "--no-default-browser-check",
    "--user-data-dir=" + PROFILE, "--disable-extensions-except=" + EXT, "--load-extension=" + EXT,
    "--remote-debugging-port=" + CDP_PORT, "--remote-allow-origins=*", "about:blank"], { stdio: "ignore", windowsHide: true });

  let pageCdp = null;
  let extCdp = null;
  try {
    await waitJson("http://127.0.0.1:" + CDP_PORT + "/json/version", 30000);
    // 打开目标页
    let targets = await waitJson("http://127.0.0.1:" + CDP_PORT + "/json/list", 10000);
    const page = targets.find((t) => t.type === "page" && String(t.url || "").indexOf("about:blank") >= 0) || targets.find((t) => t.type === "page");
    pageCdp = await Cdp.connect(page.webSocketDebuggerUrl);
    await pageCdp.send("Page.enable");
    await pageCdp.send("Runtime.enable");
    await pageCdp.send("Emulation.setDeviceMetricsOverride", { width: 1440, height: 900, deviceScaleFactor: 1, mobile: false });
    await pageCdp.send("Page.navigate", { url: "http://127.0.0.1:" + PAGE_PORT + "/" });

    // 等扩展 options 页出现（扩展启动时会自动打开）
    let extPage = null;
    for (let i = 0; i < 30; i += 1) {
      await sleep(500);
      targets = await waitJson("http://127.0.0.1:" + CDP_PORT + "/json/list", 10000);
      extPage = targets.find((t) => t.type === "page" && String(t.url || "").indexOf("chrome-extension://") === 0 && String(t.url).indexOf("/src/options/") >= 0);
      if (extPage) break;
    }
    if (!extPage) {
      step("targets", targets.map((t) => t.type + ":" + String(t.url || "").slice(0, 60)));
      throw new Error("扩展页面没有出现，无法在扩展上下文执行测试");
    }
    step("扩展控制台", String(extPage.url).slice(0, 80));
    extCdp = await Cdp.connect(extPage.webSocketDebuggerUrl);
    await extCdp.send("Runtime.enable");
    await sleep(1500);

    const before = JSON.parse(await pageCdp.eval("JSON.stringify({ trans: document.querySelectorAll('.ait-trans').length })"));
    step("注入前页面状态", before);

    const result = await extCdp.eval("(async () => {" +
      "const tabs = await chrome.tabs.query({});" +
      "const tab = tabs.find((t) => t.url && t.url.indexOf('127.0.0.1') >= 0);" +
      "if (!tab) return { error: 'no-tab', urls: tabs.map((t) => t.url).slice(0, 6) };" +
      "const mod = await import(chrome.runtime.getURL('src/shared/inject.js'));" +
      "const firstProbe = await mod.probeContentScript(tab.id);" +
      "const ok1 = await mod.ensureContentScript(tab.id);" +
      "let state1 = null; try { state1 = await chrome.tabs.sendMessage(tab.id, { type: 'ait:tab.pageState' }); } catch (e) { state1 = { err: String(e) }; }" +
      "const ok2 = await mod.ensureContentScript(tab.id);" +
      "let state2 = null; try { state2 = await chrome.tabs.sendMessage(tab.id, { type: 'ait:tab.pageState' }); } catch (e) { state2 = { err: String(e) }; }" +
      "return { tabId: tab.id, firstProbe, ok1, state1, ok2, state2 };" +
      "})()");
    step("动态注入结果", result);

    await extCdp.eval("(async () => {" +
      "const tabs = await chrome.tabs.query({});" +
      "const tab = tabs.find((t) => t.url && t.url.indexOf('127.0.0.1') >= 0);" +
      "await chrome.tabs.sendMessage(tab.id, { type: 'ait:cmd.toggleTranslate' });" +
      "return true;" +
      "})()");

    let trans = 0;
    let toast = "";
    for (let i = 0; i < 25; i += 1) {
      await sleep(700);
      const state = JSON.parse(await pageCdp.eval("JSON.stringify({ trans: document.querySelectorAll('.ait-trans').length, toast: document.querySelector('.ait-toast') ? document.querySelector('.ait-toast').textContent.trim().slice(0, 40) : '' })"));
      trans = state.trans || 0;
      toast = state.toast || "";
      if (trans >= 15) break;
    }
    step("注入后翻译", { trans, toast });

    const shot = await pageCdp.send("Page.captureScreenshot", { format: "png" });
    fs.writeFileSync(path.join(OUT, "dyn-inject.png"), Buffer.from(shot.data, "base64"));
    report.pass = !!(result && result.firstProbe === false && result.ok1 === true && stateOk(result.state1) && result.ok2 === true && stateOk(result.state2) && trans >= 15);
    step("结论", { pass: report.pass });
  } finally {
    if (pageCdp) pageCdp.close();
    if (extCdp) extCdp.close();
    if (process.platform === "win32") spawn("taskkill", ["/PID", String(proc.pid), "/T", "/F"], { stdio: "ignore" });
    else proc.kill();
    staticSrv.close();
    mock.kill();
    await sleep(500);
  }
  fs.writeFileSync(path.join(OUT, "report.json"), JSON.stringify(report, null, 2));
  console.log(report.pass ? "[dyn] PASS" : "[dyn] FAIL");
  process.exit(report.pass ? 0 : 1);
}

main().catch((error) => {
  report.error = String(error && error.stack ? error.stack : error);
  try { fs.writeFileSync(path.join(OUT, "report.json"), JSON.stringify(report, null, 2)); } catch (_) {}
  console.log("[dyn] FAIL: " + report.error);
  process.exit(1);
});