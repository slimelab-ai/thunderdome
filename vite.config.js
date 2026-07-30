import { defineConfig } from 'vite';

export default defineConfig({
  server: {
    proxy: {
      '/api/analytics': {
        target: process.env.ANALYTICS_URL || 'http://127.0.0.1:18080',
        changeOrigin: false,
        rewrite: () => '/events',
      },
    },
  },
});
