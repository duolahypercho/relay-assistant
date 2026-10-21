import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
export default defineConfig({
  plugins: [react()],
  server: {
    watch: {
      ignored: [
        '**/release/**',
        '**/native/mobile/**',
        '**/data/**',
        '**/test-results/**',
        '**/playwright-report/**',
      ],
    },
  },
  build: {
    sourcemap: false,
    chunkSizeWarningLimit: 850,
    rollupOptions: { input: { app: 'index.html', reconnect: 'native-connection.html' } },
  },
});
