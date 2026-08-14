import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// https://vite.dev/config/
export default defineConfig({
  plugins: [react()],
  server: {
    port: 3000,
    proxy: {
      '/auth': {
        target: 'http://localhost:4000',
        changeOrigin: true,
      },
      '/v1': {
        target: 'http://localhost:4000',
        changeOrigin: true,
      },
      '/dashboard': {
        target: 'http://localhost:4000',
        changeOrigin: true,
      },
    },
  },
});
