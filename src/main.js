import { invoke, convertFileSrc } from "@tauri-apps/api/core";
import { listen, emitTo } from "@tauri-apps/api/event";
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

/* --------------------------------- 标签页 -------------------------------- */

// 多标签：每个窗口持有自己的标签集。currentXxx 全局变量始终是"活跃标签"的活状态，
// 切换标签时序列化回 tab 对象、再从目标 tab 恢复并重渲染。
const WIN_LABEL = getCurrentWindow().label; // Tauri 2：label 是属性不是方法
const tabs = []; // { id, path, source, dirty, scrollY }
let activeTabId = null;
let tabIdSeq = 0;
let dragState = null; // 标签拖拽上下文 { id, startX, startY, started }

function normalizePath(p) {
  return String(p).replace(/^\\\\\?\\/, "").replace(/\//g, "\\").toLowerCase();
}
function samePath(a, b) {
  return normalizePath(a) === normalizePath(b);
}
function sessionKey() {
  return `mdr-session:${WIN_LABEL}`;
}

/** 活跃标签的状态（含块编辑框内未落定的修改）序列化回 tab 对象 */
function snapshotActiveTab() {
  const t = tabs.find((x) => x.id === activeTabId);
  if (!t) return;
  if (activeBlockEdit) currentSource = absorbActiveBlock(currentSource);
  t.source = currentSource;
  t.dirty = editorDirty;
  t.scrollY = els.previewPane.scrollTop;
}

/** 强制退出编辑态（不弹 UI）：块内容已由调用方 absorb */
function forceExitEditState() {
  editing = false;
  activeBlockEdit = null;
  pendingOpenBlockIdx = null;
  document.body.classList.remove("editing");
  document.querySelector("#btn-edit").textContent = "✏️ 编辑";
}

async function activateTab(id, focusHeading) {
  const t = tabs.find((x) => x.id === id);
  if (!t) return;
  snapshotActiveTab();
  activeTabId = t.id;
  currentPath = t.path;
  currentDir = dirname(t.path);
  currentSource = t.source;
  editorDirty = t.dirty;
  forceExitEditState();
  blockRuns = [];
  els.welcome.hidden = true;
  els.content.hidden = false;
  updateDirtyHint();
  renderTabBar();
  persistSession();
  await renderDoc(currentSource);
  if (focusHeading) scrollToHeading(focusHeading);
  else els.previewPane.scrollTop = t.scrollY || 0;
}

/** 文件的规范身份（Rust canonicalize）：消除 8.3 短名/大小写/尾点别名，
 *  保证同一文件只有一个标签。失败时回退原路径。 */
async function canonId(path) {
  try {
    return (await invoke("canon_path", { path })) || path;
  } catch {
    return path;
  }
}

/** 直接从载荷建标签（撕出窗口交接 / 拖入合并），不读盘。
 *  index：合并时的插入位（来自目标窗口的插入缝）；非法值一律追加末尾。
 *  scrollY：拖来时的阅读位置，只对新标签生效；目标窗口已有同文件标签则保留自己的位置。
 *  @returns {Promise<boolean>} true=合并成功（源标签可移除）；false=冲突被拒（两边都保留） */
async function addTabFromPayload({ path, source, dirty, scrollY }, index) {
  // 载荷守卫：畸形事件（缺 path / source 非字符串）拒绝处理，防止幽灵标签损坏状态
  if (typeof path !== "string" || typeof source !== "string") return false;
  const idPath = await canonId(path);
  const existing = tabs.find((t) => samePath(t.path, idPath));
  if (existing) {
    if (existing.dirty) {
      if (dirty && existing.source !== source) {
        // 目标窗口该文件已有未保存修改，且拖入方也带着不同的未保存修改：
        // 拒绝合并，两边各自保留，由用户决定取舍
        return false;
      }
      // 拖入方是干净版本（=磁盘内容）：以目标未保存的内容为准，正常合并
    } else {
      existing.source = source;
      existing.dirty = !!dirty;
      if (existing.id === activeTabId) {
        currentSource = source;
        editorDirty = existing.dirty;
        updateDirtyHint();
        await renderDoc(currentSource);
      }
    }
    if (existing.id !== activeTabId) await activateTab(existing.id);
    renderTabBar();
    persistSession();
    return true;
  }
  const t = {
    id: `t${++tabIdSeq}`,
    path: idPath,
    source,
    dirty: !!dirty,
    scrollY: Number(scrollY) || 0,
  };
  let at = tabs.length;
  if (Number.isInteger(index) && index >= 0 && index <= tabs.length) at = index;
  tabs.splice(at, 0, t);
  await activateTab(t.id);
  syncWatch();
  return true;
}

function resetToWelcome() {
  activeTabId = null;
  currentPath = null;
  currentDir = null;
  currentSource = null;
  editorDirty = false;
  forceExitEditState();
  blockRuns = [];
  els.content.hidden = true;
  els.content.innerHTML = "";
  els.welcome.hidden = false;
  els.outline.hidden = true;
  updateDirtyHint();
}

/** 保存指定标签（不要求是活跃标签） */
async function saveTab(t) {
  try {
    await invoke("write_file", { path: t.path, content: t.source });
    suppressFsOnce = true; // 自己保存触发的 fs-changed 不回灌
    t.dirty = false;
    if (t.id === activeTabId) {
      editorDirty = false;
      updateDirtyHint();
    }
    renderTabBar();
    return true;
  } catch (e) {
    alert(`保存失败：${e}`);
    return false;
  }
}

async function closeTab(id) {
  const t = tabs.find((x) => x.id === id);
  if (!t) return;
  if (t.id === activeTabId) snapshotActiveTab();
  if (t.dirty) {
    const choice = await showCloseDialog(basename(t.path), "关闭");
    if (choice === "cancel") return;
    if (choice === "save" && !(await saveTab(t))) return; // 保存失败留在标签里
  }
  removeTabSilently(t);
}

/** 移除标签且不弹任何确认（拖出/合并路径：内容随载荷带走，不丢数据） */
function removeTabSilently(t) {
  const idx = tabs.indexOf(t);
  if (idx < 0) return;
  tabs.splice(idx, 1);
  if (t.id === activeTabId) {
    const next = tabs[Math.min(idx, tabs.length - 1)];
    if (next) activateTab(next.id);
    else resetToWelcome();
  }
  renderTabBar();
  persistSession();
  syncWatch();
}

function renderTabBar() {
  const bar = document.querySelector("#tabbar");
  const list = document.querySelector("#tabs");
  clearTabGap(); // 全量重建后缝元素已不在 DOM，状态一并复位
  bar.hidden = tabs.length === 0;
  list.replaceChildren(
    ...tabs.map((t) => {
      const el = document.createElement("div");
      el.className = "tab" + (t.id === activeTabId ? " active" : "");
      el.dataset.id = t.id;
      el.dataset.path = t.path;
      el.title = t.path;
      el.setAttribute("role", "tab");
      const name = document.createElement("span");
      name.className = "t-name";
      name.textContent = basename(t.path);
      el.append(name);
      if (t.dirty) {
        const dot = document.createElement("span");
        dot.className = "t-dirty";
        dot.title = "未保存";
        el.append(dot);
      }
      const close = document.createElement("button");
      close.className = "t-close";
      close.title = "关闭标签 (Ctrl+W)";
      close.textContent = "×";
      el.append(close);
      return el;
    })
  );
}

/** 文件监听与标签集保持一致 */
function syncWatch() {
  invoke("watch_files", { paths: tabs.map((t) => t.path) }).catch((e) =>
    console.error("watch failed:", e)
  );
}

let sessionTimer = null;
function persistSession() {
  clearTimeout(sessionTimer);
  sessionTimer = setTimeout(() => {
    try {
      localStorage.setItem(
        sessionKey(),
        JSON.stringify({
          paths: tabs.map((t) => t.path),
          active: currentPath,
          // 各标签阅读位置（与 paths 平行；活跃标签取实时 scrollTop）
          scrolls: tabs.map((t) =>
            t.id === activeTabId ? els.previewPane.scrollTop : t.scrollY || 0
          ),
        })
      );
    } catch {
      /* 隐私模式等存储不可用，忽略 */
    }
  }, 300);
}

// 滚动 = 阅读位置在变：随滚随存（persistSession 自带 300ms 去抖，滚动期间不落盘）
els.previewPane.addEventListener("scroll", () => persistSession(), { passive: true });

/** 重启后恢复本窗口上次的标签页（含各自阅读位置）；读不到的文件跳过 */
async function restoreSession() {
  let saved = null;
  try {
    saved = JSON.parse(localStorage.getItem(sessionKey()) || "null");
  } catch {
    return;
  }
  const list = saved?.paths || [];
  for (let i = 0; i < list.length; i++) {
    const p = list[i];
    const idPath = await canonId(p); // 用规范身份去重，别名路径不会再开出重复标签
    if (tabs.some((t) => samePath(t.path, idPath))) continue;
    try {
      const source = await invoke("read_file", { path: idPath });
      tabs.push({
        id: `t${++tabIdSeq}`,
        path: idPath,
        source,
        dirty: false,
        scrollY: Number(saved?.scrolls?.[i]) || 0,
      });
    } catch {
      /* 文件已被删除/移动：跳过 */
    }
  }
  if (tabs.length) {
    const act = tabs.find((t) => samePath(t.path, saved.active)) || tabs[0];
    await activateTab(act.id);
    syncWatch();
  }
}

/* 标签交互：点击切换、×/中键关闭、按住拖出窗口（撕标签页） */
document.querySelector("#tabs").addEventListener("click", (e) => {
  const el = e.target.closest(".tab");
  if (!el) return;
  if (e.target.closest(".t-close")) {
    closeTab(el.dataset.id).catch(console.error);
    return;
  }
  activateTab(el.dataset.id).catch(console.error);
});

document.querySelector("#tabs").addEventListener("auxclick", (e) => {
  if (e.button !== 1) return;
  const el = e.target.closest(".tab");
  if (el) closeTab(el.dataset.id).catch(console.error);
});

document.querySelector("#tabs").addEventListener("pointerdown", (e) => {
  if (e.button !== 0) return;
  if (e.target.closest(".t-close")) return;
  const el = e.target.closest(".tab");
  if (!el) return;
  dragState = {
    id: el.dataset.id,
    startX: e.clientX,
    startY: e.clientY,
    started: false,
    el,
    tabW: Math.max(48, Math.min(260, el.getBoundingClientRect().width)),
    detached: false,
  };
});

window.addEventListener(
  "pointermove",
  (e) => {
    if (!dragState || dragState.started) return;
    if (Math.hypot(e.clientX - dragState.startX, e.clientY - dragState.startY) > 5) {
      dragState.started = true; // 交给原生层跟踪（网页拿不到窗口外的鼠标）
      const t = tabs.find((x) => x.id === dragState.id);
      if (!t) {
        dragState = null;
        return;
      }
      dragState.el?.classList.add("lifting");
      invoke("drag_tab_begin", { title: basename(t.path), width: dragState.tabW }).catch(
        () => {}
      );
    }
  },
  true
);
window.addEventListener("pointerup", () => {
  if (dragState && !dragState.started) dragState = null; // 普通点击；已启动的原生拖拽由 tab-drag end 收尾
});

/* ---------------------- 拖拽视觉（记事本式）：摘除 / 回弹 / 插入缝 ---------------------- */

let gapEl = null; // 插入缝元素：拖拽期间复用，挪位瞬时、宽度首次展开有动画

function setTabGap(index, widthPx) {
  const list = document.querySelector("#tabs");
  if (!list || index == null) return;
  if (!gapEl) {
    gapEl = document.createElement("div");
    gapEl.className = "tab-gap";
    gapEl.style.width = "0px";
    list.appendChild(gapEl);
  }
  const exclude = dragState?.started ? dragState.id : null;
  const ref = [...list.querySelectorAll(".tab")].filter(
    (el) => el.dataset.id !== exclude
  )[index];
  if (ref) list.insertBefore(gapEl, ref);
  else list.appendChild(gapEl);
  requestAnimationFrame(() => {
    if (gapEl) gapEl.style.width = widthPx + "px";
  });
}

function clearTabGap() {
  gapEl?.remove();
  gapEl = null;
}

/** 客户区 x → 插入位（在"不含被拖标签"的顺序空间里；越界取末尾）。
 *  测量瞬间隐藏缝元素：缝自身的宽度会把后续标签顶开，中点反馈环会让缝卡在原地不跟手 */
function insertionIndexAt(lx, excludeId) {
  if (typeof lx !== "number") return null;
  const gap = gapEl;
  if (gap) gap.style.display = "none";
  let idx = 0;
  try {
    const els = [...document.querySelectorAll("#tabs .tab")].filter(
      (el) => el.dataset.id !== excludeId
    );
    for (const el of els) {
      const r = el.getBoundingClientRect();
      if (lx < r.left + r.width / 2) break;
      idx++;
    }
  } finally {
    if (gap) gap.style.display = "";
  }
  return idx;
}

/** 标签从栏上摘除：宽度/内边距动画收拢到 0，缝隙自然合上（ghost 小窗由 Rust 接管显示） */
function detachTabEl(s) {
  if (s.detached || !s.el?.isConnected) return;
  s.detached = true;
  const el = s.el;
  el.style.width = el.getBoundingClientRect().width + "px";
  el.classList.add("detached");
  void el.offsetWidth; // 先定起始宽度再收拢，transition 才会跑
  el.style.width = "0px";
}

/** 拖回自家标签栏带内：放回原位并展开（中途往返用，不重渲染） */
function restoreTabEl(s) {
  if (!s.detached) return;
  s.detached = false;
  const el = s.el;
  if (!el?.isConnected) return;
  el.classList.add("snap-in");
  el.classList.remove("detached");
  el.style.width = s.tabW + "px";
  setTimeout(() => {
    el.classList.remove("snap-in");
    el.style.width = "";
  }, 200);
}

// 原生拖拽回报：move 维持视觉（就地让位 / 摘除），end 收尾
listen("tab-drag", (ev) => {
  const d = ev.payload;
  if (!dragState?.started) return; // 与本次页面拖拽无关（或已收尾）
  if (d.phase === "move") {
    if (d.detached) {
      detachTabEl(dragState);
      clearTabGap();
    } else if (d.over === WIN_LABEL) {
      restoreTabEl(dragState);
      setTabGap(insertionIndexAt(d.lx, dragState.id), dragState.tabW);
    }
    return;
  }
  if (d.phase !== "end") return;
  const s = dragState;
  dragState = null;
  clearTabGap();
  const t = tabs.find((x) => x.id === s.id);
  if (!t) return;
  s.el?.classList.remove("lifting");

  if (d.over === WIN_LABEL && !d.detached) {
    // 自家标签栏内松手：就地重排（记事本行为）
    const idx = insertionIndexAt(d.lx, t.id);
    if (idx != null) {
      const rest = tabs.filter((x) => x !== t);
      rest.splice(Math.min(idx, rest.length), 0, t);
      tabs.length = 0;
      tabs.push(...rest);
      persistSession();
    }
    renderTabBar();
    return;
  }
  if (d.over && d.over !== WIN_LABEL) {
    // 拖入另一窗口：合并过去，等对方确认收到且接受后才移除本地标签
    if (t.id === activeTabId) snapshotActiveTab();
    emitTo(d.over, "tab-merge", {
      path: t.path,
      source: t.source,
      dirty: t.dirty,
      scrollY: t.scrollY || 0,
      from: WIN_LABEL,
    })
      .then(async () => {
        const accepted = await Promise.race([
          new Promise((res) => {
            const un = listen("tab-merge-result", (ev) => {
              if (ev.payload && samePath(ev.payload.path, t.path)) {
                un.then((f) => f());
                res(ev.payload.ok);
              }
            });
          }),
          new Promise((res) => setTimeout(() => res(undefined), 1500)),
        ]);
        if (accepted === undefined) {
          renderTabBar(); // 无回执：保留标签，宁重复不丢失
          return;
        }
        if (accepted === false) {
          renderTabBar();
          alert(`「${basename(t.path)}」在目标窗口已有未保存修改，两边都保留了`);
          return;
        }
        await invoke("focus_window", { label: d.over }).catch(() => {});
        removeTabSilently(t);
        if (!tabs.length) {
          // 合并走最后一个标签：本窗口使命结束，像记事本一样自动关闭
          // （随机标签的会话键不再复用，一并清掉）
          try {
            localStorage.removeItem(sessionKey());
          } catch {
            /* 存储不可用，忽略 */
          }
          getCurrentWindow().destroy().catch(() => {});
        }
      })
      .catch((e) => {
        renderTabBar();
        alert(`合并失败，标签已保留：${e}`);
      });
    return;
  }
  // 拖离标签栏后松手（自家内容区/标题栏，或所有窗口之外）：撕成新窗口（原生侧创建，失败保留标签）
  if (t.id === activeTabId) snapshotActiveTab();
  const label = `w${Date.now().toString(36)}`;
  try {
    localStorage.setItem(
      `mdr-handoff:${label}`,
      JSON.stringify({
        path: t.path,
        source: t.source,
        dirty: t.dirty,
        scrollY: t.scrollY || 0,
      })
    );
  } catch {
    renderTabBar();
    alert("内容过大，无法拖出为新窗口（本地存储超限），标签已保留");
    return;
  }
  const scale = window.devicePixelRatio || 1;
  invoke("tear_off_tab", {
    label,
    x: Math.max(0, Math.round(d.x / scale) - 200),
    y: Math.max(0, Math.round(d.y / scale) - 40),
  })
    .then(() => removeTabSilently(t))
    .catch((e) => {
      localStorage.removeItem(`mdr-handoff:${label}`);
      renderTabBar();
      alert(`新窗口创建失败，标签已保留：${e}`);
    });
});

// 悬停邀请：目标窗口按光标位置裂开插入缝；落在内容区 = 追加末尾（更宽容的合并）
let dropGapIndex = null;
listen("tab-drop-hover", (ev) => {
  const p = ev.payload || {};
  const bar = document.querySelector("#tabbar");
  if (!p.over) {
    // 只清视觉，保留 dropGapIndex：drag_end 的 over:false 总是先于合并事件到达
    bar.classList.remove("drop-target");
    clearTabGap();
    return;
  }
  bar.classList.add("drop-target");
  const inBand = typeof p.ly === "number" && p.ly >= 42 && p.ly <= 100;
  const idx = inBand ? insertionIndexAt(p.lx, null) : tabs.length;
  dropGapIndex = idx == null ? tabs.length : idx;
  setTabGap(dropGapIndex, Math.max(64, Math.min(200, p.w || 150)));
});

// 合并接收（接受与否回告源窗口，源窗口据此决定是否移除标签）
listen("tab-merge", (ev) => {
  const h = ev.payload;
  const at = dropGapIndex;
  dropGapIndex = null;
  clearTabGap();
  document.querySelector("#tabbar").classList.remove("drop-target");
  addTabFromPayload(h, at)
    .then((ok) =>
      h?.from ? emitTo(h.from, "tab-merge-result", { path: h.path, ok: !!ok }) : null
    )
    .catch(console.error);
});

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
  const title = `${editorDirty ? "● " : ""}${
    currentPath ? basename(currentPath) : "MD Reader"
  } - MD Reader`;
  document.title = title;
  // Tauri 2 下 document.title 不会同步到原生窗口标题
  getCurrentWindow().setTitle(title).catch(() => {});
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
  renderTabBar(); // 标签上的未保存圆点
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
  if (!currentPath || !editorDirty) return true;
  if (activeBlockEdit) {
    // 块内正在编辑的内容先合入源码再落盘（renderDoc 顺带清掉编辑框 DOM）
    currentSource = absorbActiveBlock(currentSource);
    renderDoc(currentSource);
  }
  const t = tabs.find((x) => x.id === activeTabId);
  if (!t) return true;
  t.source = currentSource;
  return saveTab(t);
}

/**
 * 应用内关闭确认对话框（Office 三按钮式）。不依赖原生对话框——
 * 上版原生 plugin:dialog|ask 在部分环境不返回导致窗口无法关闭。
 * @param {string} what 内容提示（文件名或数量描述）
 * @param {string} action 动作词（"关闭"/"退出"）
 * @returns {"save"|"exit"|"cancel"}
 */
function showCloseDialog(what, action = "退出") {
  return new Promise((resolve) => {
    const overlay = document.querySelector("#modal-overlay");
    document.querySelector("#dlg-text").textContent =
      `${what}有未保存的修改，${action}前要保存吗？未保存的修改将被丢弃。`;
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

// 关闭窗口：本窗口任一标签有未保存修改时弹应用内确认；任何异常都放行关闭，绝不卡死窗口
getCurrentWindow().onCloseRequested(async (event) => {
  try {
    if (activeBlockEdit) {
      // Alt+F4 等键盘关闭路径没有 mousedown，块内未落定的修改先合入
      currentSource = absorbActiveBlock(currentSource);
      renderDoc(currentSource);
    }
    snapshotActiveTab();
    const dirtyTabs = tabs.filter((t) => t.dirty);
    if (!dirtyTabs.length) return; // 无修改 → 正常关闭（会话保留，供下次恢复）
    event.preventDefault();
    if (!document.querySelector("#modal-overlay").hidden) return; // 已在询问中
    const what =
      dirtyTabs.length === 1
        ? `「${basename(dirtyTabs[0].path)}」`
        : `${dirtyTabs.length} 个标签页`;
    const choice = await showCloseDialog(what, "退出");
    if (choice === "cancel") return; // 留在页面
    if (choice === "save") {
      for (const t of dirtyTabs) {
        if (!(await saveTab(t))) return; // 保存失败不退出，留在页面
      }
    }
    await getCurrentWindow().destroy();
  } catch (err) {
    console.error("close guard failed:", err);
    await getCurrentWindow().destroy().catch(() => {});
  }
});

// 本窗口聚焦时登记为"前置窗口"：双击 .md 的新文件开到这里
getCurrentWindow().onFocusChanged(({ payload: focused }) => {
  if (focused) invoke("set_front_window", { label: WIN_LABEL }).catch(() => {});
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

/** 打开文件：已有同名标签则激活，否则新建标签（旧标签保留）；focusHeading 渲染后滚动到标题 */
async function openFile(path, focusHeading) {
  const seq = ++openSeq;
  pendingOpenBlockIdx = null; // 跨文档不保留块跳转意图，避免在新文档误开同号块
  const idPath = await canonId(path); // 规范身份去重（8.3 短名/大小写/尾点别名）
  const existing = tabs.find((t) => samePath(t.path, idPath));
  if (existing) {
    pushRecent(idPath);
    await activateTab(existing.id, focusHeading);
    return;
  }
  let source;
  try {
    source = await invoke("read_file", { path: idPath });
  } catch (err) {
    // 三个入口（启动参数/双击关联/Ctrl+O）共用这里，失败必须让用户看见
    alert(`打开「${basename(idPath)}」失败：${err}`);
    return;
  }
  if (seq !== openSeq) return; // 已有更新的打开请求
  pushRecent(idPath);
  const t = { id: `t${++tabIdSeq}`, path: idPath, source, dirty: false, scrollY: 0 };
  tabs.push(t);
  await activateTab(t.id, focusHeading);
  syncWatch();
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

/* ------------------------ 打开菜单 / 最近文档 / 文件夹 ----------------------- */

const openMenuEl = document.createElement("div");
openMenuEl.id = "open-menu";
openMenuEl.hidden = true;
document.body.append(openMenuEl);

const MAX_RECENTS = 5;

function recentList() {
  try {
    const v = JSON.parse(localStorage.getItem("mdr-recents") || "[]");
    return Array.isArray(v) ? v : [];
  } catch {
    return [];
  }
}
function pushRecent(path) {
  const norm = normalizePath(path);
  const list = recentList().filter((p) => normalizePath(p) !== norm);
  list.unshift(path);
  try {
    localStorage.setItem("mdr-recents", JSON.stringify(list.slice(0, MAX_RECENTS)));
  } catch {
    /* 存储不可用，忽略 */
  }
}

function fmtTime(unixSec) {
  const d = new Date(unixSec * 1000);
  const pad = (n) => String(n).padStart(2, "0");
  if (d.toDateString() === new Date().toDateString()) return `今天 ${pad(d.getHours())}:${pad(d.getMinutes())}`;
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

function buildOpenMenu() {
  const frag = document.createDocumentFragment();
  const mk = (cls) => {
    const el = document.createElement("div");
    el.className = cls;
    return el;
  };

  const itemOpen = mk("om-item");
  const lbl1 = document.createElement("span");
  lbl1.textContent = "📄 打开文件…";
  const kbd = document.createElement("span");
  kbd.className = "om-kbd";
  kbd.textContent = "Ctrl+O";
  itemOpen.append(lbl1, kbd);
  itemOpen.addEventListener("click", () => {
    hideOpenMenu();
    pickFile().catch(console.error);
  });
  frag.append(itemOpen);

  const itemFolder = mk("om-item");
  const lbl2 = document.createElement("span");
  lbl2.textContent = "📁 从文件夹打开…";
  itemFolder.append(lbl2);
  itemFolder.addEventListener("click", () => {
    hideOpenMenu();
    pickFolder().catch(console.error);
  });
  frag.append(itemFolder);

  frag.append(mk("om-sep"));

  const label = mk("om-label");
  label.textContent = "最近文档";
  frag.append(label);

  const recents = recentList();
  if (!recents.length) {
    const empty = mk("om-empty");
    empty.textContent = "暂无记录";
    frag.append(empty);
  } else {
    for (const p of recents) {
      const it = mk("om-item om-recent");
      const name = document.createElement("span");
      name.className = "om-name";
      name.textContent = "🗎 " + basename(p);
      const dir = document.createElement("span");
      dir.className = "om-dir";
      dir.textContent = dirname(p);
      it.title = p;
      it.append(name, dir);
      it.addEventListener("click", () => {
        hideOpenMenu();
        openFile(p).catch(console.error);
      });
      frag.append(it);
    }
  }
  openMenuEl.replaceChildren(frag);
}

function showOpenMenu() {
  buildOpenMenu();
  const btn = document.querySelector("#btn-open");
  const r = btn.getBoundingClientRect();
  openMenuEl.hidden = false;
  const mw = openMenuEl.getBoundingClientRect();
  openMenuEl.style.left = Math.max(6, Math.min(r.left, innerWidth - mw.width - 8)) + "px";
  openMenuEl.style.top = r.bottom + 6 + "px";
}
function hideOpenMenu() {
  openMenuEl.hidden = true;
}

async function pickFolder() {
  // 对话框在 Rust 侧：选中的目录同时登记为 list_md_files 的一次性许可
  const dir = await invoke("pick_folder").catch((e) => {
    alert(`打开文件夹选择器失败：${e}`);
    return null;
  });
  if (!dir) return;
  let entries;
  try {
    entries = await invoke("list_md_files", { dir });
  } catch (e) {
    alert(`读取文件夹失败：${e}`);
    return;
  }
  showFolderDialog(dir, entries);
}

function showFolderDialog(dir, entries) {
  const overlay = document.querySelector("#folder-overlay");
  document.querySelector("#folder-title").textContent = `选择文档（${entries.length} 个）`;
  document.querySelector("#folder-path").textContent = dir;
  const list = document.querySelector("#folder-list");
  list.replaceChildren(
    ...entries.map((en) => {
      const it = document.createElement("div");
      it.className = "fd-item";
      const name = document.createElement("span");
      name.className = "fd-name";
      name.textContent = en.name;
      const time = document.createElement("span");
      time.className = "fd-time";
      time.textContent = fmtTime(en.modified);
      it.title = en.path;
      it.append(name, time);
      it.addEventListener("click", () => {
        hideFolderDialog();
        openFile(en.path).catch(console.error);
      });
      return it;
    })
  );
  if (!entries.length) {
    const empty = document.createElement("div");
    empty.className = "fd-empty";
    empty.textContent = "此文件夹没有 Markdown / 文本文档";
    list.append(empty);
  }
  overlay.hidden = false;
}
function hideFolderDialog() {
  document.querySelector("#folder-overlay").hidden = true;
}
document.querySelector("#folder-overlay").addEventListener("mousedown", (e) => {
  if (e.target.id === "folder-overlay") hideFolderDialog();
});

/* --------------------------------- 事件绑定 -------------------------------- */

document.querySelector("#btn-open").addEventListener("click", () => {
  if (openMenuEl.hidden) showOpenMenu();
  else hideOpenMenu();
});
document.addEventListener("mousedown", (e) => {
  if (!openMenuEl.hidden && !openMenuEl.contains(e.target) && !e.target.closest("#btn-open")) {
    hideOpenMenu();
  }
});
document.addEventListener("keydown", (e) => {
  if (e.key === "Escape" && !openMenuEl.hidden) hideOpenMenu();
});

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
  // 标签页快捷键
  if ((e.ctrlKey || e.metaKey) && e.key === "Tab") {
    e.preventDefault();
    if (!tabs.length) return;
    const idx = tabs.findIndex((t) => t.id === activeTabId);
    const delta = e.shiftKey ? -1 : 1;
    activateTab(tabs[(idx + delta + tabs.length) % tabs.length].id).catch(console.error);
  }
  if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "w") {
    e.preventDefault();
    if (activeTabId) closeTab(activeTabId).catch(console.error);
  }
  if ((e.ctrlKey || e.metaKey) && /^[1-9]$/.test(e.key)) {
    const t = tabs[+e.key - 1];
    if (t) {
      e.preventDefault();
      activateTab(t.id).catch(console.error);
    }
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

// 拖拽 .md 到窗口打开（非文本类文件忽略）；多个文件全部开成标签
getCurrentWebview().onDragDropEvent((event) => {
  const p = event.payload;
  if (p.type === "drop" && p.paths?.length) {
    for (const file of p.paths) {
      if (/\.(md|markdown|mdown|mkd|txt)$/i.test(file)) {
        openFile(file).catch((err) => alert(`打开失败：${err}`));
      }
    }
  }
});

// 文件保存后自动刷新（保持滚动位置）；编辑模式自写抑制。事件按路径路由到对应标签。
listen("fs-changed", async (e) => {
  const t = tabs.find((x) => samePath(x.path, e.payload));
  if (!t) return; // 已关闭的文件或别的窗口的标签
  resolveCache.clear(); // 磁盘内容变了，相对路径的解析结果不再可信，下次渲染重新解析
  if (t.id === activeTabId) {
    if (suppressFsOnce) {
      suppressFsOnce = false;
      return;
    }
    const scrollTop = els.previewPane.scrollTop;
    try {
      const source = await invoke("read_file", { path: t.path });
      if (editing && editorDirty) return; // 编辑未保存期间忽略外部变化（用户编辑优先）
      t.source = source;
      currentSource = source;
      await renderDoc(source);
      if (!editing) els.previewPane.scrollTop = scrollTop;
    } catch {
      /* 编辑器保存过程中的瞬时不可读，忽略 */
    }
  } else if (!t.dirty) {
    // 后台标签静默更新；脏标签不动（用户编辑优先，切回时以源码为准）
    try {
      t.source = await invoke("read_file", { path: t.path });
    } catch {
      /* 瞬时不可读，忽略 */
    }
  }
});

// 已有实例被再次唤起（双击 .md 等）：在当前窗口打开新文件；同文件则重新读取
listen("open-file", (e) => {
  if (e.payload) {
    openFile(e.payload).catch((err) => console.error("open-file failed:", err));
  }
});

/* --------------------------------- 启动 --------------------------------- */

applyTheme();

// 窗口启动序：撕出窗口的交接载荷 > 会话恢复（可选）> 命令行文件参数（追加为标签）
(async () => {
  const handoffKey = `mdr-handoff:${WIN_LABEL}`;
  const raw = localStorage.getItem(handoffKey);
  if (raw) {
    localStorage.removeItem(handoffKey);
    try {
      await addTabFromPayload(JSON.parse(raw));
      return;
    } catch {
      /* 载荷坏了走正常启动 */
    }
  }
  await restoreSession();
  try {
    const arg = await invoke("initial_path");
    if (arg) await openFile(arg);
  } catch (err) {
    console.error(err);
  }
})();
