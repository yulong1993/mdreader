// ghost 拖拽小窗：只做展示（标题 / 宽度 / 光标样式），位置由 Rust 侧逐帧 set_position 驱动。
// 页面加载完成前 Rust 可能已发过状态，所以先拉一次 ghost_current 再增量监听。
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";

const pill = document.querySelector("#pill");
const titleEl = document.querySelector("#pill-title");

function apply(s) {
  if (!s || typeof s !== "object") return;
  if (typeof s.title === "string") titleEl.textContent = s.title;
  if (typeof s.w === "number" && s.w > 0) {
    pill.style.width = Math.min(248, Math.max(56, s.w)) + "px";
  }
  if (s.cursor === "no-drop" || s.cursor === "default") {
    document.documentElement.style.cursor = s.cursor;
  }
}

invoke("ghost_current").then(apply).catch(() => {});
listen("ghost-state", (ev) => apply(ev.payload));
