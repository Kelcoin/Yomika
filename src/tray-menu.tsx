/** 托盘右键菜单那个小窗口的入口（`tray-menu.html`）。
 *
 * 只挂菜单本身，不挂应用外壳——它和主窗是两个文档，共享的是 tokens 那一层。 */
import React from 'react';
import ReactDOM from 'react-dom/client';

import { TrayMenu } from './components/TrayMenu';
import './styles/tokens.css';
import './styles/tray-menu.css';

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <TrayMenu />
  </React.StrictMode>,
);
