/** Configure React, tier-local tests and same-origin development/preview API proxies. */
import { defineConfig, loadEnv } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig(({ mode }) => {
  const env = { ...loadEnv(mode, '.', ''), ...process.env };
  const proxy = { '/api': { target: env.API_PROXY_TARGET || 'http://localhost:3000', changeOrigin: true } };
  return {
    plugins: [react()],
    server: { host: '0.0.0.0', port: Number(env.FRONTEND_PORT || 5173), strictPort: true, proxy },
    preview: { host: '0.0.0.0', port: Number(env.PREVIEW_PORT || 4173), strictPort: true, proxy },
    test: { environment: 'jsdom', include: ['src/**/*.test.jsx'], clearMocks: true }
  };
});
