// 对抗审查探针：验证块级编辑的 token→源码行映射在最坏输入下的行为。
// 只用 markdown-it（无需 DOM），复刻 main.js 的 collectBlockRuns 逻辑。
import MarkdownIt from "markdown-it";
import footnote from "markdown-it-footnote";

const md = new MarkdownIt({ html: true, linkify: true }).use(footnote);

// 与 src/main.js collectTopRuns + collectBlockRuns 相同的实现
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
    runs.push({ mapped: !!toks[0].map, html: toks.some((x) => x.type === "html_block"), ts, te: i });
    ts = -1;
  });
  return runs;
}

function collectBlockRuns(tokens, fmLines = 0) {
  const out = [];
  for (const run of collectTopRuns(tokens)) {
    if (!run.mapped) continue;
    let s = null, e = null;
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

function probe(name, src) {
  const tokens = md.parse(src, {});
  const runs = collectBlockRuns(tokens);
  const lines = src.split("\n");
  console.log(`\n=== ${name} ===`);
  runs.forEach((r, j) => {
    const toks = tokens.slice(r.ts, r.te + 1);
    const html = md.renderer.render(toks, md.options, {});
    const nEls = (html.match(/<[a-zA-Z]/g) || []).length; // 未消毒渲染的顶层元素数（近似 children）
    console.log(
      `块${j} 行[${r.s},${r.e}) 类型:${toks[0].type} 元素数(未消毒):${nEls} 源码: ${JSON.stringify(lines.slice(r.s, r.e))}`
    );
  });
}

// 1) 原始 HTML 里含会被 DOMPurify 剥离的标签 → 探测计数 vs 主渲染计数错位
probe(
  "html_block 含被剥离标签",
  `<p>第一段</p><script>alert(1)</script>\n\n段A\n\n段B\n\n段C\n`
);

// 2) 两处分离的脚注定义 → 是否合并成一个跨大区间的块
probe(
  "分离的脚注定义",
  `正文一[^1]\n\n[^1]: 第一个定义\n\n中间隔了很多段\n\n第二段\n\n第三段\n\n[^2]: 第二个定义\n\n结尾段\n`
);

// 3) 链接引用定义与段落同行块 → 点段落会编辑到定义行
probe("引用定义", `[ref]: /url \"标题\"\n\n正文段落\n`);

// 4) 基线：普通文档 + frontmatter 偏移
probe(
  "基线+frontmatter",
  `---\ntitle: t\n---\n# 标题\n\n段落一\n\n- 列表项\n- 另一项\n\nSetext 标题\n===\n\n结尾\n`
);
