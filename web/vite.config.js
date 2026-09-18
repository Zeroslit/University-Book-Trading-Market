// Vite 配置：开发期把 /api 与 /static 代理到后端（默认 3000），生产由 Nginx 同域反代
// 演示构建（GitHub Pages 等纯静态托管）：
//   VITE_BASE=/University-Book-Trading-Market/web/ VITE_DEMO=true npm run build
// VITE_DEMO 通过 import.meta.env 注入前端，前端据此改用浏览器内的模拟后端（web/src/demo）。
import { defineConfig } from 'vite';
import vue from '@vitejs/plugin-vue';

// 演示版复用后端 lib（归一化、违禁词匹配、状态机、错误码）以保证行为一致，
// 但后端 lib 依赖 Node 专用 logger（会连带拉入 config/dotenv/fs），浏览器端统一替换为空实现。
const LOGGER_SHIM_ID = '\u0000demo-logger-shim';

const loggerShimPlugin = {
  name: 'demo-logger-shim',
  enforce: 'pre',
  resolveId(source) {
    return /(^|\/)logger\.js$/.test(source) ? LOGGER_SHIM_ID : null;
  },
  load(id) {
    if (id !== LOGGER_SHIM_ID) return null;
    return 'export const logger = { debug() {}, info() {}, warn() {}, error() {} };\nexport default logger;\n';
  },
};

export default defineConfig({
  base: process.env.VITE_BASE || '/',
  plugins: [loggerShimPlugin, vue()],
  server: {
    port: 5173,
    host: true,
    proxy: {
      '/api': { target: 'http://127.0.0.1:3000', changeOrigin: true },
      '/static': { target: 'http://127.0.0.1:3000', changeOrigin: true },
    },
  },
  build: { outDir: 'dist', sourcemap: false, chunkSizeWarningLimit: 2000 },
});
