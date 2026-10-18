/**
 * popup 控制器。
 *
 * 职责：读取设置 → 探测当前页状态 → 翻译 / 还原 → 目标语言与显示方式 →
 *       快速翻译 → 缓存与用量摘要 → 打开设置。
 * 真实扩展环境使用 chrome.*；?demo=1 时由 demo.js 的内存 mock 接管，DOM/CSS 完全一致。
 */
import { DEMO, DEMO_QUICK_INPUT, DEMO_QUICK_TRANSLATION, runSelfTest } from "./demo.js";
import { getSettings, patchSettings } from "../shared/storage.js";
import { LANGUAGES, languageName } from "../shared/config.js";
import { MSG, CMD } from "../shared/messages.js";
import { ensureContentScript } from "../shared/inject.js";

const QUICK_MAX = 6000;
const TRANSLATABLE_PROTOCOLS = /^(https?|file):$/i;

const ICON = {
  translate:
    '<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M4 5h7M7 4v2c0 3.5-1.5 6-4 7"></path><path d="M5.5 9c1.2 1.8 3 3.2 5 4"></path><path d="M13 20l4-9 4 9M14.5 17h5"></path></svg>',
  restore:
    '<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M3 7v6h6"></path><path d="M3 13a9 9 0 1 0 3-7.7L3 8"></path></svg>',
  spinner: '<span class="btn-spinner" aria-hidden="true"></span>',
};

const dom = {};
const state = {
  settings: null,
  tab: null,
  page: {
    reachable: false,
    translated: false,
    mode: "bilingual",
    reason: "",
  },
  busy: false,
  quickBusy: false,
  toastTimer: null,
  toastHideTimer: null,
};

/* ---------- 通用工具 ---------- */

function $(id) {
  return document.getElementById(id);
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** 发送一次性消息，永不 reject */
function sendRuntime(message) {
  return new Promise((resolve) => {
    try {
      chrome.runtime.sendMessage(message, (response) => {
        const lastError = chrome.runtime.lastError;
        if (lastError) {
          resolve({ ok: false, error: { code: "INTERNAL", message: lastError.message || "扩展后台未响应。" } });
          return;
        }
        resolve(response || { ok: false, error: { code: "INTERNAL", message: "扩展后台未响应。" } });
      });
    } catch (error) {
      resolve({ ok: false, error: { code: "INTERNAL", message: readableError(error) } });
    }
  });
}

function renderError(response) {
  if (response && response.error && response.error.message) return response.error.message;
  return "操作失败，请稍后重试。";
}

function readableError(error) {
  if (!error) return "未知错误";
  if (typeof error === "string") return error;
  if (error.message) return error.message;
  return String(error);
}

const numberFormat = new Intl.NumberFormat("zh-CN");

function formatNumber(value) {
  return numberFormat.format(Number(value) || 0);
}

function formatCompact(value) {
  const number = Number(value) || 0;
  if (number >= 100000000) return (number / 100000000).toFixed(1).replace(/\.0$/, "") + " 亿";
  if (number >= 10000) return (number / 10000).toFixed(1).replace(/\.0$/, "") + " 万";
  return formatNumber(number);
}

function formatBytes(bytes) {
  const value = Number(bytes) || 0;
  if (value >= 1024 * 1024) return (value / (1024 * 1024)).toFixed(1) + " MB";
  if (value >= 1024) return Math.round(value / 1024) + " KB";
  return value + " B";
}

function formatDate(timestamp) {
  const value = Number(timestamp) || 0;
  if (!value) return "—";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "—";
  return date.getFullYear() + " 年 " + (date.getMonth() + 1) + " 月 " + date.getDate() + " 日";
}

function formatUrl(url) {
  try {
    const parsed = new URL(url);
    const path = parsed.pathname === "/" ? "" : parsed.pathname;
    return parsed.host + path;
  } catch (_) {
    return String(url || "");
  }
}

function toast(message, tone) {
  const el = dom.toast;
  if (!el) return;
  window.clearTimeout(state.toastTimer);
  window.clearTimeout(state.toastHideTimer);
  el.textContent = message;
  el.classList.toggle("is-error", tone === "error");
  el.hidden = false;
  void el.offsetWidth;
  el.classList.add("is-visible");
  state.toastTimer = window.setTimeout(() => {
    el.classList.remove("is-visible");
    state.toastHideTimer = window.setTimeout(() => {
      el.hidden = true;
    }, 200);
  }, 2400);
}

/* ---------- 主题 ---------- */

function applyTheme(theme) {
  const value = theme === "light" || theme === "dark" ? theme : "auto";
  document.documentElement.dataset.theme = value;
}

/* ---------- 当前页 ---------- */

function isTranslatableUrl(url) {
  if (!url) return false;
  try {
    return TRANSLATABLE_PROTOCOLS.test(new URL(url).protocol);
  } catch (_) {
    return false;
  }
}

function currentMode() {
  if (state.page.reachable && state.page.mode) return state.page.mode;
  return (state.settings && state.settings.translate && state.settings.translate.mode) || "bilingual";
}

function currentTargetLang() {
  if (state.settings && state.settings.language && state.settings.language.target) {
    return state.settings.language.target;
  }
  return "zh-CN";
}

function hasApiKey() {
  return !!(state.settings && state.settings.provider && state.settings.provider.apiKey);
}

async function loadPageState() {
  let tab = null;
  try {
    const tabs = await chrome.tabs.query({ active: true, currentWindow: true });
    tab = tabs && tabs[0] ? tabs[0] : null;
  } catch (_) {
    tab = null;
  }
  state.tab = tab;

  if (!tab || typeof tab.id !== "number") {
    state.page = { reachable: false, translated: false, mode: currentMode(), reason: "无法获取当前标签页。" };
    renderPageCard();
    return;
  }

  renderPageMeta(tab.title || "当前页面", tab.url || "");

  if (!isTranslatableUrl(tab.url)) {
    state.page = {
      reachable: false,
      translated: false,
      mode: currentMode(),
      reason: "浏览器内部页面不允许扩展脚本运行，换一个普通网页试试。",
    };
    renderPageCard();
    return;
  }

  try {
    let response = await chrome.tabs.sendMessage(tab.id, { type: MSG.TAB_PAGE_STATE }).catch(() => null);
    // 页面在扩展安装/重载之前就打开了 => 没有 content script，动态注入后重试，无需手动刷新
    if (!DEMO && (!response || !response.ok)) {
      const injected = await ensureContentScript(tab.id);
      if (injected) {
        response = await chrome.tabs.sendMessage(tab.id, { type: MSG.TAB_PAGE_STATE }).catch(() => null);
      }
    }
    if (response && response.ok) {
      state.page = {
        reachable: true,
        translated: !!response.translated,
        mode: response.mode === "translation-only" ? "translation-only" : "bilingual",
        reason: "",
      };
    } else {
      state.page = {
        reachable: false,
        translated: false,
        mode: currentMode(),
        reason: "页面脚本尚未就绪，刷新页面后重试。",
      };
    }
  } catch (_) {
    state.page = {
      reachable: false,
      translated: false,
      mode: currentMode(),
      reason: "页面脚本未响应，刷新页面后重试。",
    };
  }
  renderPageCard();
}

function renderPageMeta(title, url) {
  dom.pageTitle.textContent = title || "当前页面";
  dom.pageTitle.title = title || "";
  dom.pageUrl.textContent = url ? formatUrl(url) : "—";
  dom.pageUrl.title = url || "";
}

function renderPageCard() {
  const page = state.page;
  const badge = dom.pageBadge;
  badge.classList.remove("is-translated", "is-muted");
  dom.pageHint.classList.remove("is-warn", "is-error");

  if (!page.reachable) {
    badge.textContent = "不可用";
    badge.classList.add("is-muted");
    dom.pageHint.textContent = page.reason || "当前页面暂不可翻译。";
    dom.pageHint.classList.add("is-warn");
  } else if (page.translated) {
    badge.textContent = "已翻译";
    badge.classList.add("is-translated");
    const modeLabel = page.mode === "translation-only" ? "仅译文" : "双语对照";
    dom.pageHint.textContent = languageName(currentTargetLang()) + " · " + modeLabel + " · 译文以批注样式显示在原文下方";
  } else {
    badge.textContent = "未翻译";
    dom.pageHint.textContent = hasApiKey()
      ? "点击上方按钮，把当前页变成双语对照。"
      : "尚未配置 API Key，请先打开设置填写。";
    if (!hasApiKey()) dom.pageHint.classList.add("is-warn");
  }
  dom.pageBadge.setAttribute("aria-label", "页面状态：" + badge.textContent);
  updateToggleButton();
}

function updateToggleButton() {
  const page = state.page;
  const button = dom.toggleTranslate;
  if (!button) return;
  button.disabled = state.busy || !page.reachable;
  button.classList.toggle("is-restore", page.reachable && page.translated);
  dom.toggleIcon.innerHTML = page.translated ? ICON.restore : ICON.translate;
  if (state.busy) return;
  dom.toggleLabel.textContent = !page.reachable
    ? "无法在此页翻译"
    : page.translated
      ? "还原原文"
      : "翻译此页";
  button.setAttribute(
    "aria-label",
    !page.reachable ? "无法在此页翻译" : page.translated ? "还原原文" : "翻译此页"
  );
}

function setBusy(busy, label) {
  state.busy = busy;
  const button = dom.toggleTranslate;
  button.disabled = busy || !state.page.reachable;
  button.setAttribute("aria-busy", busy ? "true" : "false");
  if (busy) {
    dom.toggleIcon.innerHTML = ICON.spinner;
    dom.toggleLabel.textContent = label;
  } else {
    updateToggleButton();
  }
}

async function toggleTranslate() {
  if (state.busy || !state.page.reachable || !state.tab) return;
  const translating = !state.page.translated;
  setBusy(true, translating ? "翻译中…" : "还原中…");
  try {
    await chrome.tabs.sendMessage(state.tab.id, { type: CMD.TOGGLE_TRANSLATE });
    await sleep(500);
    await loadPageState();
    toast(translating ? "已开始翻译当前页" : "已还原原文");
  } catch (error) {
    toast("操作失败：" + readableError(error), "error");
    await loadPageState();
  } finally {
    setBusy(false);
  }
}

/* ---------- 语言与显示方式 ---------- */

function renderLanguageOptions() {
  const select = dom.targetLang;
  select.textContent = "";
  LANGUAGES.forEach((lang) => {
    const option = document.createElement("option");
    option.value = lang.code;
    option.textContent = lang.label;
    select.appendChild(option);
  });
}

function renderSettingsControls() {
  const settings = state.settings;
  if (!settings) return;
  const target = (settings.language && settings.language.target) || "zh-CN";
  dom.targetLang.value = target;
  renderModeSegments();
}

function renderModeSegments() {
  const mode = currentMode();
  dom.modeButtons.forEach((button) => {
    const active = button.dataset.mode === mode;
    button.classList.toggle("is-active", active);
    button.setAttribute("aria-pressed", active ? "true" : "false");
  });
}

async function onTargetLangChange() {
  const lang = dom.targetLang.value;
  try {
    state.settings = await patchSettings({ language: { target: lang } });
    if (state.page.reachable && state.tab) {
      try {
        await chrome.tabs.sendMessage(state.tab.id, { type: CMD.SET_TARGET_LANG, lang });
      } catch (_) {
        // 页面未注入脚本时忽略，设置已保存
      }
    }
    renderPageCard();
    updateQuickState();
    toast("目标语言：" + languageName(lang));
  } catch (error) {
    toast("保存失败：" + readableError(error), "error");
  }
}

async function onModeClick(event) {
  const button = event.target.closest("[data-mode]");
  if (!button || !dom.segmented.contains(button)) return;
  const mode = button.dataset.mode;
  if (mode === currentMode()) return;
  try {
    if (state.page.reachable && state.tab) {
      try {
        await chrome.tabs.sendMessage(state.tab.id, { type: CMD.TOGGLE_MODE });
      } catch (_) {
        // 页面未注入脚本时忽略
      }
    }
    state.settings = await patchSettings({ translate: { mode } });
    if (state.page.reachable) state.page.mode = mode;
    renderModeSegments();
    renderPageCard();
    toast(mode === "bilingual" ? "已切换为双语对照" : "已切换为仅译文");
  } catch (error) {
    toast("切换失败：" + readableError(error), "error");
  }
}

/* ---------- 快速翻译 ---------- */

function updateQuickState() {
  if (!dom.quickInput) return;
  const text = dom.quickInput.value;
  const length = text.length;
  dom.quickCount.textContent = formatNumber(length) + " / " + formatNumber(QUICK_MAX);
  dom.quickCount.classList.toggle("is-max", length > QUICK_MAX);
  dom.quickTranslate.disabled = state.quickBusy || !text.trim() || length > QUICK_MAX;
}

function setQuickBusy(busy, label) {
  state.quickBusy = busy;
  dom.quickSpinner.hidden = !busy;
  dom.quickBtnLabel.textContent = busy ? label || "翻译中…" : "翻译";
  dom.quickTranslate.disabled = busy || !dom.quickInput.value.trim();
}

function showQuickError(message) {
  dom.quickError.textContent = message;
  dom.quickError.hidden = false;
}

function hideQuickError() {
  dom.quickError.hidden = true;
  dom.quickError.textContent = "";
}

function renderQuickResult(text, cached) {
  dom.quickResult.hidden = false;
  dom.quickResultTag.textContent = cached ? "译文 · 缓存命中" : "译文";
  dom.quickResultText.textContent = text || "";
}

async function quickTranslate() {
  const text = dom.quickInput.value.trim();
  if (!text || state.quickBusy) return;
  if (text.length > QUICK_MAX) {
    showQuickError("文本超过 " + formatNumber(QUICK_MAX) + " 字，请分段翻译。");
    return;
  }
  hideQuickError();
  setQuickBusy(true, "翻译中…");
  try {
    const response = await sendRuntime({
      type: MSG.TRANSLATE_TEXT,
      payload: {
        text: text,
        targetLang: currentTargetLang(),
        pageUrl: state.tab ? state.tab.url : "",
      },
    });
    if (!response || !response.ok) {
      showQuickError(renderError(response));
      return;
    }
    renderQuickResult(response.text, !!response.cached);
    void loadSummary();
  } catch (error) {
    showQuickError(readableError(error));
  } finally {
    setQuickBusy(false);
    updateQuickState();
  }
}

async function copyQuickResult() {
  const text = dom.quickResultText.textContent || "";
  if (!text) return;
  try {
    await navigator.clipboard.writeText(text);
    toast("译文已复制");
    return;
  } catch (_) {
    // 回退到旧式剪贴板
  }
  const temp = document.createElement("textarea");
  temp.value = text;
  temp.setAttribute("readonly", "");
  temp.style.position = "fixed";
  temp.style.opacity = "0";
  document.body.appendChild(temp);
  temp.select();
  try {
    document.execCommand("copy");
    toast("译文已复制");
  } catch (_) {
    toast("复制失败，请手动选择文本。", "error");
  } finally {
    temp.remove();
  }
}

/* ---------- 缓存与用量 ---------- */

async function loadSummary() {
  const [cacheResponse, statsResponse] = await Promise.all([
    sendRuntime({ type: MSG.CACHE_STATS }),
    sendRuntime({ type: MSG.STATS_GET }),
  ]);

  if (cacheResponse && cacheResponse.ok) {
    dom.statCacheEntries.textContent = formatNumber(cacheResponse.entries || 0);
    dom.cacheMeta.textContent =
      formatBytes(cacheResponse.bytes || 0) + " · 上限 " + formatNumber(cacheResponse.maxEntries || 0);
  } else {
    dom.statCacheEntries.textContent = "—";
    dom.cacheMeta.textContent = "缓存不可用";
  }

  if (statsResponse && statsResponse.ok && statsResponse.stats) {
    const stats = statsResponse.stats;
    dom.statCacheHits.textContent = formatNumber(stats.cacheHits || 0);
    dom.statRequests.textContent = formatNumber(stats.requests || 0);
    dom.statTokens.textContent = formatCompact((stats.tokensIn || 0) + (stats.tokensOut || 0));
    dom.statsSince.textContent =
      "自 " + formatDate(stats.since) + " 起累计 · 已翻译 " + formatNumber(stats.segments || 0) + " 个段落";
  } else {
    dom.statCacheHits.textContent = "—";
    dom.statRequests.textContent = "—";
    dom.statTokens.textContent = "—";
    dom.statsSince.textContent = "暂时读不到用量统计。";
  }
}

/* ---------- 设置入口 ---------- */

function openOptions() {
  try {
    const result = chrome.runtime.openOptionsPage();
    if (result && typeof result.catch === "function") {
      result.catch(() => toast("无法打开设置页，请从扩展菜单进入。", "error"));
    }
  } catch (_) {
    toast("无法打开设置页，请从扩展菜单进入。", "error");
  }
}

/* ---------- 演示 ---------- */

function initDemoView() {
  dom.demoBanner.hidden = false;
  dom.demoTag.hidden = false;
  dom.quickInput.value = DEMO_QUICK_INPUT;
  dom.quickCount.textContent = formatNumber(DEMO_QUICK_INPUT.length) + " / " + formatNumber(QUICK_MAX);
  dom.quickResult.hidden = false;
  dom.quickResultTag.textContent = "译文 · 缓存命中";
  dom.quickResultText.textContent = DEMO_QUICK_TRANSLATION;
  updateQuickState();
}

/* ---------- 初始化 ---------- */

function cacheDom() {
  dom.demoBanner = $("demo-banner");
  dom.demoTag = $("demo-tag");
  dom.pageTitle = $("page-title");
  dom.pageUrl = $("page-url");
  dom.pageBadge = $("page-badge");
  dom.pageHint = $("page-hint");
  dom.toggleTranslate = $("toggle-translate");
  dom.toggleIcon = $("toggle-icon");
  dom.toggleLabel = $("toggle-label");
  dom.targetLang = $("target-lang");
  dom.segmented = document.querySelector(".segmented");
  dom.modeButtons = Array.prototype.slice.call(document.querySelectorAll(".segment[data-mode]"));
  dom.quickInput = $("quick-input");
  dom.quickCount = $("quick-count");
  dom.quickTranslate = $("quick-translate");
  dom.quickSpinner = dom.quickTranslate.querySelector(".btn-spinner");
  dom.quickBtnLabel = $("quick-btn-label");
  dom.quickResult = $("quick-result");
  dom.quickResultTag = $("quick-result-tag");
  dom.quickResultText = $("quick-result-text");
  dom.quickCopy = $("quick-copy");
  dom.quickError = $("quick-error");
  dom.statCacheEntries = $("stat-cache-entries");
  dom.statCacheHits = $("stat-cache-hits");
  dom.statRequests = $("stat-requests");
  dom.statTokens = $("stat-tokens");
  dom.cacheMeta = $("cache-meta");
  dom.statsSince = $("stats-since");
  dom.openOptions = $("open-options");
  dom.toast = $("toast");
}

function bindEvents() {
  dom.openOptions.addEventListener("click", openOptions);
  dom.toggleTranslate.addEventListener("click", () => void toggleTranslate());
  dom.targetLang.addEventListener("change", () => void onTargetLangChange());
  dom.segmented.addEventListener("click", (event) => void onModeClick(event));
  dom.quickInput.addEventListener("input", updateQuickState);
  dom.quickInput.addEventListener("keydown", (event) => {
    if ((event.ctrlKey || event.metaKey) && event.key === "Enter") {
      event.preventDefault();
      void quickTranslate();
    }
  });
  dom.quickTranslate.addEventListener("click", () => void quickTranslate());
  dom.quickCopy.addEventListener("click", () => void copyQuickResult());

  if (chrome.storage && chrome.storage.onChanged) {
    chrome.storage.onChanged.addListener((changes, areaName) => {
      if (areaName !== "local" || !changes || !changes.settings || !changes.settings.newValue) return;
      state.settings = changes.settings.newValue;
      applyTheme(state.settings.ui && state.settings.ui.theme);
      renderSettingsControls();
      if (state.page.reachable && !state.page.translated) renderPageCard();
    });
  }
}

async function init() {
  cacheDom();
  bindEvents();
  renderLanguageOptions();

  try {
    state.settings = await getSettings();
  } catch (error) {
    state.settings = null;
    toast("读取设置失败：" + readableError(error), "error");
  }

  if (state.settings) {
    applyTheme(state.settings.ui && state.settings.ui.theme);
    renderSettingsControls();
    if (state.settings.ui && state.settings.ui.theme) applyTheme(state.settings.ui.theme);
  }

  if (DEMO) initDemoView();

  await loadPageState();
  renderModeSegments();
  renderPageCard();
  updateQuickState();
  void loadSummary();
  runSelfTest();
}

if (document.readyState === "loading") {
  document.addEventListener("DOMContentLoaded", () => void init(), { once: true });
} else {
  void init();
}
