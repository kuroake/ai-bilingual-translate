/**
 * 30-renderer.js —— 译文渲染层。
 *
 * 职责：
 * - 按 docs/ARCHITECTURE.md §6 的 DOM 契约注入译文节点（.ait-trans / .ait-trans--block / data-ait-id）；
 * - 双语 / 仅译文模式切换（仅加属性与 class，不改原文文本）；
 * - 进度 toast；
 * - 失败段标记 .ait-error，点击 / 回车重试；
 * - 所有节点可被 unmountAll() 清理。
 *
 * 依赖：00-core.js、20-translator.js（运行时调用）。
 */
(() => {
  "use strict";
  const AIT = (window.AIT = window.AIT || {});
  const util = AIT.util;
  if (!util) return;
  // 幂等守卫：popup / background 可能对同一页面重复动态注入，已初始化则直接跳过
  if (AIT.renderer) return;

  /** 这些元素的父级不允许插入块级兄弟，译文改为追加到元素内部的 span */
  const INLINE_TAGS = new Set(["TD", "TH", "CAPTION"]);

  const TOAST_HIDE_DONE_MS = 2400;
  const TOAST_HIDE_FAILED_MS = 5200;
  const TOAST_HIDE_ERROR_MS = 6000;

  let toastEl = null;
  let toastTextEl = null;
  let toastFillEl = null;
  let toastActionEl = null;
  let toastHideTimer = null;
  let toastMode = "busy";

  // ---------------------------------------------------------------- 工具

  function isInlineSegment(segment) {
    return !!segment && !!segment.el && INLINE_TAGS.has(segment.el.tagName);
  }

  function parseCssColor(value) {
    const match = String(value || "").match(/rgba?\(([^)]+)\)/);
    if (!match) return null;
    const parts = match[1].split(",").map((item) => parseFloat(item));
    if (parts.length < 3 || parts.some((item) => Number.isNaN(item))) return null;
    return { r: parts[0], g: parts[1], b: parts[2], a: parts.length > 3 ? parts[3] : 1 };
  }

  function relativeLuminance(color) {
    function channel(value) {
      const scaled = value / 255;
      return scaled <= 0.03928 ? scaled / 12.92 : Math.pow((scaled + 0.055) / 1.055, 2.4);
    }
    return 0.2126 * channel(color.r) + 0.7152 * channel(color.g) + 0.0722 * channel(color.b);
  }

  /** 向上查找第一个不透明背景色，返回相对亮度；找不到按白纸处理 */
  function hostBackgroundLuminance(el) {
    let node = el;
    while (node && node.nodeType === 1) {
      let color = null;
      try {
        color = parseCssColor(window.getComputedStyle(node).backgroundColor);
      } catch (_) {
        color = null;
      }
      if (color && color.a > 0.5) return relativeLuminance(color);
      node = node.parentElement;
    }
    return 1;
  }

  /**
   * 译文配色默认跟随系统主题，但当系统主题与宿主页面背景不一致时会撞色
   * （系统亮色 + 深色网页 => 深灰字写在深色底上）。按实际背景亮度补上
   * ait-trans--on-light / ait-trans--on-dark 类强制匹配配色。
   */
  function applyHostTone(node, el) {
    if (!node || !el) return;
    let luminance = 1;
    try {
      luminance = hostBackgroundLuminance(el);
    } catch (_) {
      luminance = 1;
    }
    node.classList.remove("ait-trans--on-light", "ait-trans--on-dark");
    if (luminance <= 0.42) node.classList.add("ait-trans--on-dark");
    else if (luminance >= 0.62) node.classList.add("ait-trans--on-light");
  }

  function selectorForId(id) {
    const escaped = window.CSS && typeof window.CSS.escape === "function" ? window.CSS.escape(id) : String(id).replace(/["\\]/g, "\\$&");
    return '.ait-trans[data-ait-id="' + escaped + '"]';
  }

  function removeTransNodes(id) {
    if (!id) return;
    const nodes = document.querySelectorAll(selectorForId(id));
    for (let i = 0; i < nodes.length; i += 1) {
      const node = nodes[i];
      if (node.parentNode) node.parentNode.removeChild(node);
    }
  }

  function insertAfterOriginal(el, node, inline) {
    if (!el || !el.isConnected) return false;
    if (inline) {
      el.appendChild(node);
      return true;
    }
    if (!el.parentNode) return false;
    el.parentNode.insertBefore(node, el.nextSibling);
    return true;
  }

  function markOriginal(segment) {
    if (segment && segment.el) segment.el.setAttribute("data-ait-src", segment.id);
  }

  function clearOriginal(segment) {
    const el = segment && segment.el;
    if (!el) return;
    el.removeAttribute("data-ait-src");
    el.removeAttribute("data-ait-state");
    el.removeAttribute("data-ait-original");
    el.classList.remove("ait-original");
  }

  // ---------------------------------------------------------------- 渲染

  function mount(segment, text) {
    if (!segment || !segment.el || !segment.el.isConnected) return;
    const content = util.normalizeText(text);
    if (!content) return;
    removeTransNodes(segment.id);
    const inline = isInlineSegment(segment);
    const node = document.createElement(inline ? "span" : "div");
    node.className = inline ? "ait-trans" : "ait-trans ait-trans--block";
    node.setAttribute("data-ait-id", segment.id);
    if (!inline) node.setAttribute("data-ait-for", segment.id);
    node.setAttribute("data-ait-state", "done");
    node.textContent = content;
    if (!insertAfterOriginal(segment.el, node, inline)) return;
    applyHostTone(node, segment.el);
    segment.targetEl = node;
    segment.translation = content;
    markOriginal(segment);
    segment.el.removeAttribute("data-ait-state");
    updateOriginalVisibility(segment);
  }

  function markPending(segment) {
    if (!segment) return;
    removeTransNodes(segment.id);
    segment.targetEl = null;
    segment.translation = null;
    segment.state = "pending";
    if (segment.el) segment.el.setAttribute("data-ait-state", "pending");
  }

  function markError(segment, message) {
    if (!segment || !segment.el || !segment.el.isConnected) return;
    removeTransNodes(segment.id);
    const errorText = message || "翻译失败";
    const inline = isInlineSegment(segment);
    const node = document.createElement(inline ? "span" : "div");
    node.className = inline ? "ait-trans ait-error" : "ait-trans ait-trans--block ait-error";
    node.setAttribute("data-ait-id", segment.id);
    if (!inline) node.setAttribute("data-ait-for", segment.id);
    node.setAttribute("data-ait-state", "error");
    node.setAttribute("role", "button");
    node.setAttribute("tabindex", "0");
    node.setAttribute("title", errorText + "（点击重试）");
    node.setAttribute("aria-label", errorText + "，点击重试");
    node.textContent = "翻译失败 · 点击重试";
    if (!insertAfterOriginal(segment.el, node, inline)) return;
    applyHostTone(node, segment.el);
    segment.targetEl = node;
    segment.translation = null;
    segment.el.setAttribute("data-ait-src", segment.id);
    // 失败段不隐藏原文：否则仅译文模式下用户会丢失内容
    segment.el.removeAttribute("data-ait-original");
    segment.el.classList.remove("ait-original");
  }

  function unmount(segment) {
    if (!segment) return;
    const id = typeof segment === "string" ? segment : segment.id;
    removeTransNodes(id);
    if (typeof segment !== "string") {
      clearOriginal(segment);
      segment.targetEl = null;
      segment.translation = null;
    }
  }

  function unmountAll() {
    const nodes = document.querySelectorAll(".ait-trans");
    for (let i = 0; i < nodes.length; i += 1) {
      const node = nodes[i];
      if (node.parentNode) node.parentNode.removeChild(node);
    }
    const marked = document.querySelectorAll("[data-ait-src]");
    for (let i = 0; i < marked.length; i += 1) {
      marked[i].removeAttribute("data-ait-src");
      marked[i].removeAttribute("data-ait-state");
    }
    const originals = document.querySelectorAll("[data-ait-original]");
    for (let i = 0; i < originals.length; i += 1) {
      originals[i].removeAttribute("data-ait-original");
      originals[i].classList.remove("ait-original");
    }
    document.documentElement.classList.remove("ait-translation-only");
    destroyToast();
  }

  /** 仅译文模式：隐藏已渲染译文的原文（内联容器保持双语，避免隐藏译文自身） */
  function updateOriginalVisibility(segment) {
    const el = segment && segment.el;
    if (!el) return;
    if (isInlineSegment(segment)) {
      el.removeAttribute("data-ait-original");
      el.classList.remove("ait-original");
      return;
    }
    const hide =
      AIT.state.mode === "translation-only" &&
      segment.state === "done" &&
      !!segment.translation &&
      !segment.skipped;
    if (hide) {
      el.setAttribute("data-ait-original", "1");
      el.classList.add("ait-original");
    } else {
      el.removeAttribute("data-ait-original");
      el.classList.remove("ait-original");
    }
  }

  function applyMode(mode) {
    const next = mode === "translation-only" ? "translation-only" : "bilingual";
    AIT.state.mode = next;
    const root = document.documentElement;
    if (next === "translation-only") root.classList.add("ait-translation-only");
    else root.classList.remove("ait-translation-only");
    const list = AIT.state.segments || [];
    for (let i = 0; i < list.length; i += 1) updateOriginalVisibility(list[i]);
    AIT.bus.emit("mode", { mode: next });
  }

  // ---------------------------------------------------------------- toast

  function ensureToast() {
    if (toastEl && toastEl.isConnected) return toastEl;
    const root = document.createElement("div");
    root.className = "ait-toast";
    root.setAttribute("role", "status");
    root.setAttribute("aria-live", "polite");

    const row = document.createElement("div");
    row.className = "ait-toast__row";

    const mark = document.createElement("span");
    mark.className = "ait-toast__mark";
    mark.setAttribute("aria-hidden", "true");

    const text = document.createElement("span");
    text.className = "ait-toast__text";

    const action = document.createElement("button");
    action.className = "ait-toast__action";
    action.type = "button";
    action.addEventListener("click", onToastAction);

    const bar = document.createElement("div");
    bar.className = "ait-toast__bar";
    const fill = document.createElement("span");
    fill.className = "ait-toast__fill";
    bar.appendChild(fill);

    row.appendChild(mark);
    row.appendChild(text);
    row.appendChild(action);
    root.appendChild(row);
    root.appendChild(bar);
    (document.body || document.documentElement).appendChild(root);

    toastEl = root;
    toastTextEl = text;
    toastFillEl = fill;
    toastActionEl = action;
    return root;
  }

  function destroyToast() {
    if (toastHideTimer) {
      clearTimeout(toastHideTimer);
      toastHideTimer = null;
    }
    if (toastEl && toastEl.parentNode) toastEl.parentNode.removeChild(toastEl);
    toastEl = null;
    toastTextEl = null;
    toastFillEl = null;
    toastActionEl = null;
    toastMode = "busy";
  }

  function normalizeProgress(source) {
    const raw = source || {};
    const done = Number(raw.done != null ? raw.done : raw.translated) || 0;
    const total = Number(raw.total) || 0;
    const failed = Number(raw.failed) || 0;
    return { done: done, total: total, failed: failed, phase: raw.phase || null, error: raw.error || null };
  }

  function setFill(percent) {
    if (!toastFillEl) return;
    const value = Math.max(0, Math.min(100, percent));
    toastFillEl.style.width = value + "%";
  }

  function showToast() {
    if (!toastEl) return;
    if (toastHideTimer) {
      clearTimeout(toastHideTimer);
      toastHideTimer = null;
    }
    // 强制一次样式计算，保证从隐藏态进入时过渡生效
    void toastEl.offsetWidth;
    toastEl.classList.add("ait-toast--visible");
  }

  function hideToast() {
    if (!toastEl) return;
    if (toastHideTimer) {
      clearTimeout(toastHideTimer);
      toastHideTimer = null;
    }
    toastEl.classList.remove("ait-toast--visible");
  }

  function scheduleHide(ms) {
    if (toastHideTimer) clearTimeout(toastHideTimer);
    toastHideTimer = setTimeout(() => {
      toastHideTimer = null;
      hideToast();
    }, ms);
  }

  function showBusy(progress) {
    const p = normalizeProgress(progress);
    ensureToast();
    toastMode = "busy";
    toastEl.className = "ait-toast ait-toast--busy";
    toastTextEl.textContent = p.total > 0 ? "正在翻译 " + p.done + " / " + p.total : "正在准备翻译";
    toastActionEl.textContent = "停止";
    toastActionEl.hidden = false;
    setFill(p.total > 0 ? Math.max(2, Math.round((p.done / p.total) * 100)) : 4);
    showToast();
  }

  function showDone(summary) {
    const p = normalizeProgress(summary);
    if (p.done === 0 && p.failed > 0) {
      showError({ message: p.error || "翻译失败，请检查 API 设置。" });
      return;
    }
    ensureToast();
    toastMode = "done";
    if (p.failed > 0) {
      toastEl.className = "ait-toast ait-toast--failed";
      toastTextEl.textContent = "翻译完成 · " + p.done + " 段，失败 " + p.failed + " 段";
    } else {
      toastEl.className = "ait-toast ait-toast--done";
      toastTextEl.textContent = p.total > 0 ? "翻译完成 · " + p.done + " 段" : "没有可翻译的内容";
    }
    toastActionEl.textContent = "还原原文";
    toastActionEl.hidden = false;
    setFill(100);
    showToast();
    scheduleHide(p.failed > 0 ? TOAST_HIDE_FAILED_MS : TOAST_HIDE_DONE_MS);
  }

  function showError(payload) {
    ensureToast();
    toastMode = "error";
    const message = (payload && payload.message) || "翻译失败，请检查 API 设置。";
    toastEl.className = "ait-toast ait-toast--error";
    toastTextEl.textContent = message;
    toastActionEl.textContent = "知道了";
    toastActionEl.hidden = false;
    setFill(0);
    showToast();
    scheduleHide(TOAST_HIDE_ERROR_MS);
  }

  function updateToast(progress) {
    const p = normalizeProgress(progress);
    if (p.phase === "restore") {
      hideToast();
      return;
    }
    if (p.phase === "done") {
      showDone(p);
      return;
    }
    showBusy(p);
  }

  function onToastAction(event) {
    if (event) {
      event.preventDefault();
      event.stopPropagation();
    }
    if (toastMode === "error") {
      hideToast();
      return;
    }
    if (AIT.translator) void AIT.translator.restore();
  }

  // ---------------------------------------------------------------- 错误重试委托

  function errorNodeFromTarget(target) {
    if (!target || !target.closest) return null;
    return target.closest(".ait-error[data-ait-id]");
  }

  function retryFromErrorNode(node) {
    const id = node.getAttribute("data-ait-id");
    if (!id || !AIT.translator) return;
    void AIT.translator.retrySegment(id);
  }

  function onClick(event) {
    const node = errorNodeFromTarget(event.target);
    if (!node) return;
    event.preventDefault();
    event.stopPropagation();
    retryFromErrorNode(node);
  }

  function onKeyDown(event) {
    if (event.key !== "Enter" && event.key !== " " && event.key !== "Spacebar") return;
    const node = errorNodeFromTarget(event.target);
    if (!node) return;
    event.preventDefault();
    event.stopPropagation();
    retryFromErrorNode(node);
  }

  document.addEventListener("click", onClick, true);
  document.addEventListener("keydown", onKeyDown, true);

  // ---------------------------------------------------------------- 事件订阅

  AIT.bus.on("translate:start", (payload) => {
    showBusy({ done: 0, total: payload && payload.total, failed: 0 });
  });
  AIT.bus.on("progress", (progress) => updateToast(progress));
  AIT.bus.on("translate:done", (summary) => showDone(summary));
  AIT.bus.on("translate:error", (payload) => showError(payload));
  AIT.bus.on("restore", () => hideToast());

  AIT.renderer = {
    mount: mount,
    markPending: markPending,
    markError: markError,
    unmount: unmount,
    unmountAll: unmountAll,
    applyMode: applyMode,
    updateToast: updateToast,
    hideToast: hideToast,
  };

  AIT.log("renderer ready");
})();
