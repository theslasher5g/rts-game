import { defineConfig } from 'vite';

export default defineConfig({
  server: {
    port: 5173,
    open: false,
    // Mehrspieler: /ws → Relay-Server (npm run server, Port 8787)
    proxy: { '/ws': { target: 'ws://localhost:8787', ws: true, changeOrigin: true } },
  },
  build: { target: 'es2022', chunkSizeWarningLimit: 1500 },
});
