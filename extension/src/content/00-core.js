/**
 * AIT 内容脚本根命名空间与通用工具。
 * 必须第一个注入。其余模块只能挂到 window.AIT 上，不得覆盖此文件导出的工具。
 */
(() => {
  "use strict";
  let AIT = (window.AIT = window.AIT || {});
  if (AIT.version) {
    // 已注入过：多数情况直接复用。但扩展重新加载后，旧内容脚本的 chrome 上下文会失效，
    // 此时必须在同一个 isolated world 里重建命名空间，否则动态注入的脚本会全部被幂等守卫跳过。
    let alive = true;
    try {
      alive = !!(typeof chrome !== "undefined" && chrome.runtime && chrome.runtime.id);
    } catch (_) {
      alive = false;
    }
    if (alive && typeof AIT.__ctxAlive === "function") {
      try {
        alive = AIT.__ctxAlive() === true;
      } catch (_) {
        alive = false;
      }
    }
    if (alive) return;
    AIT = window.AIT = {};
  }

  AIT.version = "1.1.0";
  AIT.debug = false;

  AIT.state = AIT.state || {
    settings: null,
    translated: false,
    translating: false,
    mode: "bilingual",
    pageUrl: location.href,
    segments: [],
    progress: { done: 0, total: 0, failed: 0 },
  };

  const LANG_LABELS = {
    "zh-CN": "简体中文",
    "zh-TW": "繁體中文",
    en: "English",
    ja: "日本語",
    ko: "한국어",
    fr: "Français",
    de: "Deutsch",
    es: "Español",
    ru: "Русский",
    pt: "Português",
    it: "Italiano",
    ar: "العربية",
    vi: "Tiếng Việt",
    th: "ไทย",
  };

  function isPlainObject(value) {
    return !!value && typeof value === "object" && !Array.isArray(value);
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

  function deepMerge(base, patch) {
    if (patch === undefined) return cloneValue(base);
    if (Array.isArray(base) || Array.isArray(patch)) return cloneValue(patch);
    if (!isPlainObject(base) || !isPlainObject(patch)) return cloneValue(patch);
    const out = {};
    for (const key of Object.keys(base)) out[key] = cloneValue(base[key]);
    for (const key of Object.keys(patch)) {
      if (patch[key] === undefined) continue;
      out[key] = out[key] === undefined ? cloneValue(patch[key]) : deepMerge(out[key], patch[key]);
    }
    return out;
  }

  const util = {};

  util.isPlainObject = isPlainObject;
  util.cloneValue = cloneValue;
  util.deepMerge = deepMerge;

  util.qs = function qs(selector, root) {
    return (root || document).querySelector(selector);
  };

  util.qsa = function qsa(selector, root) {
    return Array.prototype.slice.call((root || document).querySelectorAll(selector));
  };

  util.on = function on(target, event, handler, options) {
    if (!target) return () => {};
    target.addEventListener(event, handler, options);
    return () => target.removeEventListener(event, handler, options);
  };

  util.once = function once(fn) {
    let called = false;
    return function wrapped() {
      if (called) return undefined;
      called = true;
      return fn.apply(this, arguments);
    };
  };

  util.debounce = function debounce(fn, wait) {
    let timer = null;
    return function debounced() {
      const args = arguments;
      const self = this;
      if (timer) clearTimeout(timer);
      timer = setTimeout(() => {
        timer = null;
        fn.apply(self, args);
      }, wait);
    };
  };

  util.throttle = function throttle(fn, wait) {
    let last = 0;
    let timer = null;
    return function throttled() {
      const args = arguments;
      const self = this;
      const now = Date.now();
      const remain = wait - (now - last);
      if (remain <= 0) {
        if (timer) {
          clearTimeout(timer);
          timer = null;
        }
        last = now;
        fn.apply(self, args);
      } else if (!timer) {
        timer = setTimeout(() => {
          last = Date.now();
          timer = null;
          fn.apply(self, args);
        }, remain);
      }
    };
  };

  util.escapeHtml = function escapeHtml(text) {
    return String(text || "")
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;")
      .replace(/'/g, "&#39;");
  };

  /** FNV-1a 32 位，返回 8 位 hex */
  util.hash = function hash(text) {
    const value = String(text || "");
    let result = 0x811c9dc5;
    for (let i = 0; i < value.length; i += 1) {
      result ^= value.charCodeAt(i);
      result = Math.imul(result, 0x01000193) >>> 0;
    }
    return result.toString(16).padStart(8, "0");
  };

  util.uid = function uid(prefix) {
    return (prefix || "ait") + "-" + Math.random().toString(36).slice(2, 10);
  };

  util.isCJK = function isCJK(text) {
    return /[\u3400-\u9fff\u3040-\u30ff\uac00-\ud7af]/.test(String(text || ""));
  };

  util.normalizeText = function normalizeText(text) {
    return String(text || "").replace(/\s+/g, " ").trim();
  };

  util.looksTranslated = function looksTranslated(text) {
    const value = String(text || "").trim();
    if (!value) return true;
    if (/^[\d\s.,%+\-/:=()（）\[\]{}"'“”‘’#&*·…—–]+$/.test(value)) return true;
    if (/^(https?:\/\/|www\.)\S+$/i.test(value)) return true;
    return false;
  };

  /** 文本是否看起来已经是目标语言 */
  util.looksLikeTargetLanguage = function looksLikeTargetLanguage(text, targetLang) {
    const value = String(text || "");
    const code = String(targetLang || "").toLowerCase();
    if (!value.trim()) return true;
    const cjk = (value.match(/[\u3400-\u9fff]/g) || []).length;
    const kana = (value.match(/[\u3040-\u30ff]/g) || []).length;
    const hangul = (value.match(/[\uac00-\ud7af]/g) || []).length;
    const cyrillic = (value.match(/[\u0400-\u04ff]/g) || []).length;
    const latin = (value.match(/[A-Za-z]/g) || []).length;
    const visible = value.replace(/\s/g, "").length || 1;
    const letters = cjk + kana + hangul + cyrillic + latin;
    if (letters / visible < 0.2) return true;
    if (code.indexOf("zh") === 0) return (cjk + kana) / visible > 0.55;
    if (code === "ja") return (kana + cjk) / visible > 0.4;
    if (code === "ko") return hangul / visible > 0.4;
    if (code === "ru") return cyrillic / visible > 0.4;
    return latin / visible > 0.55;
  };

  util.isVisible = function isVisible(el) {
    if (!el || !el.isConnected) return false;
    if (el.closest("[hidden]")) return false;
    let node = el;
    while (node && node.nodeType === 1) {
      const style = window.getComputedStyle(node);
      if (style.display === "none" || style.visibility === "hidden" || style.opacity === "0") return false;
      node = node.parentElement;
    }
    const rect = el.getBoundingClientRect();
    return rect.width > 0 && rect.height > 0;
  };

  util.isInViewport = function isInViewport(el, margin) {
    if (!el) return false;
    const rect = el.getBoundingClientRect();
    const gap = typeof margin === "number" ? margin : 200;
    return rect.bottom >= -gap && rect.top <= window.innerHeight + gap;
  };

  util.isEditable = function isEditable(el) {
    if (!el) return false;
    const tag = (el.tagName || "").toUpperCase();
    if (tag === "TEXTAREA" || tag === "INPUT" || tag === "SELECT") return true;
    return !!el.closest("[contenteditable=''], [contenteditable='true']");
  };

  util.closestTag = function closestTag(el, tagSet) {
    const set = tagSet || new Set();
    let node = el;
    while (node && node.nodeType === 1) {
      if (set.has(node.tagName)) return node;
      node = node.parentElement;
    }
    return null;
  };

  util.sleep = function sleep(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
  };

  util.backoff = function backoff(attempt, base) {
    const wait = (base || 800) * Math.pow(2, Math.max(0, attempt - 1));
    return Math.min(wait, 15000) + Math.floor(Math.random() * 250);
  };

  util.langLabel = function langLabel(code) {
    return LANG_LABELS[code] || code || "目标语言";
  };

  util.getSelectionText = function getSelectionText() {
    try {
      return String(window.getSelection() ? window.getSelection().toString() : "");
    } catch (_) {
      return "";
    }
  };

  util.rectOfSelection = function rectOfSelection() {
    try {
      const selection = window.getSelection();
      if (!selection || !selection.rangeCount) return null;
      const range = selection.getRangeAt(0);
      const rects = range.getClientRects();
      if (rects && rects.length) return rects[rects.length - 1];
      const rect = range.getBoundingClientRect();
      return rect && rect.width ? rect : null;
    } catch (_) {
      return null;
    }
  };

  AIT.util = util;

  AIT.log = function log() {
    if (!AIT.debug) return;
    const args = Array.prototype.slice.call(arguments);
    try {
      console.log.apply(console, ["%c[AIT]", "color:#C2410C;font-weight:600"].concat(args));
    } catch (_) {}
  };

  const listeners = new Map();
  AIT.bus = {
    on(type, handler) {
      if (!type || typeof handler !== "function") return () => {};
      if (!listeners.has(type)) listeners.set(type, []);
      listeners.get(type).push(handler);
      return () => AIT.bus.off(type, handler);
    },
    off(type, handler) {
      const arr = listeners.get(type);
      if (!arr) return;
      const index = arr.indexOf(handler);
      if (index >= 0) arr.splice(index, 1);
    },
    emit(type, payload) {
      const arr = listeners.get(type);
      if (!arr || !arr.length) return;
      arr.slice().forEach((handler) => {
        try {
          handler(payload);
        } catch (error) {
          AIT.log("bus handler error", type, error);
        }
      });
    },
  };

  /**
   * 向 background 发消息；永不 reject。
   */
  AIT.runtimeSend = function runtimeSend(message) {
    return new Promise((resolve) => {
      let settled = false;
      const done = (value) => {
        if (settled) return;
        settled = true;
        resolve(value);
      };
      try {
        chrome.runtime.sendMessage(message, (response) => {
          const lastError = chrome.runtime.lastError;
          if (lastError) {
            done({ ok: false, error: { code: "INTERNAL", message: lastError.message || "扩展后台未响应" } });
            return;
          }
          done(response || { ok: false, error: { code: "INTERNAL", message: "扩展后台未响应" } });
        });
      } catch (error) {
        done({ ok: false, error: { code: "INTERNAL", message: (error && error.message) || "消息发送失败" } });
      }
    });
  };

  /** 读取合并后的设置（后台返回完整默认值） */
  AIT.loadSettings = async function loadSettings() {
    const response = await AIT.runtimeSend({ type: "ait:settings.get" });
    if (response && response.ok && response.settings) {
      AIT.state.settings = response.settings;
      return response.settings;
    }
    return AIT.state.settings;
  };

  AIT.applySettings = function applySettings(settings) {
    if (!settings) return;
    AIT.state.settings = settings;
    AIT.state.mode = (settings.translate && settings.translate.mode) || "bilingual";
    if (AIT.bus) AIT.bus.emit("settings", settings);
  };

  // 供动态注入探测：闭包捕获本代 content script 的 chrome 上下文，
  // 扩展重载后调用会抛错或返回 false，从而触发命名空间重建
  AIT.__ctxAlive = function ctxAlive() {
    try {
      return !!(chrome.runtime && chrome.runtime.id);
    } catch (_) {
      return false;
    }
  };

  AIT.ready = true;
  AIT.log("core ready", AIT.version);
})();
