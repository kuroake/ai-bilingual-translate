/**
 * 用量统计：请求数、段落数、缓存命中、token 估算。
 * 独立于 settings 存储，避免互相覆盖。
 */
import { STATS_KEY } from "./config.js";
import { storageGet, storageSet, queueWrite } from "./storage.js";

function emptyStats() {
  return { requests: 0, segments: 0, cacheHits: 0, tokensIn: 0, tokensOut: 0, since: Date.now() };
}

function normalizeStats(raw) {
  const base = emptyStats();
  if (!raw || typeof raw !== "object") return base;
  return {
    requests: Number(raw.requests) || 0,
    segments: Number(raw.segments) || 0,
    cacheHits: Number(raw.cacheHits) || 0,
    tokensIn: Number(raw.tokensIn) || 0,
    tokensOut: Number(raw.tokensOut) || 0,
    since: Number(raw.since) || Date.now(),
  };
}

export async function getStats() {
  try {
    const data = await storageGet(STATS_KEY);
    return normalizeStats(data[STATS_KEY]);
  } catch (_) {
    return emptyStats();
  }
}

export async function recordUsage(delta) {
  const add = delta || {};
  return queueWrite(async () => {
    const current = await getStats();
    const next = {
      requests: current.requests + (Number(add.requests) || 0),
      segments: current.segments + (Number(add.segments) || 0),
      cacheHits: current.cacheHits + (Number(add.cacheHits) || 0),
      tokensIn: current.tokensIn + (Number(add.tokensIn) || 0),
      tokensOut: current.tokensOut + (Number(add.tokensOut) || 0),
      since: current.since || Date.now(),
    };
    await storageSet({ [STATS_KEY]: next });
    return next;
  });
}

export async function resetStats() {
  return queueWrite(async () => {
    const next = emptyStats();
    await storageSet({ [STATS_KEY]: next });
    return next;
  });
}
