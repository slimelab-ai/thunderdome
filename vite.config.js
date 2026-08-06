import { defineConfig } from 'vite';
import { resolve } from 'node:path';

export default defineConfig({
  build: {
    rollupOptions: {
      input: {
        main: resolve('index.html'),
        xbox: resolve('xbox.html'),
      },
    },
  },
  server: {
    // Honour PORT so several dev servers can run side by side without each one
    // silently landing on 5173+1 and leaving whatever launched it looking at the
    // wrong address.
    port: Number(process.env.PORT) || 5173,
    proxy: {
      '/api/diagnostics': {
        target: process.env.ANALYTICS_URL || 'http://127.0.0.1:18080',
        changeOrigin: false,
        rewrite: path => path.replace(/^\/api/, ''),
      },
      '/api/analytics': {
        target: process.env.ANALYTICS_URL || 'http://127.0.0.1:18080',
        changeOrigin: false,
        rewrite: () => '/events',
      },
    },
  },
});
