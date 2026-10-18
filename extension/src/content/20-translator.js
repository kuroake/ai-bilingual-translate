/**
 * 20-translator.js —— 全页翻译调度器。
 *
 * 职责：
 * - 视口优先分批（IntersectionObserver + 同步初始排序）、批次并发（concurrency）；
 * - 批次失败按指数退避重试（retryLimit），单段失败降级为单段请求（失败隔离）；
 * - 进度通过 AIT.bus 的 progress 事件广播；
 * - 取消（还原）与增量翻译（MutationObserver / SPA 路由触发）；
 * - 与 background 的 ait:translate.batch 协议对接。
 *
 * 依赖：00-core.js（AIT.util / AIT.bus / AIT.runtimeSend）、10-segmenter.js、30-renderer.js。
 */
(() => {
  "use strict";
  const AIT = (window.AIT = window.AIT || {});
  const util = AIT.util;
  if (!util) return;
  // 幂等守卫：popup / background 可能对同一页面重复动态注入，已初始化则直接跳过
  if (AIT.translator) return;

  /** background 不可用（设置读取失败）时的兜底配置 */
  const FALLBACK = {
    mode: "bilingual",
    concurrency: 3,
    batchSize: 8,
    maxSegmentChars: 1500,
    minTextLength: 2,
    skipCode: true,
    retryLimit: 2,
    targetLang: "zh-CN",
    sourceLang: "auto",
  };

  /** 退避基数：800ms * 2^(n-1) + 抖动，与文档 §7.2 一致 */
  const BACKOFF_BASE = 800;

  let settings = Object.assign({}, FALLBACK);
  let segments = AIT.state.segments || [];
  let queue = [];
  let activeWorkers = 0;
  let cancelled = false;
  let running = null;
  let sessionToken = 0;
  let resolvePump = null;
  const waiters = new Set();
  let io = null;
  let ioByEl = new WeakMap();
  let viewportSet = new Set();

  let totalCount = 0;
  let doneCount = 0;
  let failedCount = 0;
  let lastError = "";

  // ---------------------------------------------------------------- 配置

  function clampNumber(value, min, max, fallback) {
    const number = Number(value);
    if (!Number.isFinite(number)) return fallback;
    return Math.min(max, Math.max(min, Math.round(number)));
  }

  function readSettings() {
    const raw = AIT.state.settings || {};
    const translate = raw.translate || {};
    const language = raw.language || {};
    return {
      mode: translate.mode === "translation-only" ? "translation-only" : "bilingual",
      concurrency: clampNumber(translate.concurrency, 1, 6, FALLBACK.concurrency),
      batchSize: clampNumber(translate.batchSize, 1, 20, FALLBACK.batchSize),
      maxSegmentChars: clampNumber(translate.maxSegmentChars, 100, 20000, FALLBACK.maxSegmentChars),
      minTextLength: clampNumber(translate.minTextLength, 1, 200, FALLBACK.minTextLength),
      skipCode: translate.skipCode !== false,
      retryLimit: clampNumber(translate.retryLimit, 0, 5, FALLBACK.retryLimit),
      targetLang: language.target || FALLBACK.targetLang,
      sourceLang: language.source || FALLBACK.sourceLang,
    };
  }

  function applySettings(nextSettings) {
    if (nextSettings) AIT.state.settings = nextSettings;
    const previousMode = settings.mode;
    settings = readSettings();
    if (AIT.state.mode !== settings.mode) AIT.state.mode = settings.mode;
    if (previousMode !== settings.mode && AIT.renderer) AIT.renderer.applyMode(settings.mode);
  }

  // ---------------------------------------------------------------- 进度

  function recomputeProgress() {
    let total = 0;
    let done = 0;
    let failed = 0;
    for (let i = 0; i < segments.length; i += 1) {
      const segment = segments[i];
      if (!segment || segment.skipped) continue;
      total += 1;
      if (segment.state === "done") done += 1;
      else if (segment.state === "error") failed += 1;
    }
    totalCount = total;
    doneCount = done;
    failedCount = failed;
    const progress = { done: done, total: total, failed: failed };
    AIT.state.progress = progress;
    return progress;
  }

  function emitProgress(phase) {
    const progress = recomputeProgress();
    AIT.bus.emit("progress", {
      done: progress.done,
      total: progress.total,
      failed: progress.failed,
      phase: phase || "translating",
    });
    return progress;
  }

  function getProgress() {
    return { done: doneCount, total: totalCount, failed: failedCount };
  }

  // ---------------------------------------------------------------- 段落管理

  function setSegments(next) {
    segments = next;
    AIT.state.segments = next;
  }

  function findSegmentByEl(el) {
    for (let i = 0; i < segments.length; i += 1) {
      if (segments[i] && segments[i].el === el) return segments[i];
    }
    return null;
  }

  function findSegmentById(id) {
    for (let i = 0; i < segments.length; i += 1) {
      if (segments[i] && segments[i].id === id) return segments[i];
    }
    return null;
  }

  function removeSegment(segment) {
    const index = segments.indexOf(segment);
    if (index >= 0) segments.splice(index, 1);
    if (AIT.renderer) AIT.renderer.unmount(segment);
    if (io && segment.el) {
      try {
        io.unobserve(segment.el);
      } catch (_) {}
      ioByEl.delete(segment.el);
    }
    viewportSet.delete(segment);
  }

  /** 清理已从 DOM 移除的旧段落（SPA 路由 / 宿主重渲染） */
  function pruneSegments() {
    const kept = [];
    for (let i = 0; i < segments.length; i += 1) {
      const segment = segments[i];
      if (!segment || !segment.el || !segment.el.isConnected) continue;
      if (segment.state === "done" && segment.targetEl && !segment.targetEl.isConnected) continue;
      kept.push(segment);
    }
    if (kept.length !== segments.length) setSegments(kept);
  }

  function collectFrom(root) {
    if (!AIT.segmenter) return [];
    return AIT.segmenter.collect(root || document.body, {
      minTextLength: settings.minTextLength,
      skipCode: settings.skipCode,
    });
  }

  /** 过滤掉已经是目标语言的段落，其余保留待翻译 */
  function prepareFresh(fresh) {
    const pending = [];
    for (let i = 0; i < fresh.length; i += 1) {
      const segment = fresh[i];
      if (!segment) continue;
      segment.rect = null;
      if (util.looksLikeTargetLanguage(segment.text, settings.targetLang)) {
        segment.skipped = true;
        continue;
      }
      pending.push(segment);
    }
    return pending;
  }

  /** 把新段落并入 AIT.state.segments，返回真正新增的部分 */
  function ingestFresh(fresh) {
    pruneSegments();
    const knownIds = new Set();
    for (let i = 0; i < segments.length; i += 1) {
      if (segments[i]) knownIds.add(segments[i].id);
    }
    const added = [];
    for (let i = 0; i < fresh.length; i += 1) {
      const segment = fresh[i];
      if (!segment) continue;
      if (knownIds.has(segment.id)) continue;
      const previous = findSegmentByEl(segment.el);
      if (previous) removeSegment(previous);
      knownIds.add(segment.id);
      segment.state = "pending";
      segments.push(segment);
      added.push(segment);
    }
    return added;
  }

  // ---------------------------------------------------------------- 视口优先

  function observeSegments(list) {
    if (typeof IntersectionObserver === "function") {
      if (!io) {
        io = new IntersectionObserver(
          (entries) => {
            for (let i = 0; i < entries.length; i += 1) {
              const entry = entries[i];
              const segment = ioByEl.get(entry.target);
              if (!segment) continue;
              if (entry.isIntersecting) viewportSet.add(segment);
              else viewportSet.delete(segment);
            }
          },
          { rootMargin: "300px 0px 300px 0px", threshold: 0 }
        );
      }
      for (let i = 0; i < list.length; i += 1) {
        const segment = list[i];
        if (!segment || !segment.el) continue;
        if (segment.state === "done" || segment.skipped) continue;
        ioByEl.set(segment.el, segment);
        io.observe(segment.el);
      }
    }
    primeViewport(list);
  }

  /** 同步标记首屏段落（IntersectionObserver 回调要等下一帧） */
  function primeViewport(list) {
    const viewportHeight = window.innerHeight || document.documentElement.clientHeight || 0;
    for (let i = 0; i < list.length; i += 1) {
      const segment = list[i];
      const el = segment && segment.el;
      if (!el || !el.getBoundingClientRect) continue;
      const rect = el.getBoundingClientRect();
      segment.rect = rect;
      if (rect.bottom >= -300 && rect.top <= viewportHeight + 300) viewportSet.add(segment);
    }
  }

  function teardownViewport() {
    if (io) {
      io.disconnect();
      io = null;
    }
    ioByEl = new WeakMap();
    viewportSet = new Set();
  }

  // ---------------------------------------------------------------- 调度

  function toRequestSegment(segment) {
    return { id: segment.id, text: segment.text };
  }

  function takeBatch() {
    const max = Math.max(1, settings.batchSize);
    const maxChars = settings.maxSegmentChars;
    const picked = [];
    const pickedSet = new Set();

    const fill = (list) => {
      list.sort((a, b) => a.order - b.order);
      for (let i = 0; i < list.length; i += 1) {
        if (picked.length >= max) return true;
        const segment = list[i];
        const oversized = !!segment.text && segment.text.length > maxChars;
        if (oversized && picked.length > 0) return true;
        picked.push(segment);
        pickedSet.add(segment);
        if (oversized) return true;
      }
      return false;
    };

    const viewport = [];
    for (let i = 0; i < queue.length; i += 1) {
      if (viewportSet.has(queue[i])) viewport.push(queue[i]);
    }
    if (viewport.length) fill(viewport);
    if (picked.length < max) {
      const rest = [];
      for (let i = 0; i < queue.length; i += 1) {
        if (!pickedSet.has(queue[i])) rest.push(queue[i]);
      }
      fill(rest);
    }
    if (pickedSet.size) queue = queue.filter((segment) => !pickedSet.has(segment));
    return picked;
  }

  function sleepCancelable(ms) {
    return new Promise((resolve) => {
      if (cancelled || ms <= 0) {
        resolve();
        return;
      }
      let waiter = null;
      const timer = setTimeout(() => {
        if (waiter) waiters.delete(waiter);
        resolve();
      }, ms);
      waiter = () => {
        clearTimeout(timer);
        waiters.delete(waiter);
        resolve();
      };
      waiters.add(waiter);
    });
  }

  function wakeWaiters() {
    const list = Array.from(waiters);
    waiters.clear();
    for (let i = 0; i < list.length; i += 1) list[i]();
  }

  function finishPump() {
    if (activeWorkers === 0 && queue.length === 0 && resolvePump) {
      const resolve = resolvePump;
      resolvePump = null;
      resolve();
    }
  }

  function pump() {
    if (cancelled) {
      finishPump();
      return;
    }
    const concurrency = settings.concurrency;
    while (activeWorkers < concurrency && queue.length) {
      const batch = takeBatch();
      if (!batch.length) break;
      activeWorkers += 1;
      void runBatch(batch)
        .catch((error) => {
          AIT.log("batch crashed", error);
          for (let i = 0; i < batch.length; i += 1) {
            const segment = batch[i];
            if (segment.state === "pending") markSegmentError(segment, (error && error.message) || "翻译失败");
          }
        })
        .finally(() => {
          activeWorkers -= 1;
          pump();
        });
    }
    finishPump();
  }

  // ---------------------------------------------------------------- 请求

  function sendBatch(items) {
    return AIT.runtimeSend({
      type: "ait:translate.batch",
      payload: {
        segments: items,
        targetLang: settings.targetLang,
        sourceLang: settings.sourceLang,
        pageUrl: location.href,
        pageTitle: document.title,
      },
    });
  }

  function errorMessage(response) {
    if (response && response.error && response.error.message) return String(response.error.message);
    if (response && response.message) return String(response.message);
    return "翻译请求失败，请检查网络或 API 设置。";
  }

  function isUsableTranslation(text) {
    return typeof text === "string" && !!util.normalizeText(text);
  }

  function applyTranslation(segment, text) {
    const normalized = util.normalizeText(text);
    const same = normalized === util.normalizeText(segment.text);
    segment.state = "done";
    segment.error = null;
    segment.translation = same ? null : normalized;
    if (!same && AIT.renderer) AIT.renderer.mount(segment, normalized);
    emitProgress("translating");
  }

  function markSegmentError(segment, message) {
    segment.state = "error";
    segment.error = message || "翻译失败";
    lastError = segment.error;
    if (AIT.renderer) AIT.renderer.markError(segment, segment.error);
    emitProgress("translating");
  }

  /** 单段请求：失败隔离与单段重试共用，内含退避 */
  async function translateSingle(segment) {
    let attempt = 0;
    while (!cancelled) {
      const response = await sendBatch([toRequestSegment(segment)]);
      if (cancelled) return;
      if (response && response.ok) {
        const results = Array.isArray(response.results) ? response.results : [];
        let text = null;
        for (let i = 0; i < results.length; i += 1) {
          if (results[i] && results[i].id === segment.id) {
            text = results[i].text;
            break;
          }
        }
        if (isUsableTranslation(text)) {
          applyTranslation(segment, text);
          return;
        }
      } else {
        lastError = errorMessage(response);
      }
      attempt += 1;
      if (attempt > settings.retryLimit) {
        markSegmentError(segment, lastError || "模型未返回该段译文，请重试。");
        return;
      }
      await sleepCancelable(util.backoff(attempt, BACKOFF_BASE));
    }
  }

  /** 一个批次的完整生命周期：整批请求 → 失败退避 → 逐段渲染 → 缺段单段隔离 */
  async function runBatch(batch) {
    let attempt = 0;
    let response = null;
    while (!cancelled) {
      response = await sendBatch(batch.map(toRequestSegment));
      if (cancelled) return;
      if (response && response.ok) break;
      lastError = errorMessage(response);
      attempt += 1;
      if (attempt > settings.retryLimit) break;
      await sleepCancelable(util.backoff(attempt, BACKOFF_BASE));
    }
    if (cancelled) return;
    if (!response || !response.ok) {
      // 整批失败（鉴权 / 限流 / 网络）已按 retryLimit 退避重试仍失败：整批标记，
      // 不再拆成单段请求，否则 429 等场景会把请求量放大到段数倍。
      // 单段失败隔离只用于「请求成功但某段译文缺失」的情况（见下方 missing）。
      for (let i = 0; i < batch.length; i += 1) {
        if (cancelled) return;
        markSegmentError(batch[i], lastError);
      }
      return;
    }

    const resultMap = new Map();
    const results = Array.isArray(response.results) ? response.results : [];
    for (let i = 0; i < results.length; i += 1) {
      const item = results[i];
      if (item && typeof item.id === "string") resultMap.set(item.id, item.text);
    }
    const missing = [];
    for (let i = 0; i < batch.length; i += 1) {
      const segment = batch[i];
      if (cancelled) return;
      const text = resultMap.get(segment.id);
      if (isUsableTranslation(text)) applyTranslation(segment, text);
      else missing.push(segment);
    }
    // 缺段（模型漏段 / 解析失败）逐段隔离重试
    for (let i = 0; i < missing.length; i += 1) {
      if (cancelled) return;
      await translateSingle(missing[i]);
    }
  }

  // ---------------------------------------------------------------- 会话

  function reportPageState(translated) {
    void AIT.runtimeSend({
      type: "ait:page.translated",
      payload: { url: location.href, translated: !!translated },
    });
  }

  function finishSession() {
    AIT.state.translating = false;
    queue = [];
    teardownViewport();
    if (AIT.observer) {
      try {
        AIT.observer.stop();
      } catch (_) {}
    }
    const progress = emitProgress("done");
    const summary = {
      total: progress.total,
      translated: progress.done,
      failed: progress.failed,
      error: lastError || null,
    };
    AIT.bus.emit("translate:done", summary);
    if (lastError && progress.done === 0) AIT.bus.emit("translate:error", { message: lastError });
    reportPageState(true);
    return summary;
  }

  function startSession(newSegments) {
    const token = (sessionToken += 1);
    cancelled = false;
    lastError = "";
    AIT.state.translating = true;
    AIT.state.translated = true;

    const pending = [];
    for (let i = 0; i < newSegments.length; i += 1) {
      const segment = newSegments[i];
      if (!segment) continue;
      segment.state = "pending";
      segment.error = null;
      segment.failCount = 0;
      pending.push(segment);
    }
    queue = queue.concat(pending);
    AIT.bus.emit("translate:start", { total: pending.length });
    emitProgress("translating");
    observeSegments(pending);
    if (AIT.observer) {
      try {
        AIT.observer.start();
      } catch (_) {}
    }

    const promise = new Promise((resolve) => {
      resolvePump = () => resolve(finishSession());
    });
    pump();
    return promise.then((summary) => {
      if (token !== sessionToken) return summary;
      return summary;
    });
  }

  // ---------------------------------------------------------------- 对外接口

  async function translatePage(options) {
    const opts = options || {};
    const force = !!opts.force;
    if (running) {
      if (!force) return Object.assign({ running: true }, getProgress());
      await restore({ silent: true });
      try {
        await running;
      } catch (_) {}
      running = null;
    }
    settings = readSettings();
    if (AIT.state.mode !== settings.mode) {
      AIT.state.mode = settings.mode;
      if (AIT.renderer) AIT.renderer.applyMode(settings.mode);
    }
    if (force) {
      await restore({ silent: true });
      cancelled = false;
    }
    pruneSegments();
    const fresh = collectFrom(document.body);
    const pending = prepareFresh(fresh);
    const added = ingestFresh(pending);
    if (!added.length) {
      if (!segments.length) {
        const empty = { total: 0, translated: 0, failed: 0, empty: true };
        AIT.bus.emit("translate:done", empty);
        return empty;
      }
      return Object.assign({ empty: true }, getProgress());
    }
    const session = startSession(added);
    running = session;
    try {
      return await session;
    } finally {
      if (running === session) running = null;
    }
  }

  async function translateElements(roots) {
    const list = Array.isArray(roots) ? roots : [roots];
    if (!list.length) return Object.assign({ empty: true }, getProgress());
    settings = readSettings();
    const fresh = [];
    for (let i = 0; i < list.length; i += 1) {
      const root = list[i];
      if (!root || !root.isConnected) continue;
      const found = collectFrom(root);
      for (let j = 0; j < found.length; j += 1) fresh.push(found[j]);
    }
    if (!fresh.length) return Object.assign({ empty: true }, getProgress());
    const pending = prepareFresh(fresh);
    const added = ingestFresh(pending);
    if (!added.length) return Object.assign({ empty: true }, getProgress());
    if (running) {
      // 翻译进行中：并入队列，由现有 worker 继续消费
      queue = queue.concat(added);
      observeSegments(added);
      emitProgress("translating");
      return Object.assign({ queued: added.length }, getProgress());
    }
    const session = startSession(added);
    running = session;
    try {
      return await session;
    } finally {
      if (running === session) running = null;
    }
  }

  async function translateElement(el) {
    return translateElements([el]);
  }

  async function restore(options) {
    const silent = !!(options && options.silent);
    sessionToken += 1;
    cancelled = true;
    wakeWaiters();
    queue = [];
    teardownViewport();
    if (AIT.observer) {
      try {
        AIT.observer.stop();
      } catch (_) {}
    }
    if (AIT.renderer) {
      try {
        AIT.renderer.unmountAll();
      } catch (error) {
        AIT.log("unmountAll failed", error);
      }
    }
    if (segments.length) setSegments([]);
    if (AIT.segmenter && AIT.segmenter.reset) AIT.segmenter.reset();
    AIT.state.translating = false;
    AIT.state.translated = false;
    totalCount = 0;
    doneCount = 0;
    failedCount = 0;
    lastError = "";
    AIT.state.progress = { done: 0, total: 0, failed: 0 };
    if (resolvePump) {
      const resolve = resolvePump;
      resolvePump = null;
      resolve();
    }
    if (!silent) {
      AIT.bus.emit("progress", { done: 0, total: 0, failed: 0, phase: "restore" });
      AIT.bus.emit("restore", {});
      reportPageState(false);
    }
  }

  function isTranslated() {
    if (AIT.state.translated || AIT.state.translating) return true;
    return !!document.querySelector(".ait-trans");
  }

  async function retrySegment(id) {
    const segment = findSegmentById(id);
    if (!segment) return;
    if (running) {
      if (segment.state === "pending") return;
      segment.state = "pending";
      segment.error = null;
      if (AIT.renderer) AIT.renderer.markPending(segment);
      queue.push(segment);
      observeSegments([segment]);
      emitProgress("translating");
      return;
    }
    segment.state = "pending";
    segment.error = null;
    segment.failCount = 0;
    if (AIT.renderer) AIT.renderer.markPending(segment);
    const session = startSession([segment]);
    running = session;
    try {
      await session;
    } finally {
      if (running === session) running = null;
    }
  }

  AIT.translator = {
    translatePage: translatePage,
    restore: restore,
    isTranslated: isTranslated,
    retrySegment: retrySegment,
    translateElement: translateElement,
    translateElements: translateElements,
    getProgress: getProgress,
    applySettings: applySettings,
  };

  AIT.log("translator ready");
})();
