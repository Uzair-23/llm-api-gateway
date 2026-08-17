import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// https://vite.dev/config/
export default defineConfig({
  plugins: [react()],
  server: {
    port: 3000,
    proxy: {
      '/auth': {
        target: 'http://44.216.227.72',
        changeOrigin: true,
      },
      '/v1': {
        target: 'http://44.216.227.72',
        changeOrigin: true,
      },
      '/dashboard': {
        target: 'http://44.216.227.72',
        changeOrigin: true,
      },
    },
  },
});