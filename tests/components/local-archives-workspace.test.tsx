import { render, screen, waitFor, within } from '@testing-library/react';
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

  it('ranks and trims the row tags exactly like a library row', async () => {
    setInvokeAdapterForTests(async (command) => {
      if (command === 'list_local_archives') {
        return { ok: true, value: [{ ...localFile, tags: ['language:chinese', 'source:https://e-hentai.org/g/1/abc', 'category:doujinshi', 'date_added:1758000000', 'female:glasses'] }] };
      }
      if (command === 'list_search_presets' || command === 'list_tasks') return { ok: true, value: [] };
      throw new Error(`Unexpected command: ${command}`);
    });

    renderPage();

    const row = (await screen.findByText('测试档案')).closest('.archive-row');
    expect(row).not.toBeNull();
    const chips = [...row!.querySelectorAll('.archive-row-tags .metadata-chip')].map((chip) => chip.textContent);
    // 记账用的命名空间不上卡片（原来它们会当标签摆出来，源地址还排在第一个）。
    expect(chips.join(' ')).not.toContain('e-hentai.org');
    expect(chips.join(' ')).not.toContain('doujinshi');
    expect(chips.join(' ')).not.toContain('1758000000');
    // 顺序按命名空间优先级，不按服务器给的次序：female 排在 language 前面。
    expect(chips.join(' ')).toContain('glasses');
    expect(chips.findIndex((chip) => chip?.includes('glasses'))).toBeLessThan(chips.findIndex((chip) => chip?.includes('chinese')));
  });

  it('opens the archive detail panes for a local file, not a private layout', async () => {
    const user = userEvent.setup();
    setInvokeAdapterForTests(async (command) => {
      if (command === 'list_local_archives') {
        return { ok: true, value: [localFile, { ...localFile, path: 'E:\\Downloads\\bbb-另一份.zip', title: '另一份', archiveId: null, serverId: null, scopeId: null, tags: ['language:chinese'] }] };
      }
      if (command === 'list_search_presets' || command === 'list_tasks') return { ok: true, value: [] };
      throw new Error(`Unexpected command: ${command}`);
    });

    renderPage();

    await user.click(await screen.findByText('测试档案'));

    // 详情面板用的就是档案详情页那几块：事实网格、按命名空间分组的标签墙。
    const facts = document.querySelector('.archive-detail-facts');
    expect(facts).not.toBeNull();
    expect(document.querySelector('.local-detail-facts')).toBeNull();
    expect(screen.getByLabelText('分类')).toBeInTheDocument();
    expect(screen.queryByLabelText('路径')).toBeNull();
    expect(screen.getByLabelText('体积')).toBeInTheDocument();
    expect(document.querySelector('.archive-detail-tag-section .tag-group-artist')).not.toBeNull();

    // 标签芯片筛的是这一页的列表，不是去档案库搜。
    await user.click(screen.getByRole('button', { name: '筛选 someone' }));
    const list = within(document.querySelector('.local-archives-list') as HTMLElement);
    expect(list.getByText('测试档案')).toBeInTheDocument();
    expect(list.queryByText('另一份')).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: '本地删除' })).toBeInTheDocument();
  });

  it('keeps the empty state off the screen until the archive list has landed', async () => {
    let resolveArchives: () => void = () => undefined;
    setInvokeAdapterForTests(async (command) => {
      if (command === 'list_local_archives') {
        return new Promise((resolve) => { resolveArchives = () => resolve({ ok: true, value: [localFile] }); });
      }
      if (command === 'list_search_presets' || command === 'list_tasks') return { ok: true, value: [] };
      throw new Error(`Unexpected command: ${command}`);
    });

    renderPage();

    // 任务列表先落地也不能代表档案读完了：空状态放行得太早，就会先闪一下
    // 「还没有下载过档案」再变成有数据的样子。
    await screen.findByText('正在读取本地档案…');
    expect(screen.queryByText('还没有下载过档案')).not.toBeInTheDocument();
    resolveArchives();
    expect(await screen.findByText('测试档案')).toBeInTheDocument();
    expect(screen.queryByText('还没有下载过档案')).not.toBeInTheDocument();
  });

  it('reads a local file through the server copy it was downloaded from', async () => {
    const user = userEvent.setup();
    const noSource = { ...localFile, path: 'E:\\Downloads\\bbb-另一份.zip', title: '另一份', archiveId: null, serverId: null, scopeId: null };
    const adapter = vi.fn(async (command: string) => {
      if (command === 'list_local_archives') return { ok: true, value: [localFile, noSource] };
      if (command === 'list_search_presets' || command === 'list_tasks') return { ok: true, value: [] };
      if (command === 'platform_capabilities') return { ok: true, value: { platform: 'windows', native: true, secureStorage: true, fileSystem: true, backgroundTasks: false, nativeInference: true } };
      if (command === 'reveal_in_file_manager') return { ok: true, value: null };
      throw new Error(`Unexpected command: ${command}`);
    });
    setInvokeAdapterForTests(adapter);
    // 平台桥在浏览器里短路成 browser；摆一个运行时标记让 capabilities 真的走适配器。
    Object.defineProperty(window, '__TAURI_INTERNALS__', { configurable: true, value: { invoke: async () => null } });

    renderPage();

    await user.click(await screen.findByText('测试档案'));
    // 认得出下载来源：阅读走档案详情页同一个入口，按服务器档案出页。
    expect(screen.getByRole('link', { name: '阅读' })).toHaveAttribute('href', `/reader/${archiveId}?server=server-a`);

    await user.click(screen.getByRole('button', { name: '返回列表' }));
    await user.click(await screen.findByText('另一份'));
    // 侧放进来、认不出来源的文件没有阅读去处，按钮不摆；资源管理器定位只看
    // 本机文件（Windows 一律有），并真的把路径交给原生命令。
    expect(screen.queryByRole('link', { name: '阅读' })).not.toBeInTheDocument();
    await user.click(await screen.findByRole('button', { name: '在资源管理器中打开' }));
    expect(adapter).toHaveBeenCalledWith('reveal_in_file_manager', { path: noSource.path });
    delete (window as { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__;
  });
});
