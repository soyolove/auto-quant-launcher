import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

const SERVER_PORT = Number.parseInt(process.env['WEB_TERMINAL_SERVER_PORT'] ?? '8787', 10);

export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    proxy: {
      '/pty': {
        target: `ws://127.0.0.1:${SERVER_PORT}`,
        ws: true,
        changeOrigin: true,
      },
    },
  },
});
