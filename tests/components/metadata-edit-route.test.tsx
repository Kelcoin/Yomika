import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { Link, MemoryRouter, Route, Routes } from 'react-router-dom';
import { MetadataEditRoute } from '../../src/components/MetadataEditRoute';
import { ToastProvider } from '../../src/components/Toast';
import { resetInvokeAdapterForTests, setInvokeAdapterForTests } from '../../src/bridge/invoke';

afterEach(resetInvokeAdapterForTests);

describe('metadata editor navigation and plugins', () => {
  it('defaults to E-Hentai and returns to its actual home origin', async () => {
    const adapter = vi.fn(async (command: string) => {
      if (command === 'list_servers') return { ok: true, value: [{ id: 's', scopeId: 's', name: 'Server', baseUrl: 'https://example.com' }] };
      if (command === 'load_archive_metadata') return { ok: true, value: { archiveId: 'a', title: 'Title', filename: 'a.zip', tags: '', extension: 'zip', progress: 0, pageCount: 10, lastReadTime: 0, size: 100 } };
      if (command === 'list_metadata_plugins') return { ok: true, value: [{ id: 'other', name: 'Other' }, { id: 'eh', name: 'E-Hentai' }] };
      if (command === 'use_metadata_plugin') return { ok: true, value: {} };
      return { ok: false, error: { code: 'UNKNOWN', message: 'unused', retryable: false } };
    });
    setInvokeAdapterForTests(adapter);
    render(<MemoryRouter><ToastProvider><Routes>
      <Route path="/" element={<Link to="/library/a/edit" state={{ returnTo: '/' }}>首页编辑</Link>} />
      <Route path="/library/a/edit" element={<MetadataEditRoute archiveId="a" />} />
      <Route path="/library/a" element={<p>错误详情页</p>} />
    </Routes></ToastProvider></MemoryRouter>);
    fireEvent.click(screen.getByRole('link', { name: '首页编辑' }));
    const select = await screen.findByRole('button', { name: /E-Hentai/ });
    fireEvent.click(select);
    expect(screen.getByRole('listbox', { name: '元数据插件' })).toBeInTheDocument();
    fireEvent.click(screen.getAllByRole('option', { name: 'E-Hentai' }).at(-1)!);
    fireEvent.click(screen.getByRole('button', { name: '执行插件' }));
    await waitFor(() => expect(adapter).toHaveBeenCalledWith('use_metadata_plugin', { serverId: 's', archiveId: 'a', plugin: 'eh', arg: 'Title' }));
    fireEvent.click(screen.getByRole('button', { name: '返回上一页' }));
    expect(screen.getByRole('link', { name: '首页编辑' })).toBeInTheDocument();
    expect(screen.queryByText('错误详情页')).not.toBeInTheDocument();
  });
});
