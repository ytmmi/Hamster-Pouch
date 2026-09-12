import { fileURLToPath, URL } from "node:url";
import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// 多入口：主界面 + dockview popout 宿主页
export default defineConfig({
  plugins: [react()],
  server: { port: 5173 },
  build: {
    rollupOptions: {
      input: {
        main: fileURLToPath(new URL("./index.html", import.meta.url)),
        popout: fileURLToPath(new URL("./popout.html", import.meta.url)),
      },
    },
  },
});
