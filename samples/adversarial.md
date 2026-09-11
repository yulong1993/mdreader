# 对抗性审查测试样本

## 1. Callout 标题重复检查

> [!note] 我是标题我该只出现一次
> 正文内容。

## 2. 自页面标题链接

跳到本页小节：[[#2-自页面标题链接]] （Obsidian 语义：同页跳转）

## 3. 子目录路径式双链

- 无扩展名带路径：[[sub/deep-note]]
- 无扩展名纯名字（子目录自动查找，应能找到）：[[deep-note]]

## 4. 高亮误报检查

在正文中写 `数值判断：5 == 5 并且 3 == 3 成立`（不带反引号的原句，看会不会被误高亮）。

数值判断：5 == 5 并且 3 == 3 成立

## 5. XSS 注入尝试（应全部被拦截）

<style>body { background: url("http://127.0.0.1:19999/css-beacon"); }</style>

<img src="http://127.0.0.1:19999/img-beacon" alt="remote-img">

<script>alert('XSS')</script>

<iframe src="http://127.0.0.1:19999/iframe-beacon"></iframe>

[恶意链接](javascript:alert(1))

<img src="file:///C:/Windows/win.ini" alt="file-leak">

## 6. CSS 信标两种写法

<style>.markdown-body h1 { background: url("http://127.0.0.1:19999/styletag-beacon"); }</style>

<div style="width:2px;height:2px;background:url('http://127.0.0.1:19999/inline-style-beacon')">x</div>

## 7. 超大文件与路径逃逸（仅记录，不实际执行）

![逃逸图](../../../../Windows/win.ini)

