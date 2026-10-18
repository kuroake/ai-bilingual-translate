# 架构与接口契约

> 这份文档是所有并行开发者的唯一契约。实现前先读完；实现时不要擅自改共享接口，确需变更先改本文档并通知 Lead。

## 1. 产品定义

**AI 双语翻译**：Microsoft Edge（Chromium MV3）浏览器扩展。用任意 OpenAI 兼容大模型把网页变成双语对照，并支持划词流式翻译。

MVP 范围（必须全部可用）：

1. 全页双语翻译：一键翻译、段落级对照、随时还原、进度可见。
2. 划词翻译：选中文字出现按钮，点击出现卡片，流式打字机输出。
3. Provider 设置：Base URL / API Key / 模型 / 温度 / 超时，支持测试连接与拉取模型列表。
4. 翻译缓存（本地 LRU）+ Token 用量统计。
5. 术语表与自定义提示词。
6. 站点规则：按域名自动翻译 / 永不翻译。
7. 快捷键、右键菜单、popup、设置页。
8. 暗色/亮色自适应。

非目标：PDF/图片/字幕翻译、云同步、账号体系、多引擎聚合。

## 2. 技术约束（硬性）

- Manifest V3，最低 Edge / Chromium 114。
- 零构建、零依赖：不使用 npm 包、不编译 TypeScript、不生成 bundle，文件即产物。
  - background / popup / options 使用原生 ES Module。
  - content scripts：MV3 的 content_scripts 不支持 type module，因此按 manifest 顺序注入多个普通脚本，共享同一 isolated world 全局作用域，统一挂到 globalThis.AIT 上（IIFE + 严格模式）。
- 不使用 eval、内联脚本、远程代码。
- 所有网络请求只在 background 发出（规避 CORS + 保护 Key）。
- 代码风格：2 空格缩进、UTF-8、LF 结尾；不使用制表符。
- 禁止使用可选链已被广泛支持的现代语法没问题，但不要用 Experimental API（如 chrome.ai）。

## 3. 目录结构与写作用域

    F:/DSH/翻译/
    ├── docs/
    │   ├── RESEARCH.md          # 竞品调研（Lead）
    │   ├── ARCHITECTURE.md      # 本文档（Lead）
    │   └── TESTING.md           # 测试与验收（qa）
    ├── extension/
    │   ├── manifest.json        # Lead
    │   ├── README.md            # 安装与使用（Lead）
    │   ├── src/
    │   │   ├── shared/          # 仅 background / popup / options 引用
    │   │   │   ├── config.js    # 默认设置、常量、语言表
    │   │   │   ├── storage.js   # chrome.storage 封装
    │   │   │   ├── provider.js  # OpenAI 兼容 API
    │   │   │   ├── prompt.js    # 提示词构造 + 编号协议解析
    │   │   │   ├── cache.js     # 本地 LRU 翻译缓存
    │   │   │   ├── stats.js     # 用量统计
    │   │   │   ├── inject.js    # 动态注入 content script
    │   │   │   └── messages.js  # 消息类型常量
    │   │   ├── background/
    │   │   │   └── service-worker.js
    │   │   ├── content/
    │   │   │   ├── 00-core.js
    │   │   │   ├── 10-segmenter.js
    │   │   │   ├── 20-translator.js
    │   │   │   ├── 30-renderer.js
    │   │   │   ├── 40-selection.js
    │   │   │   ├── 50-observer.js
    │   │   │   ├── 90-main.js
    │   │   │   └── content.css
    │   │   ├── popup/
    │   │   │   ├── popup.html
    │   │   │   ├── popup.css
    │   │   │   └── popup.js
    │   │   ├── options/
    │   │   │   ├── options.html
    │   │   │   ├── options.css
    │   │   │   └── options.js
    │   │   └── assets/          # icon16/32/48/128.png、logo.svg
    │   ├── tests/               # node 运行的纯函数测试（qa）
    │   └── scripts/pack.mjs     # 打包 zip（Lead）

写作用域（并行开发严禁越界）：

| 角色 | 可写文件 |
| --- | --- |
| Lead | docs/RESEARCH.md、docs/ARCHITECTURE.md、extension/manifest.json、extension/src/shared/*、extension/src/background/*、extension/README.md、extension/scripts/*、extension/src/assets/* |
| content-engine | extension/src/content/00-core.js、10-segmenter.js、20-translator.js、30-renderer.js、50-observer.js、90-main.js、content.css |
| selection-ui | extension/src/content/40-selection.js；content.css 中 ait-sel-* 段落只允许追加自己的块 |
| app-ui | extension/src/popup/*、extension/src/options/* |
| qa | docs/TESTING.md、extension/tests/* |

CSS 冲突处理：content.css 由 content-engine 统一维护；selection-ui 只新增自己的 ait-sel- 前缀样式块（用注释分隔），由 content-engine 合并。popup/options 各自独立 CSS，无冲突。

## 4. 设置数据模型

存储于 chrome.storage.local，key = settings。读取时与 DEFAULT_SETTINGS 深合并，缺失字段用默认值补齐，保证版本升级兼容。

    {
      version: 1,
      provider: {
        baseUrl: "https://api.deepseek.com/v1",   // 可带 /v1，也可直接以 /chat/completions 结尾
        apiKey: "",
        model: "deepseek-chat",
        temperature: 0.2,
        maxTokens: 0,          // 0 = 不传该参数
        timeoutMs: 60000,
        stream: true,          // 划词流式；全页批量始终非流式
        extraHeaders: {}       // 例如 { "X-Foo": "bar" }，可选
      },
      language: { source: "auto", target: "zh-CN" },
      translate: {
        mode: "bilingual",          // bilingual | translation-only
        concurrency: 3,             // 1..6
        batchSize: 8,               // 每次请求聚合的段落数 1..20
        maxSegmentChars: 1500,
        autoTranslate: false,
        autoSites: [],
        excludeSites: [],
        minTextLength: 2,
        skipCode: true,
        retryLimit: 2,
        showOriginalDefault: true
      },
      selection: {
        enabled: true,
        autoPopup: false,
        targetLang: "zh-CN",        // 留空则跟随 language.target
        showOriginal: true,
        stream: true,
        maxChars: 6000
      },
      glossary: [ { "from": "token", "to": "令牌", "note": "" } ],
      customPrompt: { system: "", page: "", selection: "" },
      cache: { enabled: true, maxEntries: 2000, ttlDays: 30 },
      ui: {
        theme: "auto", locale: "zh-CN", firstRun: true,
        clickAction: "popup"    // popup = 点图标打开控制面板（默认，不占用图标）；toggle = 直接翻译/还原
      }
    }

- 统计单独存 key stats：{ requests, segments, cacheHits, tokensIn, tokensOut, since }，避免设置写入时覆盖。
- 缓存单独存 key transCache。
- 语言代码见 shared/config.js 的 LANGUAGES，至少包含：zh-CN 简体中文、zh-TW 繁体中文、en English、ja 日本語、ko 한국어、fr Français、de Deutsch、es Español、ru Русский、pt Português、it Italiano、ar العربية、auto 自动检测。

## 5. 消息协议

### 5.1 一次性消息（content → background，chrome.runtime.sendMessage）

统一响应形状：{ ok: boolean, ...data, error?: { code, message } }。所有 handler 必须 try/catch，绝不让 sendMessage 抛未捕获异常。

| type | 请求 payload | 成功响应 |
| --- | --- | --- |
| ait:settings.get | 无 | { ok, settings } |
| ait:settings.patch | { patch } 深合并 | { ok, settings } |
| ait:settings.reset | 无 | { ok, settings } |
| ait:translate.batch | { segments: [{id, text}], targetLang?, sourceLang?, pageUrl?, pageTitle? } | { ok, results: [{id, text}], cached, usage: {tokensIn, tokensOut} } |
| ait:translate.text | { text, targetLang?, sourceLang?, pageUrl? } | { ok, text, cached, usage } |
| ait:provider.test | { baseUrl?, apiKey?, model? } | { ok, latencyMs, model, sample? } |
| ait:provider.models | { baseUrl?, apiKey? } | { ok, models: string[] } |
| ait:cache.stats | 无 | { ok, entries, bytes, maxEntries } |
| ait:cache.clear | 无 | { ok } |
| ait:stats.get | 无 | { ok, stats } |
| ait:stats.reset | 无 | { ok, stats } |
| ait:page.translated | { url, translated } | { ok } |
| ait:tab.pageState | 由 popup 直接 chrome.tabs.sendMessage 给 content | { ok, translated, mode } |

错误码：NO_API_KEY、INVALID_CONFIG、HTTP_401、HTTP_429、HTTP_5XX、TIMEOUT、NETWORK、PARSE、EMPTY_RESPONSE、ABORTED。error.message 必须是可直接展示给用户的中文。

### 5.2 流式 Port（content 与 background 之间）

content 调用 chrome.runtime.connect({ name: "ait-stream" })。

| 方向 | 消息 | 说明 |
| --- | --- | --- |
| CS→BG | { type: "start", payload: { text, targetLang, sourceLang, pageUrl } } | 开始 |
| BG→CS | { type: "meta", provider, model } | 可选，首个消息 |
| BG→CS | { type: "chunk", delta, content, reasoning } | 增量；content 为累计文本，reasoning 为累计思考文本（无则省略） |
| BG→CS | { type: "done", content, usage, cached } | 结束；命中缓存时直接发一条 done |
| BG→CS | { type: "error", code, message } | 出错 |
| CS→BG | { type: "abort" } | 用户关闭卡片 |

一个 port 一次会话；结束后由 background 断开或等待下一次 start。

### 5.3 background → content 命令（chrome.tabs.sendMessage）

| type | 额外字段 | 行为 |
| --- | --- | --- |
| ait:cmd.toggleTranslate | 无 | 翻译或还原当前页 |
| ait:cmd.toggleMode | 无 | 双语 / 仅译文 |
| ait:cmd.translateSelection | 无 | 对当前选区弹卡片 |
| ait:cmd.setTargetLang | { lang } | 切换目标语言（设置已保存，content 重新翻译） |
| ait:cmd.settingsChanged | { settings } | 设置变更，content 更新本地缓存 |

快捷键通过 chrome.commands 在 background 接收后转成以上命令。右键菜单同理，只保留两个入口（划词翻译 / 页面翻译·还原）。

工具栏图标的默认行为是打开 popup（manifest 中的 default_popup），**不占用图标去做翻译**。若用户在设置里主动选择 ui.clickAction = "toggle"，background 才用 chrome.action.setPopup({ popup: "" }) 清除弹窗并监听 chrome.action.onClicked 直接触发 ait:cmd.toggleTranslate；切回 popup 时恢复弹窗。该行为在 background 每次启动、onInstalled、onStartup 以及 settings 变更后都会幂等重放（MV3 service worker 可能随时休眠）。

设置迁移：DEFAULT_SETTINGS.version 升到 2，storage.getSettings 读取时对旧版本执行迁移（v2 把 ui.clickAction 重置为 popup），把结果异步写回，避免早期安装的用户被旧的 toggle 默认值粘住。

## 6. Content 侧接口契约（globalThis.AIT）

所有文件形如：

    (() => { "use strict";
      const AIT = (window.AIT = window.AIT || {});
      AIT.util = Object.assign(AIT.util || {}, {
        // ...
      });
    })();

### 00-core.js

- AIT.version
- AIT.state = { settings, translated: false, mode: "bilingual", pageUrl, segments: [], progress: { done: 0, total: 0, failed: 0 } }
- AIT.util：qs、qsa、on(el, ev, fn, opts)、debounce(fn, ms)、escapeHtml(s)、hash(str) 同步 FNV-1a、isCJK(s)、looksTranslated(s)、normalizeText(s)、isVisible(el)、closestTag(el, set)、sleep(ms)、uid()
- AIT.log(message, ...args)：带 [AIT] 前缀，仅在 AIT.debug 为真时输出
- AIT.bus：极简事件总线 on(type, fn) / emit(type, payload)
- AIT.runtimeSend(msg)：封装 chrome.runtime.sendMessage，返回 Promise，永不 reject（失败返回 { ok: false, error })

### 10-segmenter.js

    AIT.segmenter = {
      collect(root = document.body, options = {}) -> Segment[],
      segmentOf(el) -> Segment | null,
      idFor(el, text) -> string
    }

Segment 形状：

    {
      id: "a1b2c3d4e5f6",   // 稳定 id（同一文本同一 id）
      el: Element,          // 承载原文的块级元素
      text: "Hello world",  // 送去翻译的纯文本（已 normalize）
      order: 12,            // 文档顺序
      rect: null,           // 渲染时再取，可先置 null
      state: "pending",     // pending | done | error
      translation: null,
      targetEl: null
    }

必须遵守的文本块规则：

- 白名单容器：p、h1-h6、li、dd、dt、blockquote、figcaption、td、th、caption、summary，以及无块级子元素且含可译文本的 div/section/article 叶子容器。
- 跳过：script/style/noscript/template/svg/canvas/iframe/textarea/select/option、.ait-trans、[contenteditable]、[translate=no]、.notranslate、隐藏元素、code/pre/kbd/samp（受 skipCode 控制）、纯数字符号、长度小于 minTextLength。
- 文本取 textContent 后 normalize 空白，不要包含子块文本。
- 同一元素只产出一个 Segment；重复文本各自成段（缓存会合并请求成本）。

### 20-translator.js

    AIT.translator = {
      async translatePage({ force = false } = {}) -> { total, translated, failed },
      async restore() -> void,
      isTranslated() -> boolean,
      async retrySegment(id) -> void,
      async translateElement(el) -> void,
      getProgress() -> { done, total, failed },
      applySettings(settings) -> void
    }

调度要求：视口内优先 → 按 order 分批（batchSize）→ concurrency 并发 → 每批完成立即渲染 → 失败按 retryLimit 退避重试 → 仍失败标记 .ait-error 且可点击重试 → 翻译中再次点击主按钮 = 取消并还原。进度通过 AIT.bus 的 progress 事件广播。

### 30-renderer.js

    AIT.renderer = {
      mount(segment, text) -> void,
      markPending(segment) -> void,
      markError(segment, message) -> void,
      unmount(segment) -> void,
      unmountAll() -> void,
      applyMode(mode) -> void,
      updateToast(progress) -> void
    }

DOM 约定（selection、popup、测试都依赖）：

    <!-- 块级兄弟模式（p / h1-h6 / li 等） -->
    <div class="ait-trans ait-trans--block" data-ait-id="..." data-ait-for="...">译文</div>
    <!-- 内联子节点模式（td / th 等不宜插兄弟时） -->
    <span class="ait-trans" data-ait-id="...">译文</span>
    <!-- 原文被隐藏（仅译文模式） -->
    <p data-ait-original="1">原文</p>

- 译文节点必须能被 unmountAll() 清理，并且能被 .ait-trans 选择器识别。
- 不允许改动原文节点内部文本，只允许加属性。
- 译文样式：左侧 2px 朱砂强调线、字号略小、低饱和文字色，暗色自动适配。
- 宿主背景自适应：mount / markError 时向上探测段落实际背景色的相对亮度，给译文节点附加 `ait-trans--on-light`（宿主背景偏亮）或 `ait-trans--on-dark`（宿主背景偏暗）类，强制使用匹配的一套配色。用于解决「系统主题与网页主题不一致」时译文撞色（例如系统亮色 + 深色网页）。两个类选择器在 content.css 中定义，特异性高于 prefers-color-scheme 媒体查询，与声明顺序无关。QA 验收需覆盖该场景。

### 40-selection.js（selection-ui 负责）

    AIT.selection = {
      init() -> void,
      open(text, rect) -> void,
      close() -> void,
      isEnabled() -> boolean,
      applySettings(settings) -> void
    }

交互要求：mouseup / selectionchange 防抖检测选区 → 非空、长度 ≤ selection.maxChars、不在输入框内 → 在选区右下显示圆形按钮 .ait-sel-trigger（文案「译」）→ 点击弹卡片 .ait-sel-card（fixed 定位，考虑视口边缘翻转）→ 流式输出 → 支持复制 / 关闭 / Esc / 点击外部关闭 → 目标语言切换（记住本次会话选择）→ 原文折叠区 → 错误提示可重试。所有节点挂在 #ait-selection-root 容器内（position fixed、z-index 2147483000、all initial 隔离）。

### 50-observer.js

    AIT.observer = {
      start() -> void,   // 翻译进行中才启动
      stop() -> void,
      refresh() -> void  // 路由变化后重新扫描
    }

防抖 600ms；只处理新增节点；翻译结束后自动 stop。

### 90-main.js

入口职责：读设置 → 应用语言与模式 → 初始化 selection → 注册 chrome.runtime.onMessage（处理 ait:cmd.*）→ 监听 chrome.storage.onChanged → 按站点规则判断是否自动翻译 → 暴露 window.__AIT_DEBUG__ = AIT。

### 动态注入（shared/inject.js）

popup 与 background 共用 ensureContentScript(tabId)：先在 isolated world 执行探针，确认页面是否已运行本扩展的 content script（同时校验该脚本的 chrome 上下文是否仍然存活），未运行则用 chrome.scripting.insertCSS + executeScript 注入 content 脚本，注入后再探测确认。

用途：扩展安装 / 重新加载**之前**就已经打开的标签页里没有 content script，浏览器不会补注入。用户点扩展图标或按快捷键时应自动补注入，而不是要求用户先刷新页面。

- 幂等：每个 content 模块入口都有守卫（AIT.xxx 已存在则跳过）；00-core 检测到旧上下文失效时会重建 window.AIT，因此重载扩展后残留旧脚本的页面也能被重新初始化。
- background 的 sendToTab 在 sendMessage 失败时自动 ensure 后重试一次；设置变更广播走 broadcastToTab，不触发注入，避免给所有标签页注入脚本。
- popup 在 pageState 无响应时先 ensure 再重试；仍失败才提示刷新页面。
- 验收脚本：extension/scripts/e2e-inject.mjs（用 matches 永不匹配的扩展副本复现「未注入页面」场景）。

## 7. 翻译管线细节

### 7.1 批量编号协议（prompt.js）

system 消息 = 内置翻译引擎提示词（可被 customPrompt.system 覆盖）+ 术语表 + 目标语言。user 消息 = 每行一个 [序号] 原文。

强制规则写进 system：

1. 逐段输出 [序号] 译文，序号与输入一一对应，不合并、不漏段、不添加解释。
2. 只输出译文；保留原文中的数字、单位、专有名词、代码、URL。
3. 已经是目标语言、纯数字或符号的段落原样输出。
4. 术语表优先于一切。

解析：优先按行首 [数字] 切分；容忍模型加粗、全角括号；缺段则该段单独重试一次，仍缺则标记失败。

### 7.2 重试与并发

- 批次失败：指数退避 800ms 乘 2 的 n 次方，最多 retryLimit 次；429 时读 Retry-After。
- 单段失败隔离：一批里某段解析缺失，仅该段降级为单段请求，不拖垮整批。

### 7.3 站点规则

autoSites / excludeSites 支持 example.com、*.example.com、localhost。优先级：excludeSites > autoSites > 全局 autoTranslate。

### 7.4 缓存

key = FNV1a(provider.baseUrl + "|" + model + "|" + targetLang + "|" + promptVersion + "|" + normalize(text))。
value = { t: 译文, ts: 时间戳 }。LRU 上限 maxEntries，TTL ttlDays，写入 debounce 1s，启动时惰性清理。命中率计入统计。

## 8. 视觉设计 Brief

**用户与任务**：经常读英文文档、论文、GitHub 的中文用户。核心三件事：翻译整页、划词查译、配置自己的模型。需要安静、专业、不打断阅读。

**目标感受**：像一份被专业编辑校过的稿纸，克制、可信、有秩序。不是「AI 产品」，是「阅读工具」。

**核心隐喻**：校样批注。译文是编辑用朱笔写在段落下方的批注：左侧一道 2px 朱砂竖线，字号略小、颜色略淡，与原文呼吸一致。界面中的主操作也只使用这一支朱笔。

**必守约束**

- 强调色只有一个：朱砂 #C2410C（暗色下 #FB923C）。其余全部中性灰。
- 底色是纸：亮色 #FBFAF7 系，暗色 #15140F 系。卡片用比底色高一档的纸色，不用纯白。
- 禁止：紫色/蓝色渐变、发光 glow、大面积玻璃拟态、彩虹渐变文字、无意义圆角堆叠（卡片圆角统一 10px）、emoji 当图标。图标一律内联 SVG，1.5px 描边。
- 字体：正文 system-ui, "PingFang SC", "Microsoft YaHei", sans-serif；标题与 logo 可用衬线 Georgia, "Songti SC", serif 制造书卷气。
- 动效：只做 120-180ms 的透明度与位移；尊重 prefers-reduced-motion。
- 布局：popup 宽 380px 单列；options 左侧 200px 导航加右侧最大 760px 表单列；窄屏（宽度小于 560px）导航变顶部横条，表单不得溢出。
- 可访问性：正文对比度 ≥ 4.5:1；焦点环 2px 朱砂 outline、offset 2px；所有按钮有 focus-visible 样式；disabled 明确。

**交付判据**：桌面 1440x900 与窄屏 480x900 两个视口截图；无横向溢出、无文字竖排或裁切；主操作按钮首屏可见。

## 9. 测试与验收

- 单元测试（extension/tests/*.test.mjs，node --test 运行）：prompt 解析容错、缓存 LRU、URL 规范化、语言检测、settings 合并、segmenter 纯函数（用最小假 DOM）。
- 静态检查：node --check 所有 JS；JSON 解析 manifest；HTML 引用的文件存在。
- UI 截图验收：popup / options 支持 ?demo=1 模式（mock chrome.* 并注入演示数据），用无头 Edge 在 1440x900 与 480x900 截图评审。
- 手工冒烟（写进 README）：加载扩展 → 配置 Key → 打开英文页面 → Alt+T → 检查双语/还原/划词/缓存命中/暗色模式。

## 10. 协作约定

- 文件名、目录、全局对象、消息 type 一律以本文档为准。
- 共享接口变更必须先改本文档，再通知 Lead 与相关模块负责人。
- 不引入构建步骤、不新增第三方依赖、不写远程代码。
- 完成后自测：node --check 通过；自己的页面能在本机用无头 Edge 正常渲染并截图。
