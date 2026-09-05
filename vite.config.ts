import { readFileSync } from 'node:fs';
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

const { version } = JSON.parse(readFileSync(new URL('./package.json', import.meta.url), 'utf8')) as { version: string };

export default defineConfig({
  plugins: [react()],
  clearScreen: false,
  // The About page shows the shipped version; reading it from package.json keeps
  // a second copy from going stale.
  define: { __APP_VERSION__: JSON.stringify(version) },
  server: {
    strictPort: true,
  },
});
