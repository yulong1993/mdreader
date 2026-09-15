import { fileURLToPath, URL } from "node:url";
import { defineConfig } from "vite";

// https://vitejs.dev/config/
export default defineConfig({
  clearScreen: false,
  server: {
    port: 1420,
    strictPort: true,
  },
  envPrefix: ["VITE_", "TAURI_ENV_*"],
  build: {
    target: "chrome105",
    minify: !process.env.TAURI_ENV_DEBUG ? "esbuild" : false,
    sourcemap: !!process.env.TAURI_ENV_DEBUG,
    rollupOptions: {
      // 双入口：主页面 + 拖拽跟手 ghost 小窗（Rust 侧 WebviewUrl::App("ghost.html")）
      input: {
        main: fileURLToPath(new URL("./index.html", import.meta.url)),
        ghost: fileURLToPath(new URL("./ghost.html", import.meta.url)),
      },
    },
  },
});
