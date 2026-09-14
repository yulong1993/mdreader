import { invoke, convertFileSrc } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { getCurrentWebview } from "@tauri-apps/api/webview";
import { getCurrentWindow } from "@tauri-apps/api/window";
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

/** 链接目标中的百分号编码还原为文件系统路径（%20→空格等）；非法编码原样返回 */
function fsPath(p) {
  try {
    return decodeURIComponent(p);
  } catch {
    return p;
  }
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
        // Obsidian 尺寸语法：|200 或 |100x200 → width/height；其余作为 alt 文本
        const size = /^\s*(\d+)(?:x(\d+))?\s*$/.exec(alias);
        if (size) {
          tok.attrSet("width", size[1]);
          if (size[2]) tok.attrSet("height", size[2]);
          tok.attrSet("alt", label === alias ? file : label);
        } else {
          tok.attrSet("alt", label);
        }
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
          el.dataset.wikiheading = heading;
          el.dataset.resolved = "1";
          el.dataset.wikiself = "1";
          return;
        }
        let path = null;
        if (/\.(md|markdown|mdown|mkd)$/i.test(file)) {
          path = await resolveRel(baseDir, fsPath(file));
        }
        if (!path && file) {
          // 无扩展名：先按相对路径补 .md（覆盖 sub/name 写法），再子目录递归查找
          path = await resolveRel(baseDir, fsPath(file) + ".md");
        }
        if (!path && file) {
          path = await invoke("find_wiki_target", { baseDir, name: file }).catch(() => null);
        }
        if (path) {
          // 路径与标题分别存：文件名或标题里的 # 不再影响点击解析
          el.dataset.wikipath = path;
          el.dataset.wikiheading = heading;
          el.setAttribute("href", path + (heading ? `#${heading}` : ""));
          el.dataset.resolved = "1";
        } else {
          el.classList.add("wikilink-missing");
        }
      } else {
        // 图片/音视频嵌入：先按相对路径解析；Obsidian 语义下图片常在库内
        // 其他目录（如 attachments/），找不到时按文件名递归查找（≤3 层）
        let abs = await resolveRel(baseDir, fsPath(file));
        if (!abs && file && !file.includes("/") && !file.includes("\\")) {
          abs = await invoke("find_wiki_target", { baseDir, name: file }).catch(() => null);
        }
        if (abs) {
          el.setAttribute("src", convertFileSrc(abs));
        } else {
          el.classList.add("wikilink-missing");
        }
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
          c.attrSet("src", convertFileSrc(fsPath(src)));
        } else {
          jobs.push(
            resolveRel(baseDir, fsPath(src))
              .then((abs) => {
                if (abs) c.attrSet("src", convertFileSrc(abs));
              })
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
  previewPane: document.querySelector("#preview-pane"),
  outline: document.querySelector("#outline"),
};

let currentPath = null;
let currentDir = null;
let currentSource = null;
let mermaidModule = null;
let renderSeq = 0; // 丢弃过期渲染，避免快速切换文件时旧内容覆盖新内容
let openSeq = 0;

/* ------------------------- 实时编辑（块级，Obsidian 式） ------------------------- */
// 渲染视图里点击一个顶层块（段落/标题/列表/表格/代码块…），该块就地变成源码编辑框；
// 提交后立即渲染回所见即所得形态。块的源码行区间来自 markdown-it 的 token.map。

let editing = false; // 编辑模式开关（Ctrl+E）
let editorDirty = false; // 自上次保存后是否有修改
let suppressFsOnce = false; // 自己保存触发的 fs-changed 不再回灌
let blockRuns = []; // 顶层块列表：{ s, e } 源码绝对行区间（含 frontmatter 偏移），{ ts, te } token 区间
let activeBlockEdit = null; // 正在编辑的块 { ta, j, s, e, orig, origEl }
let pendingOpenBlockIdx = null; // 提交当前块后要接着打开的块（块间跳转用）

/* --------------------------------- 路径解析缓存 -------------------------------- */

// 缓存 Promise；失败不缓存以便重试
const resolveCache = new Map();
function resolveRel(baseDir, relative) {
  const key = baseDir + "\u0000" + relative;
  if (resolveCache.has(key)) return resolveCache.get(key);
  const p = invoke("resolve_path", { baseDir, relative })
    .then((r) => {
      if (r == null) resolveCache.delete(key);
      return r;
    })
    .catch(() => {
      resolveCache.delete(key);
      return null;
    });
  resolveCache.set(key, p);
  return p;
}

function updateDirtyHint() {
  const name = currentPath ? basename(currentPath) : "未打开文件";
  els.fileName.textContent = editorDirty ? `${name} ●未保存` : name;
  els.fileName.title = currentPath || "";
  document.title = `${editorDirty ? "● " : ""}${currentPath ? basename(currentPath) : "MD Reader"} - MD Reader`;
}

function setEditing(on) {
  if (on && !currentPath) return; // 未打开文档不可编辑
  if (on === editing) return;
  if (!on) commitActiveBlock(); // 退出编辑前先落定当前块
  editing = on;
  document.body.classList.toggle("editing", on);
  document.querySelector("#btn-edit").textContent = on ? "👁 预览" : "✏️ 编辑";
}

/** 把正在编辑的块内容合入源码（纯数据操作；内容区由随后的重渲染重建） */
function absorbActiveBlock(source) {
  const ed = activeBlockEdit;
  if (!ed) return source;
  activeBlockEdit = null;
  const norm = (s) => s.replace(/\r?\n/g, "\n");
  let val = ed.ta.value;
  if (norm(val) === norm(ed.orig)) return source;
  // textarea 会把 \r\n 归一成 \n，CRLF 文档写回时还原行尾
  if (source.includes("\r\n")) val = val.replace(/\r?\n/g, "\r\n");
  const lines = source.split("\n");
  if (val.trim() === "") lines.splice(ed.s, ed.e - ed.s); // 清空整个块 = 删除该块
  else lines.splice(ed.s, ed.e - ed.s, ...val.split("\n"));
  editorDirty = true;
  updateDirtyHint();
  return lines.join("\n");
}

/** 结束当前块的编辑：无变化就地把原渲染元素换回；有变化则合入源码并重渲染。
 *  @returns {Promise|null} 有变化时返回渲染完成的 Promise（打印等场景需要等待） */
function commitActiveBlock() {
  const ed = activeBlockEdit;
  if (!ed) return null;
  const norm = (s) => s.replace(/\r?\n/g, "\n");
  if (norm(ed.ta.value) === norm(ed.orig)) {
    ed.ta.replaceWith(ed.origEl);
    activeBlockEdit = null;
    if (pendingOpenBlockIdx != null) {
      const j = pendingOpenBlockIdx;
      pendingOpenBlockIdx = null;
      openBlockEdit(j);
    }
    return null;
  }
  currentSource = absorbActiveBlock(currentSource);
  return renderDoc(currentSource).then(() => {
    els.content.querySelector(`[data-blk="${ed.j}"]`)?.scrollIntoView({ block: "nearest" });
  });
}

function cancelActiveBlock() {
  const ed = activeBlockEdit;
  if (!ed) return;
  activeBlockEdit = null;
  ed.ta.replaceWith(ed.origEl);
}

function autoGrow(ta) {
  ta.style.height = "auto";
  ta.style.height = `${ta.scrollHeight}px`;
}

/** 第 j 个顶层块就地变成源码编辑框 */
function openBlockEdit(j) {
  const run = blockRuns[j];
  if (!run) return;
  const el = els.content.querySelector(`#content > [data-blk="${j}"]`);
  if (!el) return;
  const src = currentSource.split("\n").slice(run.s, run.e).join("\n");
  const ta = document.createElement("textarea");
  ta.className = "block-editor";
  ta.spellcheck = false;
  ta.value = src;
  activeBlockEdit = { ta, j, s: run.s, e: run.e, orig: src, origEl: el };
  el.replaceWith(ta);
  autoGrow(ta);
  ta.focus();
  ta.setSelectionRange(0, 0);
  ta.addEventListener("input", () => autoGrow(ta));
  ta.addEventListener("keydown", onBlockKeydown);
  ta.addEventListener("blur", onBlockBlur);
}

function onBlockKeydown(e) {
  if (!activeBlockEdit) return;
  if (e.key === "Escape") {
    e.preventDefault();
    cancelActiveBlock(); // 放弃本块的修改
  } else if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) {
    e.preventDefault();
    commitActiveBlock(); // Ctrl+Enter 提交
  } else if (e.key === "Tab") {
    e.preventDefault();
    const { selectionStart: a, selectionEnd: b } = e.target;
    e.target.setRangeText("  ", a, b, "end");
    autoGrow(e.target);
  }
}

// 切到其他应用（relatedTarget 为 null）不打断编辑；点到应用内其他位置则先落定
function onBlockBlur(e) {
  if (activeBlockEdit && e.relatedTarget !== null) commitActiveBlock();
}

// 点到应用内任意位置：正编辑某块时先落定；编辑模式下点到另一个块，落定后接着打开那块
document.addEventListener(
  "mousedown",
  (e) => {
    if (!activeBlockEdit || !e.target.closest) return;
    if (e.target.closest(".block-editor")) return;
    const blk = e.target.closest("#content > [data-blk]");
    if (editing && blk && !e.target.closest("a")) {
      e.preventDefault(); // 焦点与选区交给接下来的块编辑流程（链接点击除外——链接走导航）
      pendingOpenBlockIdx = +blk.dataset.blk;
    }
    commitActiveBlock();
  },
  true
);

// 编辑模式下点击块进入编辑；链接点击仍走导航（Obsidian 行为）；拖选文字复制时不触发
els.content.addEventListener("click", (e) => {
  if (!editing || activeBlockEdit) return;
  if (e.target.closest(".block-editor")) return;
  if (e.target.closest("a")) return;
  if (window.getSelection().toString()) return;
  const blk = e.target.closest("#content > [data-blk]");
  if (blk) {
    e.stopImmediatePropagation(); // 块编辑优先于折叠等原有交互
    openBlockEdit(+blk.dataset.blk);
  }
});

// 双击任意块：无需 Ctrl+E，直接进入编辑模式并打开该块
els.content.addEventListener("dblclick", (e) => {
  if (e.target.closest("a") || e.target.closest(".block-editor")) return;
  const blk = e.target.closest("#content > [data-blk]");
  if (!blk) return;
  if (!editing) setEditing(true);
  if (!activeBlockEdit) openBlockEdit(+blk.dataset.blk);
});

// 点击内容区空白处（不属于任何块/链接/编辑框）：落定修改并退出编辑模式
els.previewPane.addEventListener("click", (e) => {
  if (!editing) return;
  if (
    e.target.closest("#content > [data-blk]") ||
    e.target.closest(".block-editor") ||
    e.target.closest("a")
  ) {
    return;
  }
  setEditing(false); // setEditing 内部会先落定当前块
});

/** @returns {Promise<boolean>} 是否保存成功（无待保存修改视为成功） */
async function saveFile() {
  if (!editing || !currentPath) return true;
  if (activeBlockEdit) {
    // 块内正在编辑的内容先合入源码再落盘（renderDoc 顺带清掉编辑框 DOM）
    currentSource = absorbActiveBlock(currentSource);
    renderDoc(currentSource);
  }
  if (!editorDirty) return true;
  try {
    await invoke("write_file", { path: currentPath, content: currentSource });
    suppressFsOnce = true;
    editorDirty = false;
    updateDirtyHint();
    return true;
  } catch (e) {
    alert(`保存失败：${e}`);
    return false;
  }
}

/** 切换文档前：块内未落定的修改先合入，有未保存修改则自动保存（Obsidian 式）；失败返回 false */
async function confirmSaveBefore() {
  if (editing && activeBlockEdit) currentSource = absorbActiveBlock(currentSource);
  if (editing && editorDirty) return saveFile();
  return true;
}

/**
 * 应用内关闭确认对话框（Office 三按钮式）。不依赖原生对话框——
 * 上版原生 plugin:dialog|ask 在部分环境不返回导致窗口无法关闭。
 * @returns {"save"|"exit"|"cancel"}
 */
function showCloseDialog(fileName) {
  return new Promise((resolve) => {
    const overlay = document.querySelector("#modal-overlay");
    document.querySelector("#dlg-text").textContent =
      `「${fileName}」有未保存的修改，退出前要保存吗？未保存的修改将被丢弃。`;
    overlay.hidden = false;
    const saveBtn = document.querySelector("#dlg-save-exit");

    const done = (val) => {
      overlay.hidden = true;
      cleanup();
      resolve(val);
    };
    const onClick = { "#dlg-save-exit": "save", "#dlg-exit": "exit", "#dlg-cancel": "cancel" };
    const bound = [];
    for (const [sel, val] of Object.entries(onClick)) {
      const el = document.querySelector(sel);
      const fn = () => done(val);
      el.addEventListener("click", fn);
      bound.push([el, fn]);
    }
    const onKey = (e) => {
      e.stopPropagation();
      if (e.key === "Escape") done("cancel");
      else if (e.key === "Enter") done("save");
    };
    const onBackdrop = (e) => {
      if (e.target === overlay) done("cancel");
    };
    overlay.addEventListener("mousedown", onBackdrop);
    document.addEventListener("keydown", onKey, true);
    function cleanup() {
      for (const [el, fn] of bound) el.removeEventListener("click", fn);
      overlay.removeEventListener("mousedown", onBackdrop);
      document.removeEventListener("keydown", onKey, true);
    }
    saveBtn.focus();
  });
}

// 关闭窗口：有未保存修改时弹应用内确认；任何异常都放行关闭，绝不卡死窗口
getCurrentWindow().onCloseRequested(async (event) => {
  try {
    if (editing && activeBlockEdit) {
      // Alt+F4 等键盘关闭路径没有 mousedown，块内未落定的修改先合入
      currentSource = absorbActiveBlock(currentSource);
      renderDoc(currentSource);
    }
    if (!(editing && editorDirty)) return; // 无修改 → 正常关闭
    event.preventDefault();
    if (!document.querySelector("#modal-overlay").hidden) return; // 已在询问中
    const choice = await showCloseDialog(basename(currentPath));
    if (choice === "cancel") return; // 留在当前页面
    if (choice === "save" && !(await saveFile())) return; // 保存失败不退出，留在页面
    await getCurrentWindow().destroy();
  } catch (err) {
    console.error("close guard failed:", err);
    await getCurrentWindow().destroy().catch(() => {});
  }
});

/* --------------------------------- 文档渲染 -------------------------------- */

/** 顶层 token 区段（含无 map 的，如脚注区）：{ mapped, html, ts, te } */
function collectTopRuns(tokens) {
  const runs = [];
  let ts = -1;
  let depth = 0;
  tokens.forEach((t, i) => {
    if (ts < 0) {
      if (t.level !== 0) return;
      ts = i;
    }
    depth += t.nesting;
    if (depth !== 0) return;
    const toks = tokens.slice(ts, i + 1);
    runs.push({
      mapped: !!toks[0].map,
      html: toks.some((x) => x.type === "html_block"),
      ts,
      te: i,
    });
    ts = -1;
  });
  return runs;
}

/** 顶层块的源码行区间（含 frontmatter 偏移），实时编辑据此定位源码 */
function collectBlockRuns(tokens, fmLines) {
  const out = [];
  for (const run of collectTopRuns(tokens)) {
    if (!run.mapped) continue;
    let s = null;
    let e = null;
    for (let i = run.ts; i <= run.te; i++) {
      const m = tokens[i].map;
      if (!m) continue;
      if (s === null || m[0] < s) s = m[0];
      if (e === null || m[1] > e) e = m[1];
    }
    if (s !== null) out.push({ s: fmLines + s, e: fmLines + e, ts: run.ts, te: run.te });
  }
  return out;
}

/** 给 #content 的顶层元素标块号。含原始 HTML 或无行号区段（脚注等）时用
 *  与主渲染同配置的消毒探测计数，并与实际元素数对账；对不上就整体不挂
 *  块号（禁用本轮块编辑）——宁可不可编辑，也不冒"点 A 改 B"的错位风险 */
function attachBlockIndexes(tokens) {
  const kids = els.content.children;
  const top = collectTopRuns(tokens);
  const counts = top.map(() => 1);
  if (top.some((r) => r.html || !r.mapped)) {
    const probe = document.createElement("div");
    top.forEach((run, r) => {
      probe.innerHTML = DOMPurify.sanitize(
        md.renderer.render(tokens.slice(run.ts, run.te + 1), md.options, {}),
        SANITIZE_CONFIG
      );
      counts[r] = probe.children.length;
    });
  }
  if (counts.reduce((a, b) => a + b, 0) !== kids.length) return; // 对账失败：安全降级
  let ki = 0;
  let mappedIdx = 0;
  top.forEach((run, r) => {
    for (let k = 0; k < counts[r]; k++, ki++) {
      if (run.mapped) kids[ki].dataset.blk = String(mappedIdx);
    }
    if (run.mapped) mappedIdx++;
  });
}

async function renderDoc(source) {
  const seq = ++renderSeq;
  if (activeBlockEdit) source = absorbActiveBlock(source); // 重渲染前先合入块内未落定的修改
  currentSource = source;
  const body = stripFrontmatter(source);

  const tokens = md.parse(body, {});
  // 顶层块 → 源码绝对行区间（加 frontmatter 占的行数），实时编辑据此定位源码
  const fmLines = (source.slice(0, source.length - body.length).match(/\n/g) || [])
    .length;
  blockRuns = collectBlockRuns(tokens, fmLines);
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
  attachBlockIndexes(tokens);
  buildOutline();
  if (pendingOpenBlockIdx != null) {
    // 块间跳转：当前块落定重渲染后，接着打开用户点的那块
    const j = pendingOpenBlockIdx;
    pendingOpenBlockIdx = null;
    openBlockEdit(j);
  }
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
    const scrollTop = els.previewPane.scrollTop;
    renderDoc(currentSource).finally(() => {
      els.previewPane.scrollTop = scrollTop;
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
  pendingOpenBlockIdx = null; // 跨文档不保留块跳转意图，避免在新文档误开同号块
  if (!(await confirmSaveBefore())) return; // 自动保存失败：留在当前文档
  let source;
  try {
    source = await invoke("read_file", { path });
  } catch (err) {
    // 三个入口（启动参数/双击关联/Ctrl+O）共用这里，失败必须让用户看见
    alert(`打开「${basename(path)}」失败：${err}`);
    return;
  }
  if (seq !== openSeq) return; // 已有更新的打开请求
  currentPath = path;
  currentDir = dirname(path);
  updateDirtyHint();
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

document.querySelector("#btn-pdf").addEventListener("click", () => {
  const p = commitActiveBlock();
  if (p) p.then(() => window.print());
  else window.print();
});

document.querySelector("#btn-edit").addEventListener("click", () => setEditing(!editing));

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
    const p = commitActiveBlock(); // 键盘打印没有 mousedown，块内修改先落定
    if (p) p.then(() => window.print());
    else window.print();
  }
  if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "e") {
    e.preventDefault();
    setEditing(!editing);
  }
  if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "s") {
    e.preventDefault();
    saveFile();
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
      scrollToHeading(a.dataset.wikiheading || "");
      return;
    }
    const path = a.dataset.wikipath || "";
    const heading = a.dataset.wikiheading || "";
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
    resolveRel(currentDir, fsPath(href)).then((p) => p && openFile(p)).catch(console.error);
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

// 文件保存后自动刷新（保持滚动位置）；编辑模式自写抑制
listen("fs-changed", async (e) => {
  if (e.payload !== currentPath) return;
  resolveCache.clear(); // 磁盘内容变了，相对路径的解析结果不再可信，下次渲染重新解析
  if (suppressFsOnce) {
    suppressFsOnce = false;
    return;
  }
  const scrollTop = els.previewPane.scrollTop;
  try {
    const source = await invoke("read_file", { path: currentPath });
    if (editing && editorDirty) return; // 编辑未保存期间忽略外部变化（用户编辑优先）
    await renderDoc(source);
    if (!editing) els.previewPane.scrollTop = scrollTop;
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
// TEMP-DIAG（截断诊断第二轮，修完删除）：标题周期刷新视口几何，捕捉加载后异步变化
setInterval(() => {
  if (!currentPath) return;
  const d = document.documentElement;
  document.title = `${basename(currentPath)} ·iw=${innerWidth} ih=${innerHeight} dpr=${devicePixelRatio} dw=${d.scrollWidth} dh=${d.scrollHeight}`;
}, 400);
invoke("initial_path")
  .then((path) => {
    if (path) return openFile(path);
  })
  .catch(console.error);
