# MD Reader

轻量级 Windows Markdown 阅读器 —— Tauri 2 + WebView2，GitHub 级渲染质量，兼容 Obsidian 写法。

## 功能

- **GitHub 风格渲染**：表格（列对齐/横向滚动）、任务列表、~~删除线~~、自动链接、Emoji、脚注
- **代码高亮**：highlight.js（常见 40+ 语言，亮/暗双主题）
- **数学公式**：`$...$` 行内 / `$$...$$` 独立公式（KaTeX）
- **Mermaid 图表**：流程图/时序图等，懒加载（用到才下载渲染）
- **GitHub Alerts**：`> [!NOTE]` / TIP / IMPORTANT / WARNING / CAUTION 五色提示框
- **Obsidian 双链**：`[[页面]]`、`[[页面|别名]]`、`[[页面#标题]]`（跳转后滚动定位）、`![[嵌入]]`（图片/音频/视频，md 嵌入降级为链接卡片）；目标自动在当前目录及子目录（≤3 层）查找，失效链接灰色删除线
- **Obsidian Callout**：`> [!note] 自定义标题`，16 种类型（Obsidian 14 种 + GitHub 的 `important`/`caution`）统一渲染，支持 `-`（默认折叠）/`+`（默认展开）折叠标记，点击标题切换
- **Obsidian 行内语法**：`==高亮==`、`#标签`（药丸样式，支持中文/斜杠嵌套）、`%%注释%%`（渲染时隐藏）
- **导出 PDF**：工具栏 `🖨 PDF` 或 `Ctrl+P`，在打印对话框选「另存为 PDF」；打印样式已优化（页边距、长代码换行、避免表格/代码块/图表跨页截断）
- **文件监听**：保存即刷新（Rust `notify`，保持滚动位置）
- **大纲导航**：侧栏标题目录，`Ctrl+\` 切换
- **主题**：自动跟随系统 / 浅色 / 深色（`◐` 按钮循环切换）
- **打开方式**：`Ctrl+O`、拖拽进窗口、命令行参数、双击 `.md`（需安装打包版）、相对 `.md` 链接与 `[[双链]]` 点击跳转
- **图片**：相对路径自动解析（含 `../`），本地绝对路径也可
- **编码**：UTF-8（含 BOM）自动识别，GBK 老文档自动回退解码
- **安全**：DOMPurify 清洗所有渲染 HTML 与 mermaid 图表 SVG（允许内联 `style`，比 GitHub 显示能力更强）

## 安全设计

- **CSP（仅打包版生效）**：`default-src 'none'`，脚本仅限自身、图片限 https 与 asset 协议——不可信文档无法向任意服务器外发请求（跟踪信标被拦截，http: 远程资源也不加载）。注意：`tauri dev` 模式直连 vite 开发服务器，CSP 不注入，安全测试须用 release 版。
- **文件读取面收紧**：Rust 侧只接受 `.md/.markdown/.mdown/.mkd/.txt` 且 ≤ 50 MB；图片路径仅在媒体扩展名时转换为 asset 协议 URL。
- **编码识别**：UTF-8（含 BOM）/ UTF-16LE / UTF-16BE / GBK 自动回退。
- **依赖审计**：`npm audit` 0 漏洞（mermaid 固定 11.x，避开 chevrotain/lodash-es 漏洞链）。

## 开发

```bash
npm install        # 安装前端依赖
npm run tauri dev  # 开发模式（改前端即时热更新）
```

首次 `cargo` 编译较慢（几分钟），之后增量编译很快。

## 打包安装（双击 .md 打开的前提）

```bash
npm run tauri build
```

产物在 `src-tauri/target/release/bundle/`：

- `nsis/mdreader_0.1.0_x64-setup.exe` —— 推荐安装这个（含 `.md` 文件关联）
- `msi/mdreader_0.1.0_x64_en-US.msi` —— MSI 安装包
- `../mdreader.exe` —— 单文件绿色版（见下节「绿色版部署」）

## 绿色版部署（本机当前方案）

1. 把 `src-tauri/target/release/mdreader.exe` 复制到固定目录（本机为 `D:\Tools\MDReader\`），**之后不要移动路径**——文件关联指向该路径
2. 双击导入 `tools/portable-associate.reg`（写 HKCU 级 `.md`/`.markdown` 关联，优先于坚果云的机器级注册）
3. 导入后重启资源管理器或注销重登一次，让 shell 刷新关联缓存
4. 想撤销：导入 `tools/portable-unassociate.reg`，`.md` 自动回落到原有关联
5. 程序更新：重新 `npm run tauri build` 后覆盖 exe 即可，关联不受影响

注意：

- 安装包未签名，首次运行 Windows SmartScreen 可能拦截，点「更多信息 → 仍要运行」。
- 从 Git Bash 静默安装要绕开 MSYS 参数转换：`cmd //c start "" "setup.exe" /S`（直接 `/S` 会被当路径吞掉）。
- 安装后若 `.md` 默认打开方式没变，在任意 .md 上右键 → 打开方式 → 选择 MD Reader → 始终。
- 再次启动的实例（如双击第二个文件）会把路径转发给已运行的窗口，不会重复开进程。

## 项目结构

```
├── index.html            # 应用外壳（工具栏/大纲/内容区）
├── src/
│   ├── main.js           # 渲染管线 + Obsidian 扩展 + 主题 + 大纲 + 事件
│   └── styles.css        # 应用 chrome / callout / 打印样式
├── src-tauri/
│   ├── src/lib.rs        # Rust：读文件(GBK回退)/监听/路径解析/双链查找/单实例
│   ├── tauri.conf.json   # 窗口、asset 协议、打包、文件关联
│   └── capabilities/     # 权限声明
├── samples/
│   ├── demo.md           # GitHub 风格渲染测试文档
│   └── demo-obsidian.md  # Obsidian 语法测试文档（双链/callout/高亮/标签）
└── research.md           # 技术调研（选型依据）
```

## 快捷键

| 键 | 功能 |
|----|------|
| `Ctrl+O` | 打开文件 |
| `Ctrl+\` | 显示/隐藏大纲 |
| `Ctrl+P` | 导出 PDF / 打印 |
