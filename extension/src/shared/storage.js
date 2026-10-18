/**
 * chrome.storage.local 的最小封装。
 * 所有读取都带默认值兜底，所有写入串行排队，避免并发覆盖。
 */
import { DEFAULT_SETTINGS, SETTINGS_KEY, STATS_KEY, CACHE_KEY, deepMerge } from "./config.js";

let writeChain = Promise.resolve();

function area() {
  return chrome.storage.local;
}

export function storageGet(keys) {
  return area().get(keys);
}

export function storageSet(items) {
  return area().set(items);
}

export function storageRemove(keys) {
  return area().remove(keys);
}

/** 串行化写入，避免 settings 的并发 patch 互相覆盖 */
export function queueWrite(task) {
  const next = writeChain.then(task, task);
  writeChain = next.catch(() => {});
  return next;
}

/**
 * 设置迁移表：key 为目标版本号。
 * v2：工具栏图标点击回归「打开控制面板」，不再被翻译功能占用。
 */
const SETTINGS_MIGRATIONS = {
  2(settings) {
    settings.ui.clickAction = DEFAULT_SETTINGS.ui.clickAction;
    return settings;
  },
};

function migrateSettings(settings, fromVersion) {
  const target = Number(DEFAULT_SETTINGS.version) || 1;
  let next = settings;
  for (let version = fromVersion + 1; version <= target; version += 1) {
    if (SETTINGS_MIGRATIONS[version]) next = SETTINGS_MIGRATIONS[version](next);
  }
  next.version = target;
  return next;
}

export async function getSettings() {
  const data = await storageGet(SETTINGS_KEY);
  const stored = data[SETTINGS_KEY] || {};
  let settings = deepMerge(DEFAULT_SETTINGS, stored);
  const fromVersion = Number(stored.version) || 1;
  if (fromVersion < Number(DEFAULT_SETTINGS.version || 1)) {
    settings = migrateSettings(settings, fromVersion);
    // 迁移结果异步写回，下次读取即为最新版本
    void queueWrite(() => storageSet({ [SETTINGS_KEY]: settings }));
  }
  return settings;
}

export async function saveSettings(settings) {
  await queueWrite(() => storageSet({ [SETTINGS_KEY]: settings }));
  return settings;
}

export async function patchSettings(patch) {
  return queueWrite(async () => {
    const data = await storageGet(SETTINGS_KEY);
    const current = deepMerge(DEFAULT_SETTINGS, data[SETTINGS_KEY] || {});
    const next = deepMerge(current, patch || {});
    await storageSet({ [SETTINGS_KEY]: next });
    return next;
  });
}

export async function resetSettings() {
  return queueWrite(async () => {
    const settings = deepMerge(DEFAULT_SETTINGS, {});
    await storageSet({ [SETTINGS_KEY]: settings });
    return settings;
  });
}

export async function getRaw(key) {
  const data = await storageGet(key);
  return data[key];
}

export async function setRaw(key, value) {
  await queueWrite(() => storageSet({ [key]: value }));
  return value;
}

export { SETTINGS_KEY, STATS_KEY, CACHE_KEY };
