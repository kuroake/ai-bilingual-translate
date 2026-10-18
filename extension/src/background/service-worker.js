/**
 * Background service worker：所有网络请求、缓存、统计、命令路由都集中在这里。
 * 页面上下文永远不会接触到 API Key。
 */
import { deepMerge } from "./../shared/config.js";
import { getSettings, patchSettings, resetSettings, queueWrite, storageSet } from "./../shared/storage.js";
import { chatCompletion, listModels, ProviderError } from "./../shared/provider.js";
import { buildPageMessages, buildSelectionMessages, parseNumberedReply, estimateRequestTokens } from "./../shared/prompt.js";
import { cacheGet, cacheSet, cacheStats, cacheClear, flushCache } from "./../shared/cache.js";
import { getStats, recordUsage, resetStats } from "./../shared/stats.js";
import { ensureContentScript } from "./../shared/inject.js";
import { MSG, CMD, STREAM_PORT, ERR, ERROR_TEXT } from "./../shared/messages.js";

const MENU_SELECTION = "ait-menu-selection";
const MENU_PAGE = "ait-menu-page";

function toErrorPayload(error) {
  if (error instanceof ProviderError) return { code: error.code, message: error.message };
  return { code: ERR.INTERNAL, message: (error && error.message) || ERROR_TEXT.INTERNAL };
}

function ok(data) {
  return Object.assign({ ok: true }, data || {});
}

function fail(error) {
  return { ok: false, error: toErrorPayload(error) };
}

async function getActiveTab() {
  try {
    const tabs = await chrome.tabs.query({ active: true, currentWindow: true });
    return tabs && tabs[0] ? tabs[0] : null;
  } catch (_) {
    return null;
  }
}

async function sendToTab(tabId, message) {
  if (typeof tabId !== "number") return null;
  try {
    return await chrome.tabs.sendMessage(tabId, message);
  } catch (_) {
    // 页面在扩展安装/重载之前就打开了，没有 content script：动态注入后重试一次
    const injected = await ensureContentScript(tabId);
    if (!injected) return null;
    try {
      return await chrome.tabs.sendMessage(tabId, message);
    } catch (_) {
      return null;
    }
  }
}

/** 广播设置变更：只发给已有 content script 的页面，不触发动态注入 */
function broadcastToTab(tabId, message) {
  if (typeof tabId !== "number") return;
  try {
    chrome.tabs.sendMessage(tabId, message).catch(() => {});
  } catch (_) {}
}

/**
 * 工具栏图标行为：
 *   popup（默认）—— 点击打开控制面板（语言、显示方式、快速翻译、缓存用量），不占用图标；
 *   toggle        —— 点击直接翻译 / 还原当前页面（可选）。
 * 通过 chrome.action.setPopup 动态切换，设置变更立即生效。
 */
async function applyClickAction(settings) {
  const action = (settings && settings.ui && settings.ui.clickAction) || "popup";
  try {
    await chrome.action.setPopup({ popup: action === "popup" ? "src/popup/popup.html" : "" });
  } catch (_) {}
}

chrome.action.onClicked.addListener((tab) => {
  void (async () => {
    if (!tab || typeof tab.id !== "number") return;
    await sendToTab(tab.id, { type: CMD.TOGGLE_TRANSLATE });
  })();
});

void (async () => {
  try {
    applyClickAction(await getSettings());
  } catch (_) {}
})();

async function setupContextMenus() {
  try {
    await chrome.contextMenus.removeAll();
    chrome.contextMenus.create({ id: MENU_SELECTION, title: "AI 翻译选中文字", contexts: ["selection"] });
    chrome.contextMenus.create({ id: MENU_PAGE, title: "AI 双语翻译 / 还原此页面", contexts: ["page"] });
  } catch (_) {
    // 忽略菜单重复创建错误
  }
}

chrome.runtime.onInstalled.addListener((details) => {
  void (async () => {
    const settings = await getSettings();
    await queueWrite(() => storageSet({ settings }));
    await setupContextMenus();
    await applyClickAction(settings);
    if (details && details.reason === "install") {
      try {
        await chrome.runtime.openOptionsPage();
      } catch (_) {}
    }
  })();
});

chrome.runtime.onStartup.addListener(() => {
  void setupContextMenus();
  void (async () => applyClickAction(await getSettings()))();
});

chrome.contextMenus.onClicked.addListener((info, tab) => {
  void (async () => {
    const tabId = tab && tab.id;
    if (info.menuItemId === MENU_SELECTION) {
      await sendToTab(tabId, { type: CMD.TRANSLATE_SELECTION });
      return;
    }
    if (info.menuItemId === MENU_PAGE) {
      await sendToTab(tabId, { type: CMD.TOGGLE_TRANSLATE });
    }
  })();
});

chrome.commands.onCommand.addListener((command) => {
  void (async () => {
    const tab = await getActiveTab();
    if (!tab || !tab.id) return;
    const map = {
      "toggle-translate": CMD.TOGGLE_TRANSLATE,
      "toggle-mode": CMD.TOGGLE_MODE,
      "translate-selection": CMD.TRANSLATE_SELECTION,
    };
    const type = map[command];
    if (type) await sendToTab(tab.id, { type });
  })();
});

chrome.storage.onChanged.addListener((changes, areaName) => {
  if (areaName !== "local" || !changes.settings) return;
  void (async () => {
    const settings = changes.settings.newValue;
    void applyClickAction(settings);
    try {
      const tabs = await chrome.tabs.query({});
      for (const tab of tabs) {
        if (!tab.id) continue;
        broadcastToTab(tab.id, { type: CMD.SETTINGS_CHANGED, settings });
      }
    } catch (_) {}
  })();
});

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (!message || typeof message.type !== "string" || message.type.indexOf("ait:") !== 0) return false;
  void (async () => {
    try {
      const result = await handleMessage(message, sender);
      sendResponse(result);
    } catch (error) {
      sendResponse(fail(error));
    }
  })();
  return true;
});

async function handleMessage(message, sender) {
  switch (message.type) {
    case MSG.SETTINGS_GET: {
      const settings = await getSettings();
      return ok({ settings });
    }
    case MSG.SETTINGS_PATCH: {
      const settings = await patchSettings(message.patch || {});
      return ok({ settings });
    }
    case MSG.SETTINGS_RESET: {
      const settings = await resetSettings();
      return ok({ settings });
    }
    case MSG.TRANSLATE_BATCH:
      return handleTranslateBatch(message.payload || {}, sender);
    case MSG.TRANSLATE_TEXT:
      return handleTranslateText(message.payload || {});
    case MSG.PROVIDER_TEST:
      return handleProviderTest(message.payload || {});
    case MSG.PROVIDER_MODELS:
      return handleProviderModels(message.payload || {});
    case MSG.CACHE_STATS: {
      const settings = await getSettings();
      const stats = await cacheStats(settings);
      return ok(stats);
    }
    case MSG.CACHE_CLEAR:
      await cacheClear();
      return ok({});
    case MSG.STATS_GET: {
      const stats = await getStats();
      return ok({ stats });
    }
    case MSG.STATS_RESET: {
      const stats = await resetStats();
      return ok({ stats });
    }
    case MSG.PAGE_TRANSLATED:
      return ok({});
    default:
      return { ok: false, error: { code: ERR.INVALID_CONFIG, message: "未知消息类型：" + message.type } };
  }
}

function mergeProvider(settings, payload) {
  const provider = Object.assign({}, settings.provider);
  if (!payload) return provider;
  if (typeof payload.baseUrl === "string" && payload.baseUrl.trim()) provider.baseUrl = payload.baseUrl.trim();
  if (typeof payload.apiKey === "string" && payload.apiKey.trim()) provider.apiKey = payload.apiKey.trim();
  if (typeof payload.model === "string" && payload.model.trim()) provider.model = payload.model.trim();
  return provider;
}

async function handleProviderTest(payload) {
  const settings = await getSettings();
  const provider = mergeProvider(settings, payload);
  const probe = { settings: Object.assign({}, settings, { provider: provider }) };
  const started = Date.now();
  const messages = [
    { role: "system", content: "你是一个连通性测试助手。" },
    { role: "user", content: "请只回复两个字：正常" },
  ];
  const reply = await chatCompletion({
    settings: probe.settings,
    messages: messages,
    stream: false,
    overrides: { maxTokens: 24 },
  });
  return ok({
    latencyMs: Date.now() - started,
    model: provider.model,
    sample: String(reply.content || "").slice(0, 120),
  });
}

async function handleProviderModels(payload) {
  const settings = await getSettings();
  const provider = mergeProvider(settings, payload);
  const result = await listModels({ provider: provider, baseUrl: provider.baseUrl, apiKey: provider.apiKey });
  return ok({ models: result.models, count: result.count });
}

async function handleTranslateText(payload) {
  const settings = await getSettings();
  const targetLang = payload.targetLang || settings.language.target;
  const text = String(payload.text || "").trim();
  if (!text) throw new ProviderError(ERR.INVALID_CONFIG, "没有可翻译的文本。");
  const result = await translateOne(settings, text, targetLang, payload);
  await recordUsage({
    requests: result.cached ? 0 : 1,
    segments: 1,
    cacheHits: result.cached ? 1 : 0,
    tokensIn: result.usage.tokensIn,
    tokensOut: result.usage.tokensOut,
  });
  await flushCache();
  return ok({ text: result.text, cached: !!result.cached, usage: result.usage });
}

async function translateOne(settings, text, targetLang, payload) {
  const cached = await cacheGet(settings, targetLang, text);
  if (cached) return { text: cached, cached: true, usage: { tokensIn: 0, tokensOut: 0 } };
  const messages = buildSelectionMessages({
    text: text,
    targetLang: targetLang,
    sourceLang: settings.language.source,
    glossary: settings.glossary,
    customSystem: settings.customPrompt.selection || settings.customPrompt.system,
    pageTitle: payload.pageTitle,
  });
  const reply = await chatCompletion({ settings: settings, messages: messages, stream: false });
  const usage = {
    tokensIn: reply.usage.tokensIn || estimateRequestTokens(messages),
    tokensOut: reply.usage.tokensOut || Math.ceil(reply.content.length * 0.5),
  };
  await cacheSet(settings, targetLang, text, reply.content);
  return { text: reply.content, cached: false, usage: usage };
}

async function handleTranslateBatch(payload, sender) {
  const settings = await getSettings();
  const targetLang = payload.targetLang || settings.language.target;
  const all = Array.isArray(payload.segments) ? payload.segments : [];
  const segments = all.filter((segment) => segment && typeof segment.text === "string" && segment.text.trim());
  if (!segments.length) return ok({ results: [], cached: 0, usage: { tokensIn: 0, tokensOut: 0 }, failed: [] });

  const results = [];
  const pending = [];
  let cachedCount = 0;
  for (const segment of segments) {
    const hit = await cacheGet(settings, targetLang, segment.text);
    if (hit) {
      results.push({ id: segment.id, text: hit });
      cachedCount += 1;
    } else {
      pending.push(segment);
    }
  }

  const usage = { tokensIn: 0, tokensOut: 0 };
  const failed = [];
  let requests = 0;

  if (pending.length) {
    const indexed = pending.map((segment, index) => ({ index: index + 1, id: segment.id, text: segment.text }));
    const textById = new Map(indexed.map((item) => [item.id, item.text]));
    const idMap = new Map(indexed.map((item) => [String(item.index), item.id]));
    const messages = buildPageMessages({
      segments: indexed,
      targetLang: targetLang,
      sourceLang: settings.language.source,
      glossary: settings.glossary,
      customSystem: settings.customPrompt.system,
      customUser: settings.customPrompt.page,
      pageTitle: payload.pageTitle,
    });
    let parsed = { results: [], missing: indexed.map((item) => item.id) };
    try {
      const reply = await chatCompletion({ settings: settings, messages: messages, stream: false });
      requests += 1;
      usage.tokensIn += reply.usage.tokensIn || estimateRequestTokens(messages);
      usage.tokensOut += reply.usage.tokensOut || Math.ceil(reply.content.length * 0.5);
      parsed = parseNumberedReply(reply.content, indexed.map((item) => item.index), idMap);
    } catch (error) {
      if (indexed.length === 1) throw error;
      failed.push.apply(failed, indexed.map((item) => item.id));
    }

    for (const item of parsed.results) {
      results.push(item);
      const sourceText = textById.get(item.id);
      if (sourceText) await cacheSet(settings, targetLang, sourceText, item.text);
    }

    // 缺失段落降级为单段请求，避免整批失败
    if (parsed.missing.length && parsed.results.length > 0) {
      for (const id of parsed.missing) {
        const sourceText = textById.get(id);
        if (!sourceText) continue;
        try {
          const single = await translateOne(settings, sourceText, targetLang, payload);
          requests += single.cached ? 0 : 1;
          usage.tokensIn += single.usage.tokensIn;
          usage.tokensOut += single.usage.tokensOut;
          results.push({ id: id, text: single.text });
          const index = failed.indexOf(id);
          if (index >= 0) failed.splice(index, 1);
        } catch (error) {
          if (failed.indexOf(id) < 0) failed.push(id);
        }
      }
    } else if (parsed.missing.length) {
      for (const id of parsed.missing) {
        if (failed.indexOf(id) < 0) failed.push(id);
      }
    }
  }

  await recordUsage({
    requests: requests,
    segments: results.length,
    cacheHits: cachedCount,
    tokensIn: usage.tokensIn,
    tokensOut: usage.tokensOut,
  });
  await flushCache();

  return ok({ results: results, cached: cachedCount, usage: usage, failed: failed });
}

chrome.runtime.onConnect.addListener((port) => {
  if (!port || port.name !== STREAM_PORT) return;
  let controller = new AbortController();

  const post = (data) => {
    try {
      port.postMessage(data);
    } catch (_) {
      // port 已断开
    }
  };

  port.onMessage.addListener((message) => {
    if (!message || typeof message.type !== "string") return;
    if (message.type === "abort") {
      controller.abort();
      return;
    }
    if (message.type === "start") {
      controller = new AbortController();
      void runStream(port, controller, message.payload || {}, post);
    }
  });

  port.onDisconnect.addListener(() => {
    try {
      controller.abort();
    } catch (_) {}
  });
});

async function runStream(port, controller, payload, post) {
  let settings;
  try {
    settings = await getSettings();
  } catch (error) {
    post({ type: "error", code: ERR.INTERNAL, message: ERROR_TEXT.INTERNAL });
    return;
  }
  const targetLang = payload.targetLang || settings.selection.targetLang || settings.language.target;
  const text = String(payload.text || "").trim();
  if (!text) {
    post({ type: "error", code: ERR.INVALID_CONFIG, message: "没有可翻译的文本。" });
    return;
  }
  post({ type: "meta", provider: settings.provider.baseUrl, model: settings.provider.model });

  try {
    const cached = await cacheGet(settings, targetLang, text);
    if (cached) {
      post({ type: "done", content: cached, cached: true, usage: { tokensIn: 0, tokensOut: 0 } });
      await recordUsage({ requests: 0, segments: 1, cacheHits: 1, tokensIn: 0, tokensOut: 0 });
      return;
    }
    const messages = buildSelectionMessages({
      text: text,
      targetLang: targetLang,
      sourceLang: settings.language.source,
      glossary: settings.glossary,
      customSystem: settings.customPrompt.selection || settings.customPrompt.system,
      pageTitle: payload.pageTitle,
    });
    const reply = await chatCompletion({
      settings: settings,
      messages: messages,
      stream: settings.selection.stream !== false,
      signal: controller.signal,
      onDelta: (delta) => {
        post({ type: "chunk", delta: delta.delta, content: delta.content, reasoning: delta.reasoning });
      },
    });
    const usage = {
      tokensIn: reply.usage.tokensIn || estimateRequestTokens(messages),
      tokensOut: reply.usage.tokensOut || Math.ceil(reply.content.length * 0.5),
    };
    await cacheSet(settings, targetLang, text, reply.content);
    post({ type: "done", content: reply.content, usage: usage });
    await recordUsage({ requests: 1, segments: 1, cacheHits: 0, tokensIn: usage.tokensIn, tokensOut: usage.tokensOut });
    await flushCache();
  } catch (error) {
    const payloadError = toErrorPayload(error);
    if (payloadError.code === ERR.ABORTED) return;
    post({ type: "error", code: payloadError.code, message: payloadError.message });
  }
}
