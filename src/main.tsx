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
import { installKeyboardAvoidance } from './lib/keyboardAvoidance';
import { initializeLayoutMode, setLayoutPlatform } from './lib/layoutMode';
import { getPlatformCapabilities } from './bridge/platform';
import './styles/tokens.css';
import './styles/base.css';
import './styles/shell.css';
import './styles/reader.css';
import './styles/visual-enhancements.css';

/* 软键盘的高度补偿与 iOS 的分层避让：细节见 src/lib/keyboardAvoidance.ts。 */
if (document.documentElement.dataset.nativeMobile === 'true') installKeyboardAvoidance();

initializeLayoutMode();
void getPlatformCapabilities().then((result) => {
  if (result.ok) setLayoutPlatform(result.value.platform);
});

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <BrowserRouter>
      <App />
    </BrowserRouter>
  </React.StrictMode>,
);
