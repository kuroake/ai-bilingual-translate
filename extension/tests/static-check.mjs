#!/usr/bin/env node
/**
 * 扩展静态检查（零依赖，直接用 node 运行，不引入第三方库）。
 *
 * 检查项：
 *   1. manifest.json 可解析、关键字段齐全（MV3 / ES Module background / storage 权限等）
 *   2. manifest.json 引用的文件（图标、popup、options、background、content_scripts、css）都存在
 *   3. content_scripts 的 JS 列表与顺序符合 docs/ARCHITECTURE.md 契约
 *   4. 所有 .js / .mjs 通过语法检查（等价 node --check，ESM 文件自动回退 stdin 模块检查）
 *   5. HTML 引用的本地 css/js/图片存在；无内联脚本、无远程脚本/CSS（MV3 CSP）
 *   6. 产品代码无远程代码 / 动态执行（eval、new Function、远程 import 等）
 *   7. 零依赖：无 node_modules、package.json 无依赖、无 TS/Vue 等需要构建的源码
 *   8. 编码规范：UTF-8、LF 换行、无 tab 缩进、JS 两空格缩进
 *
 * 用法：
 *   node extension/tests/static-check.mjs                 严格模式（验收用）
 *   node extension/tests/static-check.mjs --warn-missing  开发期：缺失文件降级为警告
 *   node extension/tests/static-check.mjs --json          只输出 JSON 摘要
 */
import { readFileSync, readdirSync, statSync, existsSync } from "node:fs";
import { spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const EXT_ROOT = path.resolve(HERE, "..");
const SRC_ROOT = path.join(EXT_ROOT, "src");
const NODE_BIN = process.execPath;
const ARGV = new Set(process.argv.slice(2));
const WARN_MISSING = ARGV.has("--warn-missing");
const JSON_ONLY = ARGV.has("--json");

const EXPECTED_CONTENT_SCRIPTS = [
  "src/content/00-core.js",
  "src/content/10-segmenter.js",
  "src/content/20-translator.js",
  "src/content/30-renderer.js",
  "src/content/40-selection.js",
  "src/content/50-observer.js",
  "src/content/90-main.js",
];

const results = [];
function add(status, title, details) {
  results.push({ status, title, details: details || [] });
}
function pass(title, details) {
  add("pass", title, details);
}
function fail(title, details) {
  add("fail", title, details);
}
function warn(title, details) {
  add("warn", title, details);
}

/** 校验相对 extension 根目录的文件是否存在；开发期可降级为警告 */
function requireFile(relPath, label) {
  const normalized = String(relPath || "").replace(/\\/g, "/");
  const abs = path.join(EXT_ROOT, normalized);
  if (normalized && existsSync(abs) && statSync(abs).isFile()) {
    pass(label + " 存在", [normalized]);
    return true;
  }
  const detail = label + " 缺失：" + (normalized || "(空路径)");
  if (WARN_MISSING) warn(detail + "（开发期降级）");
  else fail(detail);
  return false;
}

function walk(dir) {
  const files = [];
  if (!existsSync(dir)) return files;
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === "node_modules" || entry.name === ".git" || entry.name === "dist" || entry.name === "build") {
      continue;
    }
    const abs = path.join(dir, entry.name);
    if (entry.isDirectory()) files.push(...walk(abs));
    else if (entry.isFile()) files.push(abs);
  }
  return files;
}

function relOf(abs) {
  return path.relative(EXT_ROOT, abs).split(path.sep).join("/");
}

function readText(abs) {
  return readFileSync(abs, "utf8");
}

// ---------------------------------------------------------------- 1. manifest

const manifestPath = path.join(EXT_ROOT, "manifest.json");
let manifest = null;
if (!existsSync(manifestPath)) {
  fail("manifest.json 存在");
} else {
  try {
    manifest = JSON.parse(readText(manifestPath));
    pass("manifest.json 可解析");
  } catch (error) {
    fail("manifest.json 可解析", [error.message]);
  }
}

if (manifest) {
  const m = manifest;
  if (m.manifest_version === 3) pass("manifest_version = 3");
  else fail("manifest_version = 3", ["实际：" + m.manifest_version]);

  if (typeof m.name === "string" && m.name.trim()) pass("name 非空");
  else fail("name 非空");

  if (/^\d+\.\d+\.\d+$/.test(String(m.version || ""))) pass("version 为 x.y.z");
  else fail("version 为 x.y.z", ["实际：" + m.version]);

  if (m.minimum_chrome_version && Number(m.minimum_chrome_version) >= 114) pass("minimum_chrome_version ≥ 114");
  else fail("minimum_chrome_version ≥ 114", ["实际：" + m.minimum_chrome_version]);

  if (m.background && typeof m.background.service_worker === "string") pass("background.service_worker 已声明");
  else fail("background.service_worker 已声明");
  if (m.background && m.background.type === "module") pass("background 使用 ES Module");
  else fail("background 使用 ES Module");

  if (m.action && typeof m.action.default_popup === "string") pass("action.default_popup 已声明");
  else fail("action.default_popup 已声明");

  if (m.options_ui && typeof m.options_ui.page === "string") pass("options_ui.page 已声明");
  else fail("options_ui.page 已声明");

  if (Array.isArray(m.permissions) && m.permissions.includes("storage")) pass("permissions 含 storage");
  else fail("permissions 含 storage");

  if (Array.isArray(m.host_permissions) && m.host_permissions.includes("<all_urls>")) pass("host_permissions 含 <all_urls>");
  else fail("host_permissions 含 <all_urls>");

  const commands = m.commands || {};
  const hotkeys = {
    "toggle-translate": "Alt+T",
    "toggle-mode": "Alt+M",
    "translate-selection": "Alt+S",
  };
  for (const [id, key] of Object.entries(hotkeys)) {
    const command = commands[id];
    if (command && command.suggested_key && command.suggested_key.default === key) pass("快捷键 " + key + " 已声明");
    else fail("快捷键 " + key + " 已声明", ["命令：" + id]);
  }

  // 引用文件存在性
  for (const size of Object.keys(m.icons || {})) requireFile(m.icons[size], "manifest icons[" + size + "]");
  if (m.action && typeof m.action.default_popup === "string") requireFile(m.action.default_popup, "action.default_popup");
  for (const size of Object.keys((m.action && m.action.default_icon) || {})) {
    requireFile(m.action.default_icon[size], "action.default_icon[" + size + "]");
  }
  if (m.background && m.background.service_worker) requireFile(m.background.service_worker, "background.service_worker");
  if (m.options_ui && m.options_ui.page) requireFile(m.options_ui.page, "options_ui.page");

  const contentScripts = Array.isArray(m.content_scripts) ? m.content_scripts : [];
  if (contentScripts.length === 1) pass("content_scripts 只有一组注入");
  else fail("content_scripts 只有一组注入", ["实际组数：" + contentScripts.length]);

  contentScripts.forEach((entry, index) => {
    const prefix = "content_scripts[" + index + "] ";
    if (Array.isArray(entry.matches) && entry.matches.includes("<all_urls>")) pass(prefix + "matches 含 <all_urls>");
    else fail(prefix + "matches 含 <all_urls>");

    for (const js of entry.js || []) requireFile(js, prefix + "js");
    for (const css of entry.css || []) requireFile(css, prefix + "css");

    const actual = (entry.js || []).map((item) => String(item).replace(/\\/g, "/").replace(/^\.\//, ""));
    const orderOk = JSON.stringify(actual) === JSON.stringify(EXPECTED_CONTENT_SCRIPTS);
    if (orderOk) {
      pass(prefix + "脚本顺序与契约一致");
    } else {
      fail(prefix + "脚本顺序与契约一致", [
        "期望：" + EXPECTED_CONTENT_SCRIPTS.join(" -> "),
        "实际：" + actual.join(" -> "),
      ]);
    }
  });
}

// ---------------------------------------------------------------- 2. JS 语法检查

const syntaxTargets = walk(EXT_ROOT).filter((abs) => /\.(?:js|mjs)$/i.test(abs));
let syntaxPass = 0;
const syntaxFailures = [];

function checkSyntax(abs) {
  const source = readText(abs);
  const direct = spawnSync(NODE_BIN, ["--check", abs], { encoding: "utf8", windowsHide: true });
  if (direct.status === 0) return { ok: true, mode: "check" };
  // Node 对 .js 的 ESM 自动探测在个别版本下不可用，回退到 stdin 模块检查
  const esm = spawnSync(NODE_BIN, ["--input-type=module", "--check"], {
    input: source,
    encoding: "utf8",
    windowsHide: true,
  });
  if (esm.status === 0) return { ok: true, mode: "esm-stdin" };
  const stderr = String(direct.stderr || esm.stderr || "").trim();
  return { ok: false, mode: "failed", error: stderr.split("\n").slice(0, 4).join(" | ") };
}

for (const abs of syntaxTargets) {
  const result = checkSyntax(abs);
  if (result.ok) {
    syntaxPass += 1;
    if (result.mode === "esm-stdin") warn("ESM 语法检查走 stdin 回退", [relOf(abs)]);
  } else {
    syntaxFailures.push(relOf(abs) + " -> " + result.error);
  }
}
if (syntaxFailures.length === 0) pass("全部 JS/MJS 语法检查通过", [syntaxTargets.length + " 个文件"]);
else fail("JS/MJS 语法检查", syntaxFailures);

// ---------------------------------------------------------------- 3. 产品代码远程代码扫描

const productJs = syntaxTargets.filter((abs) => {
  const rel = relOf(abs);
  return rel.startsWith("src/") && !rel.startsWith("tests/");
});
const REMOTE_CODE_PATTERNS = [
  { re: /\beval\s*\(/, label: "eval(" },
  { re: /new\s+Function\s*\(/, label: "new Function(" },
  { re: /import\s*\(\s*["'\x60]https?:/i, label: "远程动态 import()" },
  { re: /importScripts\s*\(\s*["'\x60]https?:/i, label: "远程 importScripts()" },
  { re: /document\.write\s*\(/, label: "document.write(" },
  { re: /WebAssembly\s*\.\s*(?:instantiate|compile)/, label: "WebAssembly 动态编译" },
];
const remoteHits = [];
for (const abs of productJs) {
  const source = readText(abs);
  for (const pattern of REMOTE_CODE_PATTERNS) {
    if (pattern.re.test(source)) remoteHits.push(relOf(abs) + " 含 " + pattern.label);
  }
}
if (remoteHits.length === 0) pass("产品代码无远程代码 / 动态执行");
else fail("产品代码无远程代码 / 动态执行", remoteHits);

// content 脚本里不允许直接发网络请求（网络请求统一在 background）
const contentFiles = productJs.filter((abs) => relOf(abs).startsWith("src/content/"));
const contentFetchHits = contentFiles.filter((abs) => /\bfetch\s*\(/.test(readText(abs))).map(relOf);
if (contentFetchHits.length === 0) pass("content 脚本不直接发起网络请求");
else fail("content 脚本不直接发起网络请求", contentFetchHits);

// ---------------------------------------------------------------- 4. HTML 引用与内联脚本

const htmlFiles = walk(SRC_ROOT).filter((abs) => /\.html$/i.test(abs));
if (htmlFiles.length === 0) {
  if (WARN_MISSING) warn("未找到 HTML 页面（popup/options 尚未实现，开发期降级）");
  else fail("存在 HTML 页面（popup/options）");
}
for (const abs of htmlFiles) {
  const rel = relOf(abs);
  const html = readText(abs);

  const inlineScripts = [];
  const inlineRe = /<script\b(?![^>]*\bsrc\s*=)[^>]*>([\s\S]*?)<\/script>/gi;
  let match;
  while ((match = inlineRe.exec(html))) {
    if (match[1].trim()) inlineScripts.push(match[1].trim().slice(0, 60));
  }
  if (inlineScripts.length === 0) pass(rel + " 无内联脚本");
  else fail(rel + " 无内联脚本（MV3 CSP）", inlineScripts);

  const refRe = /<(script|link|img|source)\b[^>]*?\b(src|href)\s*=\s*["']([^"']+)["'][^>]*>/gi;
  let refCount = 0;
  while ((match = refRe.exec(html))) {
    const tag = match[1].toLowerCase();
    const value = match[3].trim();
    if (!value || value.startsWith("#") || value.startsWith("data:") || value.startsWith("mailto:")) continue;
    refCount += 1;
    if (/^https?:/i.test(value)) {
      if (tag === "script" || tag === "link") fail(rel + " 引用远程资源（违反无远程代码）", [value]);
      else warn(rel + " 引用远程图片", [value]);
      continue;
    }
    const clean = value.split("#")[0].split("?")[0];
    const target = path.resolve(path.dirname(abs), clean);
    if (existsSync(target) && statSync(target).isFile()) pass(rel + " 引用存在", [clean]);
    else requireFile(relOf(target), rel + " 引用");
  }
  if (refCount > 0) pass(rel + " 本地资源引用已校验", [refCount + " 处"]);
}

// ---------------------------------------------------------------- 5. content.css 选择器隔离

const contentCss = path.join(SRC_ROOT, "content", "content.css");
if (existsSync(contentCss)) {
  const css = readText(contentCss);
  const selectorIssues = [];
  const ruleRe = /([^{}]+)\{/g;
  let rule;
  while ((rule = ruleRe.exec(css))) {
    const selector = rule[1].trim();
    if (!selector || selector.startsWith("@") || selector.startsWith("/*")) continue;
    for (const part of selector.split(",")) {
      const single = part.trim();
      if (!single) continue;
      if (/^(?:from|to|\d+(?:\.\d+)?%)$/i.test(single)) continue; // @keyframes 关键帧
      if (!single.includes("ait") && !single.includes("data-ait")) {
        selectorIssues.push("选择器未带 ait 前缀：" + single.slice(0, 80));
      }
    }
  }
  if (selectorIssues.length === 0) pass("content.css 选择器均带 ait 前缀（不污染宿主页面）");
  else fail("content.css 选择器均带 ait 前缀（不污染宿主页面）", selectorIssues.slice(0, 10));
}

// ---------------------------------------------------------------- 6. 零依赖

if (existsSync(path.join(EXT_ROOT, "node_modules"))) fail("无 node_modules（零依赖）");
else pass("无 node_modules（零依赖）");

const packageFiles = [path.join(EXT_ROOT, "package.json"), path.join(EXT_ROOT, "..", "package.json")];
let packageIssue = null;
for (const abs of packageFiles) {
  if (!existsSync(abs)) continue;
  try {
    const pkg = JSON.parse(readText(abs));
    const deps = Object.keys(pkg.dependencies || {});
    const devDeps = Object.keys(pkg.devDependencies || {});
    if (deps.length || devDeps.length) {
      packageIssue = path.basename(path.dirname(abs)) + "/package.json 含依赖：" + deps.concat(devDeps).join(",");
      break;
    }
  } catch (error) {
    packageIssue = abs + " 无法解析：" + error.message;
    break;
  }
}
if (packageIssue) fail("零 npm 依赖", [packageIssue]);
else pass("零 npm 依赖（无 dependencies）");

const buildSources = walk(SRC_ROOT).filter((abs) => /\.(?:ts|tsx|jsx|vue|svelte|scss|less)$/i.test(abs));
if (buildSources.length === 0) pass("src 无需要构建的源码（ts/jsx/vue/scss 等）");
else fail("src 无需要构建的源码（ts/jsx/vue/scss 等）", buildSources.map(relOf));

const requireUsers = productJs.filter((abs) => /\brequire\s*\(/.test(readText(abs))).map(relOf);
if (requireUsers.length === 0) pass("浏览器端产品代码不使用 require()");
else fail("浏览器端产品代码不使用 require()", requireUsers);

// ---------------------------------------------------------------- 7. 编码与缩进

const textExts = new Set([".js", ".mjs", ".json", ".html", ".css", ".md"]);
const textFiles = walk(EXT_ROOT).filter((abs) => textExts.has(path.extname(abs).toLowerCase()));
const encodingIssues = [];
const indentWarnings = [];

/** 跳过块注释后检查缩进是否为偶数个空格（项目统一 2 空格风格） */
function collectIndentWarnings(rel, text) {
  const found = [];
  const lines = text.split("\n");
  let inComment = false;
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];
    if (!inComment) {
      const indent = /^( +)\S/.exec(line);
      if (indent) {
        const firstChar = line.charAt(indent[0].length - 1);
        if (firstChar !== "*" && firstChar !== "/" && indent[1].length % 2 === 1) {
          found.push(rel + ":" + (index + 1) + " 缩进为奇数个空格");
        }
      }
    }
    let cursor = 0;
    while (cursor < line.length) {
      if (!inComment) {
        const start = line.indexOf("/*", cursor);
        if (start < 0) break;
        const end = line.indexOf("*/", start + 2);
        if (end < 0) {
          inComment = true;
          break;
        }
        cursor = end + 2;
      } else {
        const end = line.indexOf("*/", cursor);
        if (end < 0) break;
        inComment = false;
        cursor = end + 2;
      }
    }
  }
  return found;
}

for (const abs of textFiles) {
  const rel = relOf(abs);
  const text = readFileSync(abs).toString("utf8");
  if (text.includes("\uFFFD")) encodingIssues.push(rel + " 非合法 UTF-8（含替换字符）");
  if (text.includes("\r")) encodingIssues.push(rel + " 使用 CRLF 换行（要求 LF）");
  if (/^\t/m.test(text)) encodingIssues.push(rel + " 使用 tab 缩进");
  if (/\.(?:js|mjs|css|json)$/i.test(abs) && indentWarnings.length < 8) {
    for (const warning of collectIndentWarnings(rel, text)) {
      indentWarnings.push(warning);
      if (indentWarnings.length >= 8) break;
    }
  }
}
if (encodingIssues.length === 0) pass("UTF-8 / LF / 无 tab 缩进", [textFiles.length + " 个文本文件"]);
else fail("UTF-8 / LF / 无 tab 缩进", encodingIssues);
if (indentWarnings.length === 0) pass("JS/CSS/JSON 使用两空格缩进");
else warn("存在奇数空格缩进（请人工确认）", indentWarnings);

// ---------------------------------------------------------------- 8. 输出

const failCount = results.filter((item) => item.status === "fail").length;
const passCount = results.filter((item) => item.status === "pass").length;
const warnCount = results.filter((item) => item.status === "warn").length;
const summary = {
  pass: passCount,
  fail: failCount,
  warn: warnCount,
  failures: results.filter((item) => item.status === "fail"),
  warnings: results.filter((item) => item.status === "warn"),
};

if (!JSON_ONLY) {
  for (const item of results) {
    const tag = item.status === "pass" ? "[PASS]" : item.status === "fail" ? "[FAIL]" : "[WARN]";
    console.log(tag + " " + item.title);
    for (const detail of item.details || []) console.log("       " + detail);
  }
  console.log("");
  console.log(
    "汇总：通过 " + passCount + " 项 / 失败 " + failCount + " 项 / 警告 " + warnCount + " 项" +
      "（语法检查文件 " + syntaxTargets.length + " 个，其中通过 " + syntaxPass + " 个）"
  );
  if (failCount > 0) console.log("结果：FAIL（存在阻断项，修复后重跑）");
  else console.log("结果：PASS");
}
console.log("SUMMARY " + JSON.stringify(summary));

process.exitCode = failCount > 0 ? 1 : 0;
