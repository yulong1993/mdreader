// 块编辑器的 CodeMirror 6 封装（懒加载，仅在首次块编辑时 import）。
// 对齐 Obsidian Live Preview 的观感：
// - 排版由调用方传入（继承被编辑块：标题编辑时保持大号粗体）
// - 语法标记淡化（be-md），行内强调/链接等按渲染样式呈现（be-strong 等）
// - 光标所在行显示源码标记，其余行用 replace 装饰把标记藏起来（live preview 核心）
import { EditorView, keymap, ViewPlugin, Decoration } from "@codemirror/view";
import { EditorState } from "@codemirror/state";
import { defaultKeymap, history, historyKeymap } from "@codemirror/commands";
import { markdown } from "@codemirror/lang-markdown";
import { HighlightStyle, syntaxHighlighting, syntaxTree } from "@codemirror/language";
import { tags as t } from "@lezer/highlight";

/** 非光标行要隐藏的语法节点（标记字符渲染后不存在） */
const HIDE_NODES = new Set([
  "HeaderMark",
  "EmphasisMark",
  "StrikethroughMark",
  "CodeMark",
  "LinkMark",
  "URL",
]);

/** 光标不在本行时隐藏标记；fence 行（```）不藏——藏了代码块就没边界了 */
function buildHides(view) {
  const { state } = view;
  const sel = state.selection.main;
  const activeFrom = state.doc.lineAt(sel.from).from;
  const activeTo = state.doc.lineAt(sel.to).to;
  const hides = [];
  const fenceAt = (pos) => /^\s*(```+|~~~)/.test(state.doc.lineAt(pos).text);
  syntaxTree(state).iterate({
    enter(node) {
      if (!HIDE_NODES.has(node.name)) return;
      if (node.from >= activeFrom && node.to <= activeTo) return; // 光标行：显示源码
      if (node.name === "URL" && node.parent?.name !== "Link") return; // 图片 URL 不藏
      if (fenceAt(node.from)) return;
      let to = node.to;
      if (node.name === "HeaderMark") {
        // 连同 # 后面的空格一起藏，标题文字顶格如渲染态
        const after = state.doc.sliceString(node.to, node.to + 1);
        if (after === " " || after === "\t") to += 1;
      }
      hides.push(Decoration.replace({}).range(node.from, to));
    },
  });
  return Decoration.set(hides.sort((a, b) => a.from - b.from));
}

const livePreview = ViewPlugin.fromClass(
  class {
    constructor(view) {
      this.decorations = buildHides(view);
    }
    update(u) {
      this.decorations = buildHides(u);
    }
  },
  { decorations: (v) => v.decorations }
);

const hl = HighlightStyle.define([
  { tag: t.processingInstruction, class: "be-md" },
  { tag: t.meta, class: "be-md" },
  { tag: t.url, class: "be-md" },
  { tag: t.strong, class: "be-strong" },
  { tag: t.emphasis, class: "be-em" },
  { tag: t.strikethrough, class: "be-strike" },
  { tag: t.monospace, class: "be-code" },
  { tag: t.link, class: "be-link" },
]);

/**
 * @param {object} opts
 * @param {string} opts.doc 块的 Markdown 源码
 * @param {{fontFamily:string,fontSize:string,fontWeight:string,lineHeight:string,letterSpacing?:string}} opts.styles
 * @param {() => void} opts.onEscape Esc 放弃编辑
 * @param {() => void} opts.onCommit Ctrl+Enter 提交
 * @param {() => void} opts.onInternalBlur 焦点移到应用内其他位置（提交；离开应用不提交）
 */
export function createBlockCM(opts) {
  const theme = EditorView.theme({
    // 排版（字体/字号/字重/行高）由 wrapper 行内样式提供，这里只做继承——
    // 主题规则里传带引号的字体栈会被 CSSOM 解析丢弃，行内样式没有这个问题
    "&": {
      backgroundColor: "transparent",
      color: "var(--fg)",
      height: "auto",
      font: "inherit",
    },
    "&.cm-focused": { outline: "none" },
    ".cm-scroller": { overflow: "visible", font: "inherit" },
    ".cm-content": { caretColor: "var(--fg)", padding: "0", font: "inherit" },
    ".cm-line": { padding: "0" },
    "&.cm-focused .cm-selectionBackground, .cm-selectionBackground, .cm-content ::selection": {
      backgroundColor: "color-mix(in srgb, var(--accent) 24%, transparent)",
    },
  });

  const view = new EditorView({
    state: EditorState.create({
      doc: opts.doc,
      extensions: [
        EditorView.lineWrapping,
        markdown(),
        history(),
        syntaxHighlighting(hl),
        livePreview,
        theme,
        keymap.of([
          { key: "Escape", run: () => (opts.onEscape(), true) },
          { key: "Mod-Enter", run: () => (opts.onCommit(), true) },
          {
            key: "Tab",
            run: (v) => (v.dispatch(v.state.replaceSelection("  ")), true),
          },
          ...defaultKeymap,
          ...historyKeymap,
        ]),
        EditorView.updateListener.of((u) => {
          // 测试钩子（CDP 断言用）：最新文档与选区
          view.dom.__mdrValue = u.state.doc.toString();
          view.dom.__mdrSel = [u.state.selection.main.anchor, u.state.selection.main.head];
        }),
      ],
    }),
  });

  view.dom.addEventListener("focusout", (e) => {
    if (e.relatedTarget !== null && !view.dom.contains(e.relatedTarget)) opts.onInternalBlur();
  });
  view.dom.__mdrValue = opts.doc; // 测试钩子（updateListener 持续刷新）
  view.dom.__mdrView = view;

  return {
    dom: view.dom,
    getValue: () => view.state.doc.toString(),
    setSelection: (start, end) =>
      // 不带 scrollIntoView：编辑器总在用户点击处打开（本就可见）；
      // CM 在 overflow:visible 的自适高布局下会把滚动传导给外层容器，造成视野突跳
      view.dispatch({
        selection: { anchor: start, head: end },
      }),
    focus: () => view.focus(),
    destroy: () => view.destroy(),
  };
}
