// 完整复刻应用内管线：markdown-it(全部插件) -> DOMPurify -> transformCallouts
// 验证 callout 标题是否吞掉正文 / 是否重复
import MarkdownIt from "markdown-it";
import taskLists from "markdown-it-task-lists";
import { full as emoji } from "markdown-it-emoji";
import footnote from "markdown-it-footnote";
import anchor from "markdown-it-anchor";
import createDOMPurify from "dompurify";
import { JSDOM } from "jsdom";

const window = new JSDOM("").window;
const DOMPurify = createDOMPurify(window);

function slugify(s) {
  return s.trim().toLowerCase()
    .replace(/[^\p{L}\p{N}\s-]/gu, "")
    .replace(/\s+/g, "-");
}

const md = new MarkdownIt({ html: true, linkify: true, highlight: () => "" })
  .use(taskLists, { enabled: false, label: true })
  .use(emoji)
  .use(footnote)
  .use(anchor, { slugify, level: [1, 2, 3, 4, 5, 6] });

const SANITIZE_CONFIG = {
  ADD_TAGS: ["style"],
  ADD_ATTR: ["style", "target", "checked", "disabled", "align", "start", "controls", "preload"],
  ALLOW_DATA_ATTR: true,
};

const CALLOUTS = {
  note: "📝", info: "ℹ️", abstract: "📋", todo: "☑️", tip: "💡",
  success: "✅", question: "❓", warning: "⚠️", failure: "❌",
  danger: "🔥", bug: "🐞", example: "🧪", quote: "❝", cite: "❝",
  important: "❗", caution: "⛔",
};

// ↓↓↓ 与 src/main.js 新版逐行一致 ↓↓↓
function extractCalloutTitle(p) {
  let title = "";
  for (const node of [...p.childNodes]) {
    if (node.nodeType === Node.TEXT_NODE && node.data.includes("\n")) {
      const idx = node.data.indexOf("\n");
      title += node.data.slice(0, idx);
      node.data = node.data.slice(idx + 1);
      return title.trim();
    }
    title += node.textContent;
    node.remove();
  }
  return title.trim();
}

function transformCallouts(root) {
  for (const bq of root.querySelectorAll("blockquote")) {
    const firstP = bq.querySelector(":scope > p");
    const firstNode = firstP?.firstChild;
    if (!firstNode || firstNode.nodeType !== Node.TEXT_NODE) continue;
    const m = firstNode.data.match(/^\[!(\w+)\]([+-])?[ \t]*/);
    if (!m) continue;
    const type = m[1].toLowerCase();
    if (!CALLOUTS[type]) continue;
    const fold = m[2] || "";

    firstNode.data = firstNode.data.slice(m[0].length);
    const title = extractCalloutTitle(firstP);
    if (!firstP.childNodes.length) firstP.remove();

    bq.classList.add("obsidian-callout", `oc-${type}`);
    const head = window.document.createElement("div");
    head.className = "oc-title";
    const icon = window.document.createElement("span");
    icon.className = "oc-icon";
    icon.textContent = CALLOUTS[type];
    const titleEl = window.document.createElement("span");
    titleEl.className = "oc-title-text";
    titleEl.textContent = title || type[0].toUpperCase() + type.slice(1);
    head.append(icon, titleEl);
    bq.prepend(head);

    if (fold) {
      bq.classList.add("obsidian-callout", "oc-foldable", fold === "-" ? "oc-collapsed" : "oc-open");
      const body = window.document.createElement("div");
      body.className = "oc-body";
      while (head.nextSibling) body.append(head.nextSibling);
      bq.append(body);
      if (fold === "-") body.hidden = true;
    }
  }
}

const cases = [
  "> [!note] 已知类型带标题\n> 已知类型的正文",
  "> [!warning]- 已知类型折叠标记\n> 折叠正文",
  "> [!bug] 未知类型的标题\n> 未知类型的正文",
  "> [!important] GitHub 的 important 类型\n> important 正文",
  "> [!caution]+ GitHub 的 caution 类型\n> caution 正文",
  "> [!note] **粗体标题**与行内元素\n> 正文",
];

for (const src of cases) {
  console.log("======== 源:", JSON.stringify(src));
  const html = DOMPurify.sanitize(md.render(src), SANITIZE_CONFIG);
  console.log("--- sanitize 后 ---");
  console.log(html);
  const doc = new JSDOM(`<div id="c">${html}</div>`).window.document;
  // jsdom 里 Node.TEXT_NODE 可用 doc.defaultView.Node；transformCallouts 用的是全局 Node —— 绑定
  globalThis.Node = doc.defaultView.Node;
  transformCallouts(doc.getElementById("c"));
  console.log("--- transform 后 ---");
  console.log(doc.getElementById("c").innerHTML.replace(/></g, ">\n<"));
  console.log();
}
