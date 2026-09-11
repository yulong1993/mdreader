# Obsidian 图片链接测试矩阵

## 1. 同目录、无路径：`![[demo.svg]]`

![[demo.svg]]

## 2. 子目录 ASCII 路径：`![[img-tests/pic.png]]`

![[img-tests/pic.png]]

## 3. 子目录中文+空格文件名：`![[img-tests/测试 图.png]]`

![[img-tests/测试 图.png]]

## 4. 裸文件名（图片在子目录）：`![[pic.png]]`

![[pic.png]]

## 5. 带宽度后缀：`![[demo.svg|200]]`

![[demo.svg|200]]

## 6. 标准 Markdown 语法对照：`![alt](img-tests/pic.png)`

![alt](img-tests/pic.png)

## 7. 同目录 PNG 标准语法：`![x](pic2.png)`

![x](pic2.png)

## 8. 子目录 SVG 标准语法：`![y](img-tests/pic.png)` 复用 + 新 svg

![y](img-tests/arrow.svg)

## 9. 子目录换名 PNG：`![[renamed.png]]` 与标准语法对照

![[renamed.png]]

![std](img-tests/renamed.png)

## 10. 二层深目录 PNG：`![[deep/lv2.png]]`

![[deep/lv2.png]]



## 11. 裸名+尺寸：`![[pic.png|64]]`

![[pic.png|64]]
