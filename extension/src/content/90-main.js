/**
 * 90-main.js —— content 侧入口。
 *
 * 职责（docs/ARCHITECTURE.md §6）：
 * - 读取设置并应用语言 / 模式；
 * - 初始化划词翻译（AIT.selection）；
 * - 注册 chrome.runtime.onMessage，处理 ait:cmd.*；
 * - 监听 chrome.storage.onChanged；
 * - 按站点规则判断是否自动翻译；
 * - 快捷键兜底（background 的 chrome.commands 之外的兜底路径）；
 * - 暴露 window.__AIT_DEBUG__ = AIT。
 *
 * 依赖：00-core.js、10-segmenter.js、20-translator.js、30-renderer.js、40-selection.js（可选）、50-observer.js。
 */
(() => {
  "use strict";
  const AIT = (window.AIT = window.AIT || {});
  const util = AIT.util;
  if (!util) return;
  // 幂等守卫：popup / background 可能对同一页面重复动态注入，已初始化则直接跳过
  if (AIT.main) return;

  /**
   * 同一条命令在极短时间内被「background 命令 + 页面快捷键兜底」触发两次时去重。
   * 350ms 足以覆盖两条路径同帧到达的情况，又不会误伤用户手动快速切换。
   */
  const DUPLICATE_COMMAND_MS = 350;
  /** 自动翻译延迟，给首屏渲染与字体加载留时间 */
  const AUTO_TRANSLATE_DELAY_MS = 400;

  const CMD = {
    TOGGLE_TRANSLATE: "ait:cmd.toggleTranslate",
    TOGGLE_MODE: "ait:cmd.toggleMode",
    TRANSLATE_SELECTION: "ait:cmd.translateSelection",
    SET_TARGET_LANG: "ait:cmd.setTargetLang",
    SETTINGS_CHANGED: "ait:cmd.settingsChanged",
  };

  let initialized = false;
  /** 每种命令最近一次执行时间：type -> timestamp */
  const lastCommandAt = new Map();

  // ---------------------------------------------------------------- 站点规则

  /** 域名规则匹配：example.com / *.example.com / localhost，忽略端口与协议 */
  function matchSiteRule(rules, host) {
    if (!Array.isArray(rules)) return false;
    const target = String(host || "").toLowerCase().replace(/:\d+$/, "");
    if (!target) return false;
    for (let i = 0; i < rules.length; i += 1) {
      let rule = String(rules[i] || "").trim().toLowerCase();
      if (!rule) continue;
      rule = rule.replace(/^https?:\/\//, "").replace(/\/.*$/, "").replace(/:\d+$/, "");
      if (!rule) continue;
      if (rule === "*") return true;
      if (rule.indexOf("*.") === 0) {
        const base = rule.slice(2);
        if (target === base || target.endsWith("." + base)) return true;
      } else if (target === rule || target.endsWith("." + rule)) {
        return true;
      }
    }
    return false;
  }

  /** 站点自动翻译：excludeSites > autoSites > 全局 autoTranslate */
  function shouldAutoTranslate(settings) {
    if (!settings || !settings.translate) return false;
    const translate = settings.translate;
    const host = location.hostname || "";
    if (matchSiteRule(translate.excludeSites, host)) return false;
    if (matchSiteRule(translate.autoSites, host)) return true;
    return !!translate.autoTranslate;
  }

  // ---------------------------------------------------------------- 设置应用

  function safeCall(target, method, args) {
    if (!target || typeof target[method] !== "function") return undefined;
    try {
      return target[method].apply(target, args || []);
    } catch (error) {
      AIT.log(method + " failed", error);
      return undefined;
    }
  }

  /**
   * 应用完整设置到各模块。目标语言变化且页面已翻译时自动按新语言重翻。
   */
  function applySettingsEverywhere(settings) {
    if (!settings) return;
    const previous = AIT.state.settings;
    AIT.applySettings(settings);
    safeCall(AIT.translator, "applySettings", [settings]);
    if (AIT.renderer) AIT.renderer.applyMode(AIT.state.mode);
    if (AIT.selection) safeCall(AIT.selection, "applySettings", [settings]);
    const previousTarget = previous && previous.language ? previous.language.target : null;
    const nextTarget = settings.language ? settings.language.target : null;
    if (previousTarget && nextTarget && previousTarget !== nextTarget && AIT.translator && AIT.translator.isTranslated()) {
      void AIT.translator.translatePage({ force: true });
    }
  }

  // ---------------------------------------------------------------- 页面状态

  function pageState() {
    const translated = AIT.translator ? AIT.translator.isTranslated() : !!AIT.state.translated;
    const progress = AIT.translator ? AIT.translator.getProgress() : AIT.state.progress;
    return {
      ok: true,
      translated: !!translated,
      translating: !!AIT.state.translating,
      mode: AIT.state.mode,
      progress: progress,
      url: location.href,
    };
  }

  // ---------------------------------------------------------------- 命令

  function toggleTranslate() {
    if (!AIT.translator) return;
    if (AIT.state.translating || AIT.translator.isTranslated()) {
      void AIT.translator.restore();
      return;
    }
    void AIT.translator.translatePage();
  }

  function toggleMode() {
    const next = AIT.state.mode === "translation-only" ? "bilingual" : "translation-only";
    AIT.state.mode = next;
    if (AIT.renderer) AIT.renderer.applyMode(next);
    if (AIT.state.settings) {
      const settings = util.deepMerge(AIT.state.settings, { translate: { mode: next } });
      AIT.state.settings = settings;
      if (AIT.selection) safeCall(AIT.selection, "applySettings", [settings]);
    }
    void AIT.runtimeSend({ type: "ait:settings.patch", payload: { patch: { translate: { mode: next } } } });
  }

  function translateSelection() {
    if (!AIT.selection) return;
    const text = util.getSelectionText().trim();
    if (!text) return;
    const rect = util.rectOfSelection();
    if (typeof AIT.selection.open === "function") {
      AIT.selection.open(text, rect || undefined);
      return;
    }
    safeCall(AIT.selection, "translateSelection", [text, rect]);
  }

  function setTargetLang(message) {
    const payload = (message && message.payload) || {};
    const lang = (message && message.lang) || payload.lang || "";
    if (!lang) return;
    const settings = util.deepMerge(AIT.state.settings || {}, { language: { target: lang } });
    applySettingsEverywhere(settings);
    void AIT.runtimeSend({ type: "ait:settings.patch", payload: { patch: { language: { target: lang } } } });
  }

  function handleCommand(type, message) {
    switch (type) {
      case CMD.TOGGLE_TRANSLATE:
        toggleTranslate();
        return;
      case CMD.TOGGLE_MODE:
        toggleMode();
        return;
      case CMD.TRANSLATE_SELECTION:
        translateSelection();
        return;
      case CMD.SET_TARGET_LANG:
        setTargetLang(message);
        return;
      case CMD.SETTINGS_CHANGED:
        applySettingsEverywhere(message && message.settings);
        return;
      default:
        AIT.log("unknown command", type);
    }
  }

  /**
   * 统一命令入口：background 消息与页面快捷键兜底都从这里走。
   * 按键可能同时触发 chrome.commands（background 转发 ait:cmd.*）与页面 keydown 兜底，
   * 这里按「命令类型 + 350ms」去重，保证一次按键只执行一次 toggle。
   */
  function dispatchCommand(type, message) {
    const now = Date.now();
    const previous = lastCommandAt.get(type) || 0;
    if (now - previous < DUPLICATE_COMMAND_MS) {
      AIT.log("duplicate command ignored", type, now - previous);
      return;
    }
    lastCommandAt.set(type, now);
    try {
      handleCommand(type, message || {});
    } catch (error) {
      AIT.log("command failed", type, error);
    }
  }

  // ---------------------------------------------------------------- 监听器

  function onRuntimeMessage(message, sender, sendResponse) {
    if (!message || typeof message.type !== "string") return false;
    if (message.type === "ait:tab.pageState") {
      if (typeof sendResponse === "function") sendResponse(pageState());
      return false;
    }
    if (message.type.indexOf("ait:cmd.") !== 0) return false;
    dispatchCommand(message.type, message);
    if (typeof sendResponse === "function") sendResponse({ ok: true, translated: AIT.state.translated, mode: AIT.state.mode });
    return false;
  }

  function bindMessageListener() {
    try {
      if (typeof chrome !== "undefined" && chrome.runtime && chrome.runtime.onMessage) {
        chrome.runtime.onMessage.addListener(onRuntimeMessage);
      }
    } catch (error) {
      AIT.log("bind message listener failed", error);
    }
  }

  function bindStorageListener() {
    try {
      if (typeof chrome === "undefined" || !chrome.storage || !chrome.storage.onChanged) return;
      chrome.storage.onChanged.addListener((changes, areaName) => {
        if (areaName !== "local" || !changes || !changes.settings) return;
        applySettingsEverywhere(changes.settings.newValue);
      });
    } catch (error) {
      AIT.log("bind storage listener failed", error);
    }
  }

  /**
   * 快捷键兜底：manifest.commands 已注册同样的 Alt+T / Alt+M / Alt+S，正常由 background
   * 转发 ait:cmd.*；这里只在浏览器没有吞掉按键（页面仍收到 keydown）时补一条路径。
   * 两条路径同帧到达时由 dispatchCommand 的 350ms 去重保证只执行一次。
   */
  function bindHotkeys() {
    document.addEventListener(
      "keydown",
      (event) => {
        if (!event.altKey || event.ctrlKey || event.metaKey || event.shiftKey) return;
        if (event.isComposing) return;
        if (util.isEditable(event.target)) return;
        const code = event.code || "";
        const keys = { t: "KeyT", m: "KeyM", s: "KeyS" };
        const pressed = code || keys[String(event.key || "").toLowerCase()] || "";
        const map = {
          KeyT: CMD.TOGGLE_TRANSLATE,
          KeyM: CMD.TOGGLE_MODE,
          KeyS: CMD.TRANSLATE_SELECTION,
        };
        const type = map[pressed];
        if (!type) return;
        event.preventDefault();
        dispatchCommand(type, {});
      },
      true
    );
  }

  function initSelection() {
    if (!AIT.selection) return;
    safeCall(AIT.selection, "init", []);
  }

  function maybeAutoTranslate(settings) {
    if (!shouldAutoTranslate(settings)) return;
    if (location.protocol === "chrome:" || location.protocol === "edge:" || location.protocol === "about:") return;
    setTimeout(() => {
      if (!AIT.translator) return;
      if (AIT.state.translating || AIT.translator.isTranslated()) return;
      void AIT.translator.translatePage();
    }, AUTO_TRANSLATE_DELAY_MS);
  }

  // ---------------------------------------------------------------- 初始化

  async function init() {
    if (initialized) return;
    initialized = true;
    window.__AIT_DEBUG__ = AIT;
    AIT.state.pageUrl = location.href;

    // 先注册监听，避免 popup 在设置读取期间发消息无人应答
    bindMessageListener();
    bindStorageListener();
    bindHotkeys();
    initSelection();

    let settings = null;
    try {
      settings = await AIT.loadSettings();
    } catch (error) {
      AIT.log("load settings failed", error);
    }
    if (settings) {
      applySettingsEverywhere(settings);
    } else if (AIT.translator) {
      safeCall(AIT.translator, "applySettings", [AIT.state.settings]);
    }
    maybeAutoTranslate(settings);
    AIT.log("main ready", AIT.version);
  }

  AIT.main = {
    init: init,
    pageState: pageState,
    dispatchCommand: dispatchCommand,
  };

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", () => void init(), { once: true });
  } else {
    void init();
  }
})();
