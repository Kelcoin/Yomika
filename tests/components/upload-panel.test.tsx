import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, vi } from 'vitest';
import { MemoryRouter } from 'react-router-dom';

import { App } from '../../src/app/App';
import { RetainedPage } from '../../src/app/RetainedPage';
import { UploadPanel } from '../../src/components/UploadPanel';
import { resetInvokeAdapterForTests, setInvokeAdapterForTests } from '../../src/bridge/invoke';
import { resetFilePickerForTests, setArchiveFilesPickerForTests } from '../../src/bridge/filePicker';
import { resetFileDropForTests, setFileDropForTests, type FileDropHandlers } from '../../src/bridge/fileDrop';

afterEach(() => {
  resetInvokeAdapterForTests();
  resetFilePickerForTests();
  resetFileDropForTests();
});

const preferences = { theme: 'system', defaultLayout: 'auto', defaultDirection: 'ltr', cacheMaxBytes: 2_147_483_648 };
const server = { id: 'scope-a', name: 'Home', baseUrl: 'https://example.com', scopeId: 'scope-a' };

function baseAdapter(extra: (command: string, args?: Record<string, unknown>) => unknown) {
  return vi.fn(async (command: string, args?: Record<string, unknown>) => {
    if (command === 'load_preferences') return { ok: true, value: preferences };
    if (command === 'list_servers') return { ok: true, value: [server] };
    if (command === 'list_archives' || command === 'list_tasks') return { ok: true, value: [] };
    if (command === 'cache_stats') return { ok: true, value: { imageBytes: 0, imageEntries: 0, maxBytes: 2_147_483_648 } };
    const handled = extra(command, args);
    if (handled !== undefined) return handled;
    throw new Error(`Unexpected command: ${command}`);
  });
}

// Upload and dedup are full routes now; the settings tools section is an index
// of links to them.
function renderUpload() {
  return render(<MemoryRouter initialEntries={['/tools/upload']}><App /></MemoryRouter>);
}

describe('archive upload', () => {
  it('retains both intake forms in one sizing track when switching tabs', async () => {
    setInvokeAdapterForTests(baseAdapter(() => undefined));
    const user = userEvent.setup();
    const view = render(<MemoryRouter><UploadPanel /></MemoryRouter>);
    const stage = view.container.querySelector('.upload-source-stage')!;
    expect(stage.children).toHaveLength(2);
    const local = stage.children[0];
    const internet = stage.children[1];
    await user.click(screen.getByRole('tab', { name: '从互联网添加' }));
    expect(local).toHaveAttribute('hidden');
    expect(internet).not.toHaveAttribute('hidden');
    await user.type(screen.getByRole('textbox'), 'https://example.com/archive');
    await user.click(screen.getByRole('tab', { name: '从本地添加' }));
    await user.click(screen.getByRole('tab', { name: '从互联网添加' }));
    expect(screen.getByRole('textbox')).toHaveValue('https://example.com/archive');
  });
  it('recovers from a failed file picker and permits another selection', async () => {
    const user = userEvent.setup();
    setInvokeAdapterForTests(baseAdapter(() => undefined));
    let attempts = 0;
    setArchiveFilesPickerForTests(async () => {
      if (++attempts === 1) throw new Error('文件选择器暂不可用');
      return ['C:/library/recovered.cbz'];
    });
    renderUpload();
    await user.click(await screen.findByRole('button', { name: '选择文件' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('文件选择器暂不可用');
    await user.click(screen.getByRole('button', { name: '选择文件' }));
    expect(await screen.findByText('recovered.cbz')).toBeInTheDocument();
  });

  it('retries failed uploads without resubmitting successful items or retaining the old error', async () => {
    const user = userEvent.setup();
    let attempts = 0;
    let finishRetry!: (value: unknown) => void;
    const adapter = baseAdapter((command, args) => {
      if (command !== 'download_url') return undefined;
      if (args?.url === 'https://example.com/ok') return { ok: true, value: { job: 1, url: args.url } };
      if (++attempts === 1) return { ok: false, error: { code: 'REMOTE_UNAVAILABLE', message: '暂时无法下载', retryable: true } };
      return new Promise((resolve) => { finishRetry = resolve; });
    });
    setInvokeAdapterForTests(adapter);
    renderUpload();
    await user.click(await screen.findByRole('tab', { name: '从互联网添加' }));
    await user.type(screen.getByLabelText('要下载的链接（一行一个）'), 'https://example.com/ok\nhttps://example.com/retry');
    await user.click(screen.getByRole('button', { name: '加入队列' }));
    await user.click(screen.getByRole('button', { name: '开始处理' }));
    const queue = within(screen.getByRole('list'));
    expect(await queue.findByText('暂时无法下载')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: '重试失败项' }));
    await vi.waitFor(() => expect(finishRetry).toBeDefined());
    expect(queue.queryByText('暂时无法下载')).not.toBeInTheDocument();
    expect(queue.getByText('处理中')).toBeInTheDocument();
    finishRetry({ ok: true, value: { job: 2, url: 'https://example.com/retry' } });
    expect(await queue.findByText('服务器作业 #2')).toBeInTheDocument();
    expect(adapter.mock.calls.filter(([command, args]) => command === 'download_url' && args?.url === 'https://example.com/ok')).toHaveLength(1);
    expect(screen.queryByRole('button', { name: '重试失败项' })).not.toBeInTheDocument();
  });

  it('only listens for window file drops while the upload page is visible', () => {
    const unsubscribe = vi.fn();
    const subscribe = vi.fn(() => unsubscribe);
    setFileDropForTests(subscribe);
    const view = (active: boolean) => <MemoryRouter><RetainedPage active={active}><UploadPanel /></RetainedPage></MemoryRouter>;
    const { rerender } = render(view(false));
    expect(subscribe).not.toHaveBeenCalled();
    rerender(view(true));
    expect(subscribe).toHaveBeenCalledTimes(1);
    rerender(view(false));
    expect(unsubscribe).toHaveBeenCalledTimes(1);
  });

  it('queues picked files and uploads them one at a time', async () => {
    const user = userEvent.setup();
    const adapter = baseAdapter((command) => {
      if (command === 'create_task') {
        return { ok: true, value: { id: 'task-1', kind: 'download', label: '上传', status: 'queued', progress: 0, cancelable: true, retryable: true, createdAt: '2026-08-26T00:00:00Z', updatedAt: '2026-08-26T00:00:00Z' } };
      }
      if (command === 'upload_archive') return { ok: true, value: { operation: 'upload', success: 1, id: 'archive-1' } };
      return undefined;
    });
    setInvokeAdapterForTests(adapter);
    setArchiveFilesPickerForTests(async () => ['C:/library/demo.cbz', 'C:/library/other.zip', 'C:/library/notes.txt']);

    renderUpload();
    await user.click(await screen.findByRole('button', { name: '选择文件' }));

    // The unsupported file is not queued.
    const queue = await screen.findByRole('list');
    expect(within(queue).getAllByRole('listitem')).toHaveLength(2);
    expect(within(queue).getByText('demo.cbz')).toBeInTheDocument();
    expect(within(queue).queryByText('notes.txt')).not.toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: '开始处理' }));

    expect(adapter).toHaveBeenCalledWith('upload_archive', { serverId: 'scope-a', taskId: 'task-1', filePath: 'C:/library/demo.cbz' });
    expect(adapter).toHaveBeenCalledWith('upload_archive', { serverId: 'scope-a', taskId: 'task-1', filePath: 'C:/library/other.zip' });
    await vi.waitFor(() => expect(within(screen.getByRole('list')).getAllByText('已上传')).toHaveLength(2));
  });

  it('queues files dropped on the window, which is the only drop the webview reports', async () => {
    // Tauri handles drag and drop natively, so HTML5 drop events never fire and
    // this is the only path a dropped file can arrive by.
    let handlers: FileDropHandlers | undefined;
    setFileDropForTests((incoming) => { handlers = incoming; return () => { handlers = undefined; }; });
    setInvokeAdapterForTests(baseAdapter(() => undefined));

    renderUpload();
    await screen.findByRole('button', { name: '选择文件' });

    handlers?.onEnter?.();
    expect(await screen.findByText('松手即加入队列')).toBeInTheDocument();
    handlers?.onDrop(['D:/incoming/dropped.cbz']);

    expect(await screen.findByText('dropped.cbz')).toBeInTheDocument();
  });

  it('hands links to the server downloader and reports the queued job', async () => {
    const user = userEvent.setup();
    const adapter = baseAdapter((command) => {
      if (command === 'download_url') return { ok: true, value: { job: 86, url: 'https://example.com/g/1/abc' } };
      return undefined;
    });
    setInvokeAdapterForTests(adapter);

    renderUpload();
    await user.click(await screen.findByRole('tab', { name: '从互联网添加' }));
    // 字段名与下面的统计是必要信息，唯独解释下载插件的那句灰字去掉。
    expect(document.querySelector('.upload-hint')).toBeNull();
    expect(screen.queryByText('链接交给 LANraragi 自己下载，由服务器决定使用哪个下载插件。')).toBeNull();
    await user.type(screen.getByLabelText('要下载的链接（一行一个）'), 'https://example.com/g/1/abc\nnot-a-url');

    expect(screen.getByText('1 个有效链接')).toBeInTheDocument();
    expect(screen.getByText('1 个无法识别')).toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: '加入队列' }));
    await user.click(screen.getByRole('button', { name: '开始处理' }));

    expect(adapter).toHaveBeenCalledWith('download_url', { serverId: 'scope-a', url: 'https://example.com/g/1/abc', categoryId: null });
    expect(await screen.findByText('服务器作业 #86')).toBeInTheDocument();
    // The unrecognised line stays in the box rather than disappearing with the
    // queued one.
    expect(screen.getByLabelText('要下载的链接（一行一个）')).toHaveValue('not-a-url');
  });

  it('marks only the failed item as failed and keeps its reason', async () => {
    const user = userEvent.setup();
    setInvokeAdapterForTests(baseAdapter((command) => {
      if (command === 'download_url') return { ok: false, error: { code: 'REMOTE_UNAVAILABLE', message: '没有插件能处理该链接', retryable: false } };
      return undefined;
    }));

    renderUpload();
    await user.click(await screen.findByRole('tab', { name: '从互联网添加' }));
    await user.type(screen.getByLabelText('要下载的链接（一行一个）'), 'https://example.com/g/2/def');
    await user.click(screen.getByRole('button', { name: '加入队列' }));
    await user.click(screen.getByRole('button', { name: '开始处理' }));

    expect(await screen.findByText('没有插件能处理该链接')).toBeInTheDocument();
  });

  it('keeps deduplication on its own route without the Readoshi import', async () => {
    setInvokeAdapterForTests(baseAdapter(() => undefined));

    render(<MemoryRouter initialEntries={['/tools/dedup']}><App /></MemoryRouter>);

    expect(await screen.findByRole('button', { name: /开始扫描/ })).toBeInTheDocument();
    expect(screen.queryByRole('heading', { name: '导入 Readoshi 不重复关系' })).not.toBeInTheDocument();
  });

  it('reaches both tools from the settings index', async () => {
    setInvokeAdapterForTests(baseAdapter(() => undefined));

    render(<MemoryRouter initialEntries={['/settings?section=tools']}><App /></MemoryRouter>);

    // Each entry is a card that says what the tool does, so the accessible name
    // carries the description too.
    expect(await screen.findByRole('link', { name: /^上传档案/ })).toHaveAttribute('href', '/tools/upload');
    expect(screen.getByRole('link', { name: /^重复档案查重/ })).toHaveAttribute('href', '/tools/dedup');
  });
});
