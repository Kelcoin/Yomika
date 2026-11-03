import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { Link, MemoryRouter, Route, Routes } from 'react-router-dom';
import { MetadataEditRoute } from '../../src/components/MetadataEditRoute';
import { ToastProvider } from '../../src/components/Toast';
import { resetInvokeAdapterForTests, setInvokeAdapterForTests } from '../../src/bridge/invoke';
import { installTagTranslations } from '../../src/lib/tags';

afterEach(resetInvokeAdapterForTests);

describe('metadata editor navigation and plugins', () => {
  it('keeps the editor header and field skeleton while metadata is delayed', () => {
    setInvokeAdapterForTests(async () => new Promise(() => {}));
    render(<MemoryRouter><ToastProvider><MetadataEditRoute archiveId="a" /></ToastProvider></MemoryRouter>);
    expect(screen.getByRole('heading', { name: '编辑元数据' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: '返回上一页' })).toBeEnabled();
    expect(screen.getByRole('status', { name: '正在载入元数据' }).querySelector('.metadata-skeleton-summary')).not.toBeNull();
    expect(screen.queryByLabelText('标题')).toBeNull();
  });

  it('defaults to E-Hentai and returns to its actual home origin', async () => {
    const adapter = vi.fn(async (command: string) => {
      if (command === 'list_servers') return { ok: true, value: [{ id: 's', scopeId: 's', name: 'Server', baseUrl: 'https://example.com' }] };
      if (command === 'load_archive_metadata') return { ok: true, value: { archiveId: 'a', title: 'Title', filename: 'a.zip', tags: '', extension: 'zip', progress: 0, pageCount: 10, lastReadTime: 0, size: 100 } };
      if (command === 'list_metadata_plugins') return { ok: true, value: [{ id: 'other', name: 'Other' }, { id: 'eh', name: 'E-Hentai' }] };
      if (command === 'use_metadata_plugin') return { ok: true, value: { success: 1, data: { title: 'Plugin title', new_tags: 'artist:somebody, female:glasses' } } };
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
    await waitFor(() => expect(adapter).toHaveBeenCalledWith('use_metadata_plugin', { serverId: 's', archiveId: 'a', plugin: 'eh', arg: '' }));
    await waitFor(() => expect(screen.getByLabelText('标题')).toHaveValue('Plugin title'));
    expect(screen.getAllByText('female:glasses').length).toBeGreaterThan(0);
    fireEvent.click(screen.getByRole('button', { name: '返回上一页' }));
    expect(screen.getByRole('link', { name: '首页编辑' })).toBeInTheDocument();
    expect(screen.queryByText('错误详情页')).not.toBeInTheDocument();
  });
});

async function renderEditor(tags: string) {
  const adapter = vi.fn(async (command: string) => {
    if (command === 'list_servers') return { ok: true, value: [{ id: 's', scopeId: 's', name: 'Server', baseUrl: 'https://example.com' }] };
    if (command === 'load_archive_metadata') return { ok: true, value: { archiveId: 'a', title: 'Title', filename: 'a.zip', tags, extension: 'zip', progress: 0, pageCount: 10, lastReadTime: 0, size: 100 } };
    if (command === 'list_metadata_plugins') return { ok: true, value: [] };
    return { ok: false, error: { code: 'UNKNOWN', message: 'unused', retryable: false } };
  });
  setInvokeAdapterForTests(adapter);
  render(<MemoryRouter initialEntries={['/library/a/edit']}><ToastProvider><Routes>
    <Route path="/library/a/edit" element={<MetadataEditRoute archiveId="a" />} />
  </Routes></ToastProvider></MemoryRouter>);
  return { adapter, input: await screen.findByPlaceholderText(/输入标签后回车/) };
}

describe('metadata editor tags', () => {
  // 译文库是模块级的：装过的东西要清掉，否则后面的用例会带着它跑。
  afterEach(() => { installTagTranslations({}); });
  it('adds a suggested tag without the exact-query suffix', async () => {
    // 建议列表走**真实**那条路（装好的译文库 → searchTags），不 mock：setup 会预加载
    // MetadataEditRoute，测试文件里的 vi.mock 那时已经晚了。
    installTagTranslations({ female: { glasses: '眼镜' } });
    const { adapter, input } = await renderEditor('');
    fireEvent.focus(input);
    fireEvent.change(input, { target: { value: 'gla' } });
    const option = await screen.findByRole('option');
    // 候选行显示的也是标签本身，不是 `female:glasses$`（那是库检索的精确查询写法）。
    expect(option).toHaveTextContent('female:glasses');
    fireEvent.click(option);

    // 直接提表单：jsdom 不会因为点了 submit 按钮就替我们发 submit 事件。
    fireEvent.submit(document.querySelector('form.metadata-edit-form')!);
    await waitFor(() => expect(adapter).toHaveBeenCalledWith('update_archive_metadata', expect.objectContaining({
      metadata: expect.objectContaining({ tags: 'female:glasses' }),
    })));
  });

  it('does not add a tag that is already there, however it is spelled', async () => {
    const { adapter, input } = await renderEditor('artist:somebody, female:glasses');
    // 完全一样、大小写与空白不同、带精确后缀——三种写法都是同一条。
    for (const spelled of ['artist:somebody', 'Artist: somebody', 'female:glasses$']) {
      fireEvent.change(input, { target: { value: spelled } });
      fireEvent.keyDown(input, { key: 'Enter' });
    }
    // 保存时写下去的仍然只有两条（第二、三种写法被认成同一条丢掉了）。
    fireEvent.submit(document.querySelector('form.metadata-edit-form')!);
    await waitFor(() => expect(adapter).toHaveBeenCalledWith('update_archive_metadata', expect.objectContaining({
      metadata: expect.objectContaining({ tags: 'artist:somebody, female:glasses' }),
    })));
  });

  it('saves a pending draft using the same tag identity as the chips', async () => {
    const { adapter, input } = await renderEditor('artist:somebody');
    fireEvent.change(input, { target: { value: 'Artist: somebody$, female:glasses' } });
    fireEvent.submit(document.querySelector('form.metadata-edit-form')!);
    await waitFor(() => expect(adapter).toHaveBeenCalledWith('update_archive_metadata', expect.objectContaining({
      metadata: expect.objectContaining({ tags: 'artist:somebody, female:glasses' }),
    })));
    expect(input).toHaveValue('');
  });

  it('commits the suggested tag once rather than also adding the unfinished token', async () => {
    installTagTranslations({ female: { glasses: '眼镜' } });
    const { adapter, input } = await renderEditor('');
    fireEvent.focus(input);
    fireEvent.change(input, { target: { value: 'gla' } });
    await screen.findByRole('option');
    fireEvent.keyDown(input, { key: 'Enter', isComposing: true });
    expect(input).toHaveValue('gla');
    fireEvent.keyDown(input, { key: 'Enter' });
    fireEvent.submit(document.querySelector('form.metadata-edit-form')!);
    await waitFor(() => expect(adapter).toHaveBeenCalledWith('update_archive_metadata', expect.objectContaining({
      metadata: expect.objectContaining({ tags: 'female:glasses' }),
    })));
  });
});
