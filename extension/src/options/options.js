/**
 * options 控制器。
 *
 * 职责：左侧导航路由、表单即时保存、API 预设与测试连接、拉取模型、
 *       术语表与站点规则、缓存与统计、导入导出、快捷键说明、关于。
 * 真实扩展环境使用 chrome.*；?demo=1 时由 demo.js 的内存 mock 接管，DOM/CSS 完全一致。
 */
import { DEMO, DEMO_MODELS, DEMO_TEST_RESULT, runSelfTest } from "./demo.js";
import { getSettings, patchSettings, resetSettings } from "../shared/storage.js";
import {
  DEFAULT_SETTINGS,
  LANGUAGES,
  PROVIDER_PRESETS,
  chatCompletionsUrl,
  deepMerge,
} from "../shared/config.js";
import { MSG } from "../shared/messages.js";

const ICONS = {
  api:
    '<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="4" width="18" height="7" rx="2"></rect><rect x="3" y="13" width="18" height="7" rx="2"></rect><path d="M7 7.5h.01M7 16.5h.01"></path></svg>',
  language:
    '<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="9"></circle><path d="M3 12h18"></path><path d="M12 3c2.6 3 2.6 15 0 18M12 3c-2.6 3-2.6 15 0 18"></path></svg>',
  selection:
    '<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M4 7V5a1 1 0 0 1 1-1h2"></path><path d="M17 4h2a1 1 0 0 1 1 1v2"></path><path d="M20 17v2a1 1 0 0 1-1 1h-2"></path><path d="M7 20H5a1 1 0 0 1-1-1v-2"></path><path d="M8 12h8"></path></svg>',
  glossary:
    '<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M5 4a2 2 0 0 1 2-2h9l3 3v15a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2z"></path><path d="M8 8h6M8 12h8M8 16h5"></path></svg>',
  sites:
    '<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M4 10.5 12 4l8 6.5V20a1 1 0 0 1-1 1h-5v-6H10v6H5a1 1 0 0 1-1-1z"></path></svg>',
  cache:
    '<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><ellipse cx="12" cy="5.5" rx="8" ry="3"></ellipse><path d="M4 5.5v6c0 1.7 3.6 3 8 3s8-1.3 8-3v-6"></path><path d="M4 11.5v6c0 1.7 3.6 3 8 3s8-1.3 8-3v-6"></path></svg>',
  data:
    '<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M12 4v12"></path><path d="m8 8 4-4 4 4"></path><path d="M4 16v3a1 1 0 0 0 1 1h14a1 1 0 0 0 1-1v-3"></path></svg>',
  shortcuts:
    '<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><rect x="2.5" y="6" width="19" height="12" rx="2"></rect><path d="M6 10h.01M9 10h.01M12 10h.01M15 10h.01M18 10h.01M7 14h10"></path></svg>',
  about:
    '<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="9"></circle><path d="M12 11v5M12 8h.01"></path></svg>',
  eye:
    '<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M2.5 12S6 5.5 12 5.5 21.5 12 21.5 12 18 18.5 12 18.5 2.5 12 2.5 12z"></path><circle cx="12" cy="12" r="2.8"></circle></svg>',
  eyeOff:
    '<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M3 3l18 18"></path><path d="M10.6 6.1A9.9 9.9 0 0 1 12 6c6 0 9.5 6 9.5 6a17 17 0 0 1-3 3.6"></path><path d="M6.1 6.9A16.6 16.6 0 0 0 2.5 12S6 18 12 18a9.7 9.7 0 0 0 4.2-.9"></path><path d="M9.9 10a2.9 2.9 0 0 0 4.1 4.1"></path></svg>',
  trash:
    '<svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M4 7h16"></path><path d="M9 7V4.5A1.5 1.5 0 0 1 10.5 3h3A1.5 1.5 0 0 1 15 4.5V7"></path><path d="M6 7l1 13a1 1 0 0 0 1 1h8a1 1 0 0 0 1-1l1-13"></path></svg>',
  x:
    '<svg viewBox="0 0 24 24" width="12" height="12" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="m6 6 12 12M18 6 6 18"></path></svg>',
};

const SECTIONS = [
  { id: "api", label: "连接与模型", title: "连接与模型", desc: "配置 OpenAI 兼容接口，测试连通性并选择模型。" },
  { id: "language", label: "语言与翻译", title: "语言与翻译", desc: "设置源语言、目标语言、显示方式与翻译行为。" },
  { id: "selection", label: "划词翻译", title: "划词翻译", desc: "配置选中文字后的翻译按钮、卡片与流式输出。" },
  { id: "glossary", label: "术语表", title: "术语表", desc: "固定术语译法，让专有名词在整页翻译中保持一致。" },
  { id: "sites", label: "站点规则", title: "站点规则", desc: "按域名决定自动翻译或永不翻译。" },
  { id: "cache", label: "缓存与统计", title: "缓存与统计", desc: "管理本地翻译缓存与 Token 用量统计。" },
  { id: "data", label: "导入导出", title: "导入导出", desc: "备份、迁移或重置全部设置。" },
  { id: "shortcuts", label: "快捷键", title: "快捷键", desc: "查看快捷键、右键菜单与弹窗入口。" },
  { id: "about", label: "关于", title: "关于", desc: "版本信息、隐私说明与开源信息。" },
];

const DOM_IDS = [
  "nav",
  "demo-banner",
  "demo-tag",
  "version",
  "page-heading",
  "page-desc",
  "save-state",
  "preset-row",
  "base-url",
  "endpoint-preview",
  "api-key",
  "toggle-key",
  "toggle-key-icon",
  "model",
  "fetch-models",
  "fetch-models-label",
  "model-list",
  "temperature",
  "max-tokens",
  "timeout",
  "test-connection",
  "test-connection-label",
  "test-result",
  "source-lang",
  "target-lang",
  "concurrency",
  "batch-size",
  "retry-limit",
  "min-text-length",
  "max-segment-chars",
  "prompt-system",
  "prompt-page",
  "prompt-selection",
  "theme",
  "selection-lang",
  "selection-max",
  "glossary-list",
  "add-term",
  "auto-sites",
  "exclude-sites",
  "auto-site-input",
  "exclude-site-input",
  "cache-entries",
  "cache-bytes",
  "cache-limit",
  "stat-requests",
  "stat-segments",
  "stat-hits",
  "stat-tokens-in",
  "stat-tokens-out",
  "stat-since",
  "clear-cache",
  "reset-stats",
  "export-include-key",
  "export-settings",
  "import-settings",
  "import-file",
  "import-result",
  "reset-settings",
  "shortcut-list",
  "open-shortcuts",
  "about-version",
  "about-version-2",
  "confirm-dialog",
  "confirm-title",
  "confirm-message",
  "confirm-accept",
  "toast",
];

const dom = {};
const state = {
  settings: deepMerge(DEFAULT_SETTINGS, {}),
  glossary: [],
  autoSites: [],
  excludeSites: [],
  toastTimer: null,
  toastHideTimer: null,
};

const pendingSave = new Map();
let glossaryTimer = null;

/* ---------- 通用工具 ---------- */

function $(id) {
  return document.getElementById(id);
}

function readableError(error) {
  if (!error) return "未知错误";
  if (typeof error === "string") return error;
  if (error.message) return error.message;
  return String(error);
}

function renderError(response) {
  if (response && response.error && response.error.message) return response.error.message;
  return "操作失败，请稍后重试。";
}

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

const numberFormat = new Intl.NumberFormat("zh-CN");

function formatNumber(value) {
  return numberFormat.format(Number(value) || 0);
}

function formatBytes(bytes) {
  const value = Number(bytes) || 0;
  if (value >= 1024 * 1024) return (value / (1024 * 1024)).toFixed(1) + " MB";
  if (value >= 1024) return Math.round(value / 1024) + " KB";
  return value + " B";
}

function formatDate(timestamp) {
  const value = Number(timestamp) || 0;
  if (!value) return "—";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "—";
  return date.getFullYear() + "-" + String(date.getMonth() + 1).padStart(2, "0") + "-" + String(date.getDate()).padStart(2, "0");
}

function getPath(source, path) {
  return String(path || "")
    .split(".")
    .reduce((cursor, key) => (cursor === undefined || cursor === null ? undefined : cursor[key]), source);
}

function buildPatch(path, value) {
  const keys = String(path).split(".");
  const patch = {};
  let cursor = patch;
  keys.forEach((key, index) => {
    if (index === keys.length - 1) {
      cursor[key] = value;
    } else {
      cursor[key] = {};
      cursor = cursor[key];
    }
  });
  return patch;
}

function sendRuntime(message) {
  return new Promise((resolve) => {
    try {
      chrome.runtime.sendMessage(message, (response) => {
        const lastError = chrome.runtime.lastError;
        if (lastError) {
          resolve({ ok: false, error: { code: "INTERNAL", message: lastError.message || "扩展后台未响应。" } });
          return;
        }
        resolve(response || { ok: false, error: { code: "INTERNAL", message: "扩展后台未响应。" } });
      });
    } catch (error) {
      resolve({ ok: false, error: { code: "INTERNAL", message: readableError(error) } });
    }
  });
}

function toast(message, tone) {
  const el = dom.toast;
  if (!el) return;
  window.clearTimeout(state.toastTimer);
  window.clearTimeout(state.toastHideTimer);
  el.textContent = message;
  el.hidden = false;
  void el.offsetWidth;
  el.classList.add("is-visible");
  state.toastTimer = window.setTimeout(() => {
    el.classList.remove("is-visible");
    state.toastHideTimer = window.setTimeout(() => {
      el.hidden = true;
    }, 200);
  }, 2600);
}

function applyTheme(theme) {
  const value = theme === "light" || theme === "dark" ? theme : "auto";
  document.documentElement.dataset.theme = value;
}

function setSaveState(mode) {
  const el = dom.saveState;
  if (!el) return;
  if (mode === "saving") {
    el.textContent = "保存中…";
    el.classList.add("is-saving");
  } else {
    el.textContent = "已保存";
    el.classList.remove("is-saving");
  }
}

/* ---------- 保存 ---------- */

async function applyPatch(patch) {
  setSaveState("saving");
  try {
    state.settings = await patchSettings(patch);
    setSaveState("saved");
    return true;
  } catch (error) {
    setSaveState("saved");
    toast("保存失败：" + readableError(error), "error");
    return false;
  }
}

function scheduleSave(path, value, delay) {
  const existing = pendingSave.get(path);
  if (existing) window.clearTimeout(existing.timer);
  const timer = window.setTimeout(() => {
    pendingSave.delete(path);
    void applyPatch(buildPatch(path, value));
  }, typeof delay === "number" ? delay : 420);
  pendingSave.set(path, { timer, value });
}

async function flushSaves() {
  if (!pendingSave.size) return;
  let patch = {};
  for (const [path, entry] of pendingSave) {
    window.clearTimeout(entry.timer);
    patch = deepMerge(patch, buildPatch(path, entry.value));
  }
  pendingSave.clear();
  await applyPatch(patch);
}

/* ---------- 表单 ---------- */

function readControlValue(control) {
  if (control.type === "checkbox") return control.checked;
  if (control.type === "radio") return control.value;
  if (control.type === "number") {
    const raw = String(control.value || "").trim();
    if (!raw) return undefined;
    let value = Number(raw);
    if (!Number.isFinite(value)) return undefined;
    const min = control.min === "" ? -Infinity : Number(control.min);
    const max = control.max === "" ? Infinity : Number(control.max);
    if (Number.isFinite(min)) value = Math.max(min, value);
    if (Number.isFinite(max)) value = Math.min(max, value);
    return value;
  }
  return control.value;
}

function writeControlValue(control, value) {
  if (control.type === "checkbox") {
    control.checked = !!value;
    return;
  }
  if (control.type === "radio") {
    control.checked = String(value) === control.value;
    return;
  }
  if (control.tagName === "SELECT") {
    control.value = value === undefined || value === null ? "" : String(value);
    if (control.selectedIndex < 0 && control.options.length) control.selectedIndex = 0;
    return;
  }
  control.value = value === undefined || value === null ? "" : String(value);
}

function syncForm() {
  document.querySelectorAll("[data-setting]").forEach((control) => {
    writeControlValue(control, getPath(state.settings, control.dataset.setting));
  });
  updateEndpointPreview();
  renderPresets();
}

function bindFormControls() {
  document.querySelectorAll("[data-setting]").forEach((control) => {
    const path = control.dataset.setting;
    const isChoice = control.tagName === "SELECT" || control.type === "checkbox" || control.type === "radio";
    if (isChoice) {
      control.addEventListener("change", () => {
        const value = readControlValue(control);
        if (value === undefined) return;
        void applyPatch(buildPatch(path, value));
        if (path === "ui.theme") applyTheme(value);
        if (path === "provider.baseUrl") updateEndpointPreview();
      });
      return;
    }
    control.addEventListener("input", () => {
      const value = readControlValue(control);
      if (value === undefined) return;
      scheduleSave(path, value);
      if (path === "provider.baseUrl") updateEndpointPreview();
    });
    control.addEventListener("blur", () => {
      if (control.type === "number" && String(control.value || "").trim() === "") {
        writeControlValue(control, getPath(state.settings, path));
      }
    });
  });
}

/* ---------- 语言与预设 ---------- */

function fillLanguageSelects() {
  fillSelect(dom.sourceLang, [{ code: "auto", label: "自动检测" }].concat(LANGUAGES));
  fillSelect(dom.targetLang, LANGUAGES);
  fillSelect(dom.selectionLang, [{ code: "", label: "跟随全局设置" }].concat(LANGUAGES));
}

function fillSelect(select, items) {
  select.textContent = "";
  items.forEach((item) => {
    const option = document.createElement("option");
    option.value = item.code;
    option.textContent = item.label;
    select.appendChild(option);
  });
}

function normalizeBaseUrl(value) {
  return String(value || "").trim().replace(/\/+$/, "").toLowerCase();
}

function renderPresets() {
  const current = normalizeBaseUrl(getPath(state.settings, "provider.baseUrl"));
  const matched = PROVIDER_PRESETS.some((preset) => preset.baseUrl && normalizeBaseUrl(preset.baseUrl) === current);
  dom.presetRow.textContent = "";
  PROVIDER_PRESETS.forEach((preset) => {
    const button = document.createElement("button");
    button.type = "button";
    button.className = "preset-chip";
    button.dataset.preset = preset.id;
    button.textContent = preset.label;
    const active = preset.baseUrl
      ? normalizeBaseUrl(preset.baseUrl) === current
      : !matched;
    if (active) button.classList.add("is-active");
    button.setAttribute("aria-pressed", active ? "true" : "false");
    dom.presetRow.appendChild(button);
  });
}

function updateEndpointPreview() {
  const baseUrl = String(dom.baseUrl.value || "").trim();
  if (!baseUrl) {
    dom.endpointPreview.textContent = "尚未填写 Base URL，测试连接前请先填写。";
    return;
  }
  dom.endpointPreview.textContent = "请求地址：" + chatCompletionsUrl(baseUrl);
}

async function onPresetClick(event) {
  const button = event.target.closest("[data-preset]");
  if (!button) return;
  const preset = PROVIDER_PRESETS.find((item) => item.id === button.dataset.preset);
  if (!preset) return;
  if (!preset.baseUrl && !preset.model) {
    toast("已切换到自定义配置，请手动填写 Base URL 与模型。");
    return;
  }
  const saved = await applyPatch({ provider: { baseUrl: preset.baseUrl, model: preset.model } });
  if (saved) {
    syncForm();
    toast("已填入 " + preset.label + " 的地址与模型");
  }
}

/* ---------- API Key 显示 ---------- */

function toggleKeyVisibility() {
  const showing = dom.apiKey.type === "text";
  dom.apiKey.type = showing ? "password" : "text";
  dom.toggleKey.setAttribute("aria-pressed", showing ? "false" : "true");
  dom.toggleKey.setAttribute("aria-label", showing ? "显示 API Key" : "隐藏 API Key");
  dom.toggleKeyIcon.innerHTML = showing ? ICONS.eye : ICONS.eyeOff;
  dom.apiKey.focus();
}

/* ---------- 测试连接与模型 ---------- */

function setButtonBusy(button, spinner, label, busy, busyText) {
  button.disabled = busy;
  if (spinner) spinner.hidden = !busy;
  if (label && busy) {
    if (!label.dataset.idleText) label.dataset.idleText = label.textContent;
    label.textContent = busyText;
  } else if (label && label.dataset.idleText) {
    label.textContent = label.dataset.idleText;
  }
}

function showInline(element, tone, title, detail) {
  element.hidden = false;
  element.classList.remove("is-ok", "is-error");
  element.classList.add(tone === "error" ? "is-error" : "is-ok");
  element.textContent = "";
  const titleEl = document.createElement("p");
  titleEl.className = "result-title";
  titleEl.textContent = title;
  const detailEl = document.createElement("p");
  detailEl.className = "result-detail";
  detailEl.textContent = detail;
  element.append(titleEl, detailEl);
}

async function testConnection(options) {
  const silent = !!(options && options.silent);
  await flushSaves();
  setButtonBusy(dom.testConnection, dom.testSpinner, dom.testConnectionLabel, true, "测试中…");
  try {
    const response = await sendRuntime({
      type: MSG.PROVIDER_TEST,
      payload: {
        baseUrl: String(dom.baseUrl.value || "").trim(),
        apiKey: String(dom.apiKey.value || "").trim(),
        model: String(dom.model.value || "").trim(),
      },
    });
    if (response && response.ok) {
      showInline(
        dom.testResult,
        "ok",
        "连接正常",
        "延迟 " + (Number(response.latencyMs) || 0) + " ms · 模型 " + (response.model || "—") + " · 返回：" + (response.sample || "（空）")
      );
      if (!silent) toast("连接正常");
    } else {
      showInline(dom.testResult, "error", "连接失败", renderError(response));
      if (!silent) toast("连接失败，请检查配置", "error");
    }
  } finally {
    setButtonBusy(dom.testConnection, dom.testSpinner, dom.testConnectionLabel, false);
  }
}

function renderModelList(models) {
  dom.modelList.hidden = false;
  dom.modelList.textContent = "";
  models.slice(0, 80).forEach((name) => {
    const button = document.createElement("button");
    button.type = "button";
    button.className = "model-chip";
    button.textContent = name;
    button.title = "使用模型 " + name;
    button.addEventListener("click", () => {
      dom.model.value = name;
      void applyPatch({ provider: { model: name } });
      toast("已选择模型 " + name);
    });
    dom.modelList.appendChild(button);
  });
}

async function fetchModels(options) {
  const silent = !!(options && options.silent);
  await flushSaves();
  setButtonBusy(dom.fetchModels, dom.fetchModelsSpinner, dom.fetchModelsLabel, true, "拉取中…");
  try {
    const response = await sendRuntime({
      type: MSG.PROVIDER_MODELS,
      payload: {
        baseUrl: String(dom.baseUrl.value || "").trim(),
        apiKey: String(dom.apiKey.value || "").trim(),
      },
    });
    if (response && response.ok && Array.isArray(response.models)) {
      renderModelList(response.models);
      if (!silent) toast("已拉取 " + response.models.length + " 个模型");
    } else {
      toast(renderError(response), "error");
    }
  } finally {
    setButtonBusy(dom.fetchModels, dom.fetchModelsSpinner, dom.fetchModelsLabel, false);
  }
}

/* ---------- 术语表 ---------- */

function normalizeTerm(item) {
  return {
    from: String((item && item.from) || ""),
    to: String((item && item.to) || ""),
    note: String((item && item.note) || ""),
  };
}

function loadGlossary() {
  const raw = getPath(state.settings, "glossary");
  state.glossary = Array.isArray(raw) ? clone(raw).map(normalizeTerm) : [];
  renderGlossary();
}

function makeTermInput(field, value, label, index) {
  const input = document.createElement("input");
  input.className = "input";
  input.type = "text";
  input.value = value;
  input.placeholder = label;
  input.dataset.termField = field;
  input.dataset.index = String(index);
  input.setAttribute("aria-label", label + "（第 " + (index + 1) + " 条）");
  return input;
}

function renderGlossary() {
  const list = dom.glossaryList;
  list.textContent = "";
  if (!state.glossary.length) {
    const empty = document.createElement("p");
    empty.className = "empty-state";
    empty.textContent = "还没有术语。添加后会在所有翻译请求中优先使用固定译法。";
    list.appendChild(empty);
    return;
  }
  state.glossary.forEach((term, index) => {
    const row = document.createElement("div");
    row.className = "glossary-row";
    row.dataset.index = String(index);
    row.appendChild(makeTermInput("from", term.from, "原文术语", index));
    const arrow = document.createElement("span");
    arrow.className = "glossary-arrow";
    arrow.textContent = "→";
    arrow.setAttribute("aria-hidden", "true");
    row.appendChild(arrow);
    row.appendChild(makeTermInput("to", term.to, "译文术语", index));
    const note = makeTermInput("note", term.note, "备注（可选）", index);
    note.classList.add("glossary-note");
    row.appendChild(note);
    const remove = document.createElement("button");
    remove.type = "button";
    remove.className = "icon-btn";
    remove.dataset.removeTerm = String(index);
    remove.title = "删除";
    remove.setAttribute("aria-label", "删除第 " + (index + 1) + " 条术语");
    remove.innerHTML = ICONS.trash;
    row.appendChild(remove);
    list.appendChild(row);
  });
}

function scheduleGlossarySave(immediate) {
  window.clearTimeout(glossaryTimer);
  glossaryTimer = window.setTimeout(() => {
    void applyPatch({ glossary: clone(state.glossary) });
  }, immediate ? 0 : 450);
}

function addTerm() {
  state.glossary.push({ from: "", to: "", note: "" });
  renderGlossary();
  const fromInputs = dom.glossaryList.querySelectorAll('[data-term-field="from"]');
  const last = fromInputs[fromInputs.length - 1];
  if (last) last.focus();
  scheduleGlossarySave(true);
}

/* ---------- 站点规则 ---------- */

function loadSites() {
  const auto = getPath(state.settings, "translate.autoSites");
  const exclude = getPath(state.settings, "translate.excludeSites");
  state.autoSites = Array.isArray(auto) ? auto.slice() : [];
  state.excludeSites = Array.isArray(exclude) ? exclude.slice() : [];
  renderChips("autoSites");
  renderChips("excludeSites");
}

function normalizeHost(value) {
  let host = String(value || "").trim().toLowerCase();
  host = host.replace(/^https?:\/\//, "").replace(/\/.*$/, "").replace(/:\d+$/, "");
  if (!host) return "";
  if (!/^(\*\.)?[a-z0-9][a-z0-9.-]*$/.test(host)) return "";
  return host;
}

function renderChips(kind) {
  const container = kind === "autoSites" ? dom.autoSites : dom.excludeSites;
  const list = state[kind];
  container.textContent = "";
  if (!list.length) {
    const empty = document.createElement("span");
    empty.className = "chip-empty";
    empty.textContent = "暂无站点";
    container.appendChild(empty);
    return;
  }
  list.forEach((host, index) => {
    const chip = document.createElement("span");
    chip.className = "chip";
    const label = document.createElement("span");
    label.textContent = host;
    chip.appendChild(label);
    const remove = document.createElement("button");
    remove.type = "button";
    remove.className = "chip-remove";
    remove.dataset.removeSite = kind;
    remove.dataset.index = String(index);
    remove.setAttribute("aria-label", "移除站点 " + host);
    remove.title = "移除";
    remove.innerHTML = ICONS.x;
    chip.appendChild(remove);
    container.appendChild(chip);
  });
}

function addSite(kind, rawValue) {
  const host = normalizeHost(rawValue);
  if (!host) {
    toast("请输入有效域名，例如 example.com 或 *.example.com", "error");
    return false;
  }
  const list = state[kind];
  if (list.indexOf(host) >= 0) {
    toast("该站点已在列表中");
    return false;
  }
  list.push(host);
  renderChips(kind);
  void applyPatch(buildPatch("translate." + kind, list.slice()));
  return true;
}

function onRemoveSite(event) {
  const button = event.target.closest("[data-remove-site]");
  if (!button) return;
  const kind = button.dataset.removeSite;
  const index = Number(button.dataset.index);
  if (!Array.isArray(state[kind]) || index < 0) return;
  state[kind].splice(index, 1);
  renderChips(kind);
  void applyPatch(buildPatch("translate." + kind, state[kind].slice()));
}

function bindSites() {
  document.querySelectorAll("[data-chip-add]").forEach((button) => {
    const kind = button.dataset.chipAdd;
    button.addEventListener("click", () => {
      const input = kind === "autoSites" ? dom.autoSiteInput : dom.excludeSiteInput;
      if (addSite(kind, input.value)) input.value = "";
    });
  });
  [
    ["autoSites", dom.autoSiteInput],
    ["excludeSites", dom.excludeSiteInput],
  ].forEach((pair) => {
    const kind = pair[0];
    const input = pair[1];
    input.addEventListener("keydown", (event) => {
      if (event.key !== "Enter") return;
      event.preventDefault();
      if (addSite(kind, input.value)) input.value = "";
    });
  });
  dom.autoSites.addEventListener("click", onRemoveSite);
  dom.excludeSites.addEventListener("click", onRemoveSite);
}

/* ---------- 缓存与统计 ---------- */

async function loadCacheAndStats() {
  const results = await Promise.all([
    sendRuntime({ type: MSG.CACHE_STATS }),
    sendRuntime({ type: MSG.STATS_GET }),
  ]);
  const cacheResponse = results[0];
  const statsResponse = results[1];

  if (cacheResponse && cacheResponse.ok) {
    dom.cacheEntries.textContent = formatNumber(cacheResponse.entries || 0);
    dom.cacheBytes.textContent = formatBytes(cacheResponse.bytes || 0);
    dom.cacheLimit.textContent = formatNumber(cacheResponse.maxEntries || 0);
  }

  if (statsResponse && statsResponse.ok && statsResponse.stats) {
    const stats = statsResponse.stats;
    dom.statRequests.textContent = formatNumber(stats.requests);
    dom.statSegments.textContent = formatNumber(stats.segments);
    dom.statHits.textContent = formatNumber(stats.cacheHits);
    dom.statTokensIn.textContent = formatNumber(stats.tokensIn);
    dom.statTokensOut.textContent = formatNumber(stats.tokensOut);
    dom.statSince.textContent = formatDate(stats.since);
  }
}

async function clearCache() {
  const confirmed = await askConfirm({
    title: "清空翻译缓存",
    message: "将删除全部本地缓存译文，下次翻译需要重新请求模型。设置与统计不受影响。",
    acceptText: "清空缓存",
    danger: true,
  });
  if (!confirmed) return;
  const response = await sendRuntime({ type: MSG.CACHE_CLEAR });
  if (response && response.ok) {
    await loadCacheAndStats();
    toast("缓存已清空");
  } else {
    toast(renderError(response), "error");
  }
}

async function resetStats() {
  const confirmed = await askConfirm({
    title: "重置用量统计",
    message: "请求次数、段落数、缓存命中与 Token 估算都会归零，缓存不会被删除。",
    acceptText: "重置统计",
    danger: true,
  });
  if (!confirmed) return;
  const response = await sendRuntime({ type: MSG.STATS_RESET });
  if (response && response.ok) {
    await loadCacheAndStats();
    toast("统计已重置");
  } else {
    toast(renderError(response), "error");
  }
}

/* ---------- 导入导出 ---------- */

function timestampForFile() {
  const date = new Date();
  const pad = (value) => String(value).padStart(2, "0");
  return (
    date.getFullYear() +
    pad(date.getMonth() + 1) +
    pad(date.getDate()) +
    "-" +
    pad(date.getHours()) +
    pad(date.getMinutes())
  );
}

async function exportSettings() {
  try {
    await flushSaves();
    const settings = await getSettings();
    const includeKey = dom.exportIncludeKey.checked;
    const copy = clone(settings);
    if (!includeKey) copy.provider.apiKey = "";
    const payload = {
      app: "ait",
      kind: "settings",
      version: 1,
      exportedAt: new Date().toISOString(),
      includesApiKey: includeKey,
      settings: copy,
    };
    const blob = new Blob([JSON.stringify(payload, null, 2)], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = url;
    link.download = "ait-settings-" + timestampForFile() + ".json";
    document.body.appendChild(link);
    link.click();
    link.remove();
    window.setTimeout(() => URL.revokeObjectURL(url), 1500);
    toast(includeKey ? "设置已导出（包含 API Key）" : "设置已导出（不含 API Key）");
  } catch (error) {
    toast("导出失败：" + readableError(error), "error");
  }
}

async function importSettings(file) {
  try {
    const text = await file.text();
    const parsed = JSON.parse(text);
    const settings = parsed && parsed.settings && typeof parsed.settings === "object" ? parsed.settings : parsed;
    if (!settings || typeof settings !== "object" || (!settings.provider && !settings.version)) {
      showInline(dom.importResult, "error", "导入失败", "这不是有效的设置文件：缺少 provider 或 version 字段。");
      return;
    }
    // 备份文件未包含 API Key 时保留本机现有 Key，避免导入备份反而清空配置
    if (parsed && parsed.includesApiKey === false) {
      settings.provider = settings.provider || {};
      settings.provider.apiKey = getPath(state.settings, "provider.apiKey") || "";
    }
    const confirmed = await askConfirm({
      title: "导入设置",
      message: "导入会覆盖当前全部配置，包括术语表与站点规则。确定继续吗？",
      acceptText: "导入并覆盖",
      danger: false,
    });
    if (!confirmed) return;
    await flushSaves();
    state.settings = await patchSettings(settings);
    applyTheme(getPath(state.settings, "ui.theme"));
    syncForm();
    loadGlossary();
    loadSites();
    await loadCacheAndStats();
    showInline(dom.importResult, "ok", "导入完成", "已应用 " + file.name + " 中的设置。");
    toast("设置已导入");
  } catch (error) {
    showInline(dom.importResult, "error", "导入失败", "文件解析失败：" + readableError(error));
  }
}

async function resetAllSettings() {
  const confirmed = await askConfirm({
    title: "恢复默认设置",
    message: "全部配置、术语表、站点规则与提示词都会被重置为默认值，此操作不可撤销。",
    acceptText: "恢复默认",
    danger: true,
  });
  if (!confirmed) return;
  try {
    await flushSaves();
    state.settings = await resetSettings();
    applyTheme(getPath(state.settings, "ui.theme"));
    syncForm();
    loadGlossary();
    loadSites();
    await loadCacheAndStats();
    toast("已恢复默认设置");
  } catch (error) {
    toast("重置失败：" + readableError(error), "error");
  }
}

/* ---------- 快捷键 ---------- */

function renderShortcuts(commands) {
  dom.shortcutList.textContent = "";
  commands.forEach((command) => {
    const row = document.createElement("div");
    row.className = "shortcut-row";
    const name = document.createElement("span");
    name.className = "shortcut-name";
    name.textContent = command.description || command.name || "快捷键";
    const keys = document.createElement("span");
    keys.className = "shortcut-keys";
    const shortcut = String(command.shortcut || "").trim();
    if (!shortcut) {
      const unset = document.createElement("span");
      unset.className = "key-unset";
      unset.textContent = "未设置";
      keys.appendChild(unset);
    } else {
      shortcut.split("+").forEach((part) => {
        const kbd = document.createElement("kbd");
        kbd.textContent = part;
        keys.appendChild(kbd);
      });
    }
    row.append(name, keys);
    dom.shortcutList.appendChild(row);
  });
}

const FALLBACK_SHORTCUTS = [
  { description: "翻译 / 还原当前页面", shortcut: "Alt+T" },
  { description: "切换双语 / 仅译文", shortcut: "Alt+M" },
  { description: "翻译选中文字", shortcut: "Alt+S" },
];

async function loadShortcuts() {
  try {
    const commands = await chrome.commands.getAll();
    renderShortcuts(Array.isArray(commands) && commands.length ? commands : FALLBACK_SHORTCUTS);
  } catch (_) {
    renderShortcuts(FALLBACK_SHORTCUTS);
  }
}

async function openShortcutSettings() {
  try {
    await chrome.tabs.create({ url: "edge://extensions/shortcuts" });
    toast("已打开快捷键设置页");
  } catch (_) {
    toast("无法直接打开，请在地址栏访问 edge://extensions/shortcuts", "error");
  }
}

/* ---------- 关于 ---------- */

function renderVersion() {
  try {
    const manifest = chrome.runtime.getManifest();
    const version = String(manifest.version || "1.0.0");
    dom.version.textContent = "v" + version;
    dom.aboutVersion.textContent = "版本 " + version;
    dom.aboutVersion2.textContent = version;
  } catch (_) {
    // 忽略版本读取失败
  }
}

/* ---------- 导航 ---------- */

function renderNav() {
  dom.nav.textContent = "";
  SECTIONS.forEach((section) => {
    const link = document.createElement("a");
    link.className = "nav-item";
    link.href = "#" + section.id;
    link.dataset.section = section.id;
    const icon = document.createElement("span");
    icon.className = "nav-icon";
    icon.innerHTML = ICONS[section.id] || "";
    icon.setAttribute("aria-hidden", "true");
    const label = document.createElement("span");
    label.textContent = section.label;
    link.append(icon, label);
    dom.nav.appendChild(link);
  });
}

function navigate(id, options) {
  const section = SECTIONS.find((item) => item.id === id) || SECTIONS[0];
  document.querySelectorAll(".section").forEach((element) => {
    element.hidden = element.id !== "section-" + section.id;
  });
  document.querySelectorAll(".nav-item").forEach((element) => {
    const active = element.dataset.section === section.id;
    element.classList.toggle("is-active", active);
    if (active) element.setAttribute("aria-current", "page");
    else element.removeAttribute("aria-current");
  });
  dom.pageHeading.textContent = section.title;
  dom.pageDesc.textContent = section.desc;
  document.title = section.title + " · 设置 · AI 双语翻译";
  if (!(options && options.silent)) {
    if (location.hash !== "#" + section.id) history.replaceState(null, "", "#" + section.id);
    window.scrollTo(0, 0);
  }
}

function initRoute() {
  const hash = String(location.hash || "").replace(/^#/, "");
  const initial = SECTIONS.some((item) => item.id === hash) ? hash : SECTIONS[0].id;
  navigate(initial, { silent: true });
  dom.nav.addEventListener("click", (event) => {
    const link = event.target.closest("[data-section]");
    if (!link) return;
    event.preventDefault();
    navigate(link.dataset.section);
  });
  window.addEventListener("hashchange", () => {
    const next = String(location.hash || "").replace(/^#/, "");
    if (SECTIONS.some((item) => item.id === next)) navigate(next, { silent: true });
  });
}

/* ---------- 确认对话框 ---------- */

function askConfirm(options) {
  return new Promise((resolve) => {
    dom.confirmTitle.textContent = options.title || "请确认";
    dom.confirmMessage.textContent = options.message || "";
    dom.confirmAccept.textContent = options.acceptText || "确认";
    dom.confirmAccept.classList.toggle("btn-danger", options.danger !== false);
    dom.confirmAccept.classList.toggle("btn-primary", options.danger === false);
    dom.confirmDialog.returnValue = "";
    const onClose = () => {
      dom.confirmDialog.removeEventListener("close", onClose);
      resolve(dom.confirmDialog.returnValue === "confirm");
    };
    dom.confirmDialog.addEventListener("close", onClose);
    dom.confirmDialog.showModal();
  });
}

/* ---------- 演示 ---------- */

function initDemoView() {
  dom.demoBanner.hidden = false;
  dom.demoTag.hidden = false;
  // 同步预填演示结果，保证任何截图时机都能看到完整状态。
  // 点击「测试连接 / 拉取模型」时仍会走真实的 mock 请求路径。
  showInline(
    dom.testResult,
    "ok",
    "连接正常",
    "延迟 " + DEMO_TEST_RESULT.latencyMs + " ms · 模型 " + DEMO_TEST_RESULT.model + " · 返回：" + DEMO_TEST_RESULT.sample
  );
  renderModelList(DEMO_MODELS);
}

/* ---------- 初始化 ---------- */

function cacheDom() {
  DOM_IDS.forEach((id) => {
    const key = id.replace(/-([a-z0-9])/g, (match, char) => char.toUpperCase());
    dom[key] = $(id);
  });
  dom.testSpinner = dom.testConnection.querySelector(".btn-spinner");
  dom.fetchModelsSpinner = dom.fetchModels.querySelector(".btn-spinner");
}

function bindGlobal() {
  dom.toggleKeyIcon.innerHTML = ICONS.eye;
  dom.toggleKey.addEventListener("click", toggleKeyVisibility);
  dom.presetRow.addEventListener("click", (event) => void onPresetClick(event));
  dom.testConnection.addEventListener("click", () => void testConnection());
  dom.fetchModels.addEventListener("click", () => void fetchModels());
  dom.addTerm.addEventListener("click", addTerm);
  dom.glossaryList.addEventListener("input", (event) => {
    const input = event.target.closest("[data-term-field]");
    if (!input) return;
    const index = Number(input.dataset.index);
    const term = state.glossary[index];
    if (!term) return;
    term[input.dataset.termField] = input.value;
    scheduleGlossarySave(false);
  });
  dom.glossaryList.addEventListener("click", (event) => {
    const button = event.target.closest("[data-remove-term]");
    if (!button) return;
    const index = Number(button.dataset.removeTerm);
    if (!Number.isFinite(index)) return;
    state.glossary.splice(index, 1);
    renderGlossary();
    scheduleGlossarySave(true);
  });
  bindSites();
  dom.clearCache.addEventListener("click", () => void clearCache());
  dom.resetStats.addEventListener("click", () => void resetStats());
  dom.exportSettings.addEventListener("click", () => void exportSettings());
  dom.importSettings.addEventListener("click", () => dom.importFile.click());
  dom.importFile.addEventListener("change", () => {
    const file = dom.importFile.files && dom.importFile.files[0];
    dom.importFile.value = "";
    if (file) void importSettings(file);
  });
  dom.resetSettings.addEventListener("click", () => void resetAllSettings());
  dom.openShortcuts.addEventListener("click", () => void openShortcutSettings());
}

async function init() {
  cacheDom();
  fillLanguageSelects();
  renderNav();
  bindGlobal();

  try {
    state.settings = await getSettings();
  } catch (error) {
    state.settings = deepMerge(DEFAULT_SETTINGS, {});
    toast("读取设置失败：" + readableError(error), "error");
  }

  applyTheme(getPath(state.settings, "ui.theme"));
  syncForm();
  loadGlossary();
  loadSites();
  renderVersion();
  initRoute();
  bindFormControls();
  void loadCacheAndStats();
  void loadShortcuts();

  if (DEMO) initDemoView();
  runSelfTest();
}

if (document.readyState === "loading") {
  document.addEventListener("DOMContentLoaded", () => void init(), { once: true });
} else {
  void init();
}
