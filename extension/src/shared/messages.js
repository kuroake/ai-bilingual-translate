/**
 * 消息类型常量。前后端必须共用这里的字符串，禁止手写裸字符串。
 */
export const MSG = {
  SETTINGS_GET: "ait:settings.get",
  SETTINGS_PATCH: "ait:settings.patch",
  SETTINGS_RESET: "ait:settings.reset",
  TRANSLATE_BATCH: "ait:translate.batch",
  TRANSLATE_TEXT: "ait:translate.text",
  PROVIDER_TEST: "ait:provider.test",
  PROVIDER_MODELS: "ait:provider.models",
  CACHE_STATS: "ait:cache.stats",
  CACHE_CLEAR: "ait:cache.clear",
  STATS_GET: "ait:stats.get",
  STATS_RESET: "ait:stats.reset",
  PAGE_TRANSLATED: "ait:page.translated",
  TAB_PAGE_STATE: "ait:tab.pageState",
};

/** background 发给 content 的命令 */
export const CMD = {
  TOGGLE_TRANSLATE: "ait:cmd.toggleTranslate",
  TOGGLE_MODE: "ait:cmd.toggleMode",
  TRANSLATE_SELECTION: "ait:cmd.translateSelection",
  SET_TARGET_LANG: "ait:cmd.setTargetLang",
  SETTINGS_CHANGED: "ait:cmd.settingsChanged",
};

export const STREAM_PORT = "ait-stream";

export const ERR = {
  NO_API_KEY: "NO_API_KEY",
  INVALID_CONFIG: "INVALID_CONFIG",
  HTTP_401: "HTTP_401",
  HTTP_429: "HTTP_429",
  HTTP_5XX: "HTTP_5XX",
  HTTP_ERROR: "HTTP_ERROR",
  TIMEOUT: "TIMEOUT",
  NETWORK: "NETWORK",
  PARSE: "PARSE",
  EMPTY_RESPONSE: "EMPTY_RESPONSE",
  ABORTED: "ABORTED",
  INTERNAL: "INTERNAL",
};

/** 错误码 -> 中文提示（可直接展示给用户） */
export const ERROR_TEXT = {
  NO_API_KEY: "还没有配置 API Key，请打开扩展设置填写。",
  INVALID_CONFIG: "API 配置不完整，请检查 Base URL 与模型名。",
  HTTP_401: "API 鉴权失败（401），请检查 Key 是否正确、是否有该模型权限。",
  HTTP_429: "请求过于频繁（429），已限流，请稍后重试或降低并发。",
  HTTP_5XX: "翻译服务暂时不可用（5xx），请稍后重试。",
  HTTP_ERROR: "翻译接口返回错误，请检查 Base URL 是否指向 OpenAI 兼容服务。",
  TIMEOUT: "请求超时，请检查网络或增大超时时间。",
  NETWORK: "网络请求失败，请检查网络连接或接口地址。",
  PARSE: "译文格式解析失败，已自动重试。",
  EMPTY_RESPONSE: "模型返回了空内容，请重试或更换模型。",
  ABORTED: "已取消。",
  INTERNAL: "扩展内部错误，请重试或刷新页面。",
};
