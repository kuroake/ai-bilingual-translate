/**
 * content/00-core.js 单元测试（无 DOM 依赖的纯工具部分）。
 * 00-core 是经典内容脚本（IIFE 挂 window.AIT），这里构造最小全局环境后执行源码。
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { deepMerge as sharedDeepMerge } from "../src/shared/config.js";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const CORE_PATH = path.join(HERE, "..", "src", "content", "00-core.js");

function loadCore() {
  globalThis.window = globalThis;
  globalThis.location = { href: "https://example.com/article" };
  delete globalThis.AIT;
  const source = readFileSync(CORE_PATH, "utf8");
  // 内容脚本是 IIFE，直接执行即可把 AIT 挂到 window 上
  new Function(source)();
  return globalThis.AIT;
}

const AIT = loadCore();

function installRuntime(sendMessage) {
  globalThis.chrome = { runtime: { id: "test", lastError: null, sendMessage } };
  return globalThis.chrome;
}

// ---------------------------------------------------------------- 基础

test("core 初始化：版本、状态与页面地址", () => {
  assert.equal(typeof AIT.version, "string");
  assert.equal(AIT.ready, true);
  assert.equal(AIT.state.pageUrl, "https://example.com/article");
  assert.equal(AIT.state.translated, false);
  assert.equal(AIT.state.mode, "bilingual");
  assert.deepEqual(AIT.state.progress, { done: 0, total: 0, failed: 0 });
});

test("util.deepMerge 与 shared/config.js 语义一致", () => {
  const cases = [
    [{ a: 1 }, { b: 2 }],
    [{ a: { b: 1, c: 2 } }, { a: { c: 3, d: 4 } }],
    [{ list: [1, 2] }, { list: [3] }],
    [{ a: 1 }, null],
    [{ a: { b: 1 } }, undefined],
    [{}, { nested: { deep: { value: 1 } } }],
  ];
  for (const [base, patch] of cases) {
    assert.deepEqual(AIT.util.deepMerge(base, patch), sharedDeepMerge(base, patch));
  }
});

test("util.isPlainObject / cloneValue 只认普通对象并深拷贝", () => {
  assert.equal(AIT.util.isPlainObject({}), true);
  assert.equal(AIT.util.isPlainObject([]), false);
  assert.equal(AIT.util.isPlainObject(null), false);
  const original = { nested: { value: 1 }, list: [1] };
  const copy = AIT.util.cloneValue(original);
  copy.nested.value = 2;
  copy.list.push(2);
  assert.deepEqual(original, { nested: { value: 1 }, list: [1] });
});

test("util.hash 为稳定 8 位 FNV-1a", () => {
  assert.equal(AIT.util.hash(""), "811c9dc5");
  assert.equal(AIT.util.hash("abc"), AIT.util.hash("abc"));
  assert.notEqual(AIT.util.hash("abc"), AIT.util.hash("abd"));
  assert.match(AIT.util.hash("任何文本"), /^[0-9a-f]{8}$/);
});

test("util.normalizeText 压缩空白", () => {
  assert.equal(AIT.util.normalizeText("  a   b\n c\t"), "a b c");
  assert.equal(AIT.util.normalizeText(""), "");
  assert.equal(AIT.util.normalizeText(null), "");
});

test("util.escapeHtml 转义 HTML 特殊字符", () => {
  assert.equal(AIT.util.escapeHtml("<a>&'</a>"), "&lt;a&gt;&amp;&#39;&lt;/a&gt;");
  assert.equal(AIT.util.escapeHtml(String.fromCharCode(34)), "&quot;");
});

test("util.isCJK 识别中日韩字符", () => {
  assert.equal(AIT.util.isCJK("中文"), true);
  assert.equal(AIT.util.isCJK("かな"), true);
  assert.equal(AIT.util.isCJK("한국"), true);
  assert.equal(AIT.util.isCJK("abc"), false);
  assert.equal(AIT.util.isCJK(""), false);
});

test("util.looksTranslated 跳过纯符号与 URL", () => {
  assert.equal(AIT.util.looksTranslated(""), true);
  assert.equal(AIT.util.looksTranslated("123, 45%"), true);
  assert.equal(AIT.util.looksTranslated("https://example.com/a"), true);
  assert.equal(AIT.util.looksTranslated("Hello world"), false);
  assert.equal(AIT.util.looksTranslated("你好"), false);
});

test("util.looksLikeTargetLanguage 与 shared 语言启发式一致", () => {
  assert.equal(AIT.util.looksLikeTargetLanguage("这是一段中文。", "zh-CN"), true);
  assert.equal(AIT.util.looksLikeTargetLanguage("Hello world", "zh-CN"), false);
  assert.equal(AIT.util.looksLikeTargetLanguage("Hello world", "en"), true);
  assert.equal(AIT.util.looksLikeTargetLanguage("12345", "zh-CN"), true);
  assert.equal(AIT.util.looksLikeTargetLanguage("", "zh-CN"), true);
});

test("util.langLabel 返回中文语言名", () => {
  assert.equal(AIT.util.langLabel("zh-CN"), "简体中文");
  assert.equal(AIT.util.langLabel("en"), "English");
  assert.equal(AIT.util.langLabel("xx"), "xx");
});

test("util.uid 带前缀且唯一", () => {
  const a = AIT.util.uid("seg");
  const b = AIT.util.uid("seg");
  assert.match(a, /^seg-[a-z0-9]+$/);
  assert.notEqual(a, b);
});

test("util.once 只执行一次", () => {
  let count = 0;
  const fn = AIT.util.once(() => {
    count += 1;
    return count;
  });
  assert.equal(fn(), 1);
  assert.equal(fn(), undefined);
  assert.equal(count, 1);
});

test("util.debounce 只执行最后一次调用", async () => {
  const calls = [];
  const fn = AIT.util.debounce((value) => calls.push(value), 10);
  fn(1);
  fn(2);
  fn(3);
  assert.deepEqual(calls, []);
  await AIT.util.sleep(30);
  assert.deepEqual(calls, [3]);
});

test("util.throttle 先立即执行再补尾调用", async () => {
  const calls = [];
  const fn = AIT.util.throttle((value) => calls.push(value), 20);
  fn(1);
  fn(2);
  assert.deepEqual(calls, [1]);
  await AIT.util.sleep(50);
  assert.deepEqual(calls, [1, 2]);
});

test("util.backoff 指数增长并封顶", () => {
  const first = AIT.util.backoff(1, 800);
  assert.ok(first >= 800 && first < 800 + 250);
  const second = AIT.util.backoff(2, 800);
  assert.ok(second >= 1600 && second < 1600 + 250);
  const capped = AIT.util.backoff(10, 800);
  assert.ok(capped <= 15000 + 250);
});

// ---------------------------------------------------------------- 事件总线

test("AIT.bus 支持订阅/触发/退订，且单个处理器抛错不影响其他处理器", () => {
  const events = [];
  const off = AIT.bus.on("demo", (payload) => events.push(["a", payload]));
  AIT.bus.on("demo", () => {
    throw new Error("boom");
  });
  AIT.bus.on("demo", (payload) => events.push(["b", payload]));

  AIT.bus.emit("demo", 1);
  assert.deepEqual(events, [["a", 1], ["b", 1]]);

  off();
  AIT.bus.emit("demo", 2);
  assert.deepEqual(events, [["a", 1], ["b", 1], ["b", 2]]);

  AIT.bus.off("demo", () => {});
  AIT.bus.emit("no-listener", 1); // 不应抛错
});

// ---------------------------------------------------------------- runtimeSend

test("AIT.runtimeSend 成功时返回响应，永不 reject", async () => {
  installRuntime((message, callback) => {
    setTimeout(() => callback({ ok: true, echo: message.type }), 0);
  });
  const response = await AIT.runtimeSend({ type: "ait:settings.get" });
  assert.deepEqual(response, { ok: true, echo: "ait:settings.get" });
});

test("AIT.runtimeSend 遇到 chrome.runtime.lastError 时返回 ok:false", async () => {
  const chromeMock = installRuntime((message, callback) => {
    chromeMock.runtime.lastError = { message: "Could not establish connection" };
    callback(undefined);
    chromeMock.runtime.lastError = null;
  });
  const response = await AIT.runtimeSend({ type: "ait:ping" });
  assert.equal(response.ok, false);
  assert.equal(response.error.code, "INTERNAL");
  assert.match(response.error.message, /Could not establish connection/);
});

test("AIT.runtimeSend 遇到同步异常时返回 ok:false", async () => {
  installRuntime(() => {
    throw new Error("扩展上下文失效");
  });
  const response = await AIT.runtimeSend({ type: "ait:ping" });
  assert.equal(response.ok, false);
  assert.equal(response.error.code, "INTERNAL");
  assert.match(response.error.message, /扩展上下文失效/);
});

// ---------------------------------------------------------------- settings

test("AIT.loadSettings 拉取后台设置并写入 state", async () => {
  installRuntime((message, callback) => {
    callback({ ok: true, settings: { language: { target: "en" } } });
  });
  const settings = await AIT.loadSettings();
  assert.deepEqual(settings, { language: { target: "en" } });
  assert.deepEqual(AIT.state.settings, { language: { target: "en" } });
});

test("AIT.applySettings 更新 state 并广播 settings 事件", () => {
  const events = [];
  const off = AIT.bus.on("settings", (settings) => events.push(settings));
  AIT.applySettings({ translate: { mode: "translation-only" } });
  assert.equal(AIT.state.settings.translate.mode, "translation-only");
  assert.equal(AIT.state.mode, "translation-only");
  assert.equal(events.length, 1);
  assert.equal(events[0].translate.mode, "translation-only");
  off();
});

test("AIT.applySettings 忽略空值", () => {
  const before = AIT.state.settings;
  AIT.applySettings(null);
  assert.equal(AIT.state.settings, before);
});
