import { invoke, convertFileSrc } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { getCurrentWebview } from "@tauri-apps/api/webview";
import MarkdownIt from "markdown-it";
import taskLists from "markdown-it-task-lists";
import { full as emoji } from "markdown-it-emoji";
import footnote from "markdown-it-footnote";
import anchor from "markdown-it-anchor";
import katexPlugin from "@vscode/markdown-it-katex";
import DOMPurify from "dompurify";
import hljs from "highlight.js/lib/common";

// 亮/暗两套样式以 <style media> 的方式注入，切换主题只改 media 属性
import mdLightCss from "github-markdown-css/github-markdown-light.css?inline";
import mdDarkCss from "github-markdown-css/github-markdown-dark.css?inline";
import hljsLightCss from "highlight.js/styles/github.css?inline";
import hljsDarkCss from "highlight.js/styles/github-dark.css?inline";
import "katex/dist/katex.min.css";
import "./styles.css";

/* ---------------------------------- 主题 ---------------------------------- */

const stylePairs = [
  injectStyle(mdLightCss),
  injectStyle(mdDarkCss),
  injectStyle(hljsLightCss),
  injectStyle(hljsDarkCss),
];

function injectStyle(css) {
  const el = document.createElement("style");
  el.textContent = css;
  document.head.appendChild(el);
  return el;
}

const THEME_ORDER = ["auto", "light", "dark"];
const THEME_ICON = { auto: "◐", light: "☀", dark: "🌙" };

function themePref() {
  return localStorage.getItem("mdr-theme") || "auto";
}

function isDark() {
  return (
    themePref() === "dark" ||
    (themePref() === "auto" &&
      window.matchMedia("(prefers-color-scheme: dark)").matches)
  );
}

function applyTheme() {
  const pref = themePref();
  const media = {
    auto: "(prefers-color-scheme: dark)",
    dark: "all",
    light: "not all",
  };
  // [light-md, dark-md, light-hljs, dark-hljs]：暗色主题命中时亮色置为 not all
  const darkMedia = media[pref];
  const lightMedia =
    pref === "auto"
      ? "(prefers-color-scheme: light)"
      : darkMedia === "all"
      ? "not all"
      : "all";
  stylePairs[0].media = lightMedia;
  stylePairs[2].media = lightMedia;
  stylePairs[1].media = darkMedia;
  stylePairs[3].media = darkMedia;
  document.documentElement.dataset.theme = isDark() ? "dark" : "light";
  document.querySelector("#btn-theme").textContent = THEME_ICON[pref];
}

window
  .matchMedia("(prefers-color-scheme: dark)")
  .addEventListener("change", () => {
    if (themePref() === "auto") {
      applyTheme();
      rerender();
    }
  });

/* ---------------------------- Obsidian 扩展语法 ---------------------------- */

const MEDIA_EXT = {
  image: ["png", "jpg", "jpeg", "gif", "svg", "webp", "bmp", "ico", "avif"],
  audio: ["mp3", "wav", "ogg", "m4a", "flac", "aac"],
  video: ["mp4", "webm", "mov", "mkv"],
};

function mediaKind(name) {
  const ext = name.split(".").pop().toLowerCase();
  for (const [kind, exts] of Object.entries(MEDIA_EXT)) {
    if (exts.includes(ext)) return kind;
  }
  return null;
}

function escapeAttr(s) {
  return s.replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;");
}

/** `file#heading|alias` → { file, heading, alias } */
function splitWikiTarget(raw) {
  let target = raw;
  let alias = "";
  const bar = target.indexOf("|");
  if (bar >= 0) {
    alias = target.slice(bar + 1).trim();
    target = target.slice(0, bar);
  }
  let heading = "";
  const hash = target.indexOf("#");
  if (hash >= 0) {
    heading = target.slice(hash + 1).trim();
    target = target.slice(0, hash);
  }
  return { file: target.trim(), heading, alias };
}

function pushWikiLink(state, file, heading, label) {
  const open = state.push("link_open", "a", 1);
  open.attrSet("href", "#");
  open.attrSet("data-wikilink", file + (heading ? `#${heading}` : ""));
  open.attrSet("class", "wikilink");
  const text = state.push("text", "", 0);
  text.content = label;
  state.push("link_close", "a", -1);
}

/**
 * 注册 Obsidian 行内语法：[[wikilink]]、![[嵌入]]、==高亮==、%%注释%%、#标签
 */
function obsidianInline(md) {
  md.inline.ruler.before("link", "obsidian_wikilink", (state, silent) => {
    const src = state.src;
    const pos = state.pos;
    let embed = false;
    let p = pos;
    if (src[p] === "!") {
      embed = true;
      p++;
    }
    if (src[p] !== "[" || src[p + 1] !== "[") return false;
    const end = src.indexOf("]]", p + 2);
    if (end < 0 || end > state.posMax) return false;
    const inner = src.slice(p + 2, end);
    if (!inner.trim() || /[[\]\n]/.test(inner)) return false;
    if (silent) return true;

    state.pos = end + 2;
    const { file, heading, alias } = splitWikiTarget(inner);
    const baseName = file.split(/[\\/]/).pop() || file;
    const label =
      alias || (heading ? `${baseName} > ${heading}` : baseName || heading);

    if (embed) {
      const kind = mediaKind(file);
      if (kind === "image") {
        const tok = state.push("image", "img", 0);
        tok.attrSet("src", "data:,"); // 占位，稍后由 DOM 解析 pass 填充
        tok.attrSet("data-wikisrc", file);
        tok.attrSet("alt", label);
        tok.children = [];
      } else if (kind === "audio" || kind === "video") {
        const tag = kind === "audio" ? "audio" : "video";
        const style = kind === "video" ? ' style="max-width:100%"' : "";
        const tok = state.push("html_inline", "", 0);
        tok.content = `<${tag} controls preload="metadata" data-wikisrc="${escapeAttr(file)}"${style}></${tag}>`;
      } else {
        // md / pdf 等嵌入 → 链接卡片
        pushWikiLink(state, file, heading, `📎 ${label}`);
      }
    } else {
      pushWikiLink(state, file, heading, label);
    }
    return true;
  });

  md.inline.ruler.before("link", "obsidian_mark", (state, silent) => {
    const src = state.src;
    const pos = state.pos;
    if (src[pos] !== "=" || src[pos + 1] !== "=") return false;
    const end = src.indexOf("==", pos + 2);
    if (end < 0 || end === pos + 2 || src.slice(pos + 2, end).includes("\n"))
      return false;
    // Obsidian 规则：开符后/闭符前必须紧邻非空白，避免把 "5 == 5" 误判为高亮
    if (/[ \t]/.test(src[pos + 2]) || /[ \t]/.test(src[end - 1])) return false;
    if (silent) return true;
    state.pos = end + 2;
    state.push("mark_open", "mark", 1).markup = "==";
    const text = state.push("text", "", 0);
    text.content = src.slice(pos + 2, end);
    state.push("mark_close", "mark", -1).markup = "==";
    return true;
  });

  md.inline.ruler.before("link", "obsidian_comment", (state, silent) => {
    const src = state.src;
    const pos = state.pos;
    if (src[pos] !== "%" || src[pos + 1] !== "%") return false;
    const end = src.indexOf("%%", pos + 2);
    if (end < 0 || src.slice(pos + 2, end).includes("\n")) return false;
    if (silent) return true;
    state.pos = end + 2; // 整段隐藏，不产出 token
    return true;
  });

  md.inline.ruler.after("link", "obsidian_tag", (state, silent) => {
    const src = state.src;
    const pos = state.pos;
    if (src[pos] !== "#") return false;
    if (pos > 0 && !/[\s(（"“'‘\[]/.test(src[pos - 1])) return false;
    const m = /^#([\p{L}\p{N}][\p{L}\p{N}_\-/]*)/u.exec(src.slice(pos));
    if (!m) return false;
    if (silent) return true;
    state.pos = pos + m[0].length;
    const tok = state.push("html_inline", "", 0);
    tok.content = `<span class="md-tag">${escapeAttr(m[0])}</span>`;
    return true;
  });
}

/* --------------------------- Obsidian Callout（DOM 后处理） --------------------------- */

// 覆盖 Obsidian 14 种类型 + GitHub 的 IMPORTANT/CAUTION（统一由 transformCallouts 渲染）
const CALLOUTS = {
  note: "📝", info: "ℹ️", abstract: "📋", todo: "☑️", tip: "💡",
  success: "✅", question: "❓", warning: "⚠️", failure: "❌",
  danger: "🔥", bug: "🐞", example: "🧪", quote: "❝", cite: "❝",
  important: "❗", caution: "⛔",
};

/**
 * 在第一个软换行处把 callout 首段切成「标题行 / 正文」：
 * 标题行（可能含行内元素）收敛为纯文本返回并从 DOM 移除，正文保留在段落里。
 */
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
  return title.trim(); // 整段都是标题行
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

    // 去掉标记，再按首个软换行切出标题行（标题不吞正文）
    firstNode.data = firstNode.data.slice(m[0].length);
    const title = extractCalloutTitle(firstP);
    if (!firstP.childNodes.length) firstP.remove();

    bq.classList.add("obsidian-callout", `oc-${type}`);
    const head = document.createElement("div");
    head.className = "oc-title";
    const icon = document.createElement("span");
    icon.className = "oc-icon";
    icon.textContent = CALLOUTS[type];
    const titleEl = document.createElement("span");
    titleEl.className = "oc-title-text";
    titleEl.textContent = title || type[0].toUpperCase() + type.slice(1);
    head.append(icon, titleEl);
    bq.prepend(head);

    if (fold) {
      bq.classList.add("oc-foldable", fold === "-" ? "oc-collapsed" : "oc-open");
      const body = document.createElement("div");
      body.className = "oc-body";
      while (head.nextSibling) body.append(head.nextSibling);
      bq.append(body);
      if (fold === "-") body.hidden = true;
    }
  }
}

/** 解析 wikilink 目标为可导航/可显示的资源（相对路径 + 子目录查找） */
async function resolveWikiAssets(container, baseDir) {
  const nodes = container.querySelectorAll(
    "[data-wikilink], img[data-wikisrc], audio[data-wikisrc], video[data-wikisrc]"
  );
  await Promise.all(
    [...nodes].map(async (el) => {
      const raw = el.dataset.wikilink ?? el.dataset.wikisrc;
      if (!raw) return;
      const { file, heading } = splitWikiTarget(raw);
      if (el.tagName === "A") {
        if (!file && heading) {
          // [[#标题]]：同页跳转
          el.setAttribute("href", "#" + heading);
          el.dataset.resolved = "1";
          el.dataset.wikiself = "1";
          return;
        }
        let path = null;
        if (/\.(md|markdown|mdown|mkd)$/i.test(file)) {
          path = await invoke("resolve_path", { baseDir, relative: file }).catch(() => null);
        }
        if (!path && file) {
          // 无扩展名：先按相对路径补 .md（覆盖 sub/name 写法），再子目录递归查找
          path = await invoke("resolve_path", { baseDir, relative: file + ".md" }).catch(() => null);
        }
        if (!path && file) {
          path = await invoke("find_wiki_target", { baseDir, name: file }).catch(() => null);
        }
        if (path) {
          el.setAttribute("href", path + (heading ? `#${heading}` : ""));
          el.dataset.resolved = "1";
        } else {
          el.classList.add("wikilink-missing");
        }
      } else {
        const abs = await invoke("resolve_path", { baseDir, relative: file }).catch(() => null);
        if (abs) el.setAttribute("src", convertFileSrc(abs));
      }
    })
  );
}

/* --------------------------------- 渲染管线 -------------------------------- */

// GitHub 风格 slug：保留中日韩文字，便于大纲可读
function slugify(s) {
  return s
    .trim()
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s-]/gu, "")
    .replace(/\s+/g, "-");
}

const md = new MarkdownIt({
  html: true,
  linkify: true,
  highlight(str, lang) {
    const language = lang?.trim().split(/\s+/)[0];
    if (language && hljs.getLanguage(language)) {
      try {
        return hljs.highlight(str, { language, ignoreIllegals: true }).value;
      } catch {
        /* 回退到默认转义 */
      }
    }
    return "";
  },
})
  .use(obsidianInline)
  .use(taskLists, { enabled: false, label: true })
  .use(emoji)
  .use(footnote)
  .use(anchor, { slugify, level: [1, 2, 3, 4, 5, 6] })
  .use(katexPlugin);

const SANITIZE_CONFIG = {
  ADD_TAGS: ["style"],
  ADD_ATTR: ["style", "target", "checked", "disabled", "align", "start", "controls", "preload"],
  ALLOW_DATA_ATTR: true,
};

function stripFrontmatter(source) {
  const m = source.match(/^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/);
  return m ? source.slice(m[0].length) : source;
}

/** 把相对图片路径改写为 asset 协议 URL（渲染是同步的，所以先解析 token 再渲染） */
async function rewriteImages(tokens, baseDir) {
  const jobs = [];
  const isRemote = (src) => /^[a-z][a-z0-9+.-]*:/i.test(src) || src.startsWith("//");
  const isAbsoluteWin = (src) => /^[a-z]:[\\/]/i.test(src) || src.startsWith("\\\\") || src.startsWith("/");
  const walk = (toks) => {
    for (const t of toks) {
      if (!t.children) continue;
      for (const c of t.children) {
        if (c.type !== "image" || c.attrGet("data-wikisrc")) continue;
        const src = c.attrGet("src");
        if (!src || isRemote(src)) continue;
        // 仅图片/音视频扩展名允许走 asset 协议，防止任意本地文件被读取
        if (!mediaKind(src.split(/[?#]/)[0])) continue;
        if (isAbsoluteWin(src)) {
          c.attrSet("src", convertFileSrc(src));
        } else {
          jobs.push(
            invoke("resolve_path", { baseDir, relative: src })
              .then((abs) => c.attrSet("src", convertFileSrc(abs)))
              .catch(() => {})
          );
        }
      }
    }
  };
  walk(tokens);
  await Promise.all(jobs);
}

/* ---------------------------------- 状态 ---------------------------------- */

const els = {
  fileName: document.querySelector("#file-name"),
  welcome: document.querySelector("#welcome"),
  content: document.querySelector("#content"),
  contentWrap: document.querySelector("#content-wrap"),
  outline: document.querySelector("#outline"),
};

let currentPath = null;
let currentDir = null;
let currentSource = null;
let mermaidModule = null;
let renderSeq = 0; // 丢弃过期渲染，避免快速切换文件时旧内容覆盖新内容
let openSeq = 0;

/* --------------------------------- 文档渲染 -------------------------------- */

async function renderDoc(source) {
  const seq = ++renderSeq;
  currentSource = source;
  const body = stripFrontmatter(source);

  const tokens = md.parse(body, {});
  if (currentDir) await rewriteImages(tokens, currentDir);
  if (seq !== renderSeq) return;

  const html = DOMPurify.sanitize(
    md.renderer.render(tokens, md.options, {}),
    SANITIZE_CONFIG
  );

  els.welcome.hidden = true;
  els.content.hidden = false;
  els.content.innerHTML = html;

  transformCallouts(els.content);
  if (currentDir) await resolveWikiAssets(els.content, currentDir);
  await renderMermaidBlocks();
  buildOutline();
}

async function renderMermaidBlocks() {
  const blocks = [
    ...els.content.querySelectorAll(
      "pre > code.language-mermaid, pre > code.lang-mermaid"
    ),
  ];
  if (!blocks.length) return;
  if (!mermaidModule) {
    mermaidModule = (await import("mermaid")).default;
  }
  mermaidModule.initialize({
    startOnLoad: false,
    securityLevel: "strict",
    theme: isDark() ? "dark" : "default",
  });
  for (const [i, code] of blocks.entries()) {
    try {
      const { svg } = await mermaidModule.render(
        `mmd-${Date.now()}-${i}`,
        code.textContent
      );
      const div = document.createElement("div");
      div.className = "mermaid-figure";
      // mermaid 输出同样过一遍消毒，避免渲染器漏洞成为 XSS 旁路。
      // foreignObject（mermaid 节点文字都放在里面）需三重放行：
      // 1) ADD_TAGS 允许标签本身（默认在 svgDisallowed 名单）
      // 2) HTML_INTEGRATION_POINTS 允许其内的 HTML 子元素（默认表只认 annotation-xml，
      //    3.4.15 起 HTML 元素出现在未列入集成点的 SVG 父节点下会被判命名空间非法而删除）
      // 内部 HTML（div/span 等）仍走正常允许名单与属性清洗，script/on* 一律剥离
      div.innerHTML = DOMPurify.sanitize(svg, {
        ADD_TAGS: ["foreignObject"],
        HTML_INTEGRATION_POINTS: { foreignobject: true },
        ADD_ATTR: ["marker-end", "viewBox", "startoffset", "baseline-shift", "xmlns"],
      });
      code.parentElement.replaceWith(div);
    } catch {
      code.parentElement.classList.add("mermaid-error");
    }
  }
}

function rerender() {
  if (currentSource != null) {
    const scrollTop = els.contentWrap.scrollTop;
    renderDoc(currentSource).finally(() => {
      els.contentWrap.scrollTop = scrollTop;
    });
  }
}

/* ---------------------------------- 大纲 ---------------------------------- */

function buildOutline() {
  const headings = [...els.content.querySelectorAll("h1,h2,h3,h4,h5,h6")].filter(
    (h) => h.id
  );
  els.outline.innerHTML = "";
  for (const h of headings) {
    const a = document.createElement("a");
    a.href = "#";
    a.className = `lvl-${h.tagName[1]}`;
    a.textContent = h.textContent;
    a.title = h.textContent;
    a.addEventListener("click", (e) => {
      e.preventDefault();
      h.scrollIntoView({ behavior: "smooth", block: "start" });
    });
    els.outline.appendChild(a);
  }
  els.outline.hidden = headings.length === 0 || !outlineVisible();
}

let outlineVisible = () => localStorage.getItem("mdr-outline") !== "hidden";

/* --------------------------------- 打开文件 -------------------------------- */

function basename(p) {
  return p.replace(/[\\/]+$/, "").split(/[\\/]/).pop() || p;
}
function dirname(p) {
  const parts = p.replace(/[\\/]+$/, "").split(/[\\/]/);
  parts.pop();
  return parts.join("\\") || ".";
}

/** 打开文件；focusHeading 可选，渲染后滚动到对应标题 */
async function openFile(path, focusHeading) {
  const seq = ++openSeq;
  const source = await invoke("read_file", { path });
  if (seq !== openSeq) return; // 已有更新的打开请求
  currentPath = path;
  currentDir = dirname(path);
  els.fileName.textContent = basename(path);
  els.fileName.title = path;
  document.title = `${basename(path)} - MD Reader`;
  invoke("watch_file", { path }).catch((e) => console.error("watch failed:", e));
  await renderDoc(source);
  if (focusHeading) {
    scrollToHeading(focusHeading);
  }
}

function scrollToHeading(heading) {
  const target =
    document.getElementById(heading) ||
    document.getElementById(slugify(heading)) ||
    [...els.content.querySelectorAll("h1,h2,h3,h4,h5,h6")].find((h) =>
      h.textContent.trim() === heading
    );
  target?.scrollIntoView({ behavior: "smooth", block: "start" });
}

async function pickFile() {
  const path = await invoke("plugin:dialog|open", {
    options: {
      multiple: false,
      directory: false,
      title: "打开 Markdown 文件",
      filters: [{ name: "Markdown", extensions: ["md", "markdown", "mdown", "mkd"] }],
    },
  });
  if (path) await openFile(path);
}

/* --------------------------------- 事件绑定 -------------------------------- */

document.querySelector("#btn-open").addEventListener("click", pickFile);

document.querySelector("#btn-pdf").addEventListener("click", () => window.print());

document.querySelector("#btn-theme").addEventListener("click", () => {
  const next =
    THEME_ORDER[(THEME_ORDER.indexOf(themePref()) + 1) % THEME_ORDER.length];
  localStorage.setItem("mdr-theme", next);
  applyTheme();
  rerender();
});

document.querySelector("#btn-outline").addEventListener("click", () => {
  localStorage.setItem("mdr-outline", outlineVisible() ? "hidden" : "visible");
  els.outline.hidden = !outlineVisible() || !els.outline.childElementCount;
});

document.addEventListener("keydown", (e) => {
  if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "o") {
    e.preventDefault();
    pickFile();
  }
  if ((e.ctrlKey || e.metaKey) && e.key === "\\") {
    e.preventDefault();
    document.querySelector("#btn-outline").click();
  }
  if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "p") {
    e.preventDefault();
    window.print();
  }
});

// 内容区点击：callout 折叠 / wikilink / 锚点 / 外链 / 相对 .md
els.content.addEventListener("click", (e) => {
  const calloutHead = e.target.closest(".obsidian-callout.oc-foldable > .oc-title");
  if (calloutHead) {
    const body = calloutHead.parentElement.querySelector(":scope > .oc-body");
    if (body) body.hidden = !body.hidden;
    return;
  }

  const a = e.target.closest("a");
  if (!a) return;

  // Obsidian wikilink：data-wikilink 标记，href 为绝对路径（可带 #标题）
  if (a.dataset.wikilink) {
    e.preventDefault();
    if (!a.dataset.resolved) return;
    if (a.dataset.wikiself) {
      // [[#标题]]：页内跳转
      const href = a.getAttribute("href") || "";
      scrollToHeading(decodeURIComponent(href.replace(/^#/, "")));
      return;
    }
    const href = a.getAttribute("href") || "";
    const hash = href.indexOf("#");
    const path = hash >= 0 ? href.slice(0, hash) : href;
    const heading = hash >= 0 ? decodeURIComponent(href.slice(hash + 1)) : "";
    if (path) openFile(path, heading).catch(console.error);
    return;
  }

  const href = a.getAttribute("href") || "";
  if (href.startsWith("#")) {
    e.preventDefault();
    const target = document.getElementById(decodeURIComponent(href.slice(1)));
    target?.scrollIntoView({ behavior: "smooth", block: "start" });
  } else if (/^(https?|mailto):/i.test(href)) {
    e.preventDefault();
    invoke("plugin:opener|open_url", { url: href }).catch(console.error);
  } else if (/\.(md|markdown|mdown|mkd)$/i.test(href) && currentDir) {
    e.preventDefault();
    invoke("resolve_path", { baseDir: currentDir, relative: href })
      .then(openFile)
      .catch(console.error);
  }
});

// 拖拽 .md 到窗口打开（非文本类文件忽略）
getCurrentWebview().onDragDropEvent((event) => {
  const p = event.payload;
  if (p.type === "drop" && p.paths?.length) {
    const file = p.paths.find((x) => /\.(md|markdown|mdown|mkd|txt)$/i.test(x));
    if (file) openFile(file).catch((err) => alert(`打开失败：${err}`));
  }
});

// 文件保存后自动刷新（保持滚动位置）
listen("fs-changed", async (e) => {
  if (e.payload !== currentPath) return;
  const scrollTop = els.contentWrap.scrollTop;
  try {
    const source = await invoke("read_file", { path: currentPath });
    await renderDoc(source);
    els.contentWrap.scrollTop = scrollTop;
  } catch {
    /* 编辑器保存过程中的瞬时不可读，忽略 */
  }
});

// 已有实例被再次唤起（双击 .md 等）：在当前窗口打开新文件；同文件则重新读取
listen("open-file", (e) => {
  if (e.payload) {
    openFile(e.payload).catch((err) => console.error("open-file failed:", err));
  }
});

/* --------------------------------- 启动 ---------------------------------- */

applyTheme();
invoke("initial_path")
  .then((path) => {
    if (path) return openFile(path);
  })
  .catch(console.error);
