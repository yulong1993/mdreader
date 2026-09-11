// 终版验证：HTML_INTEGRATION_POINTS 放行 foreignObject
import createDOMPurify from "dompurify";
import { JSDOM } from "jsdom";

const window = new JSDOM("").window;
const DOMPurify = createDOMPurify(window);

const CFG = {
  ADD_TAGS: ["foreignObject"],
  HTML_INTEGRATION_POINTS: { foreignobject: true },
  ADD_ATTR: ["marker-end", "viewBox", "startoffset", "baseline-shift", "xmlns"],
};

const SVG = `<svg viewBox="0 0 100 40"><foreignObject width="60" height="20"><div xmlns="http://www.w3.org/1999/xhtml" style="display:inline-block"><span class="nodeLabel">文字A</span></div></foreignObject><path d="M0 0 L10 10" marker-end="url(#x)"></path></svg>`;
const ATTACK = `<svg><foreignObject><div><script>bad()</script><img src=x onerror=alert(1)><iframe src="http://evil"></iframe><a href="javascript:alert(2)">x</a></div></foreignObject></svg>`;

const out = DOMPurify.sanitize(SVG, CFG);
const ok = out.includes("文字A") && out.includes("foreignObject") && out.includes("marker-end");
console.log("mermaid 标签完整保留:", ok ? "✅" : "❌");
console.log(" ", out);

const atk = DOMPurify.sanitize(ATTACK, CFG);
const safe = !atk.includes("script") && !atk.includes("onerror") && !atk.includes("iframe") && !atk.includes("javascript");
console.log("攻击拦截（script/onerror/iframe/javascript:）:", safe ? "全部被剥 ✅" : "有泄露 ❌");
console.log(" ", atk);
