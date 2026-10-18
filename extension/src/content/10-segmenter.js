/**
 * 10-segmenter.js —— DOM 文本块扫描与分段。
 *
 * 职责：把页面切成「可翻译段落」，每段一个 Segment。
 * 规则（见 docs/ARCHITECTURE.md §6）：
 * - 白名单块级容器：p、h1-h6、li、dd、dt、blockquote、figcaption、td、th、caption、summary；
 * - 无块级子元素且含可译文本的 div / section / article 叶子容器；
 * - 跳过 script/style/... 等、代码（受 skipCode 控制）、隐藏、可编辑、已有译文、纯符号、过短文本；
 * - 文本取元素自身的内联文本（排除子块与译文节点），normalize 空白；
 * - 支持视口优先排序。
 *
 * 依赖：00-core.js（AIT.util），不修改 00-core.js。
 */
(() => {
  "use strict";
  const AIT = (window.AIT = window.AIT || {});
  const util = AIT.util;
  if (!util) return;
  // 幂等守卫：popup / background 可能对同一页面重复动态注入，已初始化则直接跳过
  if (AIT.segmenter) return;

  /** 白名单块级容器：元素自身就是一个翻译单元 */
  const BLOCK_TAGS = new Set([
    "P", "H1", "H2", "H3", "H4", "H5", "H6",
    "LI", "DD", "DT", "BLOCKQUOTE", "FIGCAPTION",
    "TD", "TH", "CAPTION", "SUMMARY",
  ]);

  /** 无块级子元素时整块翻译的通用容器 */
  const LEAF_TAGS = new Set(["DIV", "SECTION", "ARTICLE"]);

  /** 整棵子树都不参与翻译的标签 */
  const SKIP_TAGS = new Set([
    "SCRIPT", "STYLE", "NOSCRIPT", "TEMPLATE", "SVG", "CANVAS", "IFRAME",
    "TEXTAREA", "SELECT", "OPTION", "INPUT", "LINK", "META", "HEAD",
  ]);

  /** 代码类标签（skipCode 为真时整棵跳过） */
  const CODE_TAGS = new Set(["CODE", "PRE", "KBD", "SAMP"]);

  /** 常见块级标签（快速判断，避免逐个 getComputedStyle） */
  const BLOCK_DISPLAY_TAGS = new Set([
    "ADDRESS", "ARTICLE", "ASIDE", "BLOCKQUOTE", "BODY", "CAPTION", "DD",
    "DETAILS", "DIALOG", "DIV", "DL", "DT", "FIELDSET", "FIGCAPTION", "FIGURE",
    "FOOTER", "FORM", "H1", "H2", "H3", "H4", "H5", "H6", "HEADER", "HGROUP",
    "HR", "HTML", "LI", "MAIN", "NAV", "OL", "P", "PRE", "SECTION", "SUMMARY",
    "TABLE", "TBODY", "TD", "TFOOT", "TH", "THEAD", "TR", "UL",
  ]);

  /** 至少含一个「词」字符才值得翻译（纯符号、编号等跳过） */
  const WORD_RE = new RegExp(
    "[A-Za-z\\u00C0-\\u024F\\u0370-\\u052F\\u0590-\\u06FF" +
    "\\u0900-\\u0DFF\\u0E00-\\u0E7F\\u3040-\\u30FF" +
    "\\u3400-\\u4DBF\\u4E00-\\u9FFF\\uAC00-\\uD7AF]"
  );

  /** 元素 -> Segment（同元素只对应最新一次收集结果） */
  const segmentByEl = new WeakMap();
  /** id -> Segment，供 segmentOf 查询译文节点 */
  const segmentById = new Map();

  function normalizeIdOptions(options) {
    const opts = options || {};
    return {
      minTextLength: typeof opts.minTextLength === "number" ? Math.max(1, opts.minTextLength) : 2,
      skipCode: opts.skipCode !== false,
      includeRoot: opts.includeRoot !== false,
    };
  }

  /** 稳定 id：同一文本同一 id（重复文本由 collect 追加序号保证唯一） */
  function idFor(el, text) {
    const normalized = util.normalizeText(text);
    return util.hash(normalized || (el && el.tagName ? el.tagName : ""));
  }

  /** 元素自身是否隐藏（display:none 的子树整棵剪掉） */
  function isSubtreeHidden(el) {
    if (!el.isConnected) return true;
    if (el.hasAttribute("hidden")) return true;
    if (el.getAttribute("aria-hidden") === "true") return true;
    const style = window.getComputedStyle(el);
    if (style.display === "none") return true;
    if (style.contentVisibility === "hidden") return true;
    return false;
  }

  /** 元素自身或祖先命中跳过规则（标签/类/属性/可编辑/已有译文） */
  function isSkippedElement(el, opts) {
    const tag = el.tagName;
    if (SKIP_TAGS.has(tag)) return true;
    if (opts.skipCode && CODE_TAGS.has(tag)) return true;
    // 已经处理过的段落（含失败标记）不再重复收集
    if (el.hasAttribute("data-ait-src")) return true;
    if (el.hasAttribute("data-ait-ignore")) return true;
    if (el.getAttribute("translate") === "no") return true;
    if (el.classList.contains("notranslate")) return true;
    if (el.classList.contains("ait-trans") || el.classList.contains("ait-toast")) return true;
    if (el.id === "ait-selection-root") return true;
    if (el.isContentEditable) return true;
    return false;
  }

  /** 提取元素自身的内联文本：跳过子块、译文节点、脚本样式与显式跳过内容 */
  function extractText(el) {
    const parts = [];
    collectText(el, parts);
    // 按 DOM 原文直接拼接（不额外插入空格），空白交给 normalizeText 收敛，
    // 这样 <em>word</em>: 之类内联边界不会被拼成 "word :"。
    return util.normalizeText(parts.join(""));
  }

  function collectText(node, parts) {
    for (let child = node.firstChild; child; child = child.nextSibling) {
      if (child.nodeType === 3) {
        parts.push(child.nodeValue);
        continue;
      }
      if (child.nodeType !== 1) continue;
      if (isTextSkippedElement(child)) continue;
      const tag = child.tagName;
      if (tag === "BR" || tag === "WBR") {
        // 换行在视觉上是词间分隔，补一个空格
        parts.push(" ");
        continue;
      }
      collectText(child, parts);
    }
  }

  function isTextSkippedElement(el) {
    const tag = el.tagName;
    if (SKIP_TAGS.has(tag)) return true;
    if (tag === "BR" || tag === "WBR") return false;
    if (el.classList.contains("ait-trans") || el.classList.contains("ait-toast")) return true;
    if (el.hasAttribute("data-ait-ignore")) return true;
    if (el.getAttribute("aria-hidden") === "true") return true;
    if (el.hasAttribute("hidden")) return true;
    if (el.getAttribute("translate") === "no") return true;
    if (el.classList.contains("notranslate")) return true;
    if (el.id === "ait-selection-root") return true;
    if (el.style && el.style.display === "none") return true;
    return false;
  }

  /** 子元素里是否有块级盒（块级子元素说明父级不是「叶子容器」） */
  function hasBlockLevelChild(el, parentDisplay) {
    const children = el.children;
    if (!children.length) return false;
    // flex / grid 的子元素全部被块级化，父级不整体翻译
    if (/^(flex|grid|inline-flex|inline-grid)$/.test(parentDisplay || "")) return true;
    for (let i = 0; i < children.length; i += 1) {
      if (isBlockLike(children[i])) return true;
    }
    return false;
  }

  function isBlockLike(el) {
    const tag = el.tagName;
    if (BLOCK_DISPLAY_TAGS.has(tag)) return true;
    const display = window.getComputedStyle(el).display;
    if (!display || display === "none") return false;
    if (display === "contents" || display.indexOf("inline") === 0) return false;
    if (display === "ruby" || display === "ruby-text") return false;
    return true;
  }

  function isTranslatable(text, opts) {
    if (!text || text.length < opts.minTextLength) return false;
    if (util.looksTranslated(text)) return false;
    if (!WORD_RE.test(text)) return false;
    return true;
  }

  function buildSegment(el, text, order, seen) {
    const base = idFor(el, text);
    let id = base;
    let suffix = 2;
    while (seen.has(id)) {
      id = base + "-" + suffix;
      suffix += 1;
    }
    seen.add(id);
    const segment = {
      id: id,
      el: el,
      text: text,
      order: order,
      rect: null,
      state: "pending",
      translation: null,
      targetEl: null,
    };
    segmentByEl.set(el, segment);
    segmentById.set(id, segment);
    return segment;
  }

  function scanElement(el, out, opts, seen) {
    if (!el || el.nodeType !== 1) return;
    if (isSkippedElement(el, opts)) return;
    if (isSubtreeHidden(el)) return;

    const style = window.getComputedStyle(el);
    const tag = el.tagName;
    const isCandidate = BLOCK_TAGS.has(tag) || LEAF_TAGS.has(tag);
    if (!isCandidate) {
      const children = el.children;
      for (let i = 0; i < children.length; i += 1) scanElement(children[i], out, opts, seen);
      return;
    }
    if (hasBlockLevelChild(el, style.display)) {
      // 不是叶子：由子块各自成段
      const children = el.children;
      for (let i = 0; i < children.length; i += 1) scanElement(children[i], out, opts, seen);
      return;
    }
    const text = extractText(el);
    if (isTranslatable(text, opts)) out.push(buildSegment(el, text, out.length, seen));
  }

  /**
   * 收集 root 下的可翻译段落（文档顺序）。
   * @param {Element|Document} root
   * @param {{minTextLength?:number, skipCode?:boolean, includeRoot?:boolean}} options
   * @returns {Array} Segment[]
   */
  function collect(root, options) {
    const opts = normalizeIdOptions(options);
    const out = [];
    const seen = new Set();
    let rootEl = root || document.body;
    if (rootEl && rootEl.nodeType === 9) rootEl = rootEl.body || rootEl.documentElement;
    if (!rootEl || rootEl.nodeType !== 1) return out;
    if (opts.includeRoot) {
      scanElement(rootEl, out, opts, seen);
    } else {
      const children = rootEl.children;
      for (let i = 0; i < children.length; i += 1) scanElement(children[i], out, opts, seen);
    }
    return out;
  }

  /** 通过 DOM 元素反查已生成的段落（原文元素或译文节点均可） */
  function segmentOf(el) {
    if (!el || el.nodeType !== 1) return null;
    const direct = segmentByEl.get(el);
    if (direct) return direct;
    const trans = el.closest ? el.closest(".ait-trans") : null;
    if (trans) {
      const id = trans.getAttribute("data-ait-id");
      if (id && segmentById.has(id)) return segmentById.get(id);
    }
    return null;
  }

  /** 按 id 查找段落 */
  function byId(id) {
    return segmentById.get(id) || null;
  }

  /**
   * 视口优先排序：视口内的段落按 top 从近到远排在前面，其余保持文档顺序。
   * 不修改入参数组，返回新数组。
   */
  function sortByViewport(list) {
    const segments = Array.isArray(list) ? list.slice() : [];
    const viewport = [];
    const rest = [];
    const viewportHeight = window.innerHeight || document.documentElement.clientHeight || 0;
    for (let i = 0; i < segments.length; i += 1) {
      const segment = segments[i];
      const el = segment && segment.el;
      if (!el || !el.getBoundingClientRect) {
        rest.push(segment);
        continue;
      }
      const rect = el.getBoundingClientRect();
      segment.rect = rect;
      if (rect.bottom >= 0 && rect.top <= viewportHeight) viewport.push(segment);
      else rest.push(segment);
    }
    viewport.sort((a, b) => {
      const ra = a.rect || { top: 0 };
      const rb = b.rect || { top: 0 };
      return ra.top - rb.top || a.order - b.order;
    });
    rest.sort((a, b) => a.order - b.order);
    return viewport.concat(rest);
  }

  /** 清空 id 索引（还原 / 重新扫描时调用） */
  function reset() {
    segmentById.clear();
  }

  AIT.segmenter = {
    collect: collect,
    segmentOf: segmentOf,
    idFor: idFor,
    byId: byId,
    sortByViewport: sortByViewport,
    reset: reset,
  };

  AIT.log("segmenter ready");
})();
