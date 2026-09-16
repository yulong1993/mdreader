# AGENTS.md

MD Reader：Windows 下的 Tauri 2 + WebView2 Markdown 阅读器（MIT 开源，仓库公开）。
本文件是给 AI 协作代理的项目规则；面向用户的说明见 `README.md`。

## 常用命令

| 操作 | 命令 |
|---|---|
| 安装依赖 | `npm install` |
| 开发模式 | `npm run tauri dev`（改前端即时热更新） |
| 打包安装版 | `npm run tauri build` |
| 构建绿色版 exe | 先 `npm run build`，再 `cd src-tauri && cargo build --release --features custom-protocol` |

## 红线

- **绿色版必须带 `--features custom-protocol`**：缺了它产出连 `localhost:1420` 的开发版二进制（页面显示"无法访问此页面"）。
- **前端有任何改动必须先 `npm run build` 再 cargo 构建**：release 把 `dist/` 嵌进二进制，只跑 cargo 会嵌入旧前端（改动"不生效"多半是这个）。
- **提交用仓库本地中性身份** `mdreader <mdreader@users.noreply.github.com>`（已配置在 repo config，勿引入全局个人身份）。仓库公开且历史已清洗：**任何人名、邮箱、个人盘符路径、单位相关词汇不得进入新提交**——提交前 `git diff --cached` 自查一遍。
- **安全测试必须用 release 版**：`tauri dev` 模式不注入 CSP，测了不算数。
- 发布 zip 内的说明文件用 ASCII 文件名（如 `README.txt`）：Windows PowerShell 5.1 读无 BOM UTF-8 中文文件名会按 GBK 误解。

## 本机测试设施（`src-tauri/target/` 下，gitignore 不入库）

CDP 驱动的 E2E。新环境克隆后这些脚本不存在，按下面模式重建：

- **启动姿势**：`taskkill /F /IM mdreader.exe` + `wv2-kill.ps1`（杀共享 UDF 的 WebView2 进程，否则 `--remote-debugging-port=9222` 参数被吞），再以 `WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS=--remote-debugging-port=9222` 启动 exe。
- **`e2e.mjs`**：标签拖拽/会话恢复 21 项。拖拽测试还需 `MDR_DRAG_SIM` 环境变量指向 sim 文件（如 `target/drag.sim`），脚本按 `x y down` 格式写入物理像素坐标驱动原生光标模拟（lib.rs 中 TEST-ONLY 钩子，发布运行不带此变量）。
- **功能测试**（块编辑、行号栏等）：按同样模式临时写脚本——`localStorage` 注入 `mdr-session:main` 会话 + `location.reload()` 打开指定文档，然后 CDP `Runtime.evaluate` 断言。
- **坑**：`#preview-pane` 是 `scroll-behavior: smooth`，程序设 scrollTop 前先 `style.scrollBehavior='auto'`；CDP 表达式要检查 `exceptionDetails`，否则页面侧异常被静默吞掉。
- **测试会污染用户 UDF 的 localStorage**（主题/会话/行号偏好），跑完要还原再交付部署。

## 项目约定

- **行号锚体系**：渲染期给顶层块挂 `data-line="起-止"`（0 基，块编辑定位用）与 `data-line-no`（1 基起始行，行号栏显示用）。两者同源、都从 `annotateSourceLines()` 出；fence 的锚由 DOM pass 从 `<code>` 搬到外层 `<pre>`，mermaid 替换时锚跟着搬到新容器。改渲染管线时两套锚要一起维护。
- **UI 文案与注释以中文为主**，与现有风格一致。

## 文档索引

| 文件 | 内容 |
|---|---|
| `README.md` | 用户介绍 + 维护者手册（功能细节/安全设计/开源授权/打包部署） |
| `research.md` | 技术选型调研（历史文档，写于立项期） |
| `licenses/` | 随包分发资源的授权文本（KaTeX 字体 OFL 1.1） |
