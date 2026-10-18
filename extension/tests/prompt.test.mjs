/**
 * shared/prompt.js 单元测试。
 * 重点覆盖编号协议解析的容错：加粗、全角括号、缺段、无编号、多段跨行、重复/越界序号。
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  PROMPT_VERSION,
  glossaryText,
  buildPageSystemPrompt,
  buildPageMessages,
  buildSelectionSystemPrompt,
  buildSelectionMessages,
  parseNumberedReply,
  estimateRequestTokens,
} from "../src/shared/prompt.js";
import { PROMPT_VERSION as CONFIG_PROMPT_VERSION } from "../src/shared/config.js";

function idMapOf(pairs) {
  return new Map(pairs);
}

// ---------------------------------------------------------------- 编号协议解析

test("parseNumberedReply 解析标准编号输出", () => {
  const raw = "[1] 你好\n[2] 世界";
  const out = parseNumberedReply(raw, [1, 2], idMapOf([["1", "seg-1"], ["2", "seg-2"]]));
  assert.deepEqual(out.results, [
    { id: "seg-1", text: "你好" },
    { id: "seg-2", text: "世界" },
  ]);
  assert.deepEqual(out.missing, []);
});

test("parseNumberedReply 容忍序号被 Markdown 加粗", () => {
  const raw = "**[1]** 你好\n**[2]** 世界";
  const out = parseNumberedReply(raw, [1, 2], null);
  assert.deepEqual(out.results, [
    { id: "1", text: "你好" },
    { id: "2", text: "世界" },
  ]);
  assert.deepEqual(out.missing, []);
});

test("parseNumberedReply 容忍全角方括号 【】 与 ［］", () => {
  for (const raw of ["【1】你好\n【2】世界", "［1］你好\n［2］世界"]) {
    const out = parseNumberedReply(raw, [1, 2], null);
    assert.deepEqual(out.results, [
      { id: "1", text: "你好" },
      { id: "2", text: "世界" },
    ], "解析失败：" + raw);
    assert.deepEqual(out.missing, []);
  }
});

test("parseNumberedReply 容忍序号后的中文/英文冒号", () => {
  const raw = "[1]：你好\n[2]: 世界";
  const out = parseNumberedReply(raw, [1, 2], null);
  assert.deepEqual(out.results, [
    { id: "1", text: "你好" },
    { id: "2", text: "世界" },
  ]);
});

test("parseNumberedReply 忽略编号前的多余前言", () => {
  const raw = "以下是译文：\n[1] 你好\n[2] 世界";
  const out = parseNumberedReply(raw, [1, 2], null);
  assert.equal(out.results.length, 2);
  assert.deepEqual(out.missing, []);
});

test("parseNumberedReply 容忍段落之间的空行与首尾空白", () => {
  const raw = "\n\n**[1]** 你好  \n\n**[2]** 世界\n";
  const out = parseNumberedReply(raw, [1, 2], null);
  assert.deepEqual(out.results, [
    { id: "1", text: "你好" },
    { id: "2", text: "世界" },
  ]);
});

test("parseNumberedReply 保留译文内部的换行（多段跨行）", () => {
  const raw = "[1] 第一行\n第二行\n[2] 世界";
  const out = parseNumberedReply(raw, [1, 2], null);
  assert.deepEqual(out.results, [
    { id: "1", text: "第一行\n第二行" },
    { id: "2", text: "世界" },
  ]);
});

test("parseNumberedReply 按出现顺序返回，不要求序号有序", () => {
  const raw = "[2] 世界\n[1] 你好";
  const out = parseNumberedReply(raw, [1, 2], null);
  assert.deepEqual(out.results.map((item) => item.id), ["2", "1"]);
  assert.deepEqual(out.missing, []);
});

test("parseNumberedReply 缺段时返回 missing（映射为稳定 id）", () => {
  const raw = "[1] 你好\n[3] 世界";
  const out = parseNumberedReply(raw, [1, 2, 3], idMapOf([["1", "s1"], ["2", "s2"], ["3", "s3"]]));
  assert.deepEqual(out.results, [
    { id: "s1", text: "你好" },
    { id: "s3", text: "世界" },
  ]);
  assert.deepEqual(out.missing, ["s2"]);
});

test("parseNumberedReply 空正文的段落视为缺失", () => {
  const raw = "[1]\n[2] 世界";
  const out = parseNumberedReply(raw, [1, 2], null);
  assert.deepEqual(out.results, [{ id: "2", text: "世界" }]);
  assert.deepEqual(out.missing, ["1"]);
});

test("parseNumberedReply 忽略预期之外的序号", () => {
  const raw = "[1] 你好\n[9] 越界内容";
  const out = parseNumberedReply(raw, [1, 2], null);
  assert.deepEqual(out.results, [{ id: "1", text: "你好" }]);
  assert.deepEqual(out.missing, ["2"]);
});

test("parseNumberedReply 重复序号只取第一次出现的正文", () => {
  const raw = "[1] 你好\n[1] 重复内容\n[2] 世界";
  const out = parseNumberedReply(raw, [1, 2], null);
  assert.deepEqual(out.results, [
    { id: "1", text: "你好" },
    { id: "2", text: "世界" },
  ]);
  assert.deepEqual(out.missing, []);
});

test("parseNumberedReply 单段无编号时回退为整段译文", () => {
  const out = parseNumberedReply("你好世界", [1], null);
  assert.deepEqual(out.results, [{ id: "1", text: "你好世界" }]);
  assert.deepEqual(out.missing, []);
});

test("parseNumberedReply 单段无编号时清洗加粗/前缀/引号", () => {
  assert.equal(parseNumberedReply("**你好世界**", [1], null).results[0].text, "你好世界");
  assert.equal(parseNumberedReply("译文：你好世界", [1], null).results[0].text, "你好世界");
  assert.equal(parseNumberedReply("「你好世界」", [1], null).results[0].text, "你好世界");
  assert.equal(parseNumberedReply("Translation: Hello", [1], null).results[0].text, "Hello");
});

test("parseNumberedReply 多段但完全没有编号时全部标记 missing", () => {
  const out = parseNumberedReply("你好世界", [1, 2], null);
  assert.deepEqual(out.results, []);
  assert.deepEqual(out.missing, ["1", "2"]);
});

test("parseNumberedReply 容忍代码块围栏包裹", () => {
  const raw = "\x60\x60\x60\n[1] 你好\n\x60\x60\x60";
  const out = parseNumberedReply(raw, [1], null);
  assert.deepEqual(out.results, [{ id: "1", text: "你好" }]);
  assert.deepEqual(out.missing, []);
});

test("parseNumberedReply 空缺输出与纯空白返回全部 missing", () => {
  assert.deepEqual(parseNumberedReply("", [1, 2], null), { results: [], missing: ["1", "2"] });
  assert.deepEqual(parseNumberedReply("   \n  ", [1], null), { results: [], missing: ["1"] });
  assert.deepEqual(parseNumberedReply(null, [1], null), { results: [], missing: ["1"] });
});

test("parseNumberedReply 接受数字型 id 并保持映射类型", () => {
  const out = parseNumberedReply("[1] 你好", [1], idMapOf([["1", 42]]));
  assert.deepEqual(out.results, [{ id: 42, text: "你好" }]);
  assert.deepEqual(out.missing, []);
});

test("parseNumberedReply 不支持「1.」式 Markdown 编号（已知限制，降级为缺失）", () => {
  const out = parseNumberedReply("1. 你好\n2. 世界", [1, 2], null);
  assert.deepEqual(out.results, []);
  assert.deepEqual(out.missing, ["1", "2"]);
});

// ---------------------------------------------------------------- 提示词构造

test("PROMPT_VERSION 与 config 中一致", () => {
  assert.equal(PROMPT_VERSION, CONFIG_PROMPT_VERSION);
});

test("glossaryText 过滤非法项并附加备注，空表返回空串", () => {
  assert.equal(glossaryText([]), "");
  assert.equal(glossaryText(null), "");
  assert.equal(glossaryText([null, { from: "", to: "x" }, { from: "c", to: "" }]), "");
  const text = glossaryText([{ from: "token", to: "令牌", note: "术语" }]);
  assert.match(text, /术语表/);
  assert.match(text, /- token => 令牌（术语）/);
});

test("glossaryText 最多收录 300 条", () => {
  const glossary = Array.from({ length: 305 }, (_, index) => ({ from: "f" + index, to: "t" + index }));
  const lines = glossaryText(glossary).split("\n");
  assert.equal(lines.length, 301); // 1 行表头 + 300 条
});

test("buildPageSystemPrompt 包含目标语言与编号规则，术语表在末尾", () => {
  const prompt = buildPageSystemPrompt({
    targetLang: "zh-CN",
    glossary: [{ from: "token", to: "令牌" }],
  });
  assert.match(prompt, /网页翻译引擎/);
  assert.ok(prompt.includes("简体中文（简体）"));
  assert.ok(prompt.includes("[序号]"));
  assert.ok(prompt.includes("术语表"));
  assert.ok(prompt.lastIndexOf("术语表") > prompt.indexOf("输出规则"));
  // 无术语表时不应出现术语表段落
  assert.ok(!buildPageSystemPrompt({ targetLang: "en" }).includes("术语表"));
});

test("buildPageSystemPrompt 支持自定义 system 模板占位符", () => {
  const prompt = buildPageSystemPrompt({
    targetLang: "ja",
    customSystem: "请翻译为 {target}。{glossary}",
    glossary: [{ from: "a", to: "b" }],
  });
  assert.equal(prompt, "请翻译为 日本語。术语表（优先级最高，原文出现左侧术语时必须使用右侧译法）：\n- a => b");
});

test("buildPageMessages 组装 system + user，序号从 1 递增", () => {
  const messages = buildPageMessages({
    targetLang: "en",
    sourceLang: "auto",
    segments: [
      { index: 1, text: "你好" },
      { index: 2, text: "世界" },
      { index: 3, text: "第三段" },
    ],
  });
  assert.equal(messages.length, 2);
  assert.equal(messages[0].role, "system");
  assert.equal(messages[1].role, "user");
  assert.equal(
    messages[1].content,
    "请把下面的 3 个段落翻译成English。\n\n[1] 你好\n[2] 世界\n[3] 第三段"
  );
});

test("buildPageMessages 支持自定义 user 模板", () => {
  const messages = buildPageMessages({
    targetLang: "zh-CN",
    customUser: "翻译到 {target}，页面标题 {title}",
    pageTitle: "Demo",
    segments: [{ index: 1, text: "Hello" }],
  });
  assert.equal(messages[1].content, "翻译到 简体中文（简体），页面标题 Demo\n\n[1] Hello");
});

test("buildSelectionSystemPrompt 要求只输出译文并包含语言互译说明", () => {
  const prompt = buildSelectionSystemPrompt({ targetLang: "zh-CN" });
  assert.match(prompt, /翻译助手/);
  assert.ok(prompt.includes("简体中文（简体）"));
  assert.ok(prompt.includes("中英智能互译"));
  assert.ok(!buildSelectionSystemPrompt({ targetLang: "en" }).includes("术语表"));
});

test("buildSelectionMessages 去除首尾空白并附加页面标题上下文", () => {
  const messages = buildSelectionMessages({
    targetLang: "zh-CN",
    text: "  Hello world  ",
    pageTitle: "Demo Page",
  });
  assert.equal(messages.length, 2);
  assert.equal(messages[1].content, "（页面标题：Demo Page）\nHello world");
  assert.equal(
    buildSelectionMessages({ targetLang: "zh-CN", text: "Hi" })[1].content,
    "Hi"
  );
});

test("estimateRequestTokens 对提示词返回正整数", () => {
  const tokens = estimateRequestTokens([
    { role: "system", content: "你是一名翻译引擎" },
    { role: "user", content: "Hello world" },
  ]);
  assert.ok(Number.isInteger(tokens) && tokens > 0);
  assert.equal(estimateRequestTokens([]), 1);
});
