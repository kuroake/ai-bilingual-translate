/**
 * 50-observer.js —— 增量观察与 SPA 路由。
 *
 * 职责：
 * - MutationObserver 监听新增节点，防抖 600ms 后把新内容交给 translator 增量翻译；
 * - 只处理新增节点，不整页重扫；
 * - SPA 路由（pushState / replaceState / popstate / hashchange）变化后 refresh() 重新扫描；
 * - 翻译进行中由 translator 调用 start()，结束调用 stop()。
 *
 * 依赖：00-core.js、20-translator.js（运行时调用）。
 */
(() => {
  "use strict";
  const AIT = window.AIT;
  const util = AIT.util;
  if (!util) return;
  // 幂等守卫：popup / background 可能对同一页面重复动态注入，已初始化则直接跳过
  if (AIT.observer) return;

  const DEBOUNCE_MS = 600;
  const ROUTE_DEBOUNCE_MS = 400;

  /** 这些标签的新增节点内容不参与翻译观察 */
  const IGNORE_TAGS = new Set([
    "SCRIPT", "STYLE", "NOSCRIPT", "TEMPLATE", "SVG", "CANVAS", "IFRAME",
    "LINK", "META", "HEAD", "TITLE",
  ]);

  let mo = null;
  let active = false;
  let flushTimer = null;
  let routeTimer = null;
  let routesHooked = false;
  const pendingNodes = new Set();

  function isIgnoredNode(node) {
    if (!node || node.nodeType !== 1) return true;
    const tag = node.tagName;
    if (IGNORE_TAGS.has(tag)) return true;
    if (node.classList && (node.classList.contains("ait-trans") || node.classList.contains("ait-toast"))) return true;
    if (node.id === "ait-selection-root") return true;
    if (node.hasAttribute("data-ait-ignore")) return true;
    if (node.closest && node.closest(".ait-trans, .ait-toast, #ait-selection-root, [data-ait-ignore]")) return true;
    return false;
  }

  function onMutations(mutations) {
    if (!active) return;
    for (let i = 0; i < mutations.length; i += 1) {
      const mutation = mutations[i];
      if (mutation.type !== "childList") continue;
      const added = mutation.addedNodes;
      for (let j = 0; j < added.length; j += 1) {
        const node = added[j];
        if (node.nodeType !== 1) continue;
        if (isIgnoredNode(node)) continue;
        pendingNodes.add(node);
      }
    }
    if (pendingNodes.size) scheduleFlush();
  }

  function scheduleFlush() {
    if (flushTimer) clearTimeout(flushTimer);
    flushTimer = setTimeout(flush, DEBOUNCE_MS);
  }

  function flush() {
    flushTimer = null;
    if (!active) {
      pendingNodes.clear();
      return;
    }
    const nodes = [];
    pendingNodes.forEach((node) => {
      if (node.isConnected) nodes.push(node);
    });
    pendingNodes.clear();
    if (!nodes.length) return;
    if (!AIT.state.translating && !AIT.state.translated) return;
    // 去掉祖先也在列表里的节点，避免重复扫描
    const roots = nodes.filter((node) => {
      for (let i = 0; i < nodes.length; i += 1) {
        const other = nodes[i];
        if (other !== node && other.contains(node)) return false;
      }
      return true;
    });
    if (!roots.length) return;
    if (AIT.translator && AIT.translator.translateElements) {
      void AIT.translator.translateElements(roots);
    }
  }

  function start() {
    if (!AIT.state.translating && !AIT.state.translated) return;
    active = true;
    hookRoutes();
    if (mo) return;
    const target = document.body || document.documentElement;
    if (!target) return;
    mo = new MutationObserver(onMutations);
    mo.observe(target, { childList: true, subtree: true });
    AIT.log("observer started");
  }

  function stop() {
    active = false;
    if (mo) {
      mo.disconnect();
      mo = null;
    }
    pendingNodes.clear();
    if (flushTimer) {
      clearTimeout(flushTimer);
      flushTimer = null;
    }
    AIT.log("observer stopped");
  }

  /** 路由变化 / 手动触发后重新扫描（只翻译新增内容） */
  function refresh() {
    if (!AIT.state.translated && !AIT.state.translating) return;
    AIT.state.pageUrl = location.href;
    if (AIT.translator && AIT.translator.translateElements) {
      void AIT.translator.translateElements([document.body || document.documentElement]);
    }
  }

  function onRouteChange() {
    if (routeTimer) clearTimeout(routeTimer);
    routeTimer = setTimeout(() => {
      routeTimer = null;
      refresh();
    }, ROUTE_DEBOUNCE_MS);
  }

  /** 包装 history API + 监听 popstate/hashchange；只做一次，不改变宿主行为 */
  function hookRoutes() {
    if (routesHooked) return;
    routesHooked = true;
    try {
      const wrap = (name) => {
        const original = history[name];
        if (typeof original !== "function") return;
        history[name] = function patchedHistory() {
          const result = original.apply(this, arguments);
          onRouteChange();
          return result;
        };
      };
      wrap("pushState");
      wrap("replaceState");
    } catch (error) {
      AIT.log("hook history failed", error);
    }
    window.addEventListener("popstate", onRouteChange);
    window.addEventListener("hashchange", onRouteChange);
  }

  AIT.observer = {
    start: start,
    stop: stop,
    refresh: refresh,
  };

  AIT.log("observer ready");
})();
