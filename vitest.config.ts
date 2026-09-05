import { readFileSync } from 'node:fs';
import { defineConfig } from 'vitest/config';
import react from '@vitejs/plugin-react';

const pkg = JSON.parse(readFileSync(new URL('./package.json', import.meta.url), 'utf8')) as {
  version: string;
  author?: string;
  license?: string;
  repository?: { url?: string };
};

export default defineConfig({
  plugins: [react()],
  define: {
    __APP_VERSION__: JSON.stringify(pkg.version),
    __APP_AUTHOR__: JSON.stringify(pkg.author ?? ''),
    __APP_LICENSE__: JSON.stringify(pkg.license ?? ''),
    __APP_REPOSITORY__: JSON.stringify(pkg.repository?.url ?? ''),
  },
  test: {
    environment: 'jsdom',
    globals: true,
    setupFiles: ['./tests/setup.ts'],
    // `docs/` holds read-only copies of reference projects (LANreader, JHenTai,
    // ComicReadScript…), and their own test files are not ours to run — they
    // fail on dependencies this project does not have.
    exclude: ['**/node_modules/**', '**/dist/**', 'docs/**'],
  },
});
