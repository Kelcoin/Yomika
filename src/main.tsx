// 字体加载：编译进包体，跨平台一致
// Inter Variable: 拉丁文，现代几何无衬线，略带人文感
// Noto Sans SC/JP Variable: 中日文，完整 CJK 支持
import '@fontsource-variable/inter';
import '@fontsource-variable/noto-sans-sc';
import '@fontsource-variable/noto-sans-jp';

import React from 'react';
import ReactDOM from 'react-dom/client';
import { BrowserRouter } from 'react-router-dom';

import { App } from './app/App';
import { initializeLayoutMode, setLayoutPlatform } from './lib/layoutMode';
import { getPlatformCapabilities } from './bridge/platform';
import './styles/tokens.css';
import './styles/base.css';
import './styles/shell.css';
import './styles/reader.css';
import './styles/visual-enhancements.css';

/* 软键盘的高度补偿（用户 2026-10-18：悬浮底栏不应该对软键盘进行避让）。
   Android WebView 按 index.html 里 `interactive-widget=resizes-content` 缩短布局视口，
   于是每条 `position: fixed` 的底栏都会跟着往上让位。这里把「视口被缩短了多少」写成
   `--keyboard-inset`（base.css 在 html 上预置 0px），悬浮底栏的 bottom 反向减掉它，
   屏幕上的位置就不再随键盘移动。基线取观察到的最大高度：键盘落下、视口回弹，
   差值自然归零。只认原生移动端（index.html 的 data-native-mobile）：桌面端把窗口
   拉矮不是键盘。 */
function trackKeyboardInset() {
  if (document.documentElement.dataset.nativeMobile !== 'true') return;
  const viewport = window.visualViewport;
  if (!viewport) return;
  let baseline = viewport.height;
  let width = viewport.width;
  const sync = () => {
    /* 换档（横竖屏切换）会把基线留在更高的那一档上——竖屏 800 变横屏 360 会被当成
       440px 的键盘，底栏被推到屏幕外。宽度变了就跟着新视口重取基线。 */
    if (viewport.width !== width) {
      width = viewport.width;
      baseline = viewport.height;
    }
    baseline = Math.max(baseline, viewport.height);
    const inset = Math.max(0, Math.round(baseline - viewport.height));
    document.documentElement.style.setProperty('--keyboard-inset', `${inset}px`);
  };
  viewport.addEventListener('resize', sync);
  sync();
}

initializeLayoutMode();
void getPlatformCapabilities().then((result) => {
  if (result.ok) setLayoutPlatform(result.value.platform);
});
trackKeyboardInset();

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <BrowserRouter>
      <App />
    </BrowserRouter>
  </React.StrictMode>,
);
