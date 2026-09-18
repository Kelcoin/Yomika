import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, vi } from 'vitest';
import { MemoryRouter } from 'react-router-dom';

import { App } from '../../src/app/App';
import { resetInvokeAdapterForTests, setInvokeAdapterForTests } from '../../src/bridge/invoke';

afterEach(resetInvokeAdapterForTests);

const archiveId = 'a'.repeat(40);
const localFile = {
  path: 'E:\\Downloads\\aaaa-测试档案.cbz',
  archiveId,
  serverId: 'server-a',
  scopeId: 'scope-a',
  title: '测试档案',
  fileSize: 100 * 1024 * 1024,
  addedAt: 1_760_000_000_000,
  pageCount: 12,
  tags: ['artist:someone'],
};
const runningTask = {
  id: 'task-1',
  kind: 'download',
  label: '下载 demo.cbz',
  status: 'running',
  progress: 0.5,
  cancelable: true,
  retryable: true,
  createdAt: '2026-08-26T00:00:00Z',
  updatedAt: '2026-08-26T00:01:00Z',
  archiveId,
  serverId: 'server-a',
  localPath: 'E:\\Downloads\\aaaa-demo.cbz.part',
  totalBytes: 200 * 1024 * 1024,
  receivedBytes: 100 * 1024 * 1024,
  bytesPerSecond: 5 * 1024 * 1024,
};

function renderPage() {
  render(<MemoryRouter initialEntries={['/downloads']}><App /></MemoryRouter>);
}

describe('local archives workspace', () => {
  it('lists the files in the download directory and filters them by name', async () => {
    const user = userEvent.setup();
    setInvokeAdapterForTests(async (command) => {
      if (command === 'list_local_archives') {
        return { ok: true, value: [localFile, { ...localFile, path: 'E:\\Downloads\\bbb-另一份.zip', title: '另一份', fileSize: 20 * 1024 * 1024, archiveId: null, serverId: null, scopeId: null, tags: [] }] };
      }
      if (command === 'list_search_presets' || command === 'list_tasks') return { ok: true, value: [] };
      throw new Error(`Unexpected command: ${command}`);
    });

    renderPage();

    expect(await screen.findByText('测试档案')).toBeInTheDocument();
    expect(screen.getByText('另一份')).toBeInTheDocument();
    // 大小和下载时间代替了档案库那行的「几页 / 加入时间」。
    expect(screen.getByText(/100\.0 MB · /)).toBeInTheDocument();
    expect(screen.getByText(/20\.0 MB · /)).toBeInTheDocument();

    // 本地过滤，不认识服务器：每次按键就能收窄。
    await user.type(screen.getByRole('searchbox', { name: '搜索本地档案…' }), '另一');
    expect(screen.queryByText('测试档案')).not.toBeInTheDocument();
    expect(screen.getByText('另一份')).toBeInTheDocument();
  });

  it('runs the multi-select controls to the right of the preset button', async () => {
    setInvokeAdapterForTests(async (command) => {
      if (command === 'list_local_archives') return { ok: true, value: [localFile] };
      if (command === 'list_search_presets' || command === 'list_tasks') return { ok: true, value: [] };
      throw new Error(`Unexpected command: ${command}`);
    });

    renderPage();

    const preset = await screen.findByRole('button', { name: '检索预设' });
    const select = screen.getByRole('button', { name: '多选' });
    // 多选紧跟在预设按钮右边，和档案库把工具栏收起来时的位置一致。
    expect(preset.closest('.search-preset-field')?.nextElementSibling).toBe(select);
  });

  it('deletes the selected files from disk and leaves the server alone', async () => {
    const user = userEvent.setup();
    const adapter = vi.fn(async (command: string, args?: Record<string, unknown>) => {
      if (command === 'list_local_archives') return { ok: true, value: [localFile] };
      if (command === 'list_search_presets' || command === 'list_tasks') return { ok: true, value: [] };
      if (command === 'delete_local_archives') {
        expect(args?.paths).toEqual([localFile.path]);
        return { ok: true, value: 1 };
      }
      throw new Error(`Unexpected command: ${command}`);
    });
    setInvokeAdapterForTests(adapter);

    renderPage();

    await screen.findByText('测试档案');
    await user.click(screen.getByRole('button', { name: '多选' }));
    await user.click(screen.getByRole('checkbox', { name: '选择 测试档案' }));
    expect(screen.getByText('已选 1 个')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: '删除所选' }));

    // 说清楚删的是什么：本地文件，不是服务器上的那份档案。
    expect(screen.getByText(/服务器上的档案不受影响/)).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: '确认删除' }));

    await waitFor(() => expect(adapter).toHaveBeenCalledWith('delete_local_archives', { paths: [localFile.path] }));
    expect(adapter.mock.calls.some(([command]) => command === 'delete_archive')).toBe(false);
  });

  it('shows a running download with its progress, speed and controls', async () => {
    setInvokeAdapterForTests(async (command) => {
      if (command === 'list_local_archives') return { ok: true, value: [] };
      if (command === 'list_search_presets') return { ok: true, value: [] };
      if (command === 'list_tasks') return { ok: true, value: [runningTask] };
      throw new Error(`Unexpected command: ${command}`);
    });

    renderPage();

    expect(await screen.findByText('demo.cbz')).toBeInTheDocument();
    expect(screen.getByText('50% · 100.0 MB / 200.0 MB · 5.0 MB/s')).toBeInTheDocument();
    expect(screen.getByRole('progressbar', { name: 'demo.cbz进度' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: '暂停demo.cbz' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: '中止demo.cbz' })).toBeInTheDocument();
  });

  it('pauses and aborts a download through the native commands', async () => {
    const user = userEvent.setup();
    let status = 'running';
    const adapter = vi.fn(async (command: string) => {
      if (command === 'list_local_archives' || command === 'list_search_presets') return { ok: true, value: [] };
      if (command === 'list_tasks') return { ok: true, value: [{ ...runningTask, status }] };
      if (command === 'pause_download') { status = 'paused'; return { ok: true, value: null }; }
      if (command === 'cancel_download') { status = 'cancelled'; return { ok: true, value: null }; }
      throw new Error(`Unexpected command: ${command}`);
    });
    setInvokeAdapterForTests(adapter);

    renderPage();

    await user.click(await screen.findByRole('button', { name: '暂停demo.cbz' }));
    expect(adapter).toHaveBeenCalledWith('pause_download', { taskId: 'task-1' });
    // 暂停之后同一个位置换成恢复，旁边还是中止。
    expect(await screen.findByRole('button', { name: '恢复demo.cbz' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: '中止demo.cbz' })).toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: '中止demo.cbz' }));
    expect(adapter).toHaveBeenCalledWith('cancel_download', { taskId: 'task-1' });
    // 中止的任务不再占着列表：半份文件已经删掉了。
    await waitFor(() => expect(screen.queryByText('demo.cbz')).not.toBeInTheDocument());
  });

  it('resumes an interrupted download and reports where it landed', async () => {
    const user = userEvent.setup();
    const adapter = vi.fn(async (command: string) => {
      if (command === 'list_local_archives') return { ok: true, value: [] };
      if (command === 'list_search_presets') return { ok: true, value: [] };
      if (command === 'list_tasks') return { ok: true, value: [{ ...runningTask, status: 'paused', progress: 0.5 }] };
      if (command === 'resume_download') return { ok: true, value: { status: 'completed', path: 'E:\\Downloads\\aaaa-demo.cbz', taskId: 'task-1' } };
      throw new Error(`Unexpected command: ${command}`);
    });
    setInvokeAdapterForTests(adapter);

    renderPage();

    await user.click(await screen.findByRole('button', { name: '恢复demo.cbz' }));
    expect(adapter).toHaveBeenCalledWith('resume_download', { taskId: 'task-1' });
    expect(await screen.findByText('下载完成')).toBeInTheDocument();
  });
});
