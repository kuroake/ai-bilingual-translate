/**
 * 动态注入 content scripts。
 *
 * 场景：扩展安装或重新加载之前就已经打开的标签页里没有 content script，
 * 浏览器不会补注入。此时用户点扩展图标或按快捷键，不应该被要求先刷新页面。
 *
 * 这里用 chrome.scripting 探测并注入 content 脚本；重复注入是安全的，
 * 因为每个 content 模块入口都有幂等守卫（AIT.xxx 已存在则跳过）。
 * popup 与 background 共用本模块。
 */

export const CONTENT_SCRIPT_FILES = [
  "src/content/00-core.js",
  "src/content/10-segmenter.js",
  "src/content/20-translator.js",
  "src/content/30-renderer.js",
  "src/content/40-selection.js",
  "src/content/50-observer.js",
  "src/content/90-main.js",
];

export const CONTENT_STYLE_FILES = ["src/content/content.css"];

const PROBE_RETRIES = 6;
const PROBE_INTERVAL_MS = 60;

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function hasScriptingApi() {
  try {
    return !!(chrome && chrome.scripting && chrome.tabs);
  } catch (_) {
    return false;
  }
}

/** 探测页面是否已运行本扩展的 content script（在扩展的 isolated world 中执行） */
export async function probeContentScript(tabId) {
  if (typeof tabId !== "number" || !hasScriptingApi()) return false;
  try {
    const results = await chrome.scripting.executeScript({
      target: { tabId },
      func: function probeAit() {
        const AIT = globalThis.AIT;
        if (!AIT || !AIT.ready) return false;
        // 扩展重载后旧内容脚本会残留：其 chrome 上下文已失效，需要重新注入
        if (typeof AIT.__ctxAlive === "function") {
          try {
            return AIT.__ctxAlive() === true;
          } catch (_) {
            return false;
          }
        }
        return true;
      },
    });
    const first = Array.isArray(results) ? results[0] : null;
    return !!(first && first.result === true);
  } catch (_) {
    return false;
  }
}

/**
 * 确保 content script 已注入。
 * @returns {Promise<boolean>} 页面现在是否可用（已注入 / 注入成功）
 */
export async function ensureContentScript(tabId) {
  if (typeof tabId !== "number" || !hasScriptingApi()) return false;
  if (await probeContentScript(tabId)) return true;

  try {
    await chrome.scripting.insertCSS({ target: { tabId }, files: CONTENT_STYLE_FILES });
  } catch (_) {
    // 样式注入失败不阻塞脚本：功能可用，只是译文样式可能缺失
  }

  try {
    await chrome.scripting.executeScript({ target: { tabId }, files: CONTENT_SCRIPT_FILES });
  } catch (_) {
    return false;
  }

  for (let i = 0; i < PROBE_RETRIES; i += 1) {
    if (await probeContentScript(tabId)) return true;
    await sleep(PROBE_INTERVAL_MS);
  }
  return false;
}
