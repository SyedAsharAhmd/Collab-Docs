import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  server: {
    // In dev the browser only talks to Vite, which forwards /api to Express.
    // Same origin means no CORS setup is needed locally.
    proxy: { '/api': 'http://localhost:3001' },
  },
});
