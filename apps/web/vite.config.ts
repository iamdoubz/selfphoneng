// SPDX-License-Identifier: AGPL-3.0-or-later
import { defaultClientConditions, defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';

export default defineConfig({
  plugins: [react(), tailwindcss()],
  resolve: { conditions: ['source', ...defaultClientConditions] }, // workspace packages ship TS source
  server: {
    proxy: {
      // Same split as the reverse proxy (01 §5): /ws is Asterisk SIP-over-WebSocket, the rest is the api.
      '/api': { target: 'http://127.0.0.1:8080', ws: true },
      '/ws': { target: 'ws://127.0.0.1:8088', ws: true },
    },
  },
});
