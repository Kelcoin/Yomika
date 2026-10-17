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
import './styles/tokens.css';
import './styles/base.css';
import './styles/shell.css';
import './styles/reader.css';
import './styles/visual-enhancements.css';

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <BrowserRouter>
      <App />
    </BrowserRouter>
  </React.StrictMode>,
);
