// 决定性验证：用与前端相同的 markdown-it 配置解析 callout，观察 token/HTML 结构
import MarkdownIt from "markdown-it";

const md = new MarkdownIt({ html: true, linkify: true });

const cases = [
  "> [!note] 我是标题我该只出现一次\n> 正文内容。",
  "> [!note] 标题与正文间无空行的写法\n> 第二行正文\n> 第三行正文",
  "> [!note]\n> 只有正文没有标题",
];

for (const c of cases) {
  console.log("=== 源码 ===");
  console.log(JSON.stringify(c));
  const tokens = md.parse(c, {});
  for (const t of tokens) {
    if (t.type === "inline") {
      console.log(`  ${t.type}: ${JSON.stringify(t.content)}`);
    } else {
      console.log(`  ${t.type}`);
    }
    if (t.children) {
      for (const ch of t.children) {
        console.log(`      child ${ch.type}: ${JSON.stringify(ch.content)}`);
      }
    }
  }
  console.log("--- HTML ---");
  console.log(md.render(c));
  console.log();
}
