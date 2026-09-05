import { readFileSync } from 'node:fs';
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

const pkg = JSON.parse(readFileSync(new URL('./package.json', import.meta.url), 'utf8')) as {
  version: string;
  author?: string;
  license?: string;
  repository?: { url?: string };
};

export default defineConfig({
  plugins: [react()],
  clearScreen: false,
  // The About page shows the shipped version; reading it from package.json keeps
  // a second copy from going stale.
  define: {
    __APP_VERSION__: JSON.stringify(pkg.version),
    __APP_AUTHOR__: JSON.stringify(pkg.author ?? ''),
    __APP_LICENSE__: JSON.stringify(pkg.license ?? ''),
    __APP_REPOSITORY__: JSON.stringify(pkg.repository?.url ?? ''),
  },
  server: {
    strictPort: true,
  },
});
