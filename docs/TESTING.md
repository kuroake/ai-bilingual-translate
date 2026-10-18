# 测试与验收（TESTING）

> 维护：qa。本文档是自动化测试命令、手工冒烟清单与验收记录的唯一入口。
> 产品契约见 [ARCHITECTURE.md](./ARCHITECTURE.md)，调研结论见 [RESEARCH.md](./RESEARCH.md)。

## 1. 测试分层

| 层 | 位置 | 运行方式 | 覆盖内容 |
| --- | --- | --- | --- |
| 单元测试 | `extension/tests/*.test.mjs` | `node --test`（零依赖） | shared 纯函数（config / prompt / cache / provider）+ content 00-core 工具 |
| 静态检查 | `extension/tests/static-check.mjs` | `node` | JS 语法、manifest 引用与顺序、HTML 引用、无远程代码、零依赖、编码规范 |
| 页面夹具 | `extension/tests/fixtures/` | 无头 Edge 截图 | 全页渲染、划词卡片、popup / options demo 模式的视觉与溢出 |
| 手工冒烟 | 本文第 4 节 | 真实 Edge + 真实 API Key | 端到端功能（翻译 / 还原 / 划词 / 缓存 / 暗色 / 站点规则） |

QA 写作用域：`extension/tests/`、`docs/TESTING.md`。不得修改产品代码与 manifest。

## 2. 环境

- Windows + PowerShell 7（命令按 PowerShell 语法给出）
- Node.js：`C:\Users\Mio\.dsh\dsh-runtimes\dsh-primary-runtime\dependencies\node\bin\node.exe`（实测 v24.21.0）
- Edge：`C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe`
- Python（本地静态服务器）：`C:\Users\Mio\.dsh\dsh-runtimes\dsh-primary-runtime\dependencies\python\python.exe`
- 零依赖：**不执行 `npm install`**。测试只用 Node 内置模块（`node:test` / `node:assert` / `node:fs` / `node:child_process` 等）。

## 3. 自动化测试

### 3.1 单元测试

    cd F:\DSH\翻译
    & 'C:\Users\Mio\.dsh\dsh-runtimes\dsh-primary-runtime\dependencies\node\bin\node.exe' --test "extension/tests/*.test.mjs"

也可以进入 `extension` 目录后直接 `node --test`（自动发现 `tests/**/*.test.mjs`）。

> 注意：Node 24 对目录参数 `--test extension/tests/` 会按 CJS 入口解析并报 `MODULE_NOT_FOUND`，
> 请使用上面的 glob 形式或 `cd extension; node --test`。单文件调试：
> `node --test extension/tests/prompt.test.mjs`。

当前覆盖矩阵（共 138 个用例，7 个测试文件）：

| 测试文件 | 用例数 | 覆盖点 |
| --- | --- | --- |
| `config.test.mjs` | 23 | 默认设置完整性、`deepMerge`（补齐/替换/不共享引用/升级兼容）、`matchSiteRule`（精确/子域/通配/协议/端口/非法输入）、`shouldAutoTranslate` 优先级、`scriptStats` / `looksLikeTargetLanguage` 语言启发式、Base URL 规范化（`chatCompletionsUrl` / `modelsUrl`）、语言展示名、`estimateTokens` |
| `prompt.test.mjs` | 29 | `parseNumberedReply` 容错：标准编号、Markdown 加粗、全角 `【】`/`［］`、冒号、前言、空行、多段跨行、乱序、缺段、空正文、越界序号、重复序号、单段无编号回退、代码块围栏、空输出；`buildPageSystemPrompt` / `buildPageMessages` / `buildSelectionSystemPrompt` / `buildSelectionMessages` / `glossaryText` / `estimateRequestTokens` |
| `provider.test.mjs` | 26 | URL 与请求头/请求体构造；`chatCompletion` 401/403/429/5xx/400 错误映射；网络错误、AbortError、外部信号中断映射；非流式解析（content 数组、reasoning、usage、空内容、坏 JSON）；SSE 分块解析（跨 chunk 行缓冲、reasoning、usage、`[DONE]`、坏行跳过）；`listModels` 解析与错误透传；`ProviderError` 默认文案 |
| `cache.test.mjs` | 20 | 缓存键规范（空白归一/大小写/模型/Base URL/目标语言）；命中与未命中；TTL 过期删除与 `ttlDays=0` 永不过期；LRU 淘汰与 50 条下限；禁用开关短路；`flushCache` 持久化与无脏数据不写；模拟扩展重启后的持久化恢复；`cacheClear`；损坏/非法持久化数据兜底 |
| `core.test.mjs` | 22 | `00-core.js` 无 DOM 工具：`deepMerge` 与 shared 语义一致、`hash`（FNV-1a）、`normalizeText`、`escapeHtml`、`isCJK`、`looksTranslated`、`looksLikeTargetLanguage`、`uid`/`once`/`debounce`/`throttle`/`backoff`、`AIT.bus` 事件总线、`AIT.runtimeSend` 成功/lastError/同步异常、`loadSettings`/`applySettings` |
| `storage-stats.test.mjs` | 12 | `getSettings` 默认值/残缺旧设置深合并、`patchSettings` 深合并与持久化、并发 patch 串行不覆盖、`resetSettings`、`getRaw`/`setRaw`、`queueWrite` 失败不阻断后续；`getStats` 零值、`recordUsage` 累加与非法输入归一、`resetStats`、损坏 stats 兜底 |
| `messages.test.mjs` | 6 | `MSG` / `CMD` 与契约逐项一致且唯一、`STREAM_PORT`、`ERR` 覆盖契约全部错误码、每个错误码都有中文可展示文案 |

单元测试约定：

- `chrome.storage.local` 用 `extension/tests/helpers/memory-storage.mjs` 的内存 mock（JSON 深拷贝，模拟真实序列化）。
- `cache.js` 有模块级状态，用例通过带查询串的动态 `import("../src/shared/cache.js?case=N")` 获得干净实例。
- `provider.test.mjs` 全程 mock 全局 `fetch`，**不发起真实网络请求**；每个用例在 `finally` 中恢复 `globalThis.fetch`。
- 真实网络超时未做 5s 等待（provider 的超时下限是 5s），用 mock `AbortError` 覆盖错误映射，见第 5 节已知限制。

### 3.2 静态检查

严格模式（验收用，任何 FAIL 都会让进程以退出码 1 结束）：

    cd F:\DSH\翻译
    & 'C:\Users\Mio\.dsh\dsh-runtimes\dsh-primary-runtime\dependencies\node\bin\node.exe' extension/tests/static-check.mjs

开发期（开发任务尚未完成、文件暂时缺失时，把「引用文件缺失」降级为 WARN）：

    & 'C:\...\node.exe' extension/tests/static-check.mjs --warn-missing

机器可读摘要（最后一行固定为 `SUMMARY {json}`）：

    & 'C:\...\node.exe' extension/tests/static-check.mjs --json

检查项：

1. `manifest.json` 可解析；MV3、`background.type=module`、`storage` 权限、`<all_urls>`、`minimum_chrome_version ≥ 114`、三个快捷键（Alt+T / Alt+M / Alt+S）。
2. manifest 引用的所有文件存在：icons、action popup/icon、background service worker、options 页、content_scripts 的 js/css。
3. `content_scripts[].js` 顺序与契约完全一致：00-core → 10-segmenter → 20-translator → 30-renderer → 40-selection → 50-observer → 90-main。
4. 所有 `.js` / `.mjs` 语法检查（等价 `node --check`；ESM 探测失败时回退 stdin + `--input-type=module --check`）。
5. HTML：引用本地 css/js/图片存在；**无内联脚本**（MV3 CSP）、无远程 script/link（CSS 远程资源同样报错）。
6. 产品代码（`src/`）无 `eval` / `new Function` / 远程动态 `import()` / `importScripts` / `document.write` / `WebAssembly` 动态编译；content 脚本不直接 `fetch`（网络请求统一在 background）。
7. `content.css` 选择器均带 `ait` 前缀（不污染宿主页面；`@keyframes` 的 `from/to/0%` 例外）。
8. 零依赖：无 `node_modules`、无 package.json 依赖、src 下无 ts/jsx/vue/scss 等需要构建的源码、浏览器端代码不用 `require()`。
9. 编码规范：UTF-8 合法、LF 换行、无 tab 缩进、JS/CSS/JSON 两空格缩进（奇数空格缩进告警）。

### 3.3 端到端验收（真实扩展 + 本地 mock LLM，headless Edge）

    cd F:\DSH\翻译
    & 'C:\Users\Mio\.dsh\dsh-runtimes\dsh-primary-runtime\dependencies\node\bin\node.exe' extension/scripts/e2e.mjs

它做什么：

1. 复制一份扩展到 `.tmp/e2e/ext-<id>/`，**只在副本里**把默认 API 指向本地 mock 服务（改的是 `src/shared/config.js` 的 `DEFAULT_SETTINGS`）、关闭缓存，并追加 `99-e2e-probe.js` 探针；源码不受影响。
2. 自动获取空闲端口启动 `extension/scripts/mock-server.mjs`（OpenAI 兼容 mock：非流式 / SSE / 401 / 模型列表）与 fixture 静态页，互相不抢端口。
3. 用 `msedge --headless=new --load-extension=扩展副本` 加载**真实扩展**，CDP 打开 `extension/scripts/e2e-page.html`，轮询等待 `.ait-trans` 译文节点出现（fixture 共 15 个可译段落，本次实测全部译出）。
4. **跨主题配色断言**：fixture 内含浅色正文与 `.dark-panel`（背景 `#15140F`）区块；脚本检查深色区块的译文是否带 `ait-trans--on-dark` 且文字亮度 > 0.45、浅色区块是否带 `ait-trans--on-light` 且文字亮度 < 0.45，防止「系统主题与宿主背景错配」回归。
5. 输出 `.tmp/e2e/report.json`（probe / translated / samples / targets / tone / 截图路径）与 `shot-1440.png`、`shot-dark-tone.png`（深色区块特写）、`shot-480.png`。

判定：**退出码 0 即通过**；`report.json` 中 `probe=true` 证明 content script 已注入，`translated >= 3` 证明 background 请求 + prompt 解析 + renderer 渲染链路正常，`tone.darkOk/lightOk=true` 证明跨主题配色生效。
若 `probe=false`，说明当前 Edge 版本的 headless 模式不支持加载扩展，**属于环境限制而不是产品 bug**，需改用真实窗口或更新 Edge 后复验。

这是本项目最可信的自动化验收：真实扩展 + 真实 MV3 生命周期 + mock LLM，覆盖 background 消息路由、provider、prompt 解析、缓存、renderer 全链路。

### 3.4 UI 截图复核（popup / options demo + fixtures）

    & 'C:\...\node.exe' extension/tests/ui-check.mjs
    # 只跑部分页面 / 只跑亮色：
    & 'C:\...\node.exe' extension/tests/ui-check.mjs --only popup,options --themes light
    # 其他参数：--base http://127.0.0.1:8765 --out extension/tests/screenshots
    #          --viewport 1440x900,480x900 --cdp-port 9444

- 复用 `http://127.0.0.1:8765` 静态服务（仓库根）；不可用时自动用 python 在 8799 起一个。页面必须走 HTTP（ES Module 在 `file://` 下会被 CORS 拦截）。
- 默认页面：`popup.html?demo=1`、`options.html?demo=1`，以及 `extension/tests/fixtures/` 下全部 `*.html` 夹具。
- 每个页面 × {1440x900, 480x900} × {light, dark} 输出截图；长页面额外输出 `-full.png` 整页图，便于检查表单裁切。
- 程序化判定：`documentElement.scrollWidth <= innerWidth + 1`（无横向溢出）、无未捕获异常、正文非空，任一不满足 exit 1；随后人工看图复核设计语言。
- 暗色通过 CDP `Emulation.setEmulatedMedia` 精确模拟 `prefers-color-scheme`，不依赖系统设置（headless 的 `--window-size` 小于约 500px 时不可信，因此必须用 CDP 覆盖视口）。

### 3.5 一键全量（复制即用）

    $node = 'C:\Users\Mio\.dsh\dsh-runtimes\dsh-primary-runtime\dependencies\node\bin\node.exe'
    cd F:\DSH\翻译
    & $node --test "extension/tests/*.test.mjs"
    if ($LASTEXITCODE -ne 0) { Write-Host "单元测试失败"; exit 1 }
    & $node extension/tests/static-check.mjs
    if ($LASTEXITCODE -ne 0) { Write-Host "静态检查失败"; exit 1 }
    & $node extension/scripts/e2e.mjs
    if ($LASTEXITCODE -ne 0) { Write-Host "端到端验收失败"; exit 1 }
    & $node extension/tests/ui-check.mjs
    if ($LASTEXITCODE -ne 0) { Write-Host "UI 截图复核失败"; exit 1 }
    Write-Host "全部自动化验收通过"

## 4. 手工冒烟清单（真实 Edge + 真实 Key）

准备：打开 `edge://extensions/` → 开启「开发人员模式」→「加载解压缩的扩展」→ 选择仓库里的 `extension` 目录。
若已有旧版本，先点「重新加载」并刷新被测页面。

| # | 步骤 | 期望结果 | 结果 |
| --- | --- | --- | --- |
| 1 | 加载扩展 | 扩展卡片出现、无红色报错；service worker 显示「已激活」；工具栏出现图标 | 待测 |
| 2 | 配置 Key | popup → 设置 → 填 Base URL / API Key / 模型 → 点「测试连接」→ 显示延迟与示例；「拉取模型」返回列表 | 待测 |
| 3 | 全页翻译 | 打开英文页面（如英文维基百科），按 `Alt+T`；段落下方出现朱砂竖线译文，进度 toast 可见，完成后消失 | 待测 |
| 4 | 双语/仅译文 | `Alt+M` 切到仅译文（原文隐藏），再按一次回到双语 | 待测 |
| 5 | 还原 | 再按 `Alt+T`；译文节点全部移除、原文恢复、popup 状态复位 | 待测 |
| 6 | 划词翻译 | 选中一段英文 → 选区右下出现圆形「译」按钮 → 点击 → 卡片流式打字机输出；复制按钮可用；Esc / 点击外部关闭 | 待测 |
| 7 | 缓存命中 | 重复翻译同一段落；第二次翻译明显更快，用量摘要里 cacheHits 增加、requests 不增加；断网后重译同段仍能命中 | 待测 |
| 8 | 暗色模式 | 系统/Edge 切到深色后刷新；页面译文、popup、options 均为纸感暗色，强调色为 `#FB923C`，无纯白刺眼块 | 待测 |
| 9 | 站点规则 | options 把 example.com 加入「永不翻译」并打开全局自动翻译 → 打开 example.com 不自动翻译；加入「自动翻译」后打开即翻译 | 待测 |
| 10 | 右键菜单 | 页面右键出现「翻译选中文字 / 翻译此页面 / 还原此页面」，行为正确 | 待测 |
| 11 | 动态内容 | 翻译进行中/完成后，在 SPA（GitHub、知乎等）滚动加载新内容；新段落被自动补译，路由切换后仍工作 | 待测 |
| 12 | 错误路径 | 清空 API Key 后翻译 → 展示中文「还没有配置 API Key」；填错误 Key → 401 中文提示；断网 → 网络错误提示 | 待测 |
| 13 | 导入导出/重置 | options 导出 JSON；改动后导入可恢复；「重置」恢复默认设置 | 待测 |

结果填写：通过 / 失败 / 未测，失败需附截图与复现步骤。

## 5. 视觉与截图判定标准

截图生成方式见 3.4（`extension/tests/ui-check.mjs`），产物统一在 `extension/tests/screenshots/`，
命名规范 `{页面}-{theme}-{宽}x{高}.png`（长页面另有 `-full.png`）。

程序化判定（ui-check 自动执行，失败即 exit 1）：

- 横向溢出：`documentElement.scrollWidth <= window.innerWidth + 1`。
- 页面无未捕获异常（`Runtime.exceptionThrown`）。
- 正文非空（`document.body.innerText.length >= 20`）。

人工看图复核要点：

- 无横向溢出、无文字竖排、无裁切；主操作按钮首屏可见。
- 唯一强调色为朱砂（亮色 `#C2410C` / 暗色 `#FB923C`），其余中性灰；无渐变/发光/玻璃拟态/emoji 图标。
- 暗色适配正常（纸感暗底 `#15140F` 系，强调色 `#FB923C`，无纯白刺眼块）。
- 窄屏 480px 下 options 导航变顶部横条、表单不溢出、popup 保持单列。
- popup 在 1440 视口下应为居中的 380px 单列演示框（demo 模式），不应被拉伸。
- 渲染夹具中译文/原文对照、朱砂竖线、错误态、仅译文模式与设计 brief 一致。

手动兜底（ui-check 不可用时）：用 `msedge --headless=new --hide-scrollbars --screenshot=... --window-size=... URL` 直接截图；注意 headless 的 `--window-size` 小于约 500px 时不可信，窄屏请用 CDP `Emulation.setDeviceMetricsOverride`。

### 5.1 UI 截图与交互自动化注意事项

1. **headless 下必须模拟 `prefers-reduced-motion: reduce`**：用 CDP 验证划词卡片（模拟选区 → 点击朱砂按钮 → 流式返回）时，先发
   `Emulation.setEmulatedMedia({ features: [{ name: "prefers-reduced-motion", value: "reduce" }] })`。
   否则 headless 的合成器动画 / `requestAnimationFrame` 不推进，卡片会停在淡入首帧、打字机内容不更新。**这是无头环境的限制，不是产品 bug**（产品在 `content.css` 与划词 Shadow DOM 样式里都已适配 `prefers-reduced-motion`）。
2. **暗色截图用 CDP 模拟**：`Emulation.setEmulatedMedia({ features: [{ name: "prefers-color-scheme", value: "dark" }] })`，不要依赖系统主题。
3. **跨主题配色要看两种截图**：译文颜色由渲染层探测宿主背景亮度后加 `ait-trans--on-light` / `ait-trans--on-dark`；夹具与 e2e 页面都包含深色宿主区块，应同时核对「浅色页面 + 深色区块」两种译文颜色。
4. **等页面稳定再截图**：demo 模式有 160ms 入场动效，导航后在 `document.readyState === "complete"` 之后再等约 700ms 截图，避免截到动画首帧。
5. **精确视口**：用 `Emulation.setDeviceMetricsOverride`（width/height/deviceScaleFactor=1, mobile=false），不要依赖 `--window-size`。

## 6. 已知限制

1. **编号协议不支持 `1.` 式 Markdown 列表**：模型若用 `1. 2.` 编号而非 `[1] [2]`，多段时会全部判为缺失（单段会回退整段）。background 会对缺失段降级单段重试，但会增加请求成本。
2. **提示词升级需 bump 版本**：缓存 key 含 `PROMPT_VERSION`（当前 3）。修改系统提示词后若不增加版本号，旧缓存可能命中旧风格译文。
3. **缓存 TTL 是惰性清理**：只在读取时判断过期并删除，不主动扫描；禁用/清空缓存走 `cacheClear`。写入有 2.5s debounce，扩展进程被杀可能丢掉最近 2.5s 内的缓存写入。
4. **流式 token 用量可能缺失**：provider 不强制发送 `stream_options.include_usage`（部分 OpenAI 兼容服务不认该字段），服务端不返回 usage 时 background 用 `estimateRequestTokens` 估算，统计是近似值。
5. **真实超时路径未做 5s 级等待测试**：provider 的超时下限为 5s（`Math.max(5000, timeoutMs)`），单测用 mock `AbortError` 覆盖 TIMEOUT 映射，不验证真实计时器。
6. **语言启发式是脚本字符统计**：短文本、混排文本（如 "Hello 世界"）判断不精确；纯数字/符号/URL 视为无需翻译，混合内容可能漏译或重复翻译。
7. **DOM 层不在 `node --test` 覆盖**：segmenter / renderer / translator / selection / observer 依赖浏览器环境，靠 fixtures 无头页面与手工冒烟验收；无 jsdom 等第三方依赖。
8. **无头截图不等于真实扩展环境**：popup/options 的 `?demo=1` 使用 mock `chrome.*`；fixtures 页面 mock `chrome.runtime`。真实扩展行为以手工冒烟为准。
9. **真实服务商网络未自动化**：e2e 用本地 mock LLM 验证全链路；不把真实 API Key 写入测试（避免计费与密钥泄露），真实服务商网络、真实限流/鉴权表现由手工冒烟覆盖。
10. **chrome.storage 用内存 mock**：不覆盖存储配额、并发写、跨上下文时序等真实约束。
11. **划词交互部分自动化**：已有 CDP 级真实扩展划词 e2e（模拟选区 → 点击朱砂按钮 → 真实 background 经 `ait-stream` 流式返回 → 卡片渲染，截图 `.tmp/sel-e2e/selection-real.png`）；但复制、Esc、点击外部、视口边缘翻转、目标语言切换等细节仍需手工验证。
12. **剪贴板/暗色系统设置**：剪贴板权限与系统主题切换在自动化下不可靠，需手工确认。
13. ~~**译文配色不感知宿主页面背景（对比度风险）**~~ → **已修复（2026-10-19）**：renderer 现在从译文节点向上查找第一个不透明背景色并计算相对亮度，给节点加 `ait-trans--on-light`（宿主亮背景 → 深灰字 `#57534E` + 朱砂 `#C2410C`）或 `ait-trans--on-dark`（宿主暗背景 → 浅灰字 `#D6D3D1` + 橙 `#FB923C`）。
    - 验证方式：e2e 断言 `darkClass=true` / `darkLum=0.655` / `lightClass=true` / `lightLum=0.088`，截图 `.tmp/e2e/shot-dark-tone.png`。
    - 实测对比度：深色宿主区块 `#D6D3D1` on `#15140F` = **12.38:1**（修复前风险值 2.52:1）；浅色章节 `#57534E` on `#FBFAF7` = **7.31:1**；深色竖线 `#FB923C` on `#15140F` = 8.15:1（图形 ≥3:1）。
    - 残余（低风险）：极端中灰背景（相对亮度约 0.10–0.62，如 `#666`–`#B5B5B5`）两种固定字色都无法达到 4.5:1（最优约 2.2–3.9:1）；常见近白/近黑背景均已 ≥4.5:1。如后续要彻底覆盖中灰背景，可改为「双候选字色对比度择优」或给译文加半透明纸底。
14. **无头加载扩展依赖 Edge 版本能力**：e2e 用 `--headless=new --load-extension`，本机 Edg/155.0.4283.45 通过；不同 Edge 版本可能不支持，`probe=false` 时应判定为环境限制而非产品 bug。
15. **UI 自动化覆盖有限交互**：ui-check 覆盖静态呈现；划词主链路已由 CDP 真实扩展 e2e 覆盖；键盘快捷键、右键菜单、复制、拖选、滚轮、导入导出等仍需走第 4 节手工冒烟。
16. **验收记录是代码快照**：任何产品代码变更后需重跑 3.5 全部命令并更新 7.2；快照时间见验收记录表头。

## 7. 验收记录

### 7.1 第一轮（共享层就绪，2026-10-19）

范围：`extension/src/shared/` 已发布的 config / messages / prompt / provider / cache / storage / stats 与 `content/00-core.js`；开发任务（content-engine / selection-ui / app-ui）尚在进行中。

| 检查 | 命令 | 结果 |
| --- | --- | --- |
| 单元测试 | `node --test "extension/tests/*.test.mjs"` | **120 / 120 通过**（5 个文件，约 2.6s） |
| 静态检查（开发期） | `node extension/tests/static-check.mjs --warn-missing` | **PASS**：通过 43 / 失败 0 / 警告 5（均为开发中未落盘文件） |
| 静态检查（严格） | `node extension/tests/static-check.mjs` | 预期 FAIL：等待开发任务产出 `content/30-renderer.js`、`50-observer.js`、`90-main.js`、`content.css`、`options/*` |
| 无头截图 | — | 待开发任务完成后执行 |

结论：共享层契约稳定，自动化测试基线建立；集成验收待三个开发任务完成后进行。

### 7.2 第二轮（集成验收 · 最终，2026-10-19 01:24:37–01:25:26）

**验收快照**：三个开发任务 task-1（content-engine）/ task-2（selection-ui）/ task-3（app-ui）均已 completed；产品代码最后修改 01:21:28（`30-renderer.js`、`content.css`，即跨主题配色修复），此后至验收结束无源码变更。
环境 Windows / Node v24.21.0 / Edge `Edg/155.0.4283.45`。

**结论：全部通过（PASS）**——138 个单元测试、严格静态检查、真实扩展端到端（15 段译文 + 跨主题配色断言）、UI 双视口双主题复核、release zip 重打包与审计均通过；上一轮的 zip 内容落后问题已解决。

#### 通过项（实际命令与输出摘要）

| # | 检查项 | 命令 | 实测结果 |
| --- | --- | --- | --- |
| 1 | 全量单元测试 | `node --test "extension/tests/*.test.mjs"` | **tests 139 / pass 139 / fail 0**（含新增的设置迁移用例） |
| 2 | 严格静态检查 | `node extension/tests/static-check.mjs` | **通过 57 / 失败 0 / 警告 0**，31 个 JS/MJS 语法全过，exit 0 |
| 3 | 端到端验收 | `node extension/scripts/e2e.mjs` | **PASS**：译文节点 **15**/15；页面异常 **0**；跨主题配色断言 `{darkClass:true, darkLum:0.6549, lightClass:true, lightLum:0.0876, darkOk:true, lightOk:true}`；toast「翻译完成 · 15 段」+「还原原文」；截图 `shot-1440.png`、`shot-dark-tone.png`、`shot-480.png`；`report.json` |
| 4 | UI 截图复核 | `node extension/tests/ui-check.mjs` | **PASS**：5 页面（popup / options / content-demo / selection-demo / selection-smoke）× 2 视口 × 2 主题 = 20 组截图（+12 张长页 full 图，共 32 PNG）；**overflow 全部 false、页面异常 0** |
| 5 | release 重新打包 | `pwsh -File extension/scripts/pack.ps1` | 生成 `release/ai-translate-1.1.0.zip`（124.9 KB），exit 0 |
| 6 | release zip 审计 | python 校验结构 / manifest 引用 / CRC | **PASS**：32 个文件；`manifest.json` 在包根；不含 `tests/`、`scripts/`、`icon-preview.png`；manifest 17 处引用全部存在；与当前源码 **CRC 不一致 0 个**；源码缺失 0 个 |
| 7 | 跨主题配色复核（修复验证） | 截图 + WCAG 计算 | 深色宿主区块 `#D6D3D1` on `#15140F` = **12.38:1**（修复前风险值 2.52:1）；浅色章节 `#57534E` on `#FBFAF7` = **7.31:1**；深色竖线 `#FB923C` on `#15140F` = 8.15:1（图形 ≥3:1） |
| 8 | 视觉复核（人工看图） | — | 朱砂 2px 左竖线、纸色底、双语对照、明暗双主题、跨主题深色区块译文自动转浅色；popup 380px 单列、options 窄屏导航顶部横条；无横向裁切/文字竖排/渐变/发光/emoji |
| 9 | 划词真实扩展 e2e（lead 补齐） | CDP 模拟选区 → 点击朱砂按钮 | 真实 background 经 `ait-stream` 流式返回，卡片渲染译文；mock 服务日志确认收到 chat stream 请求；截图 `.tmp/sel-e2e/selection-real.png` |
| 10 | toast 文案复核 | 截图 + 源码 | 「翻译完成 · N 段」+ 独立「还原原文」按钮，歧义已消除 |

#### 两份明确回答

**A. popup / options 在 480x900 下是否有横向溢出？——没有。**
最终 ui-check 实测（5 个页面 × 2 视口 × 2 主题共 20 组全部 `overflow=false`），其中 popup/options 的 4 个组合：

| 页面 | 视口 | 主题 | scrollWidth | innerWidth | overflow |
| --- | --- | --- | --- | --- | --- |
| popup | 480x900 | light | 480 | 480 | false |
| popup | 480x900 | dark | 480 | 480 | false |
| options | 480x900 | light | 480 | 480 | false |
| options | 480x900 | dark | 480 | 480 | false |

**B. 是否存在 manifest 引用了不存在文件？——不存在。**
严格静态检查逐项校验 `icons`（4 个尺寸）、`action.default_popup` / `default_icon`、`background.service_worker`、`options_ui.page`、`content_scripts` 的 7 个 js 与 1 个 css，全部存在（57 项通过 / 0 失败）；
release zip 审计再次确认 manifest 的 17 处引用在压缩包内全部存在。

#### 失败项

- **无。** 上一轮发现的「release zip 内容落后 2 个源文件」已通过重新打包解决：重打包后 CRC 比对不一致 0 个、文件集合完整。

#### 风险与待改进

1. **中灰宿主背景残余对比度（低风险）**：跨主题配色已修复常见近白/近黑背景（≥7.3:1，深色区块 12.38:1）；但相对亮度约 0.10–0.62 的中灰背景（如 `#666`–`#B5B5B5`）两种固定字色都无法达到 4.5:1（最优约 2.2–3.9:1），属极端场景。如要彻底覆盖，建议改为「双候选字色对比度择优」或给译文加半透明纸底。
2. **e2e 硬断言仍为 `translated >= 3`**：本次实测 15/15 段全部译出；fixture 期望段数为 15，建议后续把断言收紧为 15 防止回归（当前由 report.json 人工核对）。
3. **手工冒烟 13 项未执行**：真实 API Key、快捷键/右键菜单、缓存命中、系统暗色切换、导入导出等仍需发布前按第 4 节人工过一遍；自动化用 mock 覆盖了数据链路。
4. **无头划词测试需 reduced-motion**：CDP 划词验证必须模拟 `prefers-reduced-motion: reduce`，否则卡片停在淡入首帧、打字机不更新（无头环境限制，非产品 bug，详见 5.1）。
5. 既有已知限制（编号协议 `1.` 式列表、流式 usage 估算、缓存惰性 TTL、真实超时 5s 等）见第 6 节。

#### 本轮产物路径

- 单测 / 静态检查：`extension/tests/*.test.mjs`（139 用例）、`extension/tests/static-check.mjs`、`extension/tests/ui-check.mjs`
- 端到端：`.tmp/e2e/shot-1440.png`（1440x900）、`.tmp/e2e/shot-dark-tone.png`（深色宿主区块特写）、`.tmp/e2e/shot-480.png`（480x900）、`.tmp/e2e/report.json`
- UI 复核：`extension/tests/screenshots/`（32 个 PNG：popup 4、options 8、content-demo 8、selection-demo 8、selection-smoke 4）
- 划词真实 e2e：`.tmp/sel-e2e/selection-real.png`（lead 提供）
- 发布包：`release/ai-translate-1.1.0.zip`（124.9 KB，32 个文件，manifest 在根，包内 manifest version = 1.1.0）
