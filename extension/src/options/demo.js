/**
 * options 演示模式（?demo=1）。
 *
 * 用内存 mock 接管 chrome.storage / chrome.runtime / chrome.tabs / chrome.commands，
 * 并注入一组完整的演示设置，便于无头浏览器静态评审。
 * 真实扩展环境下 DEMO 为 false，本模块不产生任何副作用。
 *
 * 另提供 ?selftest=1：渲染完成后把布局自检结果写入 <pre id="ait-selftest">。
 */
import { DEFAULT_SETTINGS, deepMerge } from "../shared/config.js";
import { MSG } from "../shared/messages.js";

const params = new URLSearchParams(location.search);
export const DEMO = params.get("demo") === "1";
export const SELFTEST = params.get("selftest") === "1";

const DAY = 24 * 60 * 60 * 1000;

/** 演示：预置的测试连接结果 */
export const DEMO_TEST_RESULT = {
  ok: true,
  latencyMs: 486,
  model: "deepseek-chat",
  sample: "正常",
};

/** 演示：可拉取的模型列表 */
export const DEMO_MODELS = [
  "deepseek-chat",
  "deepseek-reasoner",
  "gpt-4o-mini",
  "gpt-4o",
  "qwen2.5:7b",
  "llama3.1:8b",
  "glm-4-flash",
  "qwen-plus",
];

/** 演示：缓存概况 */
const DEMO_CACHE = { entries: 1284, bytes: 3245400, maxEntries: 2000 };

/** 演示：用量统计 */
const DEMO_STATS = {
  requests: 128,
  segments: 2146,
  cacheHits: 379,
  tokensIn: 183420,
  tokensOut: 96410,
  since: Date.now() - 7 * DAY,
};

/** 演示：完整设置 */
const DEMO_SETTINGS = deepMerge(DEFAULT_SETTINGS, {
  provider: {
    baseUrl: "https://api.deepseek.com/v1",
    apiKey: "sk-demo-2f8c1a4e6b0d",
    model: "deepseek-chat",
    temperature: 0.2,
    maxTokens: 0,
    timeoutMs: 60000,
  },
  language: { source: "auto", target: "zh-CN" },
  translate: {
    mode: "bilingual",
    concurrency: 3,
    batchSize: 8,
    autoTranslate: false,
    autoSites: ["arxiv.org", "*.github.io"],
    excludeSites: ["mail.google.com"],
    skipCode: true,
    showOriginalDefault: true,
  },
  selection: {
    enabled: true,
    autoPopup: false,
    targetLang: "",
    showOriginal: true,
    stream: true,
    maxChars: 6000,
  },
  glossary: [
    { from: "token", to: "令牌", note: "上下文长度单位" },
    { from: "embedding", to: "嵌入", note: "" },
    { from: "transformer", to: "Transformer", note: "架构名保留英文" },
    { from: "fine-tuning", to: "微调", note: "" },
  ],
  cache: { enabled: true, maxEntries: 2000, ttlDays: 30 },
  ui: { theme: "auto", locale: "zh-CN", firstRun: false, clickAction: "popup" },
});

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

/** chrome.storage.local 的最小可用 mock */
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

function createDemoChrome() {
  const store = {
    settings: clone(DEMO_SETTINGS),
    stats: clone(DEMO_STATS),
    transCache: {},
  };
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
    await delay(90);
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
      case MSG.PROVIDER_TEST: {
        await delay(420);
        if (!payload.apiKey) {
          return { ok: false, error: { code: "NO_API_KEY", message: "还没有配置 API Key，请填写后再测试。" } };
        }
        return Object.assign({ ok: true }, clone(DEMO_TEST_RESULT), {
          model: payload.model || DEMO_TEST_RESULT.model,
        });
      }
      case MSG.PROVIDER_MODELS: {
        await delay(360);
        if (!payload.apiKey) {
          return { ok: false, error: { code: "NO_API_KEY", message: "还没有配置 API Key，请填写后再拉取。" } };
        }
        return { ok: true, models: clone(DEMO_MODELS), count: DEMO_MODELS.length };
      }
      case MSG.CACHE_STATS:
        return Object.assign({ ok: true }, clone(DEMO_CACHE));
      case MSG.CACHE_CLEAR:
        return { ok: true };
      case MSG.STATS_GET:
        return { ok: true, stats: clone(store.stats) };
      case MSG.STATS_RESET:
        store.stats = { requests: 0, segments: 0, cacheHits: 0, tokensIn: 0, tokensOut: 0, since: Date.now() };
        return { ok: true, stats: clone(store.stats) };
      default:
        return { ok: false, error: { code: "INVALID_CONFIG", message: "演示模式未模拟该消息：" + type } };
    }
  }

  return {
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
    tabs: {
      create() {
        return Promise.resolve({ id: 9 });
      },
      query() {
        return Promise.resolve([]);
      },
      sendMessage() {
        return Promise.resolve({ ok: true });
      },
    },
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
      if (
        hidesOverflow &&
        el.clientWidth > 0 &&
        el.scrollWidth > el.clientWidth + 1 &&
        !el.classList.contains("allow-clip") &&
        !el.classList.contains("sr-only")
      ) {
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
