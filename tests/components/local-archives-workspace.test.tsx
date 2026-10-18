import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, vi } from 'vitest';
import { MemoryRouter, useLocation, useNavigate } from 'react-router-dom';

import { App } from '../../src/app/App';
import { RetainedPage } from '../../src/app/RetainedPage';
import { LocalArchivesWorkspace } from '../../src/components/LocalArchivesWorkspace';
import { resetInvokeAdapterForTests, setInvokeAdapterForTests } from '../../src/bridge/invoke';
import { UNTAGGED_FILTER_ID, categoryTagLabel } from '../../src/lib/tags';
import { DEFAULT_PREFERENCES } from '../../src/repositories/nativeSettingsRepository';

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
  it('does not navigate back to an old detail when deletion finishes after leaving', async () => {
    let finishDelete: ((value: unknown) => void) | undefined;
    let leave: (() => void) | undefined;
    setInvokeAdapterForTests(async (command) => {
      if (command === 'list_local_archives') return { ok: true, value: [localFile] };
      if (command === 'delete_local_archives') return new Promise((resolve) => { finishDelete = resolve; });
      return { ok: true, value: [] };
    });
    function Owner() {
      const location = useLocation();
      const navigate = useNavigate();
      leave = () => navigate('/elsewhere');
      return <><output data-testid="current-location">{location.pathname}</output>
        <RetainedPage active={location.pathname === '/downloads'}><LocalArchivesWorkspace /></RetainedPage></>;
    }
    render(<MemoryRouter initialEntries={[`/downloads?path=${encodeURIComponent(localFile.path)}`]}><Owner /></MemoryRouter>);
    await screen.findAllByText('测试档案');
    fireEvent.click(screen.getByRole('button', { name: '多选' }));
    fireEvent.click(screen.getByRole('checkbox', { name: '选择 测试档案' }));
    fireEvent.click(screen.getByRole('button', { name: '删除所选' }));
    fireEvent.click(screen.getByRole('button', { name: '确认删除' }));
    await waitFor(() => expect(finishDelete).toBeDefined());
    act(() => { leave!(); });
    expect(screen.getByTestId('current-location')).toHaveTextContent('/elsewhere');
    await act(async () => { finishDelete!({ ok: true, value: 1 }); });
    expect(screen.getByTestId('current-location')).toHaveTextContent('/elsewhere');
  });

  it('closes local deletion confirmation when its retained page hides', async () => {
    setInvokeAdapterForTests(async (command) => {
      if (command === 'list_local_archives') return { ok: true, value: [localFile] };
      return { ok: true, value: [] };
    });
    const content = <LocalArchivesWorkspace />;
    const view = render(<MemoryRouter><RetainedPage active>{content}</RetainedPage></MemoryRouter>);
    await screen.findByText('测试档案');
    fireEvent.click(screen.getByRole('button', { name: '多选' }));
    fireEvent.click(screen.getByRole('checkbox', { name: '选择 测试档案' }));
    fireEvent.click(screen.getByRole('button', { name: '删除所选' }));
    expect(screen.getByRole('dialog', { name: '删除本地档案' })).toBeInTheDocument();
    view.rerender(<MemoryRouter><RetainedPage active={false}>{content}</RetainedPage></MemoryRouter>);
    expect(screen.queryByRole('dialog', { hidden: true })).not.toBeInTheDocument();
    view.rerender(<MemoryRouter><RetainedPage active>{content}</RetainedPage></MemoryRouter>);
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  });

  it('stops the initial spinner after a task-list failure and allows retrying', async () => {
    const user = userEvent.setup();
    let failTasks = true;
    setInvokeAdapterForTests(async (command) => {
      if (command === 'list_tasks') return failTasks
        ? { ok: false, error: { code: 'LOCAL_DATABASE', message: '读取下载任务失败', retryable: true } }
        : { ok: true, value: [] };
      if (command === 'list_local_archives' || command === 'list_search_presets') return { ok: true, value: [] };
      throw new Error(command);
    });
    renderPage();
    expect(await screen.findByText('读取下载任务失败')).toBeInTheDocument();
    expect(screen.queryByText('正在读取本地档案…')).not.toBeInTheDocument();
    failTasks = false;
    await user.click(screen.getByRole('button', { name: '重试读取下载任务' }));
    await waitFor(() => expect(screen.queryByText('读取下载任务失败')).not.toBeInTheDocument());
    expect(screen.getByText('还没有下载过档案')).toBeInTheDocument();
  });

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

  it('puts the category filter, the sort field and 多选 in the toolbar, in the library’s order', async () => {
    setInvokeAdapterForTests(async (command) => {
      if (command === 'list_local_archives') return { ok: true, value: [localFile] };
      if (command === 'list_search_presets' || command === 'list_tasks') return { ok: true, value: [] };
      throw new Error(`Unexpected command: ${command}`);
    });

    renderPage();

    const toolbar = await screen.findByRole('toolbar', { name: '档案库工具' });
    const sort = await screen.findByRole('combobox', { name: '排序字段' });
    const toggle = screen.getByRole('button', { name: '多选' });
    // 分类筛选是从档案里推出来的，要等它们读回来才画（读完之前是一段骨架）。
    expect(await screen.findByRole('combobox', { name: '分类筛选' })).toBeInTheDocument();

    // 和档案库工具栏同一个顺序：分类筛选 → 排序方式 → 多选。
    expect(Array.from(toolbar.querySelectorAll('[aria-label]')).map((element) => element.getAttribute('aria-label')))
      .toEqual(['分类筛选', '排序字段', '多选']);
    expect(sort.closest('.select-field')?.nextElementSibling).toBe(toggle);
    // 多选不再挂在搜索行的预设按钮右边。
    expect(screen.getByRole('button', { name: '检索预设' }).closest('.search-preset-field')?.nextElementSibling).toBeNull();
  });

  it('filters by the category the row itself shows, derived from the archive’s own tags', async () => {
    const doujinshi = categoryTagLabel('doujinshi');
    const other = { ...localFile, path: 'E:\\Downloads\\bbb-另一份.zip', title: '另一份', archiveId: null, serverId: null, scopeId: null, tags: ['category:doujinshi'] };
    setInvokeAdapterForTests(async (command) => {
      if (command === 'list_local_archives') return { ok: true, value: [localFile, other] };
      if (command === 'list_search_presets' || command === 'list_tasks') return { ok: true, value: [] };
      throw new Error(`Unexpected command: ${command}`);
    });

    renderPage();

    await screen.findByText('测试档案');
    const filter = await screen.findByRole('combobox', { name: '分类筛选' });
    // 这一页没有「分类」这张表可查，取值域是从读回来的档案里现推的：分类标签
    // 一项一个，一份都没有的那一份进「无标签」。
    expect(within(filter).getByRole('option', { name: '全部分类' })).toBeInTheDocument();
    expect(within(filter).getByRole('option', { name: doujinshi })).toBeInTheDocument();
    expect(within(filter).getByRole('option', { name: '无标签' })).toBeInTheDocument();

    // 行里写的那一格和下拉框里能选的那一项是同一个值。
    const otherRow = screen.getByText('另一份').closest('.archive-row') as HTMLElement;
    expect(within(otherRow).getByText(doujinshi)).toBeInTheDocument();

    fireEvent.change(filter, { target: { value: doujinshi } });
    await waitFor(() => expect(screen.queryByText('测试档案')).not.toBeInTheDocument());
    expect(screen.getByText('另一份')).toBeInTheDocument();

    fireEvent.change(filter, { target: { value: UNTAGGED_FILTER_ID } });
    await waitFor(() => expect(screen.queryByText('另一份')).not.toBeInTheDocument());
    expect(screen.getByText('测试档案')).toBeInTheDocument();

    fireEvent.change(filter, { target: { value: '' } });
    await waitFor(() => expect(screen.getByText('另一份')).toBeInTheDocument());
  });

  it('sorts by name and flips the direction when the same option is picked again', async () => {
    const user = userEvent.setup();
    const alpha = { ...localFile, path: 'E:\\Downloads\\alpha.cbz', title: 'Alpha', addedAt: 1_700_000_000_000, tags: [] };
    const beta = { ...localFile, path: 'E:\\Downloads\\beta.cbz', title: 'Beta', addedAt: 1_760_000_000_000, tags: [] };
    setInvokeAdapterForTests(async (command) => {
      if (command === 'list_local_archives') return { ok: true, value: [alpha, beta] };
      if (command === 'list_search_presets' || command === 'list_tasks') return { ok: true, value: [] };
      throw new Error(`Unexpected command: ${command}`);
    });

    renderPage();

    await screen.findByText('Alpha');
    const titles = () => within(screen.getByRole('list', { name: '本地档案' })).getAllByRole('listitem')
      .map((item) => item.querySelector('strong')?.textContent);
    // 默认仍是原生那条次序（添加时间倒序）：后加进来的 Beta 在前。
    expect(titles()).toEqual(['Beta', 'Alpha']);

    // 换一项排序字段：方向跟着上次的不动，还是降序。
    await user.click(screen.getByRole('button', { name: '下载时间' }));
    let menu = await screen.findByRole('listbox', { name: '排序字段' });
    await user.click(within(menu).getByRole('button', { name: '名称' }));
    await waitFor(() => expect(screen.queryByRole('listbox')).not.toBeInTheDocument());
    expect(titles()).toEqual(['Beta', 'Alpha']);

    // 再点一次已经选着的那一项 = 换个方向。
    await user.click(screen.getByRole('button', { name: '名称' }));
    menu = await screen.findByRole('listbox', { name: '排序字段' });
    await user.click(within(menu).getByRole('button', { name: '名称' }));
    await waitFor(() => expect(titles()).toEqual(['Alpha', 'Beta']));
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

  it('answers a right click on a local archive with the menu this page can run', async () => {
    const user = userEvent.setup();
    setInvokeAdapterForTests(async (command) => {
      if (command === 'list_local_archives') return { ok: true, value: [localFile] };
      if (command === 'list_search_presets' || command === 'list_tasks') return { ok: true, value: [] };
      throw new Error(`Unexpected command: ${command}`);
    });

    renderPage();

    const row = (await screen.findByText('测试档案')).closest('.archive-row');
    expect(row).not.toBeNull();
    fireEvent.contextMenu(row!, { clientX: 120, clientY: 80 });

    const menu = await screen.findByRole('menu');
    // 这一页真做得到的两件：打开详情、从磁盘删掉。服务器的身份不是这一份档案的
    // 主语（侧放进来时连 archiveId 都没有），所以阅读器/元数据那几条不摆。
    expect(within(menu).getByRole('menuitem', { name: '查看详情' })).toBeInTheDocument();
    expect(within(menu).getByRole('menuitem', { name: '删除本地档案' })).toBeInTheDocument();
    expect(within(menu).queryByRole('menuitem', { name: '无痕阅读' })).not.toBeInTheDocument();
    expect(within(menu).queryByRole('menuitem', { name: '编辑元数据' })).not.toBeInTheDocument();

    await user.click(within(menu).getByRole('menuitem', { name: '查看详情' }));
    // 「查看详情」和点这一行是同一件事。
    expect(await screen.findByRole('button', { name: '本地删除' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: '更多操作' })).toBeInTheDocument();
  });

  it('deletes a right-clicked local file through the page confirmation', async () => {
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

    const row = (await screen.findByText('测试档案')).closest('.archive-row');
    fireEvent.contextMenu(row!, { clientX: 120, clientY: 80 });
    await user.click(await screen.findByRole('menuitem', { name: '删除本地档案' }));

    // 走的是页面自己那条确认（说明、繁忙态、取消），不是裸 confirm()。
    expect(screen.getByText(/这个本地文件/)).toBeInTheDocument();
    expect(screen.getByText(/服务器上的档案不受影响/)).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: '确认删除' }));

    await waitFor(() => expect(adapter).toHaveBeenCalledWith('delete_local_archives', { paths: [localFile.path] }));
    expect(adapter.mock.calls.some(([command]) => command === 'delete_archive')).toBe(false);
  });

  it('opens the same menu from the more button in the detail header', async () => {
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

    await user.click(await screen.findByText('测试档案'));
    await user.click(await screen.findByRole('button', { name: '更多操作' }));

    const menu = await screen.findByRole('menu');
    expect(within(menu).getByRole('menuitem', { name: '查看详情' })).toBeInTheDocument();
    await user.click(within(menu).getByRole('menuitem', { name: '删除本地档案' }));

    await user.click(await screen.findByRole('button', { name: '确认删除' }));
    await waitFor(() => expect(adapter).toHaveBeenCalledWith('delete_local_archives', { paths: [localFile.path] }));
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
      // 这一条测的是**标签的挑选与排序**，不是翻译：把翻译关掉，chip 上就一定是
      // 原文。否则同一进程里别的用例加载过词典之后，这里会按中文渲染，断言就成了
      // 「谁先跑」（`vitest.config.ts` 关掉了文件级隔离，模块级状态是共享的）。
      if (command === 'load_preferences') return { ok: true, value: { ...DEFAULT_PREFERENCES, tagTranslationEnabled: false } };
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
