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

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <BrowserRouter>
      <App />
    </BrowserRouter>
  </React.StrictMode>,
);
