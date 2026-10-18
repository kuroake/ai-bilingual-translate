/**
 * shared/cache.js 单元测试。
 * chrome.storage.local 用内存 mock（helpers/memory-storage.mjs），覆盖：
 * 缓存键规范化、命中/未命中、TTL 过期、LRU 淘汰、禁用开关、持久化恢复、损坏兜底。
 *
 * 注意：cache.js 内部持有模块级 store，因此每个用例都用带查询串的动态 import
 * 重新加载一份全新的模块实例，避免状态串味。
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { createMemoryStorage, installChrome } from "./helpers/memory-storage.mjs";
import { buildCacheKey as pureBuildCacheKey } from "../src/shared/cache.js";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const CACHE_URL = pathToFileURL(path.join(HERE, "..", "src", "shared", "cache.js")).href;
const DAY_MS = 24 * 60 * 60 * 1000;

let caseSeq = 0;

function makeSettings(overrides) {
  const settings = {
    provider: { baseUrl: "https://api.deepseek.com/v1", model: "deepseek-chat" },
    cache: { enabled: true, maxEntries: 2000, ttlDays: 30 },
  };
  if (overrides) {
    if (overrides.provider) Object.assign(settings.provider, overrides.provider);
    if (overrides.cache) Object.assign(settings.cache, overrides.cache);
  }
  return settings;
}

/**
 * 加载一份全新的 cache.js 模块实例。
 * @param {ReturnType<typeof createMemoryStorage>} [storage] 复用的内存 storage
 */
async function loadCache(storage) {
  const memory = storage || createMemoryStorage();
  installChrome(memory);
  const cache = await import(CACHE_URL + "?case=" + (caseSeq += 1));
  return { cache, storage: memory };
}

// ---------------------------------------------------------------- 缓存键

test("buildCacheKey 稳定、8 位十六进制、忽略首尾与重复空白", async () => {
  const { cache } = await loadCache();
  const settings = makeSettings();
  const key = cache.buildCacheKey(settings, "zh-CN", "Hello world");
  assert.match(key, /^[0-9a-f]{8}$/);
  assert.equal(key, cache.buildCacheKey(settings, "zh-CN", "Hello world"));
  assert.equal(key, cache.buildCacheKey(settings, "zh-CN", "  Hello   world  "));
  assert.equal(key, pureBuildCacheKey(settings, "zh-CN", "Hello world"));
});

test("buildCacheKey 区分模型 / Base URL / 目标语言 / 大小写", async () => {
  const { cache } = await loadCache();
  const base = makeSettings();
  const key = cache.buildCacheKey(base, "zh-CN", "Hello");
  assert.notEqual(key, cache.buildCacheKey(base, "ja", "Hello"));
  assert.notEqual(key, cache.buildCacheKey(base, "zh-CN", "hello"));
  assert.notEqual(
    key,
    cache.buildCacheKey(makeSettings({ provider: { model: "gpt-4o-mini" } }), "zh-CN", "Hello")
  );
  assert.notEqual(
    key,
    cache.buildCacheKey(makeSettings({ provider: { baseUrl: "https://api.openai.com/v1" } }), "zh-CN", "Hello")
  );
});

// ---------------------------------------------------------------- 读写命中

test("cacheGet 未命中返回 null，写入后可命中", async () => {
  const { cache } = await loadCache();
  const settings = makeSettings();
  assert.equal(await cache.cacheGet(settings, "zh-CN", "你好"), null);

  await cache.cacheSet(settings, "zh-CN", "你好", "Hello");
  assert.equal(await cache.cacheGet(settings, "zh-CN", "你好"), "Hello");
  assert.equal(await cache.cacheGet(settings, "zh-CN", "别的内容"), null);
});

test("缓存命中按规范化文本，忽略多余空白", async () => {
  const { cache } = await loadCache();
  const settings = makeSettings();
  await cache.cacheSet(settings, "zh-CN", "Hello   world", "你好世界");
  assert.equal(await cache.cacheGet(settings, "zh-CN", " Hello world "), "你好世界");
});

test("空译文不写入缓存", async () => {
  const { cache } = await loadCache();
  const settings = makeSettings();
  await cache.cacheSet(settings, "zh-CN", "Hello", "   ");
  const stats = await cache.cacheStats(settings);
  assert.equal(stats.entries, 0);
});

test("缓存禁用时读写都短路", async () => {
  const { cache, storage } = await loadCache();
  const settings = makeSettings({ cache: { enabled: false } });
  await cache.cacheSet(settings, "zh-CN", "你好", "Hello");
  assert.equal(await cache.cacheGet(settings, "zh-CN", "你好"), null);
  await cache.flushCache();
  assert.equal(storage.stats.writes, 0);
  assert.equal(storage.snapshot().transCache, undefined);
});

test("缓存读取只加载一次持久化数据", async () => {
  const { cache, storage } = await loadCache();
  const settings = makeSettings();
  await cache.cacheGet(settings, "zh-CN", "a");
  await cache.cacheGet(settings, "zh-CN", "b");
  await cache.cacheGet(settings, "zh-CN", "c");
  assert.equal(storage.stats.reads, 1);
});

// ---------------------------------------------------------------- stats / flush / clear

test("cacheStats 返回条目数、字节数与上限", async () => {
  const { cache } = await loadCache();
  const settings = makeSettings();
  await cache.cacheSet(settings, "zh-CN", "a", "A");
  await cache.cacheSet(settings, "zh-CN", "b", "B");
  const stats = await cache.cacheStats(settings);
  assert.equal(stats.entries, 2);
  assert.ok(stats.bytes > 0);
  assert.equal(stats.maxEntries, 2000);
});

test("cacheStats 的 maxEntries 下限为 50", async () => {
  const { cache } = await loadCache();
  const stats = await cache.cacheStats(makeSettings({ cache: { maxEntries: 10 } }));
  assert.equal(stats.maxEntries, 50);
});

test("flushCache 把内存 store 持久化到 chrome.storage.local", async () => {
  const { cache, storage } = await loadCache();
  const settings = makeSettings();
  await cache.cacheSet(settings, "zh-CN", "你好", "Hello");
  await cache.flushCache();
  const saved = storage.snapshot();
  assert.equal(typeof saved.transCache, "object");
  const entries = Object.values(saved.transCache);
  assert.equal(entries.length, 1);
  assert.equal(entries[0].t, "Hello");
  assert.equal(typeof entries[0].ts, "number");
});

test("flushCache 无脏数据时不写存储", async () => {
  const { cache, storage } = await loadCache();
  await cache.flushCache();
  assert.equal(storage.stats.writes, 0);
});

test("新模块实例可从持久化数据恢复缓存（模拟扩展重启）", async () => {
  const first = await loadCache();
  const settings = makeSettings();
  await first.cache.cacheSet(settings, "zh-CN", "你好", "Hello");
  await first.cache.flushCache();

  const second = await loadCache(first.storage);
  assert.equal(await second.cache.cacheGet(settings, "zh-CN", "你好"), "Hello");
});

test("cacheClear 清空内存与持久化数据", async () => {
  const { cache, storage } = await loadCache();
  const settings = makeSettings();
  await cache.cacheSet(settings, "zh-CN", "你好", "Hello");
  await cache.flushCache();
  await cache.cacheClear();
  assert.equal((await cache.cacheStats(settings)).entries, 0);
  assert.deepEqual(storage.snapshot().transCache, {});
  assert.equal(await cache.cacheGet(settings, "zh-CN", "你好"), null);
});

// ---------------------------------------------------------------- TTL

test("超过 ttlDays 的缓存被视为过期并删除", async () => {
  const settings = makeSettings();
  const key = pureBuildCacheKey(settings, "zh-CN", "你好");
  const storage = createMemoryStorage({
    transCache: { [key]: { t: "旧译文", ts: Date.now() - 31 * DAY_MS } },
  });
  const { cache } = await loadCache(storage);
  assert.equal(await cache.cacheGet(settings, "zh-CN", "你好"), null);
  await cache.flushCache();
  assert.equal(storage.snapshot().transCache[key], undefined);
  assert.deepEqual(storage.snapshot().transCache, {});
});

test("ttlDays = 0 表示永不过期", async () => {
  const settings = makeSettings({ cache: { ttlDays: 0 } });
  const key = pureBuildCacheKey(settings, "zh-CN", "你好");
  const storage = createMemoryStorage({
    transCache: { [key]: { t: "旧译文", ts: Date.now() - 999 * DAY_MS } },
  });
  const { cache } = await loadCache(storage);
  assert.equal(await cache.cacheGet(settings, "zh-CN", "你好"), "旧译文");
});

test("未过期缓存正常命中", async () => {
  const settings = makeSettings();
  const key = pureBuildCacheKey(settings, "zh-CN", "你好");
  const storage = createMemoryStorage({
    transCache: { [key]: { t: "新译文", ts: Date.now() - 1 * DAY_MS } },
  });
  const { cache } = await loadCache(storage);
  assert.equal(await cache.cacheGet(settings, "zh-CN", "你好"), "新译文");
});

// ---------------------------------------------------------------- LRU

test("LRU 超过上限时淘汰最久未使用条目", async () => {
  const settings = makeSettings({ cache: { maxEntries: 50 } });
  const { cache } = await loadCache();
  for (let index = 0; index < 50; index += 1) {
    await cache.cacheSet(settings, "zh-CN", "text-" + index, "v" + index);
  }
  assert.equal((await cache.cacheStats(settings)).entries, 50);

  // 访问 text-0 使其成为最近使用
  assert.equal(await cache.cacheGet(settings, "zh-CN", "text-0"), "v0");

  await cache.cacheSet(settings, "zh-CN", "text-50", "v50");
  assert.equal((await cache.cacheStats(settings)).entries, 50);
  assert.equal(await cache.cacheGet(settings, "zh-CN", "text-0"), "v0", "最近使用的未被淘汰");
  assert.equal(await cache.cacheGet(settings, "zh-CN", "text-1"), null, "最久未用的应被淘汰");
});

test("LRU 上限低值时仍按 50 条生效", async () => {
  const settings = makeSettings({ cache: { maxEntries: 10 } });
  const { cache } = await loadCache();
  for (let index = 0; index < 60; index += 1) {
    await cache.cacheSet(settings, "zh-CN", "text-" + index, "v" + index);
  }
  assert.equal((await cache.cacheStats(settings)).entries, 50);
});

// ---------------------------------------------------------------- 损坏数据兜底

test("持久化数据损坏时静默重建，不影响后续写入", async () => {
  const storage = createMemoryStorage({ transCache: "not-an-object" });
  const { cache } = await loadCache(storage);
  const settings = makeSettings();
  assert.equal(await cache.cacheGet(settings, "zh-CN", "你好"), null);
  await cache.cacheSet(settings, "zh-CN", "你好", "Hello");
  assert.equal(await cache.cacheGet(settings, "zh-CN", "你好"), "Hello");
});

test("持久化中字段不合法的条目被忽略", async () => {
  const settings = makeSettings();
  const goodKey = pureBuildCacheKey(settings, "zh-CN", "好");
  const badKey = pureBuildCacheKey(settings, "zh-CN", "坏");
  const storage = createMemoryStorage({
    transCache: {
      [goodKey]: { t: "好译文", ts: Date.now() },
      [badKey]: { t: 123, ts: "yesterday" },
    },
  });
  const { cache } = await loadCache(storage);
  assert.equal(await cache.cacheGet(settings, "zh-CN", "好"), "好译文");
  assert.equal(await cache.cacheGet(settings, "zh-CN", "坏"), null);
});
