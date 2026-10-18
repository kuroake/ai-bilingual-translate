/**
 * shared/storage.js 与 shared/stats.js 单元测试（内存 mock chrome.storage.local）。
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { createMemoryStorage, installChrome } from "./helpers/memory-storage.mjs";
import {
  DEFAULT_SETTINGS,
  SETTINGS_KEY,
  STATS_KEY,
  deepMerge,
} from "../src/shared/config.js";
import {
  getSettings,
  saveSettings,
  patchSettings,
  resetSettings,
  getRaw,
  setRaw,
  queueWrite,
} from "../src/shared/storage.js";
import { getStats, recordUsage, resetStats } from "../src/shared/stats.js";

function freshStorage(initial) {
  const storage = createMemoryStorage(initial);
  installChrome(storage);
  return storage;
}

// ---------------------------------------------------------------- settings

test("getSettings 在空存储时返回默认设置", async () => {
  freshStorage();
  assert.deepEqual(await getSettings(), DEFAULT_SETTINGS);
});

test("getSettings 对残缺旧设置做深合并", async () => {
  const legacy = { provider: { apiKey: "sk-test" }, ui: { theme: "dark" } };
  const storage = freshStorage({ [SETTINGS_KEY]: legacy });
  const settings = await getSettings();
  assert.deepEqual(settings, deepMerge(DEFAULT_SETTINGS, legacy));
  assert.equal(settings.provider.model, "deepseek-chat");
  assert.equal(settings.ui.theme, "dark");
  assert.equal(storage.stats.reads >= 1, true);
});

test("v1 设置迁移：工具栏图标点击回到「打开控制面板」", async () => {
  const legacy = { version: 1, provider: { model: "deepseek-chat" }, ui: { theme: "dark", clickAction: "toggle" } };
  const storage = freshStorage({ [SETTINGS_KEY]: legacy });
  const settings = await getSettings();
  assert.equal(settings.version, 2);
  assert.equal(settings.ui.clickAction, "popup");
  assert.equal(settings.ui.theme, "dark", "其他用户设置不能被迁移覆盖");
  await new Promise((resolve) => setTimeout(resolve, 30));
  const persisted = storage.snapshot()[SETTINGS_KEY];
  assert.equal(persisted.version, 2);
  assert.equal(persisted.ui.clickAction, "popup");
});

test("patchSettings 深合并并持久化，其他字段不受影响", async () => {
  freshStorage();
  await saveSettings(deepMerge(DEFAULT_SETTINGS, { ui: { theme: "dark" } }));
  const next = await patchSettings({ provider: { apiKey: "sk-new" }, language: { target: "ja" } });
  assert.equal(next.provider.apiKey, "sk-new");
  assert.equal(next.language.target, "ja");
  assert.equal(next.ui.theme, "dark");

  const stored = await getSettings();
  assert.equal(stored.provider.apiKey, "sk-new");
  assert.equal(stored.ui.theme, "dark");
  assert.equal(stored.language.target, "ja");
});

test("并发 patchSettings 串行执行，互不覆盖", async () => {
  freshStorage();
  await Promise.all([
    patchSettings({ ui: { theme: "dark" } }),
    patchSettings({ language: { target: "en" } }),
    patchSettings({ translate: { mode: "translation-only" } }),
  ]);
  const settings = await getSettings();
  assert.equal(settings.ui.theme, "dark");
  assert.equal(settings.language.target, "en");
  assert.equal(settings.translate.mode, "translation-only");
});

test("resetSettings 恢复默认值", async () => {
  freshStorage();
  await patchSettings({ provider: { apiKey: "sk-x" }, ui: { theme: "dark" } });
  const settings = await resetSettings();
  assert.deepEqual(settings, DEFAULT_SETTINGS);
  assert.deepEqual(await getSettings(), DEFAULT_SETTINGS);
});

test("saveSettings 按传入对象存储，读取时仍与默认值合并", async () => {
  freshStorage();
  const partial = { provider: { model: "custom-model" } };
  await saveSettings(partial);
  const settings = await getSettings();
  assert.equal(settings.provider.model, "custom-model");
  assert.equal(settings.version, DEFAULT_SETTINGS.version);
});

test("getRaw / setRaw 读写任意存储键", async () => {
  const storage = freshStorage();
  assert.equal(await getRaw("foo"), undefined);
  await setRaw("foo", { bar: 1 });
  assert.deepEqual(await getRaw("foo"), { bar: 1 });
  assert.deepEqual(storage.snapshot().foo, { bar: 1 });
});

test("queueWrite 单个任务失败不阻断后续写入", async () => {
  freshStorage();
  await assert.rejects(queueWrite(async () => {
    throw new Error("boom");
  }), /boom/);
  const result = await queueWrite(async () => "ok");
  assert.equal(result, "ok");
});

// ---------------------------------------------------------------- stats

test("getStats 在空存储时返回零值统计", async () => {
  freshStorage();
  const stats = await getStats();
  assert.equal(stats.requests, 0);
  assert.equal(stats.segments, 0);
  assert.equal(stats.cacheHits, 0);
  assert.equal(stats.tokensIn, 0);
  assert.equal(stats.tokensOut, 0);
  assert.equal(typeof stats.since, "number");
});

test("recordUsage 累加各类计数", async () => {
  freshStorage();
  await recordUsage({ requests: 2, segments: 5, cacheHits: 1, tokensIn: 100, tokensOut: 50 });
  await recordUsage({ requests: 1, segments: 2, cacheHits: 3, tokensIn: 20, tokensOut: 10 });
  const stats = await getStats();
  assert.equal(stats.requests, 3);
  assert.equal(stats.segments, 7);
  assert.equal(stats.cacheHits, 4);
  assert.equal(stats.tokensIn, 120);
  assert.equal(stats.tokensOut, 60);
});

test("recordUsage 忽略非法数值并保留 since", async () => {
  freshStorage();
  const first = await recordUsage({ requests: 1, tokensIn: "abc", tokensOut: null });
  const stats = await getStats();
  assert.equal(stats.requests, 1);
  assert.equal(stats.tokensIn, 0);
  assert.equal(stats.tokensOut, 0);
  assert.equal(stats.since, first.since);
});

test("resetStats 清零统计", async () => {
  freshStorage();
  await recordUsage({ requests: 3, segments: 3, cacheHits: 1, tokensIn: 9, tokensOut: 9 });
  const stats = await resetStats();
  assert.equal(stats.requests, 0);
  assert.equal(stats.cacheHits, 0);
  assert.deepEqual(await getStats(), stats);
});

test("持久化的 stats 数据损坏时安全回退为零值", async () => {
  freshStorage({ [STATS_KEY]: "corrupted" });
  const stats = await getStats();
  assert.equal(stats.requests, 0);
  assert.equal(stats.segments, 0);
});
