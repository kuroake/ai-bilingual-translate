# GitHub 同类项目调研报告

> 调研时间：2026-10-19　方式：GitHub README / 项目文档 / 商店页
> 目的：动手实现「Edge AI 翻译扩展」之前，先确认同类项目的架构、能力与已知坑，避免重复造轮子，并找到差异化空间。

## 1. 调研对象

| 项目 | 定位 | 许可证 | 技术栈 | 链接 |
| --- | --- | --- | --- | --- |
| Immersive Translate 沉浸式翻译 | 双语网页翻译的事实标准 | 闭源核心 / 部分开源 | 自研 | https://immersivetranslate.com/ |
| KISS Translator 简约翻译 | 轻量双语对照，规则与接口高度可定制 | MIT | React + Vite | https://github.com/fishjar/kiss-translator |
| FluentRead 流畅阅读 | 功能大而全：网页/悬停/划词/图片/PDF/字幕/学习中心 | GPL-3.0 | Vue + pnpm | https://github.com/Guo-astro/fluentread |
| Dual Read | 双语阅读 + 自托管 Go 缓存代理 | Apache-2.0 | WXT + TS + Go | https://github.com/skys-mission/dual-read |
| LLM 划词翻译 | 划词翻译，流式 + 思考过程展示 | 开源 | 原生 JS + esbuild + PDF.js | https://github.com/firezl/LLM_hcfy |
| ai-translator-extension | 最小可用 Edge 版：全页/划词/总结 | 开源 | 原生 JS，MV3 | https://github.com/ZJH-d-j/ai-translator-extension |

## 2. 功能矩阵

| 能力 | 沉浸式 | KISS | FluentRead | Dual Read | LLM_hcfy | 本项目目标 |
| --- | :-: | :-: | :-: | :-: | :-: | :-: |
| 全页双语对照 | 有 | 有 | 有 | 有 | 无 | 有 |
| 划词翻译 | 有 | 有 | 有 | 有 | 有（主力） | 有 |
| AI / 自定义 OpenAI 兼容接口 | 有 | 有 | 有 | 有 | 有 | 有（主力） |
| 流式输出 | 有 | 有 | 有 | 部分 | 有 | 有 |
| 翻译缓存 | 云端 | 本地 | 本地 | 本地 + 服务端 | 无 | 本地 LRU |
| 术语表 / 自定义 Prompt | 有 | 有（词典） | 有 | 无 | 有（术语库） | 有 |
| 站点自动翻译规则 | 有 | 有（最强规则引擎） | 有 | 有 | 无 | 有（精简版） |
| 动态页面 SPA + 懒加载 | 有 | 有 | 有 | 有（视口优先） | 无 | 有 |
| 失败重试 | 有 | 有 | 有 | 有（退避 + 点击重试） | 部分 | 有 |
| 免构建、直接加载 | 无 | 无 | 无 | 无 | 部分（需 esbuild） | 有 |
| 完整源码可读 | 无 | 有 | 有 | 有 | 有 | 有 |

## 3. 关键工程经验（直接采纳）

### 3.1 分段与渲染（来自沉浸式 / KISS / Dual Read）

- 不要遍历所有文本节点逐个翻译：句子被链接、加粗标签切碎后语义丢失，且请求数爆炸。
- 正确做法：识别「文本块」（p / h1-h6 / li / td / dd / blockquote / figcaption 等的叶子容器），以整块文本为翻译单元，译文作为新节点插在原文旁边做双语对照，原文 DOM 不动。
- 必须跳过：script/style/noscript/code/pre/kbd/samp、可编辑区域、已有译文节点、纯符号数字、过短节点。技术文档里翻译代码是灾难，这点是共识。
- 视口优先 + IntersectionObserver 懒翻译：长页面不必等全部完成（Dual Read 的 viewport-first lazy translation）。
- MutationObserver 增量索引新内容，避免整页重扫（Dual Read / KISS）。

### 3.2 请求与成本（来自 KISS / Dual Read）

- 聚合批量发送：把多个短段落合并进一次请求，显著降低延迟和费用（KISS 明确列为优化点）。
- 批量必须解决对齐问题。两个流派：
  - JSON 数组：格式严格，但小模型经常输出坏 JSON、截断、缺项；
  - 编号分隔（[1] …）：容错好、支持流式、可逐段恢复。我们选编号协议 + 解析容错 + 缺段回退单段请求。
- 本地缓存是省钱关键：Dual Read 的缓存代理在重复内容上省 90%。我们用 chrome.storage.local 的 LRU 实现零依赖等价物。
- 并发必须限流（3-4），并做 429/5xx 退避重试，否则用户一开全页就被 API 限流。

### 3.3 CORS 是大坑（LLM_hcfy README 的 FAQ 直接踩中）

- 在 content script 里 fetch 第三方 API 会受页面 CORS 限制，很多端点直接 403。
- 解决：API 请求全部放在 background service worker，配合 host_permissions 的全站声明，扩展请求不受 CORS 限制；API Key 也永远不进页面上下文。

### 3.4 UI 经验

- 划词按钮要小、出现在选区附近、点击外部即关；流式打字机是体验分水岭（LLM_hcfy 重点优化）。
- 暗色/亮色跟随系统；译文样式必须安静，不能抢原文注意力。
- 设置页必须能测试连接、拉取模型列表，否则用户配错 Base URL 完全无从排查（大量 issue 都是这个）。
- KISS 的规则引擎很强但学习成本高；我们只做「自动翻译站点 / 排除站点」两档。

## 4. 明确不做的事

- PDF / ePub / DOCX 文档翻译、图片 OCR、视频字幕：工程量大，与「网页 AI 翻译」核心价值偏离。
- 多引擎聚合（Google/DeepL/腾讯…）：定位就是 AI 翻译，OpenAI 兼容接口已覆盖 DeepSeek / OpenAI / Ollama / 各类中转。
- 账号体系与云端同步：本地存储 + JSON 导入导出。
- 规则订阅生态：只保留精简站点规则。

## 5. 差异化定位

1. 零构建、零依赖：下载即「加载解压缩的扩展」，源码可直接读改（对照：竞品全部需要 npm install + 构建）。
2. AI 优先而非 AI 附加：提示词、批量编号协议、术语表、缓存都围绕大模型设计，而不是传统机翻接口的补丁。
3. 隐私边界清晰：Key 只在 background，页面上下文拿不到；缓存与配置全本地；无任何遥测。
4. 质量型 UI：不堆渐变发光，用「校样批注」的视觉语言（朱砂色校对标记 + 纸感底色），让译文像编辑留下的批注。
