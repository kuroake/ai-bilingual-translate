/**
 * popup 演示模式（?demo=1）。
 *
 * 作用：在普通网页环境里用内存 mock 接管 chrome.storage / chrome.runtime / chrome.tabs，
 * 让 popup.js 走与真实扩展完全相同的调用路径，只替换数据来源。
 * 真实扩展环境下 DEMO 为 false，本模块不产生任何副作用。
 *
 * 另提供 ?selftest=1：渲染完成后把布局自检结果写入 <pre id="ait-selftest">，
 * 供无头浏览器 --dump-dom 抓取。
 */
import { DEFAULT_SETTINGS, deepMerge } from "../shared/config.js";
import { MSG, CMD } from "../shared/messages.js";

const params = new URLSearchParams(location.search);
export const DEMO = params.get("demo") === "1";
export const SELFTEST = params.get("selftest") === "1";

/** 演示：当前页信息 */
export const DEMO_PAGE = {
  id: 7,
  title: "Attention Is All You Need",
  url: "https://arxiv.org/abs/1706.03762",
};

/** 演示：快速翻译的预填原文与译文 */
export const DEMO_QUICK_INPUT =
  "The Transformer connects its encoder and decoder through an attention mechanism, replacing recurrence with parallel attention.";
export const DEMO_QUICK_TRANSLATION =
  "Transformer 通过注意力机制连接编码器与解码器，用并行注意力取代循环结构。";

const DAY = 24 * 60 * 60 * 1000;

/** 演示：设置种子 */
const DEMO_SETTINGS = deepMerge(DEFAULT_SETTINGS, {
  provider: {
    baseUrl: "https://api.deepseek.com/v1",
    apiKey: "sk-demo-2f8c1a4e6b0d",
    model: "deepseek-chat",
  },
  language: { source: "auto", target: "zh-CN" },
  translate: { mode: "bilingual" },
  ui: { theme: "auto", locale: "zh-CN", firstRun: false },
});

/** 演示：用量统计 */
const DEMO_STATS = {
  requests: 128,
  segments: 2146,
  cacheHits: 379,
  tokensIn: 183420,
  tokensOut: 96410,
  since: Date.now() - 7 * DAY,
};

/** 演示：缓存概况（与 background 的 ait:cache.stats 响应一致） */
const DEMO_CACHE = { entries: 1284, bytes: 3245400, maxEntries: 2000 };

const runtimeErrors = [];

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function clone(value) {
  return value === undefined ? undefined : JSON.parse(JSON.stringify(value));
}

function describe(el) {
  const tag = el.tagName ? el.tagName.toLowerCase() : "node";
  const cls = el.getAttribute && el.getAttribute("class");
  const first = cls ? " " + cls.split(/\s+/).filter(Boolean)[0] : "";
  return tag + first;
}

function trackErrors() {
  window.addEventListener("error", (event) => {
    runtimeErrors.push(String((event && event.message) || "script error"));
  });
  window.addEventListener("unhandledrejection", (event) => {
    const reason = event && event.reason;
    runtimeErrors.push(String((reason && reason.message) || reason || "unhandled rejection"));
  });
}

/** chrome.storage.local 的最小可用 mock（支持 string / array / object / null 四种 keys 形式） */
function createStorageMock(store, emitChange) {
  function pick(keys) {
    if (keys === null || keys === undefined) return clone(store);
    if (typeof keys === "string") return { [keys]: clone(store[keys]) };
    if (Array.isArray(keys)) {
      const out = {};
      keys.forEach((key) => {
        if (store[key] !== undefined) out[key] = clone(store[key]);
      });
      return out;
    }
    if (typeof keys === "object") {
      const out = {};
      Object.keys(keys).forEach((key) => {
        out[key] = store[key] === undefined ? clone(keys[key]) : clone(store[key]);
      });
      return out;
    }
    return {};
  }

  return {
    local: {
      get(keys) {
        return Promise.resolve(pick(keys));
      },
      set(items) {
        const changes = {};
        Object.keys(items || {}).forEach((key) => {
          changes[key] = { oldValue: clone(store[key]), newValue: clone(items[key]) };
          store[key] = clone(items[key]);
        });
        emitChange(changes);
        return Promise.resolve();
      },
      remove(keys) {
        const list = Array.isArray(keys) ? keys : [keys];
        list.forEach((key) => {
          delete store[key];
        });
        return Promise.resolve();
      },
    },
  };
}

function createTabsMock(page) {
  return {
    query() {
      return Promise.resolve([Object.assign({ active: true, windowId: 1 }, clone(DEMO_PAGE))]);
    },
    create() {
      return Promise.resolve({ id: 8 });
    },
    sendMessage(tabId, message) {
      return (async () => {
        await delay(90);
        const type = message && message.type;
        if (type === MSG.TAB_PAGE_STATE) {
          return { ok: true, translated: page.translated, mode: page.mode };
        }
        if (type === CMD.TOGGLE_TRANSLATE) {
          page.translated = !page.translated;
          return { ok: true, translated: page.translated };
        }
        if (type === CMD.TOGGLE_MODE) {
          page.mode = page.mode === "bilingual" ? "translation-only" : "bilingual";
          return { ok: true, mode: page.mode };
        }
        if (type === CMD.SET_TARGET_LANG) {
          return { ok: true, lang: message.lang };
        }
        return { ok: true };
      })();
    },
  };
}

function createDemoChrome() {
  const store = {
    settings: clone(DEMO_SETTINGS),
    stats: clone(DEMO_STATS),
    transCache: {},
  };
  const page = { translated: true, mode: "bilingual" };
  const changeListeners = [];

  function emitChange(changes) {
    if (!Object.keys(changes).length) return;
    changeListeners.forEach((fn) => {
      try {
        fn(changes, "local");
      } catch (_) {
        // 演示环境忽略监听器错误
      }
    });
  }

  async function handleRuntimeMessage(message) {
    const type = message && message.type;
    const payload = (message && message.payload) || {};
    await delay(80);
    switch (type) {
      case MSG.SETTINGS_GET:
        return { ok: true, settings: clone(store.settings) };
      case MSG.SETTINGS_PATCH: {
        store.settings = deepMerge(store.settings, message.patch || {});
        emitChange({ settings: { newValue: clone(store.settings) } });
        return { ok: true, settings: clone(store.settings) };
      }
      case MSG.SETTINGS_RESET: {
        store.settings = deepMerge(DEFAULT_SETTINGS, {});
        emitChange({ settings: { newValue: clone(store.settings) } });
        return { ok: true, settings: clone(store.settings) };
      }
      case MSG.TRANSLATE_TEXT: {
        await delay(320);
        return {
          ok: true,
          text: DEMO_QUICK_TRANSLATION,
          cached: true,
          usage: { tokensIn: 0, tokensOut: 0 },
          excerpt: String(payload.text || "").slice(0, 40),
        };
      }
      case MSG.CACHE_STATS:
        return Object.assign({ ok: true }, clone(DEMO_CACHE));
      case MSG.STATS_GET:
        return { ok: true, stats: clone(store.stats) };
      case MSG.CACHE_CLEAR:
        return { ok: true };
      case MSG.STATS_RESET:
        store.stats = { requests: 0, segments: 0, cacheHits: 0, tokensIn: 0, tokensOut: 0, since: Date.now() };
        return { ok: true, stats: clone(store.stats) };
      case MSG.PROVIDER_TEST:
        return { ok: true, latencyMs: 486, model: payload.model || "deepseek-chat", sample: "正常" };
      case MSG.PROVIDER_MODELS:
        return { ok: true, models: ["deepseek-chat", "deepseek-reasoner"], count: 2 };
      default:
        return { ok: false, error: { code: "INVALID_CONFIG", message: "演示模式未模拟该消息：" + type } };
    }
  }

  const chromeMock = {
    storage: {
      local: createStorageMock(store, emitChange).local,
      onChanged: {
        addListener(fn) {
          if (typeof fn === "function") changeListeners.push(fn);
        },
        removeListener(fn) {
          const index = changeListeners.indexOf(fn);
          if (index >= 0) changeListeners.splice(index, 1);
        },
      },
    },
    runtime: {
      id: "ait-demo",
      lastError: undefined,
      getManifest() {
        return { name: "AI 双语翻译", version: "1.1.0" };
      },
      sendMessage(message, callback) {
        const promise = handleRuntimeMessage(message);
        if (typeof callback === "function") {
          promise.then((response) => callback(response));
          return undefined;
        }
        return promise;
      },
      openOptionsPage() {
        return Promise.resolve();
      },
      onMessage: { addListener() {}, removeListener() {} },
    },
    tabs: createTabsMock(page),
    commands: {
      getAll() {
        return Promise.resolve([
          { name: "toggle-translate", description: "翻译 / 还原当前页面", shortcut: "Alt+T" },
          { name: "toggle-mode", description: "切换双语 / 仅译文", shortcut: "Alt+M" },
          { name: "translate-selection", description: "翻译选中文字", shortcut: "Alt+S" },
        ]);
      },
    },
  };
  return chromeMock;
}

if (DEMO) {
  try {
    Object.defineProperty(globalThis, "chrome", {
      value: createDemoChrome(),
      configurable: true,
      writable: true,
    });
  } catch (_) {
    globalThis.chrome = createDemoChrome();
  }
  document.documentElement.classList.add("is-demo");
  trackErrors();
}

/**
 * 布局自检：横向溢出、文本裁切、竖排文字、脚本错误。
 * 结果同时写入隐藏 <pre id="ait-selftest"> 与 console.info，便于 --dump-dom 抓取。
 */
export function runSelfTest() {
  if (!SELFTEST) return;
  setTimeout(() => {
    const viewport = { width: window.innerWidth, height: window.innerHeight };
    const root = document.documentElement;
    const horizontalOverflow = [];
    const clipped = [];
    const verticalText = [];

    document.querySelectorAll("body *").forEach((el) => {
      if (!(el instanceof Element)) return;
      const rect = el.getBoundingClientRect();
      if (rect.width > 0 && rect.height > 0 && (rect.right > viewport.width + 1 || rect.left < -1)) {
        horizontalOverflow.push({ el: describe(el), left: Math.round(rect.left), right: Math.round(rect.right) });
      }
      const style = window.getComputedStyle(el);
      if (style.writingMode && style.writingMode !== "horizontal-tb") verticalText.push(describe(el));
      const hidesOverflow = style.overflowX === "hidden" || style.overflow === "hidden";
      if (hidesOverflow && el.clientWidth > 0 && el.scrollWidth > el.clientWidth + 1 && !el.classList.contains("allow-clip")) {
        clipped.push({ el: describe(el), scrollWidth: el.scrollWidth, clientWidth: el.clientWidth });
      }
    });

    const result = {
      demo: true,
      viewport,
      documentOverflowX: root.scrollWidth > root.clientWidth + 1,
      scrollWidth: root.scrollWidth,
      clientWidth: root.clientWidth,
      horizontalOverflow: horizontalOverflow.slice(0, 12),
      clippedText: clipped.slice(0, 12),
      verticalText: verticalText.slice(0, 12),
      errors: runtimeErrors.slice(0, 12),
    };
    result.pass =
      !result.documentOverflowX &&
      horizontalOverflow.length === 0 &&
      clipped.length === 0 &&
      verticalText.length === 0 &&
      runtimeErrors.length === 0;

    const pre = document.createElement("pre");
    pre.id = "ait-selftest";
    pre.hidden = true;
    pre.textContent = JSON.stringify(result);
    document.body.appendChild(pre);
    console.info("[AIT selftest] " + JSON.stringify(result));
  }, 1600);
}
