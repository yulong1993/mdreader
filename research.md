# Windows 轻量级 Markdown 阅读器 — 技术调研

> 调研日期：2026-09-11
> 目标：一个轻量的 Windows Markdown **阅读器**（只读为主），对表格、颜色（语法高亮/主题/内联颜色）、各类段落与符号（标题、列表、引用、任务框、表格框线等）有 GitHub 级的渲染质量。

---

## 一、GitHub 是怎么渲染 Markdown 的（对标基准）

GitHub 服务端的渲染链路：

```
Markdown 源文件
  → cmark-gfm（C 语言解析器，CommonMark + GFM 扩展）
  → HTML Pipeline 过滤（安全清洗、emoji、任务列表、锚点等）
  → 语法高亮（tree-sitter）
  → 前端用 GitHub 自家 CSS 渲染
```

关键事实：

- GitHub 官方解析器是 [cmark-gfm](https://github.com/github/cmark-gfm)，为追求确定性和规范符合度，GitHub 早年从 Ruby 的 Redcarpet 迁移到了 cmark（[官方工程博客](https://github.blog/engineering/user-experience/a-formal-spec-for-github-markdown/)）。
- [GFM 规范](https://github.github.com/gfm/) = CommonMark + 表格 + 任务列表 + 删除线 + 自动链接 + 受限原始 HTML。
- 社区把 GitHub 的样式提取成了 **[github-markdown-css](https://github.com/sindresorhus/github-markdown-css)**，"最小 CSS 复刻 GitHub Markdown 外观"，可离线像素级还原 README 效果（官方 [demo](https://sindresorhus.com/github-markdown-css/)）。

### 需要对齐的 GitHub 渲染特性清单

| 特性 | 语法 | 说明 |
|---|---|---|
| 表格（含列对齐） | `| a \| b |` + `:---:` | GFM 内置，`---:` 右对齐等 |
| 任务列表 | `- [x]` / `- [ ]` | 渲染成可勾选样式（表格内不渲染） |
| 删除线 | `~~text~~` | GFM 内置 |
| 自动链接 | 裸 URL | GFM 内置 |
| 代码高亮 | ` ```js ` | GitHub 用 tree-sitter；前端可用 highlight.js/Shiki 等价替代 |
| 数学公式 | `$...$` / `$$...$$` | GitHub 2022 年起支持，基于 LaTeX |
| Mermaid 图表 | ` ```mermaid ` | 原生渲染流程图/时序图等 |
| Alerts 提示框 | `> [!NOTE]` 等 | 5 种彩色提示框：NOTE 蓝 / TIP 绿 / IMPORTANT 紫 / WARNING 橙 / CAUTION 红 |
| Emoji 短代码 | `:+1:` | 渲染为 emoji 字符 |
| 脚注 | `[^1]` | GitHub 支持 |
| 标题锚点 | `## 标题` | 自动生成 heading id，可做大纲跳转 |

参考：[GitHub Docs — Basic writing and formatting syntax](https://docs.github.com/github/writing-on-github/getting-started-with-writing-and-formatting-on-github/basic-writing-and-formatting-syntax)、[Mermaid 文档](https://docs.github.com/en/get-started/writing-on-github/working-with-advanced-formatting/creating-diagrams)。

---

## 二、渲染层选型（核心结论）

### 2.1 Markdown 解析器：markdown-it ✅

| 解析器 | 速度 | 规范符合度 | 插件生态 | 结论 |
|---|---|---|---|---|
| **markdown-it** | 快 | CommonMark 严格符合 | 极丰富（100+ 插件） | **推荐**。**VS Code 内置 Markdown 预览同款** |
| marked | 最快（简单场景） | 弱，默认不安全 | 中 | 不推荐（[Don't use marked](https://macwright.com/2024/01/28/dont-use-marked)） |
| remark/micromark | 最慢 | 最严格、最现代 | 强（unified 生态） | 适合复杂 AST 变换，对阅读器过重 |
| showdown | 慢、老旧 | 弱 | 少 | 不考虑 |

- VS Code 官方确认其内置预览基于 markdown-it + 插件机制（[官方文档](https://code.visualstudio.com/api/extension-guides/markdown-extension)、[SO](https://stackoverflow.com/questions/56623758/how-to-invoke-the-visual-studio-code-markdown-renderer)）——这是"markdown-it 足以撑起一个高质量 MD 查看器"的最强背书。
- markdown-it **开箱即含** GFM 表格、删除线，`linkify: true` 即得自动链接；任务列表/emoji/脚注/alerts 用插件补齐。

**推荐插件清单（全部成熟、低体积）：**

```
markdown-it                    # 核心（表格/删除线内置）
markdown-it-task-lists         # 任务列表
markdown-it-emoji              # :smile: 短代码
markdown-it-footnote           # 脚注
markdown-it-github-alerts      # > [!NOTE] 五色提示框
markdown-it-anchor             # 标题锚点（配合大纲侧栏）
@vscode/markdown-it-katex      # 数学公式（或 markdown-it-katex 变体）
```

### 2.2 样式：github-markdown-css ✅

- 7 个主题：light / dark / dark dimmed / 高对比度 / 色盲友好等，完美支持亮暗双模式。
- 复刻 GitHub 版心：`max-width: 980px; padding: 45px; margin: 0 auto;`。
- 表格框线、列表符号（圆点/数字）、引用竖线、任务复选框等符号渲染与 GitHub 完全一致——直接解决"段落符号显示好"的需求。
- 想跟进 GitHub 最新样式可用 [generate-github-markdown-css](https://github.com/sindresorhus/generate-github-markdown-css) 重新生成。

### 2.3 代码高亮：highlight.js（默认）或 Shiki（进阶）

| 方案 | 体积 | 质量 | 适用 |
|---|---|---|---|
| **highlight.js** | common 集约 100–250KB（可按语言裁剪更小），零依赖 | 够用，GitHub 主题配色齐全 | 轻量首选 |
| **Shiki** | core 约 106KB min / 34KB gzip，语言和主题全部懒加载 | VS Code 级（TextMate 语法），最接近 GitHub tree-sitter 效果 | 追求极致还原 |
| Prism | ~20KB + 每语言 3–30KB | 中 | 备选 |

结论：MVP 用 **highlight.js + github-light/github-dark 主题**；以后想要 VS Code 级高亮再切 Shiki（懒加载模式下体积可控）。

### 2.4 数学与图表（按需加载）

- 数学：**KaTeX**（快、字体可子集化），不用 MathJax（重约 1MB 级）。
- 图表：**mermaid.js**（约 1MB 级，只在文档里出现 ` ```mermaid ` 时动态加载）。

### 2.5 安全：DOMPurify

阅读器会打开来路不明的 .md 文件，渲染出的 HTML 必须过一遍 **DOMPurify**（约 20KB）再插入 DOM，防止内嵌 `<script>`、`onerror` 等注入。本地阅读器可自定义放行策略（例如允许 `style` 属性——这是能做得**比 GitHub 更好的点**：GitHub 会过滤 `style`，阅读器可以选择保留 `<span style="color:red">` 这类内联颜色，"颜色"显示能力反而超过 GitHub）。

### 2.6 中文/CJK 排版要点

- 字体栈：`-apple-system, "Segoe UI", "Microsoft YaHei", "PingFang SC", sans-serif`；代码字体 `"Cascadia Code", Consolas, "Microsoft YaHei", monospace`（代码注释里的中文需要回退字体）。
- WebView2（Chromium 内核）原生支持彩色 emoji（Segoe UI Emoji），`:emoji:` 短代码和字符 emoji 都能正确显示。
- 注意 `line-height` 放宽到 1.6 左右中英文混排才舒适；github-markdown-css 默认已处理。

### 2.7 渲染管线小结

```js
import MarkdownIt from 'markdown-it';
import DOMPurify from 'dompurify';
// + 各插件…

const md = new MarkdownIt({ html: true, linkify: true, typographer: true })
  .use(taskLists).use(emoji).use(footnote).use(githubAlerts).use(anchor)
  .use(katex);

const dirty = md.render(source);
const clean = DOMPurify.sanitize(dirty, { ADD_ATTR: ['style'] });
container.innerHTML = clean;   // container 带 .markdown-body 类 + github-markdown-css
// 之后对 pre>code 跑 highlight.js；检测到 mermaid 块再动态加载 mermaid.js
```

---

## 三、外壳选型：怎么做到"轻量"

### 3.1 方案对比

| 方案 | 安装包体积 | 空闲内存 | 渲染质量 | 结论 |
|---|---|---|---|---|
| **Tauri 2（Rust + 系统 WebView2）** | ~3–10 MB | ~40–80 MB | Chromium 级 | ✅ **推荐** |
| C# (WPF/WinUI) + WebView2 | 小（依赖 .NET 运行时或自包含 ~60–100MB） | 与 Tauri 相当 | Chromium 级 | ✅ 可行替代（不想写 Rust 时） |
| Electron | ~120–200 MB | ~150–400 MB | Chromium 级 | ❌ 与"轻量"矛盾 |
| 纯原生（Qt QTextBrowser / WPF FlowDocument / Flutter） | 小 | 最小 | ❌ 表格/颜色/高亮还原度差，工作量巨大 | ❌ 不推荐 |

要点：

- 决定性的事实是：**想要 GitHub 级的表格和颜色渲染，就必须用浏览器引擎排版**；而 Windows 10/11 自带 Edge WebView2（Chromium 内核，随 Edge 自动更新），所以"WebView2 做壳"是轻量与渲染质量兼得的唯一路线。
- Tauri 相比 Electron：安装包小约 96%，内存少约 50–75%（[实测报告](https://www.reddit.com/r/programming/comments/1jwjw7b/tauri_vs_electron_benchmark_58_less_memory_96/)、[详细对比](https://www.gethopp.app/blog/tauri-vs-electron)、[2026 对比](https://rustify.rs/articles/rust-tauri-vs-electron-2026)）。注意 WebView2 本身也是 Chromium 进程，总内存比裸数字高，个别场景（[tauri#5889](https://github.com/tauri-apps/tauri/issues/5889)）甚至可能反超 Electron，但整体仍明显占优。
- 前端 UI 不需要框架，vanilla HTML/CSS/JS（或 Preact）即可，进一步压体积。

### 3.2 Rust 侧职责（Tauri）

- 文件读取（大文件流式/分块渲染可后置）；
- **文件监听自动刷新**（`notify` crate）——写 Markdown 时实时看到渲染结果，阅读器的核心体验；
- 最近文件、文件关联 `.md`（Tauri bundle 配置即支持）；
- 原生菜单 / 暗色模式跟随系统（Tauri 2 有 window theme API）。

---

## 四、竞品参考

| 产品 | 技术 | 借鉴点 |
|---|---|---|
| **VS Code 内置预览** | Electron + markdown-it | 渲染器选型的最强背书 |
| **Typora** | 闭源、付费 | 体验标杆：无干扰阅读、主题丰富 |
| MarkText | Electron | 已半弃维护，再次说明 Electron 路线又重又难持续 |
| Obsidian | Electron | 功能全但重（数百 MB 内存） |
| **MonoReader / MDHero / SoloMD** | **Tauri + WebView2** | 2025 年后新一批轻量 MD 阅读器，验证了 Tauri 路线可行（[MonoReader 已上架微软商店](https://apps.microsoft.com/detail/9nhr7vv7zwkt)） |
| grip | 调 GitHub API | 需联网+限流，思路不可取，离线渲染才是正解 |

---

## 五、建议的 MVP 架构

```
┌─────────────────────────── Tauri 2 壳 ───────────────────────────┐
│  Rust 侧                          前端 (WebView2, vanilla JS)     │
│  ├─ 打开文件/文件夹               ├─ markdown-it + 插件全家桶      │
│  ├─ notify 文件监听 →自动重渲染    ├─ DOMPurify 清洗               │
│  ├─ 最近文件/书签(后置)           ├─ github-markdown-css 双主题    │
│  └─ .md 文件关联                  ├─ highlight.js / KaTeX          │
│                                   ├─ mermaid 懒加载               │
│                                   └─ 大纲侧栏（heading anchors）  │
└──────────────────────────────────────────────────────────────────┘
```

MVP 功能清单（按优先级）：

1. 打开/拖拽 .md 文件，`Ctrl+O`；文件关联双击打开
2. GitHub 级渲染：表格、删除线、任务列表、代码高亮、emoji、alerts
3. 亮/暗主题（跟随系统）
4. 文件保存时自动刷新（notify）
5. 大纲侧栏 + 标题锚点跳转
6. 数学公式（KaTeX）、Mermaid（懒加载）
7. 图片相对路径解析（相对所打开 md 文件目录）
8. 后置：多标签、最近文件列表、导出 PDF（直接用浏览器打印）、front-matter 解析

预期指标：安装包 < 10 MB，冷启动 < 500 ms，空闲内存 < 100 MB（含 WebView2 进程）。

---

## 六、主要来源

- [github/cmark-gfm](https://github.com/github/cmark-gfm) · [GFM Spec](https://github.github.com/gfm/) · [GitHub 工程博客：GFM 规范化](https://github.blog/engineering/user-experience/a-formal-spec-for-github-markdown/)
- [github-markdown-css](https://github.com/sindresorhus/github-markdown-css) · [npm](https://www.npmjs.com/package/github-markdown-css) · [在线 Demo](https://sindresorhus.com/github-markdown-css/)
- [markdown-it](https://github.com/markdown-it/markdown-it) · [VS Code Markdown 扩展指南](https://code.visualstudio.com/api/extension-guides/markdown-extension)
- [marked vs remark vs markdown-it（2026）](https://www.pkgpulse.com/guides/marked-vs-remark-vs-markdown-it-parsers-2026) · [Don't use marked](https://macwright.com/2024/01/28/dont-use-marked)
- [Shiki 官方文档（体积数据）](https://shiki.style/guide/) · [Shiki vs Prism vs highlight.js](https://www.pkgpulse.com/guides/shiki-vs-prismjs-vs-highlightjs-syntax-highlighting-2026)
- [Tauri vs Electron 实测](https://www.reddit.com/r/programming/comments/1jwjw7b/tauri_vs_electron_benchmark_58_less_memory_96/) · [gethopp 对比](https://www.gethopp.app/blog/tauri-vs-electron) · [tauri#5889](https://github.com/tauri-apps/tauri/issues/5889)
- [GitHub Docs：Basic writing and formatting syntax](https://docs.github.com/github/writing-on-github/getting-started-with-writing-and-formatting-on-github/basic-writing-and-formatting-syntax) · [Mermaid](https://docs.github.com/en/get-started/writing-on-github/working-with-advanced-formatting/creating-diagrams)
