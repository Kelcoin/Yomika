import { render, screen, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';

import { App } from '../../src/app/App';

function renderAt(path = '/') {
  return render(
    <MemoryRouter initialEntries={[path]}>
      <App />
    </MemoryRouter>,
  );
}

describe('application shell', () => {
  it('exposes full desktop navigation and compact five-item navigation', () => {
    renderAt();

    const desktop = screen.getByRole('navigation', { name: '主导航' });
    expect(within(desktop).getByRole('link', { name: '下载' })).toBeInTheDocument();
    expect(within(desktop).getByRole('link', { name: '同步' })).toBeInTheDocument();

    const compact = screen.getByRole('navigation', { name: '移动导航' });
    expect(within(compact).getAllByRole('link')).toHaveLength(6);
    expect(within(compact).getByRole('link', { name: 'E-Hentai' })).toBeInTheDocument();
    expect(within(compact).queryByRole('link', { name: '下载' })).not.toBeInTheDocument();
    expect(within(compact).queryByRole('link', { name: '同步' })).not.toBeInTheDocument();
  });

  it('marks the current route and renders its workspace heading', () => {
    renderAt('/library');

    const desktop = screen.getByRole('navigation', { name: '主导航' });
    expect(within(desktop).getByRole('link', { name: '档案库', current: 'page' })).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: '档案库' })).toBeInTheDocument();
  });

  it('offers server setup from the first-run home', () => {
    renderAt();

    expect(screen.getByRole('link', { name: '添加服务器' })).toHaveAttribute('href', '/settings');
  });

  it('announces connection, sync, task, and cache status', () => {
    renderAt();

    expect(screen.getByRole('status', { name: '连接状态' })).toHaveTextContent('未连接');
    expect(screen.getByRole('status', { name: '同步状态' })).toHaveTextContent('未配置');
    expect(screen.getByRole('status', { name: '任务状态' })).toHaveTextContent('0');
    expect(screen.getByRole('status', { name: '缓存状态' })).toHaveTextContent('0 B');
  });

  it('keeps tooltip icon controls accessible by name', () => {
    renderAt();

    expect(screen.getByRole('button', { name: '搜索' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: '任务中心' })).toBeInTheDocument();
  });
});
