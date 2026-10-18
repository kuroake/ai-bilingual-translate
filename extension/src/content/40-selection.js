/**
 * 40-selection.js — 划词翻译浮层（Shadow DOM 完全隔离）。
 *
 * 职责：
 *   1. 监听选区，在选区右下角显示圆形朱砂按钮 .ait-sel-trigger（文案「译」）；
 *   2. 点击按钮弹出 .ait-sel-card 卡片，经 chrome.runtime.connect({ name: "ait-stream" })
 *      流式展示译文，支持复制、关闭、Esc、点击外部关闭；
 *   3. 目标语言切换（页面会话内记忆）、原文折叠、思考过程折叠、错误重试、autoPopup；
 *   4. 若运行环境没有 chrome.runtime.connect（如离线测试页），降级为一次性消息
 *      ait:translate.text 的非流式翻译。
 *
 * 依赖：00-core.js（AIT.util / AIT.bus / AIT.runtimeSend / AIT.state）。
 * 对外接口（供 90-main.js 调用）：
 *   AIT.selection.init() / open(text, rect) / close() / isEnabled() / applySettings(settings)
 *
 * 全部 UI 节点位于 #ait-selection-root 宿主内，样式全部内联在 shadow root 中，
 * 不读取、不写入页面样式，也不依赖 content.css。
 */
(() => {
  "use strict";

  const AIT = (window.AIT = window.AIT || {});
  if (!AIT.util) return;
  if (AIT.selection && AIT.selection.__aitSelection) return;

  const util = AIT.util;

  // ===== 常量 =====

  const HOST_ID = "ait-selection-root";
  const PORT_NAME = "ait-stream";
  const HOST_Z_INDEX = "2147483000";
  const TRIGGER_SIZE = 30;
  const GAP_TRIGGER = 6;
  const GAP_CARD = 10;
  const VIEW_MARGIN = 12;
  const AUTO_POPUP_DELAY = 320;
  const SELECTION_DEBOUNCE = 220;
  const COPY_FEEDBACK_MS = 1400;

  /** 与 shared/config.js 的 LANGUAGES 保持一致（content script 不能 import ES Module）。 */
  const LANG_CODES = [
    "zh-CN",
    "zh-TW",
    "en",
    "ja",
    "ko",
    "fr",
    "de",
    "es",
    "ru",
    "pt",
    "it",
    "ar",
    "vi",
    "th",
  ];

  const DEFAULT_SELECTION = {
    enabled: true,
    autoPopup: false,
    targetLang: "",
    showOriginal: true,
    stream: true,
    maxChars: 6000,
  };

  /** 内联 SVG 图标：1.5px 描边，禁用 emoji。 */
  const ICONS = {
    chevronRight:
      '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" focusable="false"><path d="M6.25 3.75L10.5 8l-4.25 4.25"></path></svg>',
    chevronDown:
      '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" focusable="false"><path d="M4.25 6.25L8 10l3.75-3.75"></path></svg>',
    copy:
      '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" focusable="false"><rect x="5.75" y="5.75" width="7.5" height="7.5" rx="1.5"></rect><path d="M10.25 5.75V3.5A1.5 1.5 0 0 0 8.75 2H3.5A1.5 1.5 0 0 0 2 3.5v5.25a1.5 1.5 0 0 0 1.5 1.5h2.25"></path></svg>',
    check:
      '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" focusable="false"><path d="M3.25 8.5l3.1 3.1 6.4-7.2"></path></svg>',
    close:
      '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" focusable="false"><path d="M3.75 3.75l8.5 8.5M12.25 3.75l-8.5 8.5"></path></svg>',
    retry:
      '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" focusable="false"><path d="M13.25 8a5.25 5.25 0 1 1-1.6-3.78"></path><path d="M13.5 2.6v3.6H9.9"></path></svg>',
  };

  // ===== Shadow DOM 内联样式 =====
  // 设计语言：校样批注。纸色底、朱砂唯一强调色、无渐变、无发光、无 emoji。
  // 变量定义在 :host 上，暗色由 prefers-color-scheme 与 settings.ui.theme 共同决定。

  const CSS_TEXT = [
    "/* --- 设计变量（纸 / 墨 / 朱砂） --- */",
    ":host {",
    "  --ait-paper: #fbfaf7;",
    "  --ait-card: #fffdf8;",
    "  --ait-card-2: #f5f1e8;",
    "  --ait-line: #e3ddd1;",
    "  --ait-line-2: #d2cab9;",
    "  --ait-ink: #221d16;",
    "  --ait-ink-2: #5f574a;",
    "  --ait-ink-3: #8d8475;",
    "  --ait-accent: #c2410c;",
    "  --ait-accent-2: #a3360a;",
    "  --ait-accent-soft: rgba(194, 65, 12, 0.08);",
    "  --ait-accent-line: rgba(194, 65, 12, 0.3);",
    "  --ait-shadow: 0 1px 2px rgba(34, 29, 22, 0.05), 0 10px 28px rgba(34, 29, 22, 0.14);",
    '  --ait-font: system-ui, -apple-system, "PingFang SC", "Microsoft YaHei", sans-serif;',
    '  --ait-serif: Georgia, "Songti SC", "SimSun", serif;',
    '  --ait-mono: ui-monospace, "SFMono-Regular", Consolas, monospace;',
    "  --ait-radius: 10px;",
    "  all: initial;",
    "  position: fixed;",
    "  top: 0;",
    "  left: 0;",
    "  width: 0;",
    "  height: 0;",
    "  overflow: visible;",
    "  pointer-events: none;",
    "  direction: ltr;",
    "  color-scheme: light;",
    "}",
    "",
    "@media (prefers-color-scheme: dark) {",
    "  :host {",
    "    --ait-paper: #15140f;",
    "    --ait-card: #1e1c16;",
    "    --ait-card-2: #262319;",
    "    --ait-line: #353128;",
    "    --ait-line-2: #484234;",
    "    --ait-ink: #ece6da;",
    "    --ait-ink-2: #b3ab9b;",
    "    --ait-ink-3: #8a8274;",
    "    --ait-accent: #fb923c;",
    "    --ait-accent-2: #fdba74;",
    "    --ait-accent-soft: rgba(251, 146, 60, 0.14);",
    "    --ait-accent-line: rgba(251, 146, 60, 0.34);",
    "    --ait-shadow: 0 1px 2px rgba(0, 0, 0, 0.4), 0 12px 32px rgba(0, 0, 0, 0.5);",
    "    color-scheme: dark;",
    "  }",
    "}",
    "",
    "/* 设置页强制亮色（优先于系统暗色） */",
    ':host([data-theme="light"]) {',
    "  --ait-paper: #fbfaf7;",
    "  --ait-card: #fffdf8;",
    "  --ait-card-2: #f5f1e8;",
    "  --ait-line: #e3ddd1;",
    "  --ait-line-2: #d2cab9;",
    "  --ait-ink: #221d16;",
    "  --ait-ink-2: #5f574a;",
    "  --ait-ink-3: #8d8475;",
    "  --ait-accent: #c2410c;",
    "  --ait-accent-2: #a3360a;",
    "  --ait-accent-soft: rgba(194, 65, 12, 0.08);",
    "  --ait-accent-line: rgba(194, 65, 12, 0.3);",
    "  --ait-shadow: 0 1px 2px rgba(34, 29, 22, 0.05), 0 10px 28px rgba(34, 29, 22, 0.14);",
    "  color-scheme: light;",
    "}",
    "",
    "/* 设置页强制暗色 */",
    ':host([data-theme="dark"]) {',
    "  --ait-paper: #15140f;",
    "  --ait-card: #1e1c16;",
    "  --ait-card-2: #262319;",
    "  --ait-line: #353128;",
    "  --ait-line-2: #484234;",
    "  --ait-ink: #ece6da;",
    "  --ait-ink-2: #b3ab9b;",
    "  --ait-ink-3: #8a8274;",
    "  --ait-accent: #fb923c;",
    "  --ait-accent-2: #fdba74;",
    "  --ait-accent-soft: rgba(251, 146, 60, 0.14);",
    "  --ait-accent-line: rgba(251, 146, 60, 0.34);",
    "  --ait-shadow: 0 1px 2px rgba(0, 0, 0, 0.4), 0 12px 32px rgba(0, 0, 0, 0.5);",
    "  color-scheme: dark;",
    "}",
    "",
    "/* --- 基础重置（shadow root 内自给自足，不继承页面样式） --- */",
    "*, *::before, *::after {",
    "  box-sizing: border-box;",
    "  margin: 0;",
    "  padding: 0;",
    "  border: 0;",
    "  font-family: var(--ait-font);",
    "  font-size: inherit;",
    "  font-weight: inherit;",
    "  line-height: inherit;",
    "  color: inherit;",
    "  background: transparent;",
    "  -webkit-tap-highlight-color: transparent;",
    "}",
    "",
    "[hidden] {",
    "  display: none !important;",
    "}",
    "",
    "button {",
    "  cursor: pointer;",
    "  -webkit-user-select: none;",
    "  user-select: none;",
    "}",
    "",
    "svg {",
    "  display: block;",
    "  flex: none;",
    "}",
    "",
    "summary {",
    "  cursor: pointer;",
    "  list-style: none;",
    "  -webkit-user-select: none;",
    "  user-select: none;",
    "}",
    "",
    "summary::-webkit-details-marker {",
    "  display: none;",
    "}",
    "",
    "/* --- 焦点：2px 朱砂 outline，offset 2px --- */",
    "button:focus-visible,",
    "select:focus-visible,",
    "summary:focus-visible {",
    "  outline: 2px solid var(--ait-accent);",
    "  outline-offset: 2px;",
    "}",
    "",
    "/* --- 触发按钮：朱砂圆点，文案「译」 --- */",
    ".ait-sel-trigger {",
    "  position: fixed;",
    "  z-index: 3;",
    "  display: block;",
    "  width: 30px;",
    "  height: 30px;",
    "  padding: 0;",
    "  border-radius: 50%;",
    "  background: var(--ait-accent);",
    "  color: #fdfaf4;",
    "  font-family: var(--ait-serif);",
    "  font-size: 14px;",
    "  font-weight: 600;",
    "  line-height: 30px;",
    "  text-align: center;",
    "  box-shadow: 0 1px 2px rgba(34, 29, 22, 0.2), 0 3px 10px rgba(34, 29, 22, 0.18);",
    "  opacity: 0;",
    "  transform: translateY(-2px) scale(0.96);",
    "  transition: opacity 140ms ease, transform 140ms ease, background-color 140ms ease;",
    "  pointer-events: auto;",
    "}",
    "",
    ".ait-sel-trigger.is-visible {",
    "  opacity: 1;",
    "  transform: translateY(0) scale(1);",
    "}",
    "",
    ".ait-sel-trigger:hover {",
    "  background: var(--ait-accent-2);",
    "}",
    "",
    ".ait-sel-trigger:active {",
    "  transform: scale(0.94);",
    "}",
    "",
    "/* --- 卡片：纸面批注条 --- */",
    ".ait-sel-card {",
    "  position: fixed;",
    "  z-index: 2;",
    "  display: flex;",
    "  flex-direction: column;",
    "  width: 380px;",
    "  max-width: calc(100vw - 24px);",
    "  max-height: calc(100vh - 24px);",
    "  background: var(--ait-card);",
    "  color: var(--ait-ink);",
    "  font-family: var(--ait-font);",
    "  font-size: 13px;",
    "  line-height: 1.65;",
    "  border: 1px solid var(--ait-line);",
    "  border-radius: var(--ait-radius);",
    "  box-shadow: var(--ait-shadow);",
    "  overflow: hidden;",
    "  pointer-events: auto;",
    "  opacity: 0;",
    "  transform: translateY(4px);",
    "  transition: opacity 150ms ease, transform 150ms ease;",
    "  color-scheme: light;",
    "}",
    "",
    ".ait-sel-card.is-visible {",
    "  opacity: 1;",
    "  transform: translateY(0);",
    "}",
    "",
    ".ait-sel-card:focus {",
    "  outline: none;",
    "}",
    "",
    "/* 卡片头部 */",
    ".ait-sel-head {",
    "  display: flex;",
    "  align-items: center;",
    "  gap: 8px;",
    "  flex: none;",
    "  padding: 8px 10px 8px 12px;",
    "  border-bottom: 1px solid var(--ait-line);",
    "  background: var(--ait-card);",
    "}",
    "",
    ".ait-sel-brand {",
    "  display: flex;",
    "  align-items: baseline;",
    "  gap: 7px;",
    "  flex: 1 1 auto;",
    "  min-width: 0;",
    "}",
    "",
    ".ait-sel-mark {",
    "  align-self: center;",
    "  width: 3px;",
    "  height: 14px;",
    "  flex: none;",
    "  border-radius: 1px;",
    "  background: var(--ait-accent);",
    "}",
    "",
    ".ait-sel-title {",
    "  flex: none;",
    "  font-family: var(--ait-serif);",
    "  font-size: 13.5px;",
    "  font-weight: 600;",
    "  letter-spacing: 0.02em;",
    "  white-space: nowrap;",
    "  color: var(--ait-ink);",
    "}",
    "",
    ".ait-sel-model {",
    "  min-width: 0;",
    "  overflow: hidden;",
    "  text-overflow: ellipsis;",
    "  white-space: nowrap;",
    "  padding-left: 8px;",
    "  border-left: 1px solid var(--ait-line-2);",
    "  font-family: var(--ait-mono);",
    "  font-size: 10.5px;",
    "  line-height: 12px;",
    "  color: var(--ait-ink-3);",
    "}",
    "",
    ".ait-sel-actions {",
    "  display: flex;",
    "  align-items: center;",
    "  gap: 2px;",
    "  flex: none;",
    "}",
    "",
    ".ait-sel-icon-btn {",
    "  display: inline-flex;",
    "  align-items: center;",
    "  justify-content: center;",
    "  width: 26px;",
    "  height: 26px;",
    "  border-radius: 6px;",
    "  color: var(--ait-ink-3);",
    "  transition: background-color 140ms ease, color 140ms ease;",
    "}",
    "",
    ".ait-sel-icon-btn:hover {",
    "  background: var(--ait-card-2);",
    "  color: var(--ait-ink);",
    "}",
    "",
    ".ait-sel-icon-btn svg {",
    "  width: 15px;",
    "  height: 15px;",
    "}",
    "",
    ".ait-sel-icon-btn.is-ok {",
    "  color: var(--ait-accent);",
    "}",
    "",
    "/* 原文折叠区 */",
    ".ait-sel-source {",
    "  flex: none;",
    "  padding: 8px 12px 8px;",
    "  border-bottom: 1px solid var(--ait-line);",
    "  background: var(--ait-paper);",
    "}",
    "",
    ".ait-sel-fold {",
    "  display: inline-flex;",
    "  align-items: center;",
    "  gap: 5px;",
    "  padding: 2px 4px 2px 0;",
    "  border-radius: 4px;",
    "  font-size: 11px;",
    "  font-weight: 500;",
    "  letter-spacing: 0.04em;",
    "  color: var(--ait-ink-3);",
    "  transition: color 140ms ease;",
    "}",
    "",
    ".ait-sel-fold:hover {",
    "  color: var(--ait-ink-2);",
    "}",
    "",
    ".ait-sel-chev {",
    "  display: inline-flex;",
    "  color: var(--ait-ink-3);",
    "}",
    "",
    ".ait-sel-chev svg {",
    "  width: 11px;",
    "  height: 11px;",
    "  transition: transform 140ms ease;",
    "}",
    "",
    '.ait-sel-fold[aria-expanded="true"] .ait-sel-chev svg {',
    "  transform: rotate(90deg);",
    "}",
    "",
    ".ait-sel-count {",
    "  font-family: var(--ait-mono);",
    "  font-size: 10px;",
    "  font-weight: 400;",
    "  letter-spacing: 0;",
    "  color: var(--ait-ink-3);",
    "}",
    "",
    ".ait-sel-source-text {",
    "  margin-top: 3px;",
    "  max-height: 84px;",
    "  overflow-y: auto;",
    "  font-size: 12px;",
    "  line-height: 1.62;",
    "  color: var(--ait-ink-2);",
    "  white-space: pre-wrap;",
    "  overflow-wrap: anywhere;",
    "  -webkit-user-select: text;",
    "  user-select: text;",
    "}",
    "",
    "/* 目标语言行 */",
    ".ait-sel-langrow {",
    "  display: flex;",
    "  align-items: center;",
    "  gap: 8px;",
    "  flex: none;",
    "  padding: 7px 12px 8px;",
    "  border-bottom: 1px solid var(--ait-line);",
    "}",
    "",
    ".ait-sel-lang-label {",
    "  flex: none;",
    "  font-size: 11px;",
    "  letter-spacing: 0.04em;",
    "  color: var(--ait-ink-3);",
    "}",
    "",
    ".ait-sel-select-wrap {",
    "  position: relative;",
    "  display: inline-flex;",
    "  align-items: center;",
    "}",
    "",
    ".ait-sel-select {",
    "  -webkit-appearance: none;",
    "  appearance: none;",
    "  height: 26px;",
    "  padding: 0 24px 0 8px;",
    "  border: 1px solid var(--ait-line);",
    "  border-radius: 6px;",
    "  background: var(--ait-card-2);",
    "  color: var(--ait-ink);",
    "  font-family: var(--ait-font);",
    "  font-size: 12px;",
    "  line-height: 24px;",
    "  cursor: pointer;",
    "}",
    "",
    ".ait-sel-select:hover {",
    "  border-color: var(--ait-line-2);",
    "}",
    "",
    ".ait-sel-select-arrow {",
    "  position: absolute;",
    "  right: 7px;",
    "  top: 50%;",
    "  margin-top: -5.5px;",
    "  color: var(--ait-ink-3);",
    "  pointer-events: none;",
    "}",
    "",
    ".ait-sel-select-arrow svg {",
    "  width: 11px;",
    "  height: 11px;",
    "}",
    "",
    ".ait-sel-truncated {",
    "  margin-left: auto;",
    "  font-size: 10.5px;",
    "  color: var(--ait-accent);",
    "  white-space: nowrap;",
    "}",
    "",
    "/* 输出区 */",
    ".ait-sel-output {",
    "  flex: 1 1 auto;",
    "  min-height: 0;",
    "  padding: 10px 12px 12px;",
    "  overflow-y: auto;",
    "  overflow-x: hidden;",
    "}",
    "",
    ".ait-sel-placeholder {",
    "  display: flex;",
    "  align-items: center;",
    "  gap: 7px;",
    "  font-size: 12px;",
    "  color: var(--ait-ink-3);",
    "}",
    "",
    ".ait-sel-placeholder::before {",
    '  content: "";',
    "  width: 2px;",
    "  height: 12px;",
    "  border-radius: 1px;",
    "  background: var(--ait-accent);",
    "  animation: ait-sel-caret 1.1s steps(1, end) infinite;",
    "}",
    "",
    "/* 译文：左侧 2px 朱砂批注线（与全页译文一致的核心隐喻） */",
    ".ait-sel-translation {",
    "  padding: 1px 0 1px 10px;",
    "  border-left: 2px solid var(--ait-accent);",
    "  font-size: 13.5px;",
    "  line-height: 1.72;",
    "  color: var(--ait-ink);",
    "  white-space: pre-wrap;",
    "  overflow-wrap: anywhere;",
    "  -webkit-user-select: text;",
    "  user-select: text;",
    "}",
    "",
    ".ait-sel-translation:empty {",
    "  padding: 0;",
    "  border-left: 0;",
    "}",
    "",
    "/* 流式打字机光标 */",
    ".ait-sel-card.is-streaming .ait-sel-translation:not(:empty)::after {",
    '  content: "";',
    "  display: inline-block;",
    "  width: 2px;",
    "  height: 1em;",
    "  margin-left: 2px;",
    "  vertical-align: -0.14em;",
    "  background: var(--ait-accent);",
    "  animation: ait-sel-caret 1.05s steps(1, end) infinite;",
    "}",
    "",
    "/* 思考过程折叠 */",
    ".ait-sel-reasoning {",
    "  margin-bottom: 9px;",
    "  border: 1px solid var(--ait-line);",
    "  border-radius: 8px;",
    "  background: var(--ait-card-2);",
    "  overflow: hidden;",
    "}",
    "",
    ".ait-sel-reasoning-summary {",
    "  display: flex;",
    "  align-items: center;",
    "  gap: 6px;",
    "  padding: 5px 8px;",
    "  font-size: 11px;",
    "  color: var(--ait-ink-2);",
    "}",
    "",
    ".ait-sel-reasoning[open] > .ait-sel-reasoning-summary {",
    "  border-bottom: 1px solid var(--ait-line);",
    "}",
    "",
    ".ait-sel-reasoning[open] .ait-sel-reasoning-summary .ait-sel-chev svg {",
    "  transform: rotate(90deg);",
    "}",
    "",
    ".ait-sel-reasoning-label {",
    "  white-space: nowrap;",
    "}",
    "",
    ".ait-sel-reasoning-hint {",
    "  margin-left: auto;",
    "  overflow: hidden;",
    "  text-overflow: ellipsis;",
    "  white-space: nowrap;",
    "  font-family: var(--ait-mono);",
    "  font-size: 10px;",
    "  color: var(--ait-ink-3);",
    "}",
    "",
    ".ait-sel-reasoning-text {",
    "  max-height: 132px;",
    "  padding: 7px 9px;",
    "  overflow-y: auto;",
    "  font-size: 12px;",
    "  line-height: 1.62;",
    "  color: var(--ait-ink-2);",
    "  white-space: pre-wrap;",
    "  overflow-wrap: anywhere;",
    "  -webkit-user-select: text;",
    "  user-select: text;",
    "}",
    "",
    "/* 错误态 */",
    ".ait-sel-error {",
    "  display: flex;",
    "  align-items: flex-start;",
    "  gap: 10px;",
    "  margin-top: 9px;",
    "  padding: 8px 10px;",
    "  border-left: 2px solid var(--ait-accent);",
    "  border-radius: 0 6px 6px 0;",
    "  background: var(--ait-accent-soft);",
    "}",
    "",
    ".ait-sel-error-text {",
    "  flex: 1 1 auto;",
    "  font-size: 12px;",
    "  line-height: 1.6;",
    "  color: var(--ait-ink);",
    "  -webkit-user-select: text;",
    "  user-select: text;",
    "}",
    "",
    ".ait-sel-retry {",
    "  display: inline-flex;",
    "  align-items: center;",
    "  gap: 4px;",
    "  flex: none;",
    "  height: 24px;",
    "  padding: 0 9px;",
    "  border: 1px solid var(--ait-line-2);",
    "  border-radius: 6px;",
    "  background: var(--ait-card);",
    "  font-size: 11.5px;",
    "  color: var(--ait-ink-2);",
    "  transition: border-color 140ms ease, color 140ms ease;",
    "}",
    "",
    ".ait-sel-retry:hover {",
    "  border-color: var(--ait-accent);",
    "  color: var(--ait-accent);",
    "}",
    "",
    ".ait-sel-retry svg {",
    "  width: 12px;",
    "  height: 12px;",
    "}",
    "",
    "/* 状态栏 */",
    ".ait-sel-foot {",
    "  display: flex;",
    "  align-items: center;",
    "  gap: 8px;",
    "  flex: none;",
    "  padding: 6px 12px 7px;",
    "  border-top: 1px solid var(--ait-line);",
    "  background: var(--ait-paper);",
    "  font-family: var(--ait-mono);",
    "  font-size: 10.5px;",
    "  color: var(--ait-ink-3);",
    "}",
    "",
    ".ait-sel-status {",
    "  min-width: 0;",
    "  overflow: hidden;",
    "  text-overflow: ellipsis;",
    "  white-space: nowrap;",
    "}",
    "",
    ".ait-sel-status.is-error {",
    "  color: var(--ait-accent);",
    "}",
    "",
    ".ait-sel-usage {",
    "  margin-left: auto;",
    "  flex: none;",
    "  white-space: nowrap;",
    "}",
    "",
    "/* 细滚动条 */",
    ".ait-sel-output::-webkit-scrollbar,",
    ".ait-sel-source-text::-webkit-scrollbar,",
    ".ait-sel-reasoning-text::-webkit-scrollbar {",
    "  width: 8px;",
    "}",
    "",
    ".ait-sel-output::-webkit-scrollbar-thumb,",
    ".ait-sel-source-text::-webkit-scrollbar-thumb,",
    ".ait-sel-reasoning-text::-webkit-scrollbar-thumb {",
    "  border: 2px solid transparent;",
    "  border-radius: 8px;",
    "  background-clip: content-box;",
    "  background-color: var(--ait-line-2);",
    "}",
    "",
    ".ait-sel-output::-webkit-scrollbar-track,",
    ".ait-sel-source-text::-webkit-scrollbar-track,",
    ".ait-sel-reasoning-text::-webkit-scrollbar-track {",
    "  background: transparent;",
    "}",
    "",
    "@keyframes ait-sel-caret {",
    "  0%, 49% { opacity: 1; }",
    "  50%, 100% { opacity: 0; }",
    "}",
    "",
    "/* 窄屏：卡片占满可用宽度，正文略放大 */",
    "@media (max-width: 560px) {",
    "  .ait-sel-card {",
    "    width: calc(100vw - 20px);",
    "    max-width: calc(100vw - 20px);",
    "    max-height: calc(100vh - 20px);",
    "  }",
    "",
    "  .ait-sel-translation {",
    "    font-size: 14px;",
    "  }",
    "",
    "  .ait-sel-source-text {",
    "    max-height: 72px;",
    "  }",
    "}",
    "",
    "/* 原生控件（select 下拉）跟随卡片主题 */",
    "@media (prefers-color-scheme: dark) {",
    "  .ait-sel-card { color-scheme: dark; }",
    "}",

    ':host([data-theme="light"]) .ait-sel-card { color-scheme: light; }',
    ':host([data-theme="dark"]) .ait-sel-card { color-scheme: dark; }',

    "/* 尊重 prefers-reduced-motion：关闭过渡与光标闪烁 */",
    "@media (prefers-reduced-motion: reduce) {",
    "  .ait-sel-card,",
    "  .ait-sel-trigger,",
    "  .ait-sel-icon-btn,",
    "  .ait-sel-fold,",
    "  .ait-sel-chev svg,",
    "  .ait-sel-retry {",
    "    transition: none !important;",
    "  }",
    "",
    "  .ait-sel-card.is-streaming .ait-sel-translation::after,",
    "  .ait-sel-placeholder::before {",
    "    animation: none !important;",
    "  }",
    "",
    "  .ait-sel-trigger {",
    "    transform: none !important;",
    "  }",
    "}",
  ].join("\n");

  // ===== 卡片静态骨架 =====

  const CARD_HTML = [
    '<div class="ait-sel-head">',
    '  <div class="ait-sel-brand">',
    '    <span class="ait-sel-mark" aria-hidden="true"></span>',
    '    <span class="ait-sel-title">划词翻译</span>',
    '    <span class="ait-sel-model" hidden></span>',
    "  </div>",
    '  <div class="ait-sel-actions">',
    '    <button type="button" class="ait-sel-icon-btn" data-act="copy" aria-label="复制译文" title="复制译文">' +
      ICONS.copy +
      "</button>",
    '    <button type="button" class="ait-sel-icon-btn" data-act="close" aria-label="关闭（Esc）" title="关闭（Esc）">' +
      ICONS.close +
      "</button>",
    "  </div>",
    "</div>",
    '<div class="ait-sel-source">',
    '  <button type="button" class="ait-sel-fold" data-act="fold" aria-expanded="true">',
    '    <span class="ait-sel-chev">' + ICONS.chevronRight + "</span>",
    "    <span>原文</span>",
    '    <span class="ait-sel-count"></span>',
    "  </button>",
    '  <div class="ait-sel-source-text"></div>',
    "</div>",
    '<div class="ait-sel-langrow">',
    '  <span class="ait-sel-lang-label">译成</span>',
    '  <span class="ait-sel-select-wrap">',
    '    <select class="ait-sel-select" aria-label="目标语言"></select>',
    '    <span class="ait-sel-select-arrow">' + ICONS.chevronDown + "</span>",
    "  </span>",
    '  <span class="ait-sel-truncated" hidden></span>',
    "</div>",
    '<div class="ait-sel-output">',
    '  <details class="ait-sel-reasoning" hidden>',
    '    <summary class="ait-sel-reasoning-summary">',
    '      <span class="ait-sel-chev">' + ICONS.chevronRight + "</span>",
    '      <span class="ait-sel-reasoning-label">思考过程</span>',
    '      <span class="ait-sel-reasoning-hint"></span>',
    "    </summary>",
    '    <div class="ait-sel-reasoning-text"></div>',
    "  </details>",
    '  <div class="ait-sel-placeholder">正在翻译…</div>',
    '  <div class="ait-sel-translation"></div>',
    '  <div class="ait-sel-error" role="alert" hidden>',
    '    <span class="ait-sel-error-text"></span>',
    '    <button type="button" class="ait-sel-retry" data-act="retry">' +
      ICONS.retry +
      "<span>重试</span></button>",
    "  </div>",
    "</div>",
    '<div class="ait-sel-foot">',
    '  <span class="ait-sel-status" role="status" aria-live="polite"></span>',
    '  <span class="ait-sel-usage"></span>',
    "</div>",
  ].join("\n");

  // ===== 运行时状态 =====

  const state = {
    inited: false,
    bound: false,
    host: null,
    shadow: null,
    refs: null,
    settings: normalizeSettings(null),
    /** 本次页面会话内用户手动选择的目标语言（会话内记忆，不写 storage） */
    sessionLang: "",
    trigger: { visible: false, text: "", rect: null, bounds: null, anchor: null },
    card: createCardState(),
    autoTimer: 0,
    viewportRaf: 0,
    detachers: [],
  };

  function createCardState() {
    return {
      open: false,
      el: null,
      seq: 0,
      text: "",
      sourceText: "",
      truncated: false,
      targetLang: "",
      status: "idle",
      content: "",
      reasoning: "",
      shown: "",
      error: null,
      usage: null,
      cached: false,
      finished: null,
      startedAt: 0,
      meta: { provider: "", model: "" },
      sourceOpen: true,
      port: null,
      watchdog: 0,
      fallback: false,
      anchor: null,
      returnFocus: null,
      copyTimer: 0,
    };
  }

  // ===== 小工具 =====

  function clamp(value, min, max) {
    if (!isFinite(value)) return min;
    return Math.min(Math.max(value, min), max);
  }

  function reducedMotion() {
    try {
      return !!window.matchMedia && window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    } catch (_) {
      return false;
    }
  }

  function formatSeconds(value) {
    const seconds = Number(value);
    if (!isFinite(seconds) || seconds < 0) return "";
    if (seconds < 10) return seconds.toFixed(1) + "s";
    return Math.round(seconds) + "s";
  }

  function normalizeUsage(usage) {
    if (!usage || typeof usage !== "object") return null;
    const tokensIn = Number(usage.tokensIn);
    const tokensOut = Number(usage.tokensOut);
    if (!isFinite(tokensIn) && !isFinite(tokensOut)) return null;
    return {
      tokensIn: isFinite(tokensIn) ? Math.max(0, Math.round(tokensIn)) : 0,
      tokensOut: isFinite(tokensOut) ? Math.max(0, Math.round(tokensOut)) : 0,
    };
  }

  function shortProvider(value) {
    const text = String(value || "").trim();
    if (!text) return "";
    try {
      const url = new URL(text);
      return url.host || text;
    } catch (_) {
      return text.replace(/^https?:\/\//, "").split("/")[0];
    }
  }

  function countLabel(text) {
    const length = String(text || "").length;
    return length > 0 ? length + " 字" : "";
  }

  function safeSliceEnd(text, end) {
    if (end <= 0 || end >= text.length) return end;
    const code = text.charCodeAt(end - 1);
    if (code >= 0xd800 && code <= 0xdbff) return Math.min(text.length, end + 1);
    return end;
  }

  function clearNode(node) {
    if (!node) return;
    while (node.firstChild) node.removeChild(node.firstChild);
  }

  /**
   * 清洗选区文本：统一换行、去零宽字符、去行尾空白、压缩连续空行。
   */
  function cleanSelectionText(raw) {
    let text = String(raw || "").replace(/\r\n?/g, "\n");
    text = text.replace(/[\u200b-\u200d\ufeff]/g, "");
    text = text.replace(/\u00a0/g, " ");
    text = text.replace(/[ \t]+\n/g, "\n");
    text = text.replace(/\n{3,}/g, "\n\n");
    return text.trim();
  }

  function rectToAnchor(rect) {
    const scrollX = window.scrollX || window.pageXOffset || 0;
    const scrollY = window.scrollY || window.pageYOffset || 0;
    return {
      left: rect.left + scrollX,
      top: rect.top + scrollY,
      right: rect.right + scrollX,
      bottom: rect.bottom + scrollY,
      width: rect.width,
      height: rect.height,
    };
  }

  function anchorToRect(anchor) {
    if (!anchor) return null;
    const scrollX = window.scrollX || window.pageXOffset || 0;
    const scrollY = window.scrollY || window.pageYOffset || 0;
    return {
      left: anchor.left - scrollX,
      top: anchor.top - scrollY,
      right: anchor.right - scrollX,
      bottom: anchor.bottom - scrollY,
      width: anchor.width,
      height: anchor.height,
    };
  }

  function normalizeRectInput(rect) {
    if (!rect || typeof rect !== "object") return null;
    const left = Number(rect.left);
    const top = Number(rect.top);
    if (!isFinite(left) || !isFinite(top)) return null;
    const width = Number(rect.width);
    const height = Number(rect.height);
    const right = isFinite(Number(rect.right)) ? Number(rect.right) : left + (isFinite(width) ? width : 0);
    const bottom = isFinite(Number(rect.bottom)) ? Number(rect.bottom) : top + (isFinite(height) ? height : 0);
    return {
      left: left,
      top: top,
      right: right,
      bottom: bottom,
      width: Math.max(0, right - left),
      height: Math.max(0, bottom - top),
    };
  }

  function centerRect() {
    const left = Math.max(24, window.innerWidth / 2 - 90);
    const top = Math.max(24, window.innerHeight / 2 - 80);
    return { left: left, top: top, right: left + 180, bottom: top + 26, width: 180, height: 26 };
  }

  function isRectOutsideViewport(rect, padding) {
    if (!rect) return true;
    const pad = typeof padding === "number" ? padding : 24;
    return (
      rect.bottom < -pad ||
      rect.top > window.innerHeight + pad ||
      rect.right < -pad ||
      rect.left > window.innerWidth + pad
    );
  }

  // ===== 设置 =====

  function normalizeSettings(raw) {
    const source = raw && typeof raw === "object" ? raw : {};
    const selection =
      source.selection && typeof source.selection === "object" ? source.selection : {};
    const language = source.language && typeof source.language === "object" ? source.language : {};
    const ui = source.ui && typeof source.ui === "object" ? source.ui : {};
    const provider = source.provider && typeof source.provider === "object" ? source.provider : {};
    return {
      raw: source,
      provider: {
        timeoutMs: Math.max(5000, Number(provider.timeoutMs) || 60000),
        stream: provider.stream !== false,
      },
      selection: {
        enabled: selection.enabled !== false,
        autoPopup: selection.autoPopup === true,
        targetLang: typeof selection.targetLang === "string" ? selection.targetLang : DEFAULT_SELECTION.targetLang,
        showOriginal: selection.showOriginal !== false,
        stream: selection.stream !== false,
        maxChars: Math.round(
          clamp(Number(selection.maxChars) || DEFAULT_SELECTION.maxChars, 200, 20000)
        ),
      },
      languageTarget: typeof language.target === "string" && language.target ? language.target : "zh-CN",
      theme: ui.theme === "light" || ui.theme === "dark" ? ui.theme : "auto",
    };
  }

  function applySettings(settings) {
    if (!settings || typeof settings !== "object") return;
    state.settings = normalizeSettings(settings);
    applyTheme();
    if (!state.settings.selection.enabled) {
      hideTrigger();
      if (state.card.open) closeCard("disabled");
    }
    AIT.log("selection settings", state.settings.selection);
  }

  function loadSettings() {
    if (AIT.state && AIT.state.settings) applySettings(AIT.state.settings);
    AIT.runtimeSend({ type: "ait:settings.get" }).then((response) => {
      if (response && response.ok && response.settings) applySettings(response.settings);
    });
  }

  function applyTheme() {
    if (!state.host) return;
    const theme = state.settings.theme;
    if (theme === "light" || theme === "dark") {
      state.host.setAttribute("data-theme", theme);
    } else {
      state.host.removeAttribute("data-theme");
    }
  }

  function isEnabled() {
    return state.settings.selection.enabled !== false;
  }

  function resolveTargetLang() {
    const candidates = [
      state.sessionLang,
      state.settings.selection.targetLang,
      state.settings.languageTarget,
    ];
    for (let i = 0; i < candidates.length; i += 1) {
      const value = candidates[i];
      if (value && LANG_CODES.indexOf(value) >= 0) return value;
    }
    return LANG_CODES[0];
  }
  // ===== Shadow DOM 宿主与 UI 构建 =====

  /** 宿主样式只用 inline + !important，防止页面 CSS 干扰定位与层叠。 */
  function applyHostStyles(host) {
    host.style.setProperty("all", "initial", "important");
    host.style.setProperty("position", "fixed", "important");
    host.style.setProperty("top", "0", "important");
    host.style.setProperty("left", "0", "important");
    host.style.setProperty("width", "0", "important");
    host.style.setProperty("height", "0", "important");
    host.style.setProperty("margin", "0", "important");
    host.style.setProperty("padding", "0", "important");
    host.style.setProperty("border", "0", "important");
    host.style.setProperty("overflow", "visible", "important");
    host.style.setProperty("pointer-events", "none", "important");
    host.style.setProperty("z-index", HOST_Z_INDEX, "important");
    host.style.setProperty("display", "block", "important");
  }

  function createHost() {
    const host = document.createElement("div");
    host.id = HOST_ID;
    host.dataset.aitSelection = "1";
    applyHostStyles(host);
    const parent = document.documentElement || document.body;
    if (!parent) return null;
    parent.appendChild(host);
    return host;
  }

  function ensureHost() {
    if (state.host && state.host.isConnected) return state.host;
    let host = document.getElementById(HOST_ID);
    if (host && host.dataset.aitSelection !== "1") {
      // 页面恰好占用了同名 id，移除并重建，保证我们的唯一控制权
      host.remove();
      host = null;
    }
    if (!host) {
      host = createHost();
      if (!host) return null;
    }
    state.host = host;
    let shadow = host.shadowRoot;
    if (!shadow) {
      try {
        shadow = host.attachShadow({ mode: "open" });
      } catch (error) {
        host.remove();
        host = createHost();
        if (!host) return null;
        state.host = host;
        shadow = host.attachShadow({ mode: "open" });
      }
    }
    state.shadow = shadow;
    clearNode(shadow);
    buildUi(shadow);
    applyTheme();
    return host;
  }

  function buildUi(shadow) {
    const style = document.createElement("style");
    style.textContent = CSS_TEXT;
    shadow.appendChild(style);

    const trigger = document.createElement("button");
    trigger.type = "button";
    trigger.className = "ait-sel-trigger";
    trigger.textContent = "译";
    trigger.title = "翻译选中文字";
    trigger.setAttribute("aria-label", "翻译选中文字");
    trigger.hidden = true;
    shadow.appendChild(trigger);

    const card = document.createElement("article");
    card.className = "ait-sel-card";
    card.setAttribute("role", "dialog");
    card.setAttribute("aria-label", "划词翻译");
    card.tabIndex = -1;
    card.hidden = true;
    card.innerHTML = CARD_HTML;
    shadow.appendChild(card);

    const refs = {
      shadow: shadow,
      trigger: trigger,
      card: card,
      model: card.querySelector(".ait-sel-model"),
      copyBtn: card.querySelector('[data-act="copy"]'),
      closeBtn: card.querySelector('[data-act="close"]'),
      foldBtn: card.querySelector('[data-act="fold"]'),
      count: card.querySelector(".ait-sel-count"),
      sourceText: card.querySelector(".ait-sel-source-text"),
      langSelect: card.querySelector(".ait-sel-select"),
      truncated: card.querySelector(".ait-sel-truncated"),
      output: card.querySelector(".ait-sel-output"),
      placeholder: card.querySelector(".ait-sel-placeholder"),
      translation: card.querySelector(".ait-sel-translation"),
      reasoning: card.querySelector(".ait-sel-reasoning"),
      reasoningLabel: card.querySelector(".ait-sel-reasoning-label"),
      reasoningHint: card.querySelector(".ait-sel-reasoning-hint"),
      reasoningText: card.querySelector(".ait-sel-reasoning-text"),
      errorBox: card.querySelector(".ait-sel-error"),
      errorText: card.querySelector(".ait-sel-error-text"),
      retryBtn: card.querySelector('[data-act="retry"]'),
      status: card.querySelector(".ait-sel-status"),
      usage: card.querySelector(".ait-sel-usage"),
    };

    // 译文用单个文本节点增量更新，避免每帧重建 DOM
    refs.translationText = document.createTextNode("");
    refs.translation.appendChild(refs.translationText);

    LANG_CODES.forEach(function (code) {
      const option = document.createElement("option");
      option.value = code;
      option.textContent = typeof util.langLabel === "function" ? util.langLabel(code) : code;
      refs.langSelect.appendChild(option);
    });

    bindUi(refs);
    state.refs = refs;
    state.card.el = card;
    return refs;
  }

  function bindUi(refs) {
    // mousedown 阻止默认行为，保住页面选区（否则点击按钮时选区可能被清除）
    refs.trigger.addEventListener("mousedown", function (event) {
      event.preventDefault();
    });
    refs.trigger.addEventListener("click", function (event) {
      event.preventDefault();
      event.stopPropagation();
      openFromTrigger();
    });
    refs.card.addEventListener("click", onCardClick);
    refs.langSelect.addEventListener("change", onLangChange);
    refs.reasoning.addEventListener("toggle", function () {
      if (refs.reasoning.open) {
        refs.reasoningText.scrollTop = refs.reasoningText.scrollHeight;
      }
    });
  }

  // ===== 触发按钮 =====

  function showTrigger(text, rect, bounds) {
    const refs = state.refs;
    if (!refs || !rect) return;
    const el = refs.trigger;
    const wasHidden = el.hidden;
    state.trigger.visible = true;
    state.trigger.text = text;
    state.trigger.rect = rect;
    state.trigger.bounds = bounds || rect;
    state.trigger.anchor = rectToAnchor(rect);
    el.hidden = false;
    positionTrigger(rect);
    if (wasHidden) {
      el.classList.remove("is-visible");
      window.requestAnimationFrame(function () {
        if (state.trigger.visible) el.classList.add("is-visible");
      });
    } else {
      el.classList.add("is-visible");
    }
  }

  function hideTrigger() {
    state.trigger.visible = false;
    state.trigger.text = "";
    state.trigger.rect = null;
    state.trigger.bounds = null;
    state.trigger.anchor = null;
    if (state.refs && state.refs.trigger) {
      state.refs.trigger.classList.remove("is-visible");
      state.refs.trigger.hidden = true;
    }
  }

  function positionTrigger(rect) {
    const el = state.refs ? state.refs.trigger : null;
    if (!el || !rect) return;
    const vw = window.innerWidth;
    const vh = window.innerHeight;
    let left = rect.right + GAP_TRIGGER;
    if (left + TRIGGER_SIZE > vw - VIEW_MARGIN) left = rect.right - TRIGGER_SIZE - GAP_TRIGGER;
    if (left < VIEW_MARGIN) left = clamp(rect.left, VIEW_MARGIN, Math.max(VIEW_MARGIN, vw - TRIGGER_SIZE - VIEW_MARGIN));
    let top = rect.bottom + GAP_TRIGGER;
    if (top + TRIGGER_SIZE > vh - VIEW_MARGIN) top = rect.top - TRIGGER_SIZE - GAP_TRIGGER;
    if (top < VIEW_MARGIN) top = clamp(rect.bottom - TRIGGER_SIZE, VIEW_MARGIN, Math.max(VIEW_MARGIN, vh - TRIGGER_SIZE - VIEW_MARGIN));
    el.style.left = Math.round(left) + "px";
    el.style.top = Math.round(top) + "px";
  }

  function openFromTrigger() {
    const text = state.trigger.text;
    const rect = state.trigger.bounds || state.trigger.rect;
    if (!text) return;
    hideTrigger();
    openCard(text, rect);
  }

  // ===== 选区检测 =====

  function isNodeEditable(node) {
    if (!node) return false;
    const element = node.nodeType === 1 ? node : node.parentElement;
    if (!element || typeof util.isEditable !== "function") return false;
    return util.isEditable(element);
  }

  /** document.getSelection() 对 shadow 内选区返回的 anchorNode 是宿主本身。 */
  function selectionInHost(selection) {
    if (!selection || !state.host) return false;
    const node = selection.anchorNode || selection.focusNode;
    if (!node) return false;
    const element = node.nodeType === 1 ? node : node.parentElement;
    if (!element) return false;
    if (element === state.host) return true;
    try {
      if (element.closest && element.closest("#" + HOST_ID)) return true;
    } catch (_) {}
    return false;
  }

  /** 取选区最后一行的矩形（多行选区时按钮贴在末行右下）。 */
  function selectionLastRect(selection) {
    if (!selection || !selection.rangeCount) return null;
    let range;
    try {
      range = selection.getRangeAt(0);
    } catch (_) {
      return null;
    }
    let best = null;
    try {
      const rects = range.getClientRects();
      for (let i = 0; i < rects.length; i += 1) {
        const rect = rects[i];
        if (rect && rect.width > 0 && rect.height > 0) best = rect;
      }
    } catch (_) {}
    if (!best) {
      try {
        const rect = range.getBoundingClientRect();
        if (rect && rect.width > 0) best = rect;
      } catch (_) {}
    }
    return normalizeRectInput(best);
  }

  /** 选区整体包围盒：卡片定位用，避免多行选区时卡片盖住选区。 */
  function selectionBoundsRect(selection) {
    if (!selection || !selection.rangeCount) return null;
    try {
      const range = selection.getRangeAt(0);
      const rect = range.getBoundingClientRect();
      if (!rect || (!rect.width && !rect.height)) return null;
      return normalizeRectInput(rect);
    } catch (_) {
      return null;
    }
  }

  function evaluateSelection() {
    if (!state.inited) return;
    const settings = state.settings.selection;
    if (!settings.enabled) {
      hideTrigger();
      return;
    }
    if (state.card.open) {
      hideTrigger();
      return;
    }
    const selection = window.getSelection();
    if (!selection || selection.isCollapsed || !selection.rangeCount) {
      hideTrigger();
      return;
    }
    if (selectionInHost(selection)) {
      hideTrigger();
      return;
    }
    const text = cleanSelectionText(selection.toString());
    if (!text) {
      hideTrigger();
      return;
    }
    if (isNodeEditable(selection.anchorNode || selection.focusNode)) {
      hideTrigger();
      return;
    }
    if (typeof util.looksTranslated === "function" && util.looksTranslated(text)) {
      // 纯数字、纯符号、单独 URL 不需要翻译
      hideTrigger();
      return;
    }
    if (text.length > settings.maxChars) {
      hideTrigger();
      return;
    }
    const rect = selectionLastRect(selection);
    if (!rect) {
      hideTrigger();
      return;
    }
    const bounds = selectionBoundsRect(selection) || rect;
    if (settings.autoPopup) {
      hideTrigger();
      scheduleAutoPopup(text, bounds);
      return;
    }
    showTrigger(text, rect, bounds);
  }

  function scheduleAutoPopup(text, rect) {
    if (state.autoTimer) clearTimeout(state.autoTimer);
    state.autoTimer = window.setTimeout(function () {
      state.autoTimer = 0;
      if (!state.settings.selection.autoPopup) return;
      if (state.card.open) return;
      openCard(text, rect);
    }, AUTO_POPUP_DELAY);
  }

  const handleSelectionChange = util.debounce(function onSelectionChangeDebounced() {
    if (!state.inited) return;
    if (state.card.open) {
      const selection = window.getSelection();
      if (!selection || selection.isCollapsed || !selection.rangeCount) return;
      if (selectionInHost(selection)) return;
      const current = cleanSelectionText(selection.toString());
      // 选区仍是打开卡片时的那一段（selectionchange 只是迟到的防抖回调），不关闭卡片
      const opened = state.card.sourceText || "";
      if (current && opened && (current === opened || current.indexOf(opened) === 0)) return;
      // 卡片开着时用户重新划词：关旧卡片，走新选区流程
      closeCard("reselect");
    }
    evaluateSelection();
  }, SELECTION_DEBOUNCE);

  function isEventInsideHost(event) {
    if (!state.host) return false;
    if (event && typeof event.composedPath === "function") {
      try {
        const path = event.composedPath();
        if (path && path.indexOf(state.host) >= 0) return true;
      } catch (_) {}
    }
    const target = event ? event.target : null;
    return !!(target && (target === state.host || target === state.host.shadowRoot));
  }

  function onDocumentMouseUp(event) {
    if (!state.inited) return;
    if (isEventInsideHost(event)) return;
    const target = event ? event.target : null;
    if (target && target.nodeType === 1 && typeof util.isEditable === "function" && util.isEditable(target)) {
      hideTrigger();
      return;
    }
    window.setTimeout(function () {
      if (!state.inited) return;
      if (state.card.open) {
        const selection = window.getSelection();
        if (!selection || selection.isCollapsed || !selection.rangeCount || selectionInHost(selection)) return;
        closeCard("reselect");
      }
      evaluateSelection();
    }, 0);
  }

  function onDocumentPointerDown(event) {
    if (!state.card.open) return;
    if (isEventInsideHost(event)) return;
    closeCard("outside");
  }

  function onDocumentKeyDown(event) {
    const key = event.key;
    if (key !== "Escape" && key !== "Esc") return;
    if (state.card.open) {
      event.preventDefault();
      event.stopPropagation();
      closeCard("esc");
      return;
    }
    if (state.trigger.visible) {
      event.preventDefault();
      hideTrigger();
    }
  }

  function scheduleViewportLayout() {
    if (state.viewportRaf) return;
    state.viewportRaf = window.requestAnimationFrame(function () {
      state.viewportRaf = 0;
      onViewportLayout();
    });
  }

  function onViewportLayout() {
    if (!state.inited) return;
    if (state.trigger.visible) {
      const rect = anchorToRect(state.trigger.anchor);
      if (isRectOutsideViewport(rect, 40)) {
        hideTrigger();
      } else if (rect) {
        positionTrigger(rect);
      }
    }
    if (state.card.open && state.card.anchor) {
      const rect = anchorToRect(state.card.anchor);
      if (isRectOutsideViewport(rect, 140)) {
        closeCard("scroll");
        return;
      }
      positionCard(rect);
    }
  }

  function bindEvents() {
    if (state.bound) return;
    state.bound = true;
    state.detachers.push(util.on(document, "mouseup", onDocumentMouseUp, true));
    state.detachers.push(util.on(document, "pointerdown", onDocumentPointerDown, true));
    state.detachers.push(util.on(document, "keydown", onDocumentKeyDown, true));
    state.detachers.push(util.on(document, "selectionchange", handleSelectionChange));
    state.detachers.push(
      util.on(window, "scroll", scheduleViewportLayout, { capture: true, passive: true })
    );
    state.detachers.push(util.on(window, "resize", scheduleViewportLayout));
    state.detachers.push(util.on(window, "pagehide", abortPort));
    state.detachers.push(
      AIT.bus.on("settings", function (settings) {
        applySettings(settings);
      })
    );
    try {
      const media = window.matchMedia ? window.matchMedia("(prefers-color-scheme: dark)") : null;
      if (media && typeof media.addEventListener === "function") {
        const onChange = function () {
          applyTheme();
        };
        media.addEventListener("change", onChange);
        state.detachers.push(function () {
          media.removeEventListener("change", onChange);
        });
      }
    } catch (_) {}
  }

  // ===== 卡片：打开 / 关闭 / 定位 =====

  function openCard(text, rect) {
    if (!state.inited) init();
    const cleaned = cleanSelectionText(text);
    if (!cleaned) return;
    if (!ensureHost()) return;
    if (state.card.open) closeCard("reopen");
    const card = state.card;
    const settings = state.settings.selection;
    card.seq += 1;
    card.open = true;
    card.text = cleaned;
    card.sourceText = cleaned;
    card.truncated = false;
    if (card.text.length > settings.maxChars) {
      card.text = card.text.slice(0, settings.maxChars);
      card.truncated = true;
    }
    card.targetLang = resolveTargetLang();
    card.content = "";
    card.reasoning = "";
    card.shown = "";
    card.status = "loading";
    card.error = null;
    card.usage = null;
    card.cached = false;
    card.finished = null;
    card.fallback = false;
    card.meta = { provider: "", model: "" };
    card.startedAt = Date.now();
    card.sourceOpen = settings.showOriginal !== false;
    card.anchor = rectToAnchor(rect || centerRect());
    card.returnFocus = document.activeElement;
    card.port = null;
    card.watchdog = 0;

    resetCardView();
    renderSource();
    updateFoot();
    showCard();
    try {
      card.el.focus({ preventScroll: true });
    } catch (_) {}
    runTranslation();
  }

  function showCard() {
    const card = state.card;
    const el = card.el;
    el.hidden = false;
    el.classList.remove("is-visible");
    el.style.visibility = "hidden";
    el.style.left = "0px";
    el.style.top = "0px";
    positionCard(anchorToRect(card.anchor));
    el.style.visibility = "";
    window.requestAnimationFrame(function () {
      if (state.card.open) el.classList.add("is-visible");
    });
  }

  /** 视口边缘翻转：优先选区下方，其次上方，都放不下则贴边。 */
  function positionCard(rect) {
    const card = state.card;
    if (!rect || !card.el) return;
    const el = card.el;
    const vw = window.innerWidth;
    const vh = window.innerHeight;
    const width = el.offsetWidth || 380;
    const height = el.offsetHeight || 200;
    let left = rect.left;
    if (left + width > vw - VIEW_MARGIN) left = vw - VIEW_MARGIN - width;
    if (left < VIEW_MARGIN) left = VIEW_MARGIN;
    let top;
    const below = rect.bottom + GAP_CARD;
    const above = rect.top - height - GAP_CARD;
    const roomBelow = vh - VIEW_MARGIN - below;
    const roomAbove = rect.top - GAP_CARD - VIEW_MARGIN;
    if (height <= roomBelow) top = below;
    else if (height <= roomAbove) top = above;
    else top = vh - VIEW_MARGIN - height;
    if (top < VIEW_MARGIN) top = VIEW_MARGIN;
    if (top + height > vh - VIEW_MARGIN) top = Math.max(VIEW_MARGIN, vh - VIEW_MARGIN - height);
    el.style.left = Math.round(left) + "px";
    el.style.top = Math.round(top) + "px";
  }

  /** 内容增长后把卡片拉回视口内（只移动不改变锚点）。 */
  function keepCardInViewport() {
    const card = state.card;
    if (!card.open || !card.el) return;
    const el = card.el;
    const rect = el.getBoundingClientRect();
    if (!rect.width) return;
    let left = rect.left;
    let top = rect.top;
    if (rect.right > window.innerWidth - VIEW_MARGIN) left = window.innerWidth - VIEW_MARGIN - rect.width;
    if (left < VIEW_MARGIN) left = VIEW_MARGIN;
    if (rect.bottom > window.innerHeight - VIEW_MARGIN) top = window.innerHeight - VIEW_MARGIN - rect.height;
    if (top < VIEW_MARGIN) top = VIEW_MARGIN;
    if (Math.abs(left - rect.left) >= 0.5 || Math.abs(top - rect.top) >= 0.5) {
      el.style.left = Math.round(left) + "px";
      el.style.top = Math.round(top) + "px";
    }
  }

  function closeCard(reason) {
    const card = state.card;
    if (!card.open) return;
    abortPort();
    cancelTypewriter();
    stopWatchdog();
    card.open = false;
    card.seq += 1;
    card.status = "idle";
    card.fallback = false;
    AIT.log("selection closed", reason);
    if (state.autoTimer) {
      clearTimeout(state.autoTimer);
      state.autoTimer = 0;
    }
    if (card.copyTimer) {
      clearTimeout(card.copyTimer);
      card.copyTimer = 0;
    }
    const el = card.el;
    if (el) {
      el.classList.remove("is-visible", "is-streaming");
      const seq = card.seq;
      window.setTimeout(function () {
        if (!state.card.open && state.card.seq === seq) el.hidden = true;
      }, 160);
    }
    const target = card.returnFocus;
    card.returnFocus = null;
    if (target && target.isConnected && typeof target.focus === "function") {
      try {
        target.focus({ preventScroll: true });
      } catch (_) {}
    }
    card.port = null;
    hideTrigger();
  }

  // ===== 卡片渲染 =====

  function resetCardView() {
    const refs = state.refs;
    const card = state.card;
    card.el.classList.add("is-streaming");
    refs.translationText.nodeValue = "";
    refs.placeholder.hidden = false;
    refs.placeholder.textContent = "正在翻译…";
    refs.errorBox.hidden = true;
    refs.errorText.textContent = "";
    refs.reasoning.hidden = true;
    refs.reasoning.open = false;
    refs.reasoningText.textContent = "";
    refs.reasoningLabel.textContent = "思考过程";
    refs.reasoningHint.textContent = "";
    refs.usage.textContent = "";
    refs.model.hidden = true;
    refs.model.textContent = "";
    refs.status.textContent = "";
    refs.status.classList.remove("is-error");
    refs.copyBtn.innerHTML = ICONS.copy;
    refs.copyBtn.classList.remove("is-ok");
    refs.copyBtn.title = "复制译文";
    if (card.copyTimer) {
      clearTimeout(card.copyTimer);
      card.copyTimer = 0;
    }
    refs.truncated.hidden = !card.truncated;
    refs.truncated.textContent = card.truncated ? "已截断至 " + state.settings.selection.maxChars + " 字" : "";
    refs.sourceText.scrollTop = 0;
    refs.output.scrollTop = 0;
    refs.langSelect.value = card.targetLang;
  }

  function renderSource() {
    const refs = state.refs;
    const card = state.card;
    refs.sourceText.textContent = card.text;
    refs.count.textContent = countLabel(card.text);
    refs.sourceText.hidden = !card.sourceOpen;
    refs.foldBtn.setAttribute("aria-expanded", card.sourceOpen ? "true" : "false");
  }

  function toggleSource() {
    state.card.sourceOpen = !state.card.sourceOpen;
    renderSource();
  }

  function updatePlaceholder() {
    const refs = state.refs;
    if (!refs) return;
    const card = state.card;
    const hasText = !!card.shown || !!card.content;
    // 出错时隐藏占位文案，避免「正在翻译…」和错误提示同时出现
    refs.placeholder.hidden = hasText || card.status === "error" || card.status === "done";
    refs.placeholder.textContent = card.fallback ? "正在请求翻译…" : "正在翻译…";
  }

  function renderTranslation(forceScroll) {
    const refs = state.refs;
    if (!refs) return;
    const output = refs.output;
    const nearBottom = output.scrollHeight - output.scrollTop - output.clientHeight < 56;
    refs.translationText.nodeValue = state.card.shown;
    if (forceScroll || nearBottom) output.scrollTop = output.scrollHeight;
  }

  function updateReasoning() {
    const refs = state.refs;
    const card = state.card;
    const text = card.reasoning || "";
    if (!text) {
      refs.reasoning.hidden = true;
      return;
    }
    refs.reasoning.hidden = false;
    refs.reasoningText.textContent = text;
    const active = card.status === "loading" || card.status === "streaming";
    refs.reasoningLabel.textContent = active ? "思考过程（进行中）" : "思考过程";
    refs.reasoningHint.textContent = countLabel(text);
    if (refs.reasoning.open) refs.reasoningText.scrollTop = refs.reasoningText.scrollHeight;
  }

  function updateMeta() {
    const refs = state.refs;
    const card = state.card;
    if (!refs) return;
    const provider = shortProvider(card.meta.provider);
    const model = String(card.meta.model || "");
    const label = [provider, model].filter(Boolean).join(" · ");
    refs.model.textContent = label;
    refs.model.hidden = !label;
  }

  function updateFoot() {
    const refs = state.refs;
    if (!refs) return;
    const card = state.card;
    const parts = [];
    if (card.status === "loading") {
      parts.push(card.fallback ? "非流式请求中…" : "正在翻译…");
    } else if (card.status === "streaming") {
      parts.push("正在输出…");
    } else if (card.status === "done") {
      parts.push(card.cached ? "缓存命中" : "已完成");
      const finishedAt = card.finished ? card.finished.at : Date.now();
      const cost = formatSeconds((finishedAt - card.startedAt) / 1000);
      if (cost) parts.push("· " + cost);
      if (card.fallback) parts.push("· 非流式");
      if (card.truncated) parts.push("· 已截断");
    } else if (card.status === "error") {
      parts.push("翻译失败");
    }
    refs.status.textContent = parts.join(" ").trim();
    refs.status.classList.toggle("is-error", card.status === "error");
    const usage = card.usage;
    if (usage && (usage.tokensIn || usage.tokensOut)) {
      refs.usage.textContent = "↑ " + usage.tokensIn + " · ↓ " + usage.tokensOut;
    } else {
      refs.usage.textContent = "";
    }
  }

  // ===== 卡片交互 =====

  function onCardClick(event) {
    const target = event ? event.target : null;
    if (!target || typeof target.closest !== "function") return;
    const actionEl = target.closest("[data-act]");
    if (!actionEl) return;
    const action = actionEl.getAttribute("data-act");
    if (action === "copy") {
      event.preventDefault();
      copyTranslation();
    } else if (action === "close") {
      event.preventDefault();
      closeCard("button");
    } else if (action === "retry") {
      event.preventDefault();
      retryTranslation();
    } else if (action === "fold") {
      event.preventDefault();
      toggleSource();
    }
  }

  function onLangChange() {
    const refs = state.refs;
    const card = state.card;
    if (!refs || !card.open) return;
    const next = refs.langSelect.value;
    if (!next || next === card.targetLang) return;
    card.targetLang = next;
    // 会话内记忆：本页后续划词都沿用这个选择，不写 storage
    state.sessionLang = next;
    runTranslation();
  }

  function retryTranslation() {
    if (!state.card.open) return;
    runTranslation();
  }

  // ===== 复制 =====

  function fallbackCopy(text) {
    try {
      const area = document.createElement("textarea");
      area.value = text;
      area.setAttribute("readonly", "");
      area.style.cssText = "position:fixed;left:-9999px;top:0;opacity:0;";
      document.body.appendChild(area);
      area.select();
      const ok = document.execCommand("copy");
      document.body.removeChild(area);
      return !!ok;
    } catch (_) {
      return false;
    }
  }

  function writeClipboard(text) {
    return new Promise(function (resolve) {
      let settled = false;
      const done = function (value) {
        if (settled) return;
        settled = true;
        resolve(value);
      };
      try {
        if (navigator.clipboard && typeof navigator.clipboard.writeText === "function") {
          navigator.clipboard.writeText(text).then(
            function () {
              done(true);
            },
            function () {
              done(fallbackCopy(text));
            }
          );
          return;
        }
      } catch (_) {}
      done(fallbackCopy(text));
    });
  }

  function flashCopy(ok) {
    const refs = state.refs;
    const card = state.card;
    if (!refs) return;
    refs.copyBtn.innerHTML = ok ? ICONS.check : ICONS.copy;
    refs.copyBtn.classList.toggle("is-ok", !!ok);
    refs.copyBtn.title = ok ? "已复制" : "复制失败，请手动选择译文";
    if (card.copyTimer) clearTimeout(card.copyTimer);
    card.copyTimer = window.setTimeout(function () {
      card.copyTimer = 0;
      if (!state.refs) return;
      state.refs.copyBtn.innerHTML = ICONS.copy;
      state.refs.copyBtn.classList.remove("is-ok");
      state.refs.copyBtn.title = "复制译文";
    }, COPY_FEEDBACK_MS);
  }

  function copyTranslation() {
    const card = state.card;
    const seq = card.seq;
    const text = card.content || card.shown || "";
    if (!text) return;
    writeClipboard(text).then(function (ok) {
      // 复制是异步的：期间卡片可能已关闭或重开，用 seq 快照丢弃过期回调
      if (!state.card.open || state.card.seq !== seq) return;
      flashCopy(!!ok);
    });
  }

  // ===== 流式会话 =====

  const typewriter = { raf: 0 };

  function connectStream() {
    try {
      const chromeApi = typeof chrome !== "undefined" ? chrome : window.chrome;
      if (!chromeApi || !chromeApi.runtime || typeof chromeApi.runtime.connect !== "function") {
        return null;
      }
      return chromeApi.runtime.connect({ name: PORT_NAME });
    } catch (error) {
      AIT.log("stream connect failed", error);
      return null;
    }
  }

  function sourceLangOf() {
    const raw = state.settings.raw || {};
    const language = raw.language && typeof raw.language === "object" ? raw.language : {};
    return typeof language.source === "string" && language.source ? language.source : "auto";
  }

  function runTranslation() {
    const card = state.card;
    if (!card.open) return;
    abortPort();
    cancelTypewriter();
    stopWatchdog();
    card.seq += 1;
    const seq = card.seq;
    const refs = state.refs;
    card.status = "loading";
    card.content = "";
    card.reasoning = "";
    card.shown = "";
    card.error = null;
    card.usage = null;
    card.cached = false;
    card.finished = null;
    card.fallback = false;
    card.startedAt = Date.now();
    card.meta = { provider: "", model: "" };
    card.el.classList.add("is-streaming");
    refs.translationText.nodeValue = "";
    refs.placeholder.hidden = false;
    refs.placeholder.textContent = "正在翻译…";
    refs.errorBox.hidden = true;
    refs.errorText.textContent = "";
    refs.reasoning.hidden = true;
    refs.reasoning.open = false;
    refs.reasoningText.textContent = "";
    refs.reasoningLabel.textContent = "思考过程";
    refs.reasoningHint.textContent = "";
    refs.usage.textContent = "";
    refs.model.hidden = true;
    refs.model.textContent = "";
    refs.output.scrollTop = 0;
    updateFoot();

    const streaming =
      state.settings.selection.stream !== false && state.settings.provider.stream !== false;
    const port = streaming ? connectStream() : null;
    if (!port) {
      fallbackTranslate(seq);
      return;
    }
    card.port = port;
    port.onMessage.addListener(function (message) {
      onPortMessage(seq, message);
    });
    port.onDisconnect.addListener(function () {
      onPortDisconnect(seq);
    });
    try {
      port.postMessage({
        type: "start",
        payload: {
          text: card.text,
          targetLang: card.targetLang,
          sourceLang: sourceLangOf(),
          pageUrl: location.href,
          pageTitle: document.title || "",
        },
      });
    } catch (error) {
      AIT.log("stream start failed", error);
      card.port = null;
      fallbackTranslate(seq);
      return;
    }
    startWatchdog(seq);
  }

  function onPortMessage(seq, message) {
    const card = state.card;
    if (seq !== card.seq || !card.open) return;
    if (!message || typeof message !== "object") return;
    const type = String(message.type || "");
    if (type === "meta") {
      card.meta = {
        provider: String(message.provider || ""),
        model: String(message.model || ""),
      };
      updateMeta();
      return;
    }
    if (type === "chunk") {
      const wasLoading = card.status === "loading";
      card.status = "streaming";
      if (typeof message.content === "string") card.content = message.content;
      else if (typeof message.delta === "string") card.content += message.delta;
      if (typeof message.reasoning === "string") card.reasoning = message.reasoning;
      updateReasoning();
      if (wasLoading) updateFoot();
      scheduleTypewriter();
      return;
    }
    if (type === "done") {
      card.usage = normalizeUsage(message.usage) || card.usage;
      card.cached = message.cached === true;
      const text = typeof message.content === "string" ? message.content : card.content;
      finishStream(text, seq);
      return;
    }
    if (type === "error") {
      failStream(message.code, message.message);
    }
  }

  function onPortDisconnect(seq) {
    const card = state.card;
    if (seq !== card.seq || !card.open) return;
    card.port = null;
    if (card.status === "done" || card.status === "error") return;
    let detail = "";
    try {
      if (typeof chrome !== "undefined" && chrome.runtime && chrome.runtime.lastError) {
        detail = chrome.runtime.lastError.message || "";
      }
    } catch (_) {}
    AIT.log("stream disconnected", detail);
    failStream("INTERNAL", "与扩展后台的连接已断开，请刷新页面后重试。");
  }

  function fallbackTranslate(seq) {
    const card = state.card;
    card.fallback = true;
    card.status = "loading";
    updateFoot();
    updatePlaceholder();
    AIT.runtimeSend({
      type: "ait:translate.text",
      payload: {
        text: card.text,
        targetLang: card.targetLang,
        sourceLang: sourceLangOf(),
        pageUrl: location.href,
        pageTitle: document.title || "",
      },
    }).then(function (response) {
      if (seq !== state.card.seq || !state.card.open) return;
      if (response && response.ok && typeof response.text === "string" && response.text.trim()) {
        state.card.usage = normalizeUsage(response.usage);
        state.card.cached = response.cached === true;
        finishStream(response.text, seq);
        return;
      }
      const error = (response && response.error) || {};
      failStream(error.code || "INTERNAL", error.message || "翻译失败，请检查 API 设置后重试。");
    });
  }

  function startWatchdog(seq) {
    stopWatchdog();
    const card = state.card;
    const wait = Math.max(15000, state.settings.provider.timeoutMs + 5000);
    card.watchdog = window.setTimeout(function () {
      card.watchdog = 0;
      if (seq !== card.seq || !card.open) return;
      if (card.status === "done" || card.status === "error") return;
      if (card.content) finishStream(card.content, seq);
      else failStream("TIMEOUT", "请求超时，没有收到响应。请检查网络或稍后重试。");
    }, wait);
  }

  function stopWatchdog() {
    const card = state.card;
    if (card.watchdog) {
      clearTimeout(card.watchdog);
      card.watchdog = 0;
    }
  }

  function abortPort() {
    const card = state.card;
    const port = card.port;
    card.port = null;
    if (!port) return;
    try {
      port.postMessage({ type: "abort" });
    } catch (_) {}
    try {
      port.disconnect();
    } catch (_) {}
  }

  function finishStream(finalText, seq) {
    const card = state.card;
    if (seq !== card.seq || !card.open) return;
    if (typeof finalText === "string" && finalText.trim()) card.content = finalText;
    if (!card.content) {
      failStream("EMPTY_RESPONSE", "模型返回了空内容，请重试或更换模型。");
      return;
    }
    card.finished = { at: Date.now(), usage: card.usage, cached: card.cached };
    stopWatchdog();
    if (reducedMotion() || card.shown === card.content) {
      card.shown = card.content;
      renderTranslation(true);
      updatePlaceholder();
      finalizeDone();
      return;
    }
    scheduleTypewriter();
  }

  function finalizeDone() {
    const card = state.card;
    if (!card.open || card.status === "done") return;
    card.status = "done";
    stopWatchdog();
    if (card.content !== card.shown) {
      card.shown = card.content;
      renderTranslation(true);
    }
    card.el.classList.remove("is-streaming");
    updatePlaceholder();
    updateReasoning();
    updateFoot();
  }

  function failStream(code, message) {
    const card = state.card;
    if (!card.open) return;
    stopWatchdog();
    abortPort();
    cancelTypewriter();
    card.status = "error";
    card.error = {
      code: String(code || "INTERNAL"),
      message: String(message || "翻译失败，请重试。"),
    };
    card.el.classList.remove("is-streaming");
    if (card.content && card.shown !== card.content) {
      // 保留已流出的部分译文
      card.shown = card.content;
      renderTranslation(true);
    }
    const refs = state.refs;
    refs.errorText.textContent = card.error.message;
    refs.errorBox.hidden = false;
    updatePlaceholder();
    updateReasoning();
    updateFoot();
    refs.output.scrollTop = refs.output.scrollHeight;
  }

  // ===== 打字机 =====

  function scheduleTypewriter() {
    const card = state.card;
    if (!card.open) return;
    if (reducedMotion()) {
      card.shown = card.content;
      renderTranslation(true);
      updatePlaceholder();
      if (card.finished) finalizeDone();
      return;
    }
    if (typewriter.raf) return;
    typewriter.raf = window.requestAnimationFrame(typeTick);
  }

  function cancelTypewriter() {
    if (typewriter.raf) {
      window.cancelAnimationFrame(typewriter.raf);
      typewriter.raf = 0;
    }
  }

  function typeTick() {
    typewriter.raf = 0;
    const card = state.card;
    if (!card.open) return;
    const target = card.content;
    if (card.shown === target) {
      updatePlaceholder();
      if (card.finished) finalizeDone();
      return;
    }
    if (target.indexOf(card.shown) !== 0) {
      card.shown = target;
    } else {
      const backlog = target.length - card.shown.length;
      let step = 2;
      if (backlog > 480) step = card.finished ? 60 : 30;
      else if (backlog > 160) step = 14;
      else if (backlog > 48) step = 7;
      else if (backlog > 12) step = 4;
      const end = safeSliceEnd(target, Math.min(target.length, card.shown.length + step));
      card.shown = target.slice(0, end);
    }
    renderTranslation(false);
    updatePlaceholder();
    keepCardInViewport();
    typewriter.raf = window.requestAnimationFrame(typeTick);
  }

  // ===== 初始化与对外接口 =====

  function init() {
    if (state.inited) return;
    if (!document.documentElement) return;
    if (!ensureHost()) return;
    state.inited = true;
    bindEvents();
    applyTheme();
    loadSettings();
    AIT.log("selection ready");
  }

  function open(text, rect) {
    if (!state.inited) init();
    let targetText = typeof text === "string" ? text : "";
    let targetRect = normalizeRectInput(rect);
    if (!targetText) {
      const selection = window.getSelection();
      targetText = selection ? selection.toString() : "";
      if (!targetRect && selection) {
        targetRect = selectionBoundsRect(selection) || selectionLastRect(selection);
      }
    }
    if (!targetRect && state.trigger.anchor) targetRect = anchorToRect(state.trigger.anchor);
    if (!targetRect) targetRect = centerRect();
    openCard(targetText, targetRect);
  }

  function closeApi() {
    closeCard("api");
  }

  AIT.selection = {
    __aitSelection: true,
    init: init,
    open: open,
    close: closeApi,
    isEnabled: isEnabled,
    applySettings: applySettings,
    getState: function () {
      return {
        inited: state.inited,
        enabled: isEnabled(),
        targetLang: state.sessionLang || resolveTargetLang(),
        triggerVisible: state.trigger.visible,
        cardOpen: state.card.open,
        status: state.card.status,
        contentLength: state.card.content.length,
        reasoningLength: state.card.reasoning.length,
        viewport: [window.innerWidth, window.innerHeight, window.scrollX, window.scrollY],
        triggerRect: state.trigger.rect ? Object.assign({}, state.trigger.rect) : null,
        triggerAnchor: state.trigger.anchor ? Object.assign({}, state.trigger.anchor) : null,
        cardAnchor: state.card.anchor ? Object.assign({}, state.card.anchor) : null,
      };
    },
  };

  // 兜底自初始化：90-main.js 也会调用 init()，此处幂等，保证单独加载时可用
  if (document.readyState === "loading") {
    document.addEventListener(
      "DOMContentLoaded",
      function () {
        init();
      },
      { once: true }
    );
  } else {
    init();
  }

})();
