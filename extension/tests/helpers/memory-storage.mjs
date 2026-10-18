/**
 * 内存版 chrome.storage.local，供 node 单元测试使用。
 * 读写都做 JSON 深拷贝，模拟真实 storage 的序列化 / 反序列化行为，
 * 这样缓存等模块如果直接改动取出的对象，测试能暴露问题。
 */

/**
 * @param {Record<string, unknown>} [initial] 初始数据
 * @returns {{ map: Map<string, unknown>, local: object, stats: object, snapshot: () => object }}
 */
export function createMemoryStorage(initial) {
  const map = new Map();
  const stats = { reads: 0, writes: 0, removes: 0, clears: 0 };
  if (initial && typeof initial === "object") {
    for (const key of Object.keys(initial)) map.set(key, clone(initial[key]));
  }

  function keysOf(query) {
    if (query === null || query === undefined) return Array.from(map.keys());
    if (typeof query === "string") return [query];
    if (Array.isArray(query)) return query.map(String);
    if (typeof query === "object") return Object.keys(query);
    return [];
  }

  const local = {
    async get(query) {
      stats.reads += 1;
      const out = {};
      if (query && typeof query === "object" && !Array.isArray(query)) {
        for (const key of Object.keys(query)) {
          out[key] = map.has(key) ? clone(map.get(key)) : clone(query[key]);
        }
        return out;
      }
      for (const key of keysOf(query)) {
        if (map.has(key)) out[key] = clone(map.get(key));
      }
      return out;
    },
    async set(items) {
      stats.writes += 1;
      for (const key of Object.keys(items || {})) map.set(key, clone(items[key]));
    },
    async remove(query) {
      stats.removes += 1;
      for (const key of keysOf(query)) map.delete(key);
    },
    async clear() {
      stats.clears += 1;
      map.clear();
    },
  };

  return {
    map,
    local,
    stats,
    snapshot() {
      return clone(Object.fromEntries(map));
    },
  };
}

/** 把内存 storage 挂到全局 chrome 上（动态 import 前调用） */
export function installChrome(storage) {
  const local = storage && storage.local ? storage.local : storage;
  globalThis.chrome = {
    storage: { local },
    runtime: { id: "test-extension", lastError: null, sendMessage() {} },
  };
  return globalThis.chrome;
}

/** 清理全局 chrome，避免影响其他用例 */
export function uninstallChrome() {
  delete globalThis.chrome;
}

function clone(value) {
  if (value === undefined) return undefined;
  return JSON.parse(JSON.stringify(value));
}
