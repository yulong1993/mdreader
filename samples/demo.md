# MD Reader 渲染测试文档

这是一个用于验证渲染效果的测试文件，覆�?GitHub 风格 Markdown 的主要特性。中英文混排 Typography 测试：Markdown 是一种轻量级标记语言�?026 年仍然是文档事实标准�?
## 基础排版

**加粗**�?斜体*、~~删除线~~、`行内代码`、[链接](https://github.com)、自动链�?https://tauri.app，以�?emoji�?+1: :rocket: :sparkles: :heart:

> 引用块：简单胜于复杂（Simple is better than complex）�?
## 表格（含对齐�?
| 命令 | 说明 | 示例 |
|:-----|:----:|----:|
| `Ctrl+O` | 打开文件 | �?|
| `Ctrl+\` | 切换大纲 | �?|
| `Ctrl+P` | 打印 / 导出 PDF | �?|

| 项目 | 体积 | 状�?|
|------|------|------|
| Tauri �?| ~5 MB | �?|
| WebView2 运行�?| 系统自带 | �?|
| Electron 对照 | ~150 MB | �?|

## 任务列表

- [x] 支持 GFM 表格
- [x] 代码语法高亮
- [x] �?/ 暗主题切�?- [ ] 多标签页
- [ ] 导出 PDF

## 代码高亮

```javascript
// 经典 FizzBuzz
for (let i = 1; i <= 15; i++) {
  const out = (i % 3 ? "" : "Fizz") + (i % 5 ? "" : "Buzz");
  console.log(out || i);
}
```

```rust
#[tauri::command]
fn read_file(path: String) -> Result<String, String> {
    std::fs::read_to_string(&path).map_err(|e| e.to_string())
}
```

```python
def greet(name: str) -> str:
    return f"Hello, {name}!"
```

## 数学公式

质能方程 $E = mc^2$ 是行内公式；下面是独立公式：

$$
\int_{-\infty}^{\infty} e^{-x^2} \, dx = \sqrt{\pi}
$$

## 提示框（GitHub Alerts�?
> [!NOTE]
> 这是一�?NOTE 提示，用于补充说明信息�?
> [!TIP]
> 把文件拖进窗口即可打开，保存后自动刷新�?
> [!WARNING]
> 注意：阅读模式下任务列表复选框不可编辑�?
## 图片（相对路�?+ asset 协议�?
![示例图片](demo.svg)

## Mermaid 图表

```mermaid
flowchart LR
    A[打开 .md 文件] --> B{�?mermaid?}
    B -- �?--> C[懒加�?mermaid.js]
    B -- �?--> D[直接渲染]
    C --> D
    D --> E[GitHub 级显示]
```

## 脚注

这里有一个脚注引用[^1]，还有一个[^note]�?
[^1]: 这是第一个脚注的内容�?[^note]: 脚注也可以用命名标记�?
## 长表格横向滚动测�?
| 特性一 | 特性二 | 特性三 | 特性四 | 特性五 | 特性六 | 特性七 | 特性八 |
|--------|--------|--------|--------|--------|--------|--------|--------|
| 表格 | 颜色 | 符号 | 高亮 | 公式 | 图表 | 主题 | 大纲 |
| �?| �?| �?| �?| �?| �?| �?| �?|
