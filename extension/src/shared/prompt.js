/**
 * 提示词构造与编号协议解析。
 * 纯函数模块，不依赖 chrome，可在 Node 中直接测试。
 */
import { PROMPT_VERSION, languagePromptName } from "./config.js";

const SEPARATOR_RE = /(?:^|\n)[ \t]*(?:\*\*|__)?[ \t]*(?:\[|【|［)[ \t]*(\d{1,4})[ \t]*(?:\]|】|］)(?:\*\*|__)?[ \t]*[:：]?[ \t]*/g;
const FENCE_OPEN_RE = /\x60{3}[a-zA-Z0-9_-]*[ \t]*\n?/g;
const FENCE_CLOSE_RE = /\n?[ \t]*\x60{3}/g;

export { PROMPT_VERSION };

function fillTemplate(template, vars) {
  return String(template || "").replace(/\{(target|source|glossary|title)\}/g, (match, key) => {
    const value = vars[key];
    return value === undefined || value === null ? "" : String(value);
  });
}

/** 术语表文本块 */
export function glossaryText(glossary) {
  if (!Array.isArray(glossary) || !glossary.length) return "";
  const lines = [];
  for (const item of glossary.slice(0, 300)) {
    if (!item) continue;
    const from = String(item.from || "").trim();
    const to = String(item.to || "").trim();
    if (!from || !to) continue;
    const note = String(item.note || "").trim();
    lines.push("- " + from + " => " + to + (note ? "（" + note + "）" : ""));
  }
  if (!lines.length) return "";
  return "术语表（优先级最高，原文出现左侧术语时必须使用右侧译法）：\n" + lines.join("\n");
}

/** 全页翻译 system 提示词 */
export function buildPageSystemPrompt(options) {
  const target = languagePromptName(options.targetLang);
  const glossary = glossaryText(options.glossary);
  const custom = String(options.customSystem || "").trim();
  if (custom) {
    return fillTemplate(custom, { target, source: "", glossary, title: options.pageTitle || "" });
  }
  return [
    "你是一名专业的网页翻译引擎，负责把网页段落翻译成" + target + "。",
    "",
    "输出规则（必须严格遵守）：",
    "1. 逐段输出，每段以 [序号] 开头，序号必须与输入中的序号完全一致；不得合并段落、不得遗漏、不得添加未编号的内容或解释。",
    "2. 只输出译文，不要复述原文，不要使用 Markdown 代码块围栏。",
    "3. 译文要准确、自然、地道，符合" + target + "的表达习惯；保留原文的数字、单位、专有名词、URL、代码片段、括号中的补充说明。",
    "4. 原文已经是" + target + "，或只是数字、符号、URL、代码时，原样输出。",
    "5. 每个段落各占一行，段落之间不要空行。",
    "6. 不要输出任何前言、后记或对翻译过程的说明。",
    glossary ? "\n" + glossary : "",
  ].filter((line) => line !== "").join("\n");
}

/** 全页翻译 messages 数组 */
export function buildPageMessages(options) {
  const segments = options.segments || [];
  const target = languagePromptName(options.targetLang);
  const source = options.sourceLang && options.sourceLang !== "auto" ? languagePromptName(options.sourceLang) : "";
  const custom = String(options.customUser || "").trim();
  const system = buildPageSystemPrompt({
    targetLang: options.targetLang,
    glossary: options.glossary,
    customSystem: options.customSystem,
    pageTitle: options.pageTitle,
  });
  const header = custom
    ? fillTemplate(custom, { target, source, glossary: "", title: options.pageTitle || "" })
    : "请把下面的 " + segments.length + " 个段落翻译成" + target + "。";
  const body = segments.map((segment) => "[" + segment.index + "] " + segment.text).join("\n");
  return [
    { role: "system", content: system },
    { role: "user", content: header + "\n\n" + body },
  ];
}

/** 划词翻译 system 提示词 */
export function buildSelectionSystemPrompt(options) {
  const target = languagePromptName(options.targetLang);
  const glossary = glossaryText(options.glossary);
  const custom = String(options.customSystem || "").trim();
  if (custom) {
    return fillTemplate(custom, { target, source: "", glossary, title: options.pageTitle || "" });
  }
  return [
    "你是一名专业的翻译助手，负责把用户选中的网页文本翻译成" + target + "。",
    "",
    "规则：",
    "1. 只输出译文本身，不要解释、不要复述原文、不要加引号，不要使用代码块。",
    "2. 译文准确、自然，保留原文的语气、换行与列表结构，保留数字、单位、专有名词、URL 与代码片段。",
    "3. 如果原文已经是" + target + "，则将其翻译成 English（即中英智能互译）。",
    glossary ? "\n" + glossary : "",
  ].filter((line) => line !== "").join("\n");
}

export function buildSelectionMessages(options) {
  const system = buildSelectionSystemPrompt({
    targetLang: options.targetLang,
    glossary: options.glossary,
    customSystem: options.customSystem,
    pageTitle: options.pageTitle,
  });
  let text = String(options.text || "").trim();
  if (options.pageTitle) {
    text = "（页面标题：" + String(options.pageTitle).slice(0, 200) + "）\n" + text;
  }
  return [
    { role: "system", content: system },
    { role: "user", content: text },
  ];
}

function cleanTranslation(text) {
  let value = String(text || "").trim();
  if (!value) return "";
  value = value.replace(FENCE_OPEN_RE, "").replace(FENCE_CLOSE_RE, "").trim();
  value = value.replace(/^\*\*(.*)\*\*$/s, "$1").trim();
  value = value.replace(/^(译文|翻译结果|翻译|Translation)[:：][ \t]*/i, "").trim();
  value = value.replace(/^["“「](.*)["”」]$/s, "$1").trim();
  return value;
}

/**
 * 解析模型返回的编号译文。
 * @param {string} raw 模型原始输出
 * @param {Array<string|number>} ids 期望的段落序号
 * @param {Map<string,string>} idMap 原始序号 -> 稳定 segment id
 * @returns {{ results: Array<{id:string, text:string}>, missing: string[] }}
 */
export function parseNumberedReply(raw, ids, idMap) {
  const allowed = [];
  const lookup = new Map();
  ids.forEach((id) => {
    const key = String(id);
    allowed.push(key);
    lookup.set(key, idMap && idMap.get ? idMap.get(key) || key : key);
  });
  const text = String(raw || "").replace(/\r\n?/g, "\n");
  const found = [];
  SEPARATOR_RE.lastIndex = 0;
  let match;
  while ((match = SEPARATOR_RE.exec(text))) {
    found.push({ num: match[1], start: match.index, contentStart: match.index + match[0].length });
  }
  const results = [];
  const seen = new Set();
  if (!found.length) {
    if (allowed.length === 1) {
      const only = cleanTranslation(text);
      if (only) {
        results.push({ id: lookup.get(allowed[0]), text: only });
        seen.add(allowed[0]);
      }
    }
  } else {
    for (let i = 0; i < found.length; i += 1) {
      const current = found[i];
      const end = i + 1 < found.length ? found[i + 1].start : text.length;
      const body = cleanTranslation(text.slice(current.contentStart, end));
      if (!body) continue;
      if (!lookup.has(current.num)) continue;
      if (seen.has(current.num)) continue;
      seen.add(current.num);
      results.push({ id: lookup.get(current.num), text: body });
    }
  }
  const missing = allowed.filter((id) => !seen.has(id)).map((id) => lookup.get(id));
  return { results, missing };
}

/** 估算一次请求的 token（粗略） */
export function estimateRequestTokens(messages) {
  const text = (messages || []).map((message) => String(message.content || "")).join("\n");
  const cjk = (text.match(/[\u3400-\u9fff\u3040-\u30ff\uac00-\ud7af]/g) || []).length;
  const other = text.length - cjk;
  return Math.max(1, Math.ceil(cjk * 0.7 + other * 0.26));
}
