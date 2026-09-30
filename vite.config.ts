import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

const pkg = JSON.parse(readFileSync(new URL('./package.json', import.meta.url), 'utf8')) as {
  version: string;
  author?: string;
  license?: string;
  repository?: { url?: string };
};
const entry = (name: string) => fileURLToPath(new URL(name, import.meta.url));

export default defineConfig({
  plugins: [react()],
  cacheDir: '.vite-cache',
  clearScreen: false,
  // 第二个入口：托盘右键菜单那个小窗口（见 src-tauri/src/tray_menu.rs）。它只挂菜单
  // 本身、不挂应用外壳，所以是独立文档而不是 index.html 的一条分支——为两条菜单项把
  // 整个应用 bundle 拉进第二个 WebView 不值当。
  build: {
    rollupOptions: {
      input: {
        main: entry('./index.html'),
        'tray-menu': entry('./tray-menu.html'),
      },
    },
  },
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
