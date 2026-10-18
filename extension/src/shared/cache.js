/**
 * 本地翻译缓存（内存 LRU + chrome.storage.local 持久化）。
 * 只应在 background 中使用，避免多上下文并发写。
 */
import { CACHE_KEY, PROMPT_VERSION } from "./config.js";
import { storageGet, storageSet } from "./storage.js";

const store = new Map();
let loaded = false;
let loading = null;
let dirty = false;
let flushTimer = null;

function normalizeText(text) {
  return String(text || "").replace(/\s+/g, " ").trim();
}

/** FNV-1a 32 位，输出 8 位十六进制 */
function fnv1a(text) {
  let hash = 0x811c9dc5;
  for (let i = 0; i < text.length; i += 1) {
    hash ^= text.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash.toString(16).padStart(8, "0");
}

export function buildCacheKey(settings, targetLang, text) {
  const provider = (settings && settings.provider) || {};
  const raw = [
    provider.baseUrl || "",
    provider.model || "",
    targetLang || "",
    String(PROMPT_VERSION),
    normalizeText(text),
  ].join("|");
  return fnv1a(raw);
}

export async function ensureCacheLoaded() {
  if (loaded) return;
  if (loading) return loading;
  loading = (async () => {
    try {
      const data = await storageGet(CACHE_KEY);
      const raw = data[CACHE_KEY];
      if (raw && typeof raw === "object") {
        for (const key of Object.keys(raw)) {
          const entry = raw[key];
          if (entry && typeof entry.t === "string" && typeof entry.ts === "number") {
            store.set(key, entry);
          }
        }
      }
    } catch (_) {
      // 缓存损坏时静默重建
    }
    loaded = true;
    loading = null;
  })();
  return loading;
}

function ttlMs(settings) {
  const days = Number(settings && settings.cache && settings.cache.ttlDays);
  return days > 0 ? days * 24 * 60 * 60 * 1000 : 0;
}

export async function cacheGet(settings, targetLang, text) {
  if (!(settings && settings.cache && settings.cache.enabled)) return null;
  await ensureCacheLoaded();
  const key = buildCacheKey(settings, targetLang, text);
  const entry = store.get(key);
  if (!entry) return null;
  const ttl = ttlMs(settings);
  if (ttl > 0 && Date.now() - entry.ts > ttl) {
    store.delete(key);
    dirty = true;
    return null;
  }
  store.delete(key);
  store.set(key, entry);
  return entry.t;
}

export async function cacheSet(settings, targetLang, text, translation) {
  if (!(settings && settings.cache && settings.cache.enabled)) return;
  const value = String(translation || "").trim();
  if (!value) return;
  await ensureCacheLoaded();
  const key = buildCacheKey(settings, targetLang, text);
  store.set(key, { t: value, ts: Date.now() });
  prune(settings);
  dirty = true;
  scheduleFlush();
}

function prune(settings) {
  const max = Math.max(50, Number((settings && settings.cache && settings.cache.maxEntries) || 2000));
  while (store.size > max) {
    const oldest = store.keys().next();
    if (oldest.done) break;
    store.delete(oldest.value);
  }
}

function scheduleFlush() {
  if (flushTimer) return;
  flushTimer = setTimeout(() => {
    flushTimer = null;
    void flushCache();
  }, 2500);
}

export async function flushCache() {
  if (!dirty) return;
  dirty = false;
  const plain = {};
  for (const [key, entry] of store.entries()) plain[key] = entry;
  try {
    await storageSet({ [CACHE_KEY]: plain });
  } catch (_) {
    dirty = true;
  }
}

export async function cacheStats(settings) {
  await ensureCacheLoaded();
  let bytes = 0;
  try {
    bytes = JSON.stringify(Object.fromEntries(store.entries())).length;
  } catch (_) {
    bytes = 0;
  }
  return {
    entries: store.size,
    bytes,
    maxEntries: Math.max(50, Number((settings && settings.cache && settings.cache.maxEntries) || 2000)),
  };
}

export async function cacheClear() {
  store.clear();
  loaded = true;
  dirty = false;
  await storageSet({ [CACHE_KEY]: {} });
}
