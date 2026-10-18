/**
 * 全局默认配置与常量。
 * 被 background、popup、options 引用（ES Module）。
 */

export const SETTINGS_KEY = "settings";
export const STATS_KEY = "stats";
export const CACHE_KEY = "transCache";
export const PROMPT_VERSION = 3;
export const STREAM_PORT_NAME = "ait-stream";

/** 支持的目标语言。name 用于提示词，label 用于界面。 */
export const LANGUAGES = [
  { code: "zh-CN", label: "简体中文", name: "简体中文（简体）" },
  { code: "zh-TW", label: "繁體中文", name: "繁体中文" },
  { code: "en", label: "English", name: "English" },
  { code: "ja", label: "日本語", name: "日本語" },
  { code: "ko", label: "한국어", name: "한국어" },
  { code: "fr", label: "Français", name: "Français" },
  { code: "de", label: "Deutsch", name: "Deutsch" },
  { code: "es", label: "Español", name: "Español" },
  { code: "ru", label: "Русский", name: "Русский" },
  { code: "pt", label: "Português", name: "Português" },
  { code: "it", label: "Italiano", name: "Italiano" },
  { code: "ar", label: "العربية", name: "العربية" },
  { code: "vi", label: "Tiếng Việt", name: "Tiếng Việt" },
  { code: "th", label: "ไทย", name: "ไทย" },
];

export const DEFAULT_SETTINGS = {
  version: 2,
  provider: {
    baseUrl: "https://api.deepseek.com/v1",
    apiKey: "",
    model: "deepseek-chat",
    temperature: 0.2,
    maxTokens: 0,
    timeoutMs: 60000,
    stream: true,
    extraHeaders: {},
  },
  language: { source: "auto", target: "zh-CN" },
  translate: {
    mode: "bilingual",
    concurrency: 3,
    batchSize: 8,
    maxSegmentChars: 1500,
    autoTranslate: false,
    autoSites: [],
    excludeSites: [],
    minTextLength: 2,
    skipCode: true,
    retryLimit: 2,
    showOriginalDefault: true,
  },
  selection: {
    enabled: true,
    autoPopup: false,
    targetLang: "zh-CN",
    showOriginal: true,
    stream: true,
    maxChars: 6000,
  },
  glossary: [],
  customPrompt: { system: "", page: "", selection: "" },
  cache: { enabled: true, maxEntries: 2000, ttlDays: 30 },
  ui: { theme: "auto", locale: "zh-CN", firstRun: true, clickAction: "popup" },
};

export const CLAUDE_STYLE_MAX_TOKENS = 0;

/** 语言代码 -> 中文展示名 */
export function languageName(code) {
  const found = LANGUAGES.find((item) => item.code === code);
  return found ? found.label : code || "目标语言";
}

/** 语言代码 -> 提示词中的语言全名 */
export function languagePromptName(code) {
  const found = LANGUAGES.find((item) => item.code === code);
  return found ? found.name : code || "目标语言";
}

export function isPlainObject(value) {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

/**
 * 深合并设置。数组与标量直接替换（不做元素级合并），缺失字段保留默认值。
 */
export function deepMerge(base, patch) {
  if (patch === undefined) return cloneValue(base);
  if (Array.isArray(base) || Array.isArray(patch)) return cloneValue(patch);
  if (!isPlainObject(base) || !isPlainObject(patch)) return cloneValue(patch);
  const out = {};
  for (const key of Object.keys(base)) out[key] = cloneValue(base[key]);
  for (const key of Object.keys(patch)) {
    const value = patch[key];
    if (value === undefined) continue;
    out[key] = out[key] === undefined ? cloneValue(value) : deepMerge(out[key], value);
  }
  return out;
}

function cloneValue(value) {
  if (Array.isArray(value)) return value.map(cloneValue);
  if (isPlainObject(value)) {
    const out = {};
    for (const key of Object.keys(value)) out[key] = cloneValue(value[key]);
    return out;
  }
  return value;
}

/** 去除首尾空白与内部空白，便于拼 URL */
export function normalizeBaseUrl(raw) {
  return String(raw || "").trim().replace(/\s+/g, "");
}

/** Base URL -> chat/completions 完整地址 */
export function chatCompletionsUrl(baseUrl) {
  let url = normalizeBaseUrl(baseUrl);
  if (!url) return "";
  url = url.replace(/\/+$/, "");
  if (/\/chat\/completions$/i.test(url)) return url;
  if (/\/v\d+[a-z]*$/i.test(url)) return url + "/chat/completions";
  return url + "/chat/completions";
}

/** Base URL -> models 列表地址 */
export function modelsUrl(baseUrl) {
  let url = normalizeBaseUrl(baseUrl);
  if (!url) return "";
  url = url.replace(/\/+$/, "");
  url = url.replace(/\/chat\/completions$/i, "");
  return url + "/models";
}

/** 常见 Base URL 提示值，供设置页一键填入 */
export const PROVIDER_PRESETS = [
  { id: "deepseek", label: "DeepSeek", baseUrl: "https://api.deepseek.com/v1", model: "deepseek-chat" },
  { id: "openai", label: "OpenAI", baseUrl: "https://api.openai.com/v1", model: "gpt-4o-mini" },
  { id: "ollama", label: "Ollama 本地", baseUrl: "http://localhost:11434/v1", model: "qwen2.5:7b" },
  { id: "siliconflow", label: "SiliconFlow", baseUrl: "https://api.siliconflow.cn/v1", model: "deepseek-ai/DeepSeek-V3" },
  { id: "custom", label: "自定义", baseUrl: "", model: "" },
];

/**
 * 域名规则匹配。支持 example.com、*.example.com、localhost、带端口。
 */
export function matchSiteRule(rules, host) {
  if (!Array.isArray(rules)) return false;
  const target = String(host || "").toLowerCase().replace(/:\d+$/, "");
  if (!target) return false;
  return rules.some((raw) => {
    let rule = String(raw || "").trim().toLowerCase();
    if (!rule) return false;
    rule = rule.replace(/^https?:\/\//, "").replace(/\/.*$/, "").replace(/:\d+$/, "");
    if (!rule) return false;
    if (rule === "*") return true;
    if (rule.startsWith("*.")) {
      const base = rule.slice(2);
      return target === base || target.endsWith("." + base);
    }
    return target === rule || target.endsWith("." + rule);
  });
}

/** 判断页面是否应自动翻译 */
export function shouldAutoTranslate(settings, host) {
  const t = (settings && settings.translate) || DEFAULT_SETTINGS.translate;
  if (matchSiteRule(t.excludeSites, host)) return false;
  if (matchSiteRule(t.autoSites, host)) return true;
  return !!t.autoTranslate;
}

/**
 * 粗略统计文本的 CJK 与拉丁字符，用于语言启发式判断。
 */
export function scriptStats(text) {
  const s = String(text || "");
  const cjk = (s.match(/[\u4e00-\u9fff]/g) || []).length;
  const kana = (s.match(/[\u3040-\u30ff]/g) || []).length;
  const hangul = (s.match(/[\uac00-\ud7af]/g) || []).length;
  const cyrillic = (s.match(/[\u0400-\u04ff]/g) || []).length;
  const latin = (s.match(/[A-Za-z]/g) || []).length;
  const digits = (s.match(/[0-9]/g) || []).length;
  const visible = s.replace(/\s/g, "").length || 1;
  return { cjk, kana, hangul, cyrillic, latin, digits, visible };
}

/** 文本是否看起来已经是目标语言（避免重复翻译） */
export function looksLikeTargetLanguage(text, targetLang) {
  const s = String(text || "").trim();
  if (!s) return true;
  const stats = scriptStats(s);
  const code = String(targetLang || "").toLowerCase();
  const letterRatio = (stats.cjk + stats.kana + stats.hangul + stats.cyrillic + stats.latin) / stats.visible;
  if (letterRatio < 0.2) return true; // 纯数字/符号/表情
  if (code.startsWith("zh")) {
    const zh = stats.cjk + stats.kana;
    return zh / stats.visible > 0.55;
  }
  if (code === "ja") return (stats.kana + stats.cjk) / stats.visible > 0.4;
  if (code === "ko") return stats.hangul / stats.visible > 0.4;
  if (code === "ru") return stats.cyrillic / stats.visible > 0.4;
  return stats.latin / stats.visible > 0.55;
}

/** 估算 token 数（中文约 0.65 token/字，拉丁约 0.25 token/字符） */
export function estimateTokens(text) {
  const s = String(text || "");
  const cjk = (s.match(/[\u3400-\u9fff\u3040-\u30ff\uac00-\ud7af]/g) || []).length;
  const other = s.length - cjk;
  return Math.max(1, Math.ceil(cjk * 0.7 + other * 0.26));
}
