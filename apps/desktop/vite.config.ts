import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// M0 占位：最小可启动配置
export default defineConfig({
  plugins: [react()],
  server: { port: 5173 },
});
