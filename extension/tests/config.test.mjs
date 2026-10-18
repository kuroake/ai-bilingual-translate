/**
 * shared/config.js 单元测试。
 * 覆盖：设置深合并、站点规则、自动翻译优先级、语言启发式、URL 规范化、默认值完整性。
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  DEFAULT_SETTINGS,
  LANGUAGES,
  PROVIDER_PRESETS,
  PROMPT_VERSION,
  SETTINGS_KEY,
  STATS_KEY,
  CACHE_KEY,
  deepMerge,
  isPlainObject,
  languageName,
  languagePromptName,
  normalizeBaseUrl,
  chatCompletionsUrl,
  modelsUrl,
  matchSiteRule,
  shouldAutoTranslate,
  scriptStats,
  looksLikeTargetLanguage,
  estimateTokens,
} from "../src/shared/config.js";

// ---------------------------------------------------------------- 常量与默认值

test("存储 key 与提示词版本为稳定值", () => {
  assert.equal(SETTINGS_KEY, "settings");
  assert.equal(STATS_KEY, "stats");
  assert.equal(CACHE_KEY, "transCache");
  assert.ok(Number.isInteger(PROMPT_VERSION) && PROMPT_VERSION > 0);
});

test("语言表至少覆盖契约要求的 12 种语言且代码唯一", () => {
  const required = ["zh-CN", "zh-TW", "en", "ja", "ko", "fr", "de", "es", "ru", "pt", "it", "ar", "auto"];
  const codes = LANGUAGES.map((item) => item.code);
  for (const code of required) {
    if (code === "auto") continue; // auto 是源语言标记，不在目标语言表中
    assert.ok(codes.includes(code), "缺少语言：" + code);
  }
  assert.equal(new Set(codes).size, codes.length, "语言代码必须唯一");
  for (const item of LANGUAGES) {
    assert.ok(item.label && item.name, "语言 " + item.code + " 缺少展示名");
  }
});

test("预设服务商列表完整且字段可用", () => {
  const ids = PROVIDER_PRESETS.map((item) => item.id);
  for (const id of ["deepseek", "openai", "ollama", "custom"]) {
    assert.ok(ids.includes(id), "缺少服务商预设：" + id);
  }
  for (const preset of PROVIDER_PRESETS) {
    assert.equal(typeof preset.label, "string");
    assert.equal(typeof preset.baseUrl, "string");
    assert.equal(typeof preset.model, "string");
  }
});

test("DEFAULT_SETTINGS 与架构文档的数据模型一致", () => {
  assert.equal(DEFAULT_SETTINGS.version, 2);
  assert.equal(DEFAULT_SETTINGS.provider.baseUrl, "https://api.deepseek.com/v1");
  assert.equal(DEFAULT_SETTINGS.provider.model, "deepseek-chat");
  assert.equal(DEFAULT_SETTINGS.provider.maxTokens, 0);
  assert.equal(DEFAULT_SETTINGS.provider.stream, true);
  assert.deepEqual(DEFAULT_SETTINGS.provider.extraHeaders, {});
  assert.deepEqual(DEFAULT_SETTINGS.language, { source: "auto", target: "zh-CN" });
  assert.equal(DEFAULT_SETTINGS.translate.mode, "bilingual");
  assert.equal(DEFAULT_SETTINGS.translate.concurrency, 3);
  assert.equal(DEFAULT_SETTINGS.translate.batchSize, 8);
  assert.equal(DEFAULT_SETTINGS.translate.retryLimit, 2);
  assert.equal(DEFAULT_SETTINGS.translate.skipCode, true);
  assert.equal(DEFAULT_SETTINGS.selection.enabled, true);
  assert.equal(DEFAULT_SETTINGS.selection.maxChars, 6000);
  assert.deepEqual(DEFAULT_SETTINGS.glossary, []);
  assert.deepEqual(DEFAULT_SETTINGS.customPrompt, { system: "", page: "", selection: "" });
  assert.deepEqual(DEFAULT_SETTINGS.cache, { enabled: true, maxEntries: 2000, ttlDays: 30 });
  assert.deepEqual(DEFAULT_SETTINGS.ui, { theme: "auto", locale: "zh-CN", firstRun: true, clickAction: "popup" });
});

// ---------------------------------------------------------------- deepMerge

test("deepMerge 递归补齐缺失字段，数组与标量整体替换", () => {
  const base = { a: 1, nested: { x: 1, y: 2 }, list: [1, 2] };
  const patch = { nested: { y: 20, z: 30 }, list: [9] };
  const out = deepMerge(base, patch);
  assert.deepEqual(out, { a: 1, nested: { x: 1, y: 20, z: 30 }, list: [9] });
});

test("deepMerge 不修改入参且不共享引用", () => {
  const base = { a: 1, nested: { x: 1 }, list: [1, 2] };
  const patch = { nested: { y: 2 }, list: [9] };
  const out = deepMerge(base, patch);
  assert.deepEqual(base, { a: 1, nested: { x: 1 }, list: [1, 2] });
  assert.deepEqual(patch, { nested: { y: 2 }, list: [9] });
  out.nested.y = 999;
  out.list.push(3);
  assert.equal(base.nested.y, undefined);
  assert.deepEqual(base.list, [1, 2]);
  assert.deepEqual(patch.list, [9]);
});

test("deepMerge 对 undefined / null / 标量的边界行为", () => {
  assert.deepEqual(deepMerge({ a: 1 }, undefined), { a: 1 });
  assert.equal(deepMerge({ a: 1 }, null), null);
  assert.equal(deepMerge({ a: 1 }, 5), 5);
  assert.equal(deepMerge({ a: 1 }, "x"), "x");
  assert.deepEqual(deepMerge({ a: { b: 1 } }, {}), { a: { b: 1 } });
  assert.deepEqual(deepMerge({}, { a: { b: 2 } }), { a: { b: 2 } });
});

test("deepMerge 模拟版本升级：旧设置缺字段时用默认值补齐", () => {
  const legacy = { provider: { apiKey: "sk-test" }, ui: { theme: "dark" } };
  const merged = deepMerge(DEFAULT_SETTINGS, legacy);
  assert.equal(merged.provider.apiKey, "sk-test");
  assert.equal(merged.provider.model, DEFAULT_SETTINGS.provider.model);
  assert.equal(merged.ui.theme, "dark");
  assert.equal(merged.ui.firstRun, true);
  assert.equal(merged.ui.clickAction, "popup");
  assert.equal(merged.translate.batchSize, 8);
  assert.deepEqual(merged.glossary, []);
});

test("deepMerge(DEFAULT_SETTINGS, {}) 与默认值深相等", () => {
  assert.deepEqual(deepMerge(DEFAULT_SETTINGS, {}), DEFAULT_SETTINGS);
});

test("isPlainObject 只认普通对象", () => {
  assert.equal(isPlainObject({}), true);
  assert.equal(isPlainObject([]), false);
  assert.equal(isPlainObject(null), false);
  assert.equal(isPlainObject(undefined), false);
  assert.equal(isPlainObject("x"), false);
  assert.equal(isPlainObject(1), false);
});

// ---------------------------------------------------------------- URL 规范化

test("normalizeBaseUrl 去空白并压缩内部空白", () => {
  assert.equal(normalizeBaseUrl("  https://api.deepseek.com/v1  "), "https://api.deepseek.com/v1");
  assert.equal(normalizeBaseUrl("https:// a.com /v1"), "https://a.com/v1");
  assert.equal(normalizeBaseUrl(""), "");
  assert.equal(normalizeBaseUrl(undefined), "");
  assert.equal(normalizeBaseUrl(null), "");
});

test("chatCompletionsUrl 兼容带 / 不带 /v1 / 已带端点", () => {
  assert.equal(chatCompletionsUrl("https://api.deepseek.com/v1"), "https://api.deepseek.com/v1/chat/completions");
  assert.equal(chatCompletionsUrl("https://api.deepseek.com/v1/"), "https://api.deepseek.com/v1/chat/completions");
  assert.equal(chatCompletionsUrl("https://api.openai.com"), "https://api.openai.com/chat/completions");
  assert.equal(chatCompletionsUrl("https://x.com/v1/chat/completions"), "https://x.com/v1/chat/completions");
  assert.equal(chatCompletionsUrl("https://x.com/v1/chat/completions/"), "https://x.com/v1/chat/completions");
  assert.equal(chatCompletionsUrl("https://x.com/v1beta"), "https://x.com/v1beta/chat/completions");
  assert.equal(chatCompletionsUrl(""), "");
  assert.equal(chatCompletionsUrl("   "), "");
});

test("modelsUrl 从 Base URL 推导模型列表地址", () => {
  assert.equal(modelsUrl("https://api.deepseek.com/v1"), "https://api.deepseek.com/v1/models");
  assert.equal(modelsUrl("https://x.com/v1/chat/completions"), "https://x.com/v1/models");
  assert.equal(modelsUrl("https://x.com/v1/"), "https://x.com/v1/models");
  assert.equal(modelsUrl("https://x.com"), "https://x.com/models");
  assert.equal(modelsUrl(""), "");
});

// ---------------------------------------------------------------- 站点规则

test("matchSiteRule 支持精确域名、子域、通配、协议路径与端口", () => {
  assert.equal(matchSiteRule(["example.com"], "example.com"), true);
  assert.equal(matchSiteRule(["example.com"], "www.example.com"), true);
  assert.equal(matchSiteRule(["example.com"], "notexample.com"), false);
  assert.equal(matchSiteRule(["*.example.com"], "a.b.example.com"), true);
  assert.equal(matchSiteRule(["*.example.com"], "example.com"), true);
  assert.equal(matchSiteRule(["https://example.com/path"], "example.com"), true);
  assert.equal(matchSiteRule(["example.com:8080"], "example.com"), true);
  assert.equal(matchSiteRule(["localhost"], "localhost:3000"), true);
  assert.equal(matchSiteRule(["localhost"], "127.0.0.1"), false);
  assert.equal(matchSiteRule(["*"], "anything.dev"), true);
  assert.equal(matchSiteRule(["Example.COM"], "www.example.com"), true);
});

test("matchSiteRule 对非法输入安全返回 false", () => {
  assert.equal(matchSiteRule([], "example.com"), false);
  assert.equal(matchSiteRule(null, "example.com"), false);
  assert.equal(matchSiteRule(undefined, "example.com"), false);
  assert.equal(matchSiteRule(["example.com"], ""), false);
  assert.equal(matchSiteRule(["example.com"], null), false);
  assert.equal(matchSiteRule(["   "], "example.com"), false);
  assert.equal(matchSiteRule([""], "example.com"), false);
  assert.equal(matchSiteRule([null], "example.com"), false);
});

test("shouldAutoTranslate 优先级：excludeSites > autoSites > 全局开关", () => {
  const base = deepMerge(DEFAULT_SETTINGS, {});
  assert.equal(shouldAutoTranslate(base, "example.com"), false);

  const globalOn = deepMerge(base, { translate: { autoTranslate: true } });
  assert.equal(shouldAutoTranslate(globalOn, "example.com"), true);

  const autoSites = deepMerge(base, { translate: { autoSites: ["example.com"] } });
  assert.equal(shouldAutoTranslate(autoSites, "www.example.com"), true);
  assert.equal(shouldAutoTranslate(autoSites, "other.com"), false);

  const excludeWins = deepMerge(base, {
    translate: { autoTranslate: true, autoSites: ["example.com"], excludeSites: ["example.com"] },
  });
  assert.equal(shouldAutoTranslate(excludeWins, "example.com"), false);

  const wildcard = deepMerge(base, { translate: { autoSites: ["*.docs.com"] } });
  assert.equal(shouldAutoTranslate(wildcard, "api.docs.com"), true);

  assert.equal(shouldAutoTranslate(null, "example.com"), false);
});

// ---------------------------------------------------------------- 语言启发式

test("scriptStats 粗略统计字符类别", () => {
  const stats = scriptStats("Hello 世界123");
  assert.equal(stats.cjk, 2);
  assert.equal(stats.latin, 5);
  assert.equal(stats.digits, 3);
  assert.equal(stats.visible, 10);
});

test("looksLikeTargetLanguage 对中文目标的正负例", () => {
  assert.equal(looksLikeTargetLanguage("这是一段中文。", "zh-CN"), true);
  assert.equal(looksLikeTargetLanguage("繁體中文也是中文。", "zh-TW"), true);
  assert.equal(looksLikeTargetLanguage("Hello world", "zh-CN"), false);
  assert.equal(looksLikeTargetLanguage("Hello 世界", "zh-CN"), false);
  assert.equal(looksLikeTargetLanguage("你好世界hello", "zh-CN"), false);
});

test("looksLikeTargetLanguage 对其他目标语言的正负例", () => {
  assert.equal(looksLikeTargetLanguage("Hello world", "en"), true);
  assert.equal(looksLikeTargetLanguage("こんにちは", "ja"), true);
  assert.equal(looksLikeTargetLanguage("안녕하세요", "ko"), true);
  assert.equal(looksLikeTargetLanguage("Привет", "ru"), true);
  assert.equal(looksLikeTargetLanguage("Hello world", "ja"), false);
  assert.equal(looksLikeTargetLanguage("這是中文", "ja"), true); // 汉字按日文启发式计入
});

test("looksLikeTargetLanguage 跳过空文本、纯数字与符号", () => {
  assert.equal(looksLikeTargetLanguage("", "zh-CN"), true);
  assert.equal(looksLikeTargetLanguage("   ", "zh-CN"), true);
  assert.equal(looksLikeTargetLanguage("12345", "zh-CN"), true);
  assert.equal(looksLikeTargetLanguage("$100, 50% + - = ()", "zh-CN"), true);
  assert.equal(looksLikeTargetLanguage("😀😀", "zh-CN"), true);
  assert.equal(looksLikeTargetLanguage(undefined, "zh-CN"), true);
});

test("looksLikeTargetLanguage 对 URL 文本返回 false（交由其他规则跳过）", () => {
  assert.equal(looksLikeTargetLanguage("https://example.com/a/b", "zh-CN"), false);
});

// ---------------------------------------------------------------- 展示名与 token 估算

test("languageName / languagePromptName 对未知代码回退原代码", () => {
  assert.equal(languageName("zh-CN"), "简体中文");
  assert.equal(languageName("en"), "English");
  assert.equal(languageName("xx"), "xx");
  assert.equal(languageName(""), "目标语言");
  assert.equal(languagePromptName("zh-CN"), "简体中文（简体）");
  assert.equal(languagePromptName("en"), "English");
  assert.equal(languagePromptName("xx"), "xx");
});

test("estimateTokens 对空串与中英文返回正整数", () => {
  assert.equal(estimateTokens(""), 1);
  assert.equal(estimateTokens("中文"), 2);
  assert.equal(estimateTokens("hello"), 2);
  assert.ok(estimateTokens("这是一段较长的中文文本用于估算 token 数") > 5);
});
