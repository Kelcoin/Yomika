import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, vi } from 'vitest';
import { MemoryRouter } from 'react-router-dom';

import { App } from '../../src/app/App';
import { resetInvokeAdapterForTests, setInvokeAdapterForTests } from '../../src/bridge/invoke';
import { resetFilePickerForTests, setDirectoryPickerForTests, setModelPickerForTests, setSavePickerForTests } from '../../src/bridge/filePicker';
import { COMPACT_WIDTH_QUERY } from '../../src/lib/useMediaQuery';
import { DEFAULT_PREFERENCES } from '../../src/repositories/nativeSettingsRepository';
import { COLOR_SCHEMES } from '../../src/lib/cssThemePresets';
import { DEFAULT_DATA_TRANSFER_SCOPE, TRANSFER_CREDENTIAL_CATEGORIES } from '../../src/domain/dataTransferScope';
import { readoshiServerScope } from '../../src/lib/readoshiScope';
import { emitTauriEvent } from '../tauriEvents';

afterEach(() => {
  resetInvokeAdapterForTests();
  resetFilePickerForTests();
});

/** Sections are grouped by topic, and `?section=` opens one directly, which is
 * how a test reaches the controls it asserts on without clicking through. */
function renderSettings(section?: string) {
  return render(
    <MemoryRouter initialEntries={[section ? `/settings?section=${section}` : '/settings']}>
      <App />
    </MemoryRouter>,
  );
}

/** 勾上「导入导出范围」里的凭据类。它们默认不勾——带凭据的文件要额外设口令，该是一次
 * 明确的选择——所以每条凭据路径都得先跨过这一步，这本身也是被测的行为。
 *
 * 调用前要先关掉别的菜单：每个菜单都往 document 上挂了自己的 Escape 监听，一次 Escape
 * 会把当时开着的菜单全关掉。 */
async function checkCredentialScope(user: ReturnType<typeof userEvent.setup>) {
  await user.click(await screen.findByRole('button', { name: '导入导出范围' }));
  const panel = await screen.findByRole('dialog', { name: '导入导出范围' });
  for (const category of TRANSFER_CREDENTIAL_CATEGORIES) {
    const row = within(panel).getByRole('checkbox', { name: `导入导出${category.label}` });
    if (row.getAttribute('aria-checked') === 'false') await user.click(row);
  }
  await user.keyboard('{Escape}');
}

/** 本机导出的那份记录文本：`export_scoped_data` 的回包与交给凭据加密的入参用它。 */
const SCOPED_EXPORT_TEXT = '{"kind":"yomika-scope-export","schemaVersion":1,"document":{"version":1,"epoch":0,"objects":{"a":1,"b":2}}}';

/** 凭据类按域的固定顺序进文件，所以断言里能直接写出这个数组。 */
const CREDENTIAL_SCOPE = JSON.stringify(TRANSFER_CREDENTIAL_CATEGORIES.map((category) => category.id));

describe('settings workspace', () => {
  it('opens About links through the native external browser command', async () => {
    const user = userEvent.setup();
    const adapter = vi.fn(async (command: string, args?: Record<string, unknown>) => {
      if (command === 'load_preferences') return { ok: true, value: DEFAULT_PREFERENCES };
      if (command === 'list_servers') return { ok: true, value: [] };
      if (command === 'open_external_url') return { ok: true, value: null };
      return { ok: true, value: [] };
    });
    setInvokeAdapterForTests(adapter);
    renderSettings('about');

    await user.click(await screen.findByRole('button', { name: 'LANraragi 文档' }));
    expect(adapter).toHaveBeenCalledWith('open_external_url', { url: 'https://sugoi.gitbook.io/lanraragi' });
    // The repository row names the repo and opens it through the same command.
    await user.click(await screen.findByRole('button', { name: '仓库地址' }));
    expect(adapter).toHaveBeenCalledWith('open_external_url', { url: 'https://github.com/Kelcoin/Yomika' });
  });

  it('shows this run\'s errors inside the About page and exports the same list', async () => {
    const user = userEvent.setup();
    const adapter = vi.fn(async (command: string) => {
      if (command === 'load_preferences') return { ok: true, value: DEFAULT_PREFERENCES };
      if (command === 'list_servers') return { ok: true, value: [] };
      if (command === 'error_log_read') {
        return {
          ok: true,
          value: [{ at: '2026-09-16T02:00:00.000Z', level: 'error', source: 'bridge/list_archives', message: 'LANraragi 不可达', detail: 'https://lrr.test/api/info' }],
        };
      }
      if (command === 'error_log_export') return { ok: true, value: 'C:/tmp/yomika-error.log' };
      return { ok: true, value: [] };
    });
    setInvokeAdapterForTests(adapter);
    setSavePickerForTests(async () => 'C:/tmp/yomika-error.log');
    renderSettings('about');

    // 错误日志不再是一个设置分类，它长成关于页里普通的一行：行上是条数，
    // 点开才是菜单——菜单里才读取列表并给出刷新、导出。
    const about = await screen.findByRole('region', { name: '关于' });
    const row = within(about).getByRole('button', { name: '错误日志' });
    expect(row).toHaveTextContent('1 条');
    expect(screen.queryByRole('dialog', { name: '错误日志' })).not.toBeInTheDocument();

    await user.click(row);
    const menu = await screen.findByRole('dialog', { name: '错误日志' });
    expect(within(menu).getByText(/本次运行记录到 1 条/)).toBeInTheDocument();
    expect(within(menu).getByText('bridge/list_archives')).toBeInTheDocument();
    expect(within(menu).getByText('LANraragi 不可达')).toBeInTheDocument();
    // 顶上那两句说明文字已经去掉：留着的都是眼下的事实。
    expect(menu.textContent).not.toContain('每次启动重新记录');

    await user.click(within(menu).getByRole('button', { name: '导出' }));
    // 导出的是界面这一份（同一次拼装）：内容由前端给，原生侧只管写。
    await waitFor(() => expect(adapter).toHaveBeenCalledWith('error_log_export', {
      path: 'C:/tmp/yomika-error.log',
      contents: expect.stringContaining('LANraragi 不可达'),
    }));
  });

  it("keeps the last run's crash trail apart from this run", async () => {
    // 崩溃现场（以及崩溃前那几步黑匣子记录）来自**上一次运行**：它们要显示，但不能混进
    // 「本次运行」的计数里——看到的第一眼就该知道这不是这次记下的。
    const user = userEvent.setup();
    const adapter = vi.fn(async (command: string) => {
      if (command === 'load_preferences') return { ok: true, value: DEFAULT_PREFERENCES };
      if (command === 'list_servers') return { ok: true, value: [] };
      if (command === 'error_log_read') {
        return {
          ok: true,
          value: [
            { at: 'epoch:1790000000000', level: 'warn', source: '上次运行 · eh/in-app-login', message: 'navigate：准备导航到登录页', detail: null },
            { at: '2026-09-23T02:00:00.000Z', level: 'error', source: 'bridge/list_archives', message: 'LANraragi 不可达', detail: null },
          ],
        };
      }
      return { ok: true, value: [] };
    });
    setInvokeAdapterForTests(adapter);
    renderSettings('about');

    const about = await screen.findByRole('region', { name: '关于' });
    await user.click(within(about).getByRole('button', { name: '错误日志' }));
    const menu = await screen.findByRole('dialog', { name: '错误日志' });

    await vi.waitFor(() => expect(menu.textContent).toContain('本次运行 1 条，上次运行 1 条'));
    expect(within(menu).getByText('上次运行 · eh/in-app-login')).toBeInTheDocument();
    expect(within(menu).getByText('navigate：准备导航到登录页')).toBeInTheDocument();
  });

  it('shows only upload and dedup in tools', async () => {
    setInvokeAdapterForTests(async (command) => {
      if (command === 'load_preferences') return { ok: true, value: DEFAULT_PREFERENCES };
      if (command === 'list_servers') return { ok: true, value: [] };
      return { ok: true, value: [] };
    });
    renderSettings('tools');
    expect(await screen.findByRole('link', { name: /上传档案/ })).toBeInTheDocument();
    expect(screen.getByRole('link', { name: /重复档案查重/ })).toBeInTheDocument();
    expect(screen.queryByText('任务列表')).not.toBeInTheDocument();
  });

  it('persists a chosen download directory and restores its default', async () => {
    const user = userEvent.setup();
    const adapter = vi.fn(async (command: string, args?: Record<string, unknown>) => {
      if (command === 'load_preferences') return { ok: true, value: DEFAULT_PREFERENCES };
      if (command === 'save_preferences') return { ok: true, value: args?.input };
      return { ok: true, value: [] };
    });
    setInvokeAdapterForTests(adapter);
    setDirectoryPickerForTests(async () => 'E:\\Comics');
    renderSettings('general');
    // The row opens the floating menu; the picker button lives in the menu.
    await user.click(await screen.findByRole('button', { name: '下载目录' }));
    await user.click(await screen.findByRole('button', { name: '选择下载目录' }));
    expect(await screen.findByText('E:\\Comics')).toBeInTheDocument();
    await vi.waitFor(() => expect(adapter).toHaveBeenCalledWith('save_preferences', { input: { ...DEFAULT_PREFERENCES, downloadDirectory: 'E:\\Comics' } }));
    await user.click(screen.getByRole('button', { name: '恢复默认下载目录' }));
    await vi.waitFor(() => expect(adapter).toHaveBeenCalledWith('save_preferences', { input: DEFAULT_PREFERENCES }));
  });

  it('uses drawn switches for favorite deletion sync and per-deletion confirmation', async () => {
    const user = userEvent.setup();
    const adapter = vi.fn(async (command: string, args?: Record<string, unknown>) => {
      if (command === 'load_preferences') return { ok: true, value: DEFAULT_PREFERENCES };
      if (command === 'save_preferences') return { ok: true, value: args?.input };
      // 已登录的 E-Hentai 账户：收藏同步删除才开得起来。
      if (command === 'list_eh_accounts') return { ok: true, value: [{ id: 'eh-1', label: 'E-Hentai 账户', host: 'e-hentai.org', cookieRef: 'ref', isActive: true, status: 'verified', createdAt: '2026-01-01', updatedAt: '2026-01-01' }] };
      return { ok: true, value: [] };
    });
    setInvokeAdapterForTests(adapter);
    renderSettings('sync');
    // 纯开关不再有二级菜单：绘制的开关就在行的右侧，翻转即保存。
    const toggle = await screen.findByRole('switch', { name: '同步删除 E-Hentai 收藏' });
    expect(toggle).toHaveClass('switch-control');
    const confirmation = screen.getByRole('switch', { name: '默认开启收藏同步删除' });
    expect(confirmation).toBeDisabled();
    await user.click(toggle);
    await user.click(confirmation);
    await vi.waitFor(() => expect(adapter).toHaveBeenCalledWith('save_preferences', { input: { ...DEFAULT_PREFERENCES, ehFavoriteDeleteSync: true, confirmEhFavoriteDelete: false } }));
  });

  it('refuses to turn on favorite sync deletion while no E-Hentai account is signed in', async () => {
    const user = userEvent.setup();
    const adapter = vi.fn(async (command: string, args?: Record<string, unknown>) => {
      if (command === 'load_preferences') return { ok: true, value: DEFAULT_PREFERENCES };
      if (command === 'save_preferences') return { ok: true, value: args?.input };
      if (command === 'list_eh_accounts') return { ok: true, value: [] };
      return { ok: true, value: [] };
    });
    setInvokeAdapterForTests(adapter);
    renderSettings('sync');
    // 没登录：开关按不动，行里说明原因。
    const toggle = await screen.findByRole('switch', { name: '同步删除 E-Hentai 收藏' });
    await waitFor(() => expect(toggle).toBeDisabled());
    expect(screen.getByText('登录 E-Hentai 后才能启用')).toBeInTheDocument();
    await user.click(toggle);
    expect(adapter.mock.calls.some(([command]) => command === 'save_preferences')).toBe(false);
  });

  it('persists the feature switches in general, appearance and eh sections', async () => {
    const user = userEvent.setup();
    const adapter = vi.fn(async (command: string, args?: Record<string, unknown>) => {
      if (command === 'load_preferences') return { ok: true, value: DEFAULT_PREFERENCES };
      if (command === 'save_preferences') return { ok: true, value: args?.input };
      return { ok: true, value: [] };
    });
    setInvokeAdapterForTests(adapter);
    renderSettings('general');
    // 继续阅读的已读完开关默认开着，历史页不受它影响。
    const finished = await screen.findByRole('switch', { name: '继续阅读显示已读完' });
    await user.click(finished);
    await vi.waitFor(() => expect(adapter).toHaveBeenCalledWith('save_preferences', { input: { ...DEFAULT_PREFERENCES, continueReadingShowFinished: false } }));

    renderSettings('appearance');
    // SFW 模式：封面一律模糊，悬停/点击临时显示。
    const sfw = await screen.findByRole('switch', { name: 'SFW 模式' });
    await user.click(sfw);
    await vi.waitFor(() => expect(adapter).toHaveBeenCalledWith('save_preferences', { input: { ...DEFAULT_PREFERENCES, sfwMode: true } }));

    renderSettings('eh');
    // 未登录时开关锁定为关闭（disabled 且显示未勾选），不写入偏好。
    const myTags = await screen.findByRole('switch', { name: '我的标签' });
    expect(myTags).toBeDisabled();
    expect(myTags).not.toBeChecked();
  });
  it('carries the auto-sync switch and reports the last sync on the account row', async () => {
    const user = userEvent.setup();
    const adapter = vi.fn(async (command: string, args?: Record<string, unknown>) => {
      if (command === 'load_preferences') return { ok: true, value: DEFAULT_PREFERENCES };
      if (command === 'save_preferences') return { ok: true, value: args?.input };
      if (command === 'list_servers') return { ok: true, value: [{ id: 'scope-a', name: 'Home', baseUrl: 'https://example.com', scopeId: 'scope-a', enabled: true }] };
      if (command === 'list_sync_accounts') return { ok: true, value: [{
        id: 'personal', label: 'Personal WebDAV', baseUrl: 'https://dav.example.com/Yomika', username: 'reader',
        credentialRef: 'personal-secret', syncScope: '[]', status: 'ok', lastProbeAt: null,
        lastSyncAt: new Date(Date.now() - 30 * 60 * 1000).toISOString().slice(0, 19).replace('T', ' '),
        lastErrorCode: null, createdAt: '2026-08-28 00:00:00', updatedAt: '2026-08-28 00:00:00',
      }] };
      return { ok: true, value: [] };
    });
    setInvokeAdapterForTests(adapter);
    renderSettings('sync');

    // 默认开着：关掉它只剩「立即同步」按钮。
    const autoSync = await screen.findByRole('switch', { name: '自动同步' });
    expect(autoSync).toBeChecked();
    await user.click(autoSync);
    await vi.waitFor(() => expect(adapter).toHaveBeenCalledWith('save_preferences', { input: { ...DEFAULT_PREFERENCES, autoSync: false } }));

    // 账户行报出上次同步的时刻（原生给的是 SQLite 的 UTC 串）。
    await user.click(await screen.findByRole('button', { name: '同步账户' }));
    const menu = await screen.findByRole('dialog', { name: '同步账户' });
    // 行上只留「类型 · 上次同步」：范围有自己的行，用户名/Access Key 不再重复。
    expect(within(menu).getByText('WebDAV · 30 分钟前同步')).toBeInTheDocument();
  });

  it('prunes the reading history from the general section', async () => {
    const user = userEvent.setup();
    const adapter = vi.fn(async (command: string) => {
      if (command === 'load_preferences') return { ok: true, value: DEFAULT_PREFERENCES };
      if (command === 'prune_history') return { ok: true, value: 4 };
      return { ok: true, value: [] };
    });
    setInvokeAdapterForTests(adapter);
    renderSettings('general');

    await user.click(await screen.findByRole('button', { name: '历史记录清理' }));
    const menu = await screen.findByRole('dialog', { name: '历史记录清理' });
    // 策略写在菜单里，用户点之前就能看到留多久。
    expect(within(menu).getByText(/已读完留 3 个月，未读完留 1 年/)).toBeInTheDocument();
    expect(within(menu).getByText(/读到总页数 95% 以上算读完/)).toBeInTheDocument();
    await user.click(within(menu).getByRole('button', { name: '立即清理' }));
    await vi.waitFor(() => expect(adapter).toHaveBeenCalledWith('prune_history', {}));
    expect(await screen.findByText('已清理 4 条历史记录')).toBeInTheDocument();
  });

  it('loads models directly in advanced settings and toggles decensor', async () => {
    const user = userEvent.setup();
    const adapter = vi.fn(async (command: string, args?: Record<string, unknown>) => {
      if (command === 'load_preferences') return { ok: true, value: { theme: 'system', defaultLayout: 'auto', defaultDirection: 'ltr', cacheMaxBytes: 2_147_483_648 } };
      if (command === 'list_servers') return { ok: true, value: [] };
      if (command === 'inference_list_models') return { ok: true, value: [{ id: 'aletheia-lens', version: '1', scale: null, kind: 'decensor', components: [
        { id: 'mrcnn', name: 'Mask R-CNN', role: '遮挡区域检测', path: 'mrcnn/weights.onnx' },
        { id: 'deepcreampy-bar', name: 'DeepCreamPy Bar', role: '条状遮挡修补', path: 'deepcreampy/bar.onnx' },
        { id: 'deepcreampy-mosaic', name: 'DeepCreamPy Mosaic', role: '马赛克修补', path: 'deepcreampy/mosaic.onnx' },
        { id: 'fatal-pixels', name: 'Fatal Pixels', role: '修复结果增强', path: 'esrgan/4x-Fatal-Pixels.onnx' },
      ] }] };
      if (command === 'save_preferences') return { ok: true, value: args?.input };
      throw new Error(`Unexpected command: ${command}`);
    });
    setInvokeAdapterForTests(adapter);
    renderSettings('advanced');
    // Every stage is a row naming the model it runs; the choices are one click
    // away in that row's floating menu, which is what keeps the section one list
    // instead of a column of filled-in forms.
    await screen.findByRole('button', { name: '遮挡区域检测模型' });
    for (const role of ['遮挡区域检测', '条状遮挡修补', '马赛克修补', '修复结果增强']) {
      expect(screen.getByText(role)).toBeInTheDocument();
      expect(screen.getByRole('button', { name: `${role}模型` })).toBeInTheDocument();
    }
    await user.click(screen.getByRole('button', { name: '遮挡区域检测模型' }));
    expect(await screen.findByRole('button', { name: 'Mask R-CNN' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /^下载/ })).toBeNull();
    await user.keyboard('{Escape}');
    expect(screen.queryByRole('button', { name: 'Mask R-CNN' })).toBeNull();
    // The feature switch lives in its row, flipped in place.
    const toggle = screen.getByRole('switch', { name: '启用去码' });
    expect(toggle).toBeEnabled();
    expect(toggle).toHaveClass('switch-control');
    expect(toggle).toHaveAttribute('aria-checked', 'false');
    await user.click(toggle);
    expect(toggle).toHaveAttribute('aria-checked', 'true');
    // Drain the autosave debounce inside this test: a pending 400ms timer would
    // otherwise fire into the next test's adapter and count as its save.
    await vi.waitFor(() => expect(adapter).toHaveBeenCalledWith('save_preferences', { input: expect.objectContaining({ decensorModel: 'aletheia-lens' }) }));
    await user.keyboard('{Escape}');
    // Model import keeps to its row: the picker button sits on the right of it
    // and opens the native file dialog directly, with no second level to open
    // and no hidden file input in the DOM.
    expect(screen.getByRole('button', { name: '选择模型文件…' })).toBeInTheDocument();
    expect(document.querySelector('input[type="file"]')).toBeNull();
    expect(screen.queryByRole('dialog', { name: '模型导入' })).toBeNull();
    expect(adapter.mock.calls.filter(([command]) => command === 'inference_list_models')).toHaveLength(1);
  });

  it('says the model list is still loading instead of claiming nothing is installed', async () => {
    // 模型列表还没回来时，两个开关都只说「正在读取模型…」。以前卡片底部还有一行状态
    // 文字说同一件事（同一个结论在卡片里出现两遍），现在状态只在开关自己那一行上——
    // 而且不能反过来先报「尚未安装」：还没查完就先下结论是错的。
    const adapter = vi.fn(async (command: string) => {
      if (command === 'load_preferences') return { ok: true, value: DEFAULT_PREFERENCES };
      if (command === 'list_servers') return { ok: true, value: [] };
      // 永远不回：把「正在读取」这一刻留在屏幕上量。
      if (command === 'inference_list_models') return new Promise(() => {});
      return { ok: true, value: [] };
    });
    setInvokeAdapterForTests(adapter);
    renderSettings('advanced');

    const upscale = await screen.findByRole('switch', { name: '启用超分' });
    expect(upscale.closest('.settings-row')).toHaveTextContent('正在读取模型…');
    expect(screen.getByRole('switch', { name: '启用去码' }).closest('.settings-row')).toHaveTextContent('正在读取模型…');
    expect(screen.queryByText(/尚未安装/)).toBeNull();
    expect(screen.queryByText(/正在读取已安装模型|正在读取模型索引/)).toBeNull();
  });

  it('blocks an incomplete decensor bundle with a toast instead of enabling it', async () => {
    const user = userEvent.setup();
    const adapter = vi.fn(async (command: string, args?: Record<string, unknown>) => {
      if (command === 'load_preferences') return { ok: true, value: DEFAULT_PREFERENCES };
      if (command === 'list_servers') return { ok: true, value: [] };
      if (command === 'inference_list_models') return {
        ok: true,
        value: [{
          id: 'aletheia-lens', version: '1', scale: null, kind: 'decensor',
          components: [{ id: 'mrcnn', name: 'Mask R-CNN', role: '遮挡区域检测', path: 'mrcnn/weights.onnx' }],
        }],
      };
      if (command === 'save_preferences') return { ok: true, value: args?.input };
      return { ok: true, value: [] };
    });
    setInvokeAdapterForTests(adapter);
    renderSettings('advanced');
    const toggle = await screen.findByRole('switch', { name: '启用去码' });

    expect(toggle).not.toBeDisabled();
    await user.click(toggle);

    expect(toggle).toHaveAttribute('aria-checked', 'false');
    expect(await screen.findByRole('alert')).toHaveTextContent('去码模型不完整');
    expect(adapter.mock.calls.some(([command]) => command === 'save_preferences')).toBe(false);
  });

  it('hides the download action for an installed upscale model', async () => {
    const user = userEvent.setup();
    const adapter = vi.fn(async (command: string) => {
      if (command === 'load_preferences') return { ok: true, value: DEFAULT_PREFERENCES };
      if (command === 'list_servers') return { ok: true, value: [] };
      if (command === 'inference_list_models') return {
        ok: true,
        value: [{ id: 'waifu2x-upconv7', version: '1', scale: 2, kind: 'upscale', components: [] }],
      };
      return { ok: true, value: [] };
    });
    setInvokeAdapterForTests(adapter);
    renderSettings('advanced');
    await user.click(await screen.findByRole('button', { name: '超分模型' }));
    expect(await screen.findByRole('button', { name: 'waifu2x' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: '下载waifu2x' })).toBeNull();
  });

  it('lists the built-in Anime4K chains as choices with nothing to download', async () => {
    const user = userEvent.setup();
    const adapter = vi.fn(async (command: string) => {
      if (command === 'load_preferences') return { ok: true, value: DEFAULT_PREFERENCES };
      if (command === 'list_servers') return { ok: true, value: [] };
      if (command === 'inference_list_models') return {
        ok: true,
        value: [
          { id: 'anime4k', version: '2', scale: 2, kind: 'upscale', components: [] },
        ],
      };
      return { ok: true, value: [] };
    });
    setInvokeAdapterForTests(adapter);
    renderSettings('advanced');

    await user.click(await screen.findByRole('button', { name: '超分模型' }));
    expect(await screen.findByRole('button', { name: 'Anime4K' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: '下载Anime4K' })).toBeNull();
  });

  it('collapses model menu rows that share an id into one option', async () => {
    const user = userEvent.setup();
    // 后端按版本各出一条记录，选项的值是 id：两个版本照旧渲染成两行一模一样的
    // 「Mask R-CNN」。同一 id 只能有一行。
    const decensorRecord = (version: string) => ({
      id: 'aletheia-lens', version, scale: null, kind: 'decensor',
      components: [{ id: 'mrcnn', name: 'Mask R-CNN', role: '遮挡区域检测', path: 'mrcnn/weights.onnx' }],
    });
    const adapter = vi.fn(async (command: string) => {
      if (command === 'load_preferences') return { ok: true, value: DEFAULT_PREFERENCES };
      if (command === 'list_servers') return { ok: true, value: [] };
      if (command === 'inference_list_models') return {
        ok: true,
        value: [decensorRecord('1'), decensorRecord('2')],
      };
      return { ok: true, value: [] };
    });
    setInvokeAdapterForTests(adapter);
    renderSettings('advanced');

    await user.click(await screen.findByRole('button', { name: '遮挡区域检测模型' }));
    const menu = screen.getByRole('dialog', { name: '遮挡区域检测模型' });
    expect(within(menu).getAllByRole('button', { name: 'Mask R-CNN' })).toHaveLength(1);
  });

  it('loads saved servers from the native repository', async () => {
    setInvokeAdapterForTests(async (command) => {
      if (command === 'load_preferences') return { ok: true, value: { theme: 'system', defaultLayout: 'auto', defaultDirection: 'ltr', cacheMaxBytes: 2_147_483_648 } };
      if (command === 'list_servers') return { ok: true, value: [{ id: 'scope-a', name: 'Home', baseUrl: 'https://example.com', scopeId: 'scope-a' }] };
      throw new Error(`Unexpected command: ${command}`);
    });

    renderSettings();

    await userEvent.setup().click(await screen.findByRole('link', { name: /通用/ }));
    expect(await screen.findByText('Home')).toBeInTheDocument();
    expect(screen.getByText('https://example.com')).toBeInTheDocument();
    expect(screen.getByText('已配置')).toBeInTheDocument();
  });

  it('switches the enabled server and updates the rows in place', async () => {
    // 一次只允许启用一台：启用另一台会把当前那台停掉，书架与首页随之改读
    // 新启用的服务器。当前标记是名字旁的小徽章；已启用的行没有开关可关。
    const user = userEvent.setup();
    const adapter = vi.fn(async (command: string, args?: Record<string, unknown>) => {
      if (command === 'load_preferences') return { ok: true, value: { theme: 'system', defaultLayout: 'auto', defaultDirection: 'ltr', cacheMaxBytes: 2_147_483_648 } };
      if (command === 'list_servers') return { ok: true, value: [
        { id: 'scope-a', name: 'Home', baseUrl: 'https://a.example.com', scopeId: 'scope-a', enabled: true },
        { id: 'scope-b', name: 'Office', baseUrl: 'https://b.example.com', scopeId: 'scope-b', enabled: false },
      ] };
      if (command === 'set_server_enabled') {
        expect(args).toEqual({ serverId: 'scope-b', enabled: true });
        return { ok: true, value: { id: 'scope-b', name: 'Office', baseUrl: 'https://b.example.com', scopeId: 'scope-b', enabled: true } };
      }
      throw new Error(`Unexpected command: ${command}`);
    });
    setInvokeAdapterForTests(adapter);

    renderSettings();

    await user.click(await screen.findByRole('link', { name: /通用/ }));
    // Home 的名字旁挂着自绘的「当前」标记（不再是两个字），且没有可关的开关。
    const badge = await screen.findByRole('img', { name: '当前服务器' });
    expect(badge.querySelector('svg')).not.toBeNull();
    expect(badge.closest('.settings-row-label')?.textContent).toContain('Home');
    expect(screen.queryByRole('button', { name: '当前' })).toBeNull();
    const officeToggle = await screen.findByRole('button', { name: '启用' });
    await user.click(officeToggle);

    expect(adapter).toHaveBeenCalledWith('set_server_enabled', { serverId: 'scope-b', enabled: true });
    // The rows swap in place: Office now carries the mark, Home offers 启用.
    await waitFor(() => expect(screen.getByRole('img', { name: '当前服务器' }).closest('.settings-row-label')?.textContent).toContain('Office'));
    expect(screen.getByRole('button', { name: '启用' })).toBeInTheDocument();
  });

  it('shows a newly saved server without reloading the page', async () => {
    const user = userEvent.setup();
    const adapter = vi.fn(async (command: string) => {
      if (command === 'load_preferences') return { ok: true, value: { theme: 'system', defaultLayout: 'auto', defaultDirection: 'ltr', cacheMaxBytes: 2_147_483_648 } };
      if (command === 'list_servers') return { ok: true, value: [] };
      if (command === 'save_server') {
        return {
          ok: true,
          value: { id: 'scope-a', name: 'Home', baseUrl: 'https://example.com', scopeId: 'scope-a' },
        };
      }
      throw new Error(`Unexpected command: ${command}`);
    });
    setInvokeAdapterForTests(adapter);
    renderSettings();

    await userEvent.setup().click(await screen.findByRole('link', { name: /通用/ }));
    // The section is one list of servers plus the button that adds another; with
    // none configured the list is empty and the button is all there is.
    await user.click(await screen.findByRole('button', { name: '添加服务器' }));
    await user.type(screen.getByLabelText('名称'), 'Home');
    await user.type(screen.getByLabelText('服务器地址'), 'https://example.com');
    await user.type(screen.getByLabelText('API Key'), 'secret');
    await user.click(screen.getByRole('button', { name: '保存服务器' }));

    expect(await screen.findByText('Home')).toBeInTheDocument();
    expect(screen.queryByText('secret')).not.toBeInTheDocument();
    expect(adapter).toHaveBeenCalledWith('save_server', expect.objectContaining({
      server: expect.objectContaining({ name: 'Home', baseUrl: 'https://example.com' }),
      apiKey: 'secret',
    }));
  });

  it('opens an existing server with its identity and stored API key prefilled', async () => {
    const user = userEvent.setup();
    const adapter = vi.fn(async (command: string) => {
      if (command === 'load_preferences') return { ok: true, value: { theme: 'system', defaultLayout: 'auto', defaultDirection: 'ltr', cacheMaxBytes: 2_147_483_648 } };
      if (command === 'list_servers') return { ok: true, value: [{ id: 'scope-a', name: 'Home', baseUrl: 'https://example.com', scopeId: 'scope-a' }] };
      if (command === 'read_server_api_key') return { ok: true, value: 'stored-key' };
      if (command === 'save_server') return { ok: true, value: { id: 'scope-a', name: 'Home', baseUrl: 'https://example.com', scopeId: 'scope-a' } };
      throw new Error(`Unexpected command: ${command}`);
    });
    setInvokeAdapterForTests(adapter);
    renderSettings();

    await userEvent.setup().click(await screen.findByRole('link', { name: /通用/ }));
    await screen.findByRole('button', { name: '编辑 Home' });
    await user.click(screen.getByRole('button', { name: '编辑 Home' }));
    expect(screen.getByRole('dialog')).toHaveTextContent('更新 LANraragi');
    expect(screen.getByLabelText('名称')).toHaveValue('Home');
    expect(screen.getByLabelText('服务器地址')).toHaveValue('https://example.com');
    // 之前配置的 API Key 从安全存储读回并预填，用户能看到自己配置过的值。
    expect(await screen.findByLabelText('API Key')).toHaveValue('stored-key');
    await user.clear(screen.getByLabelText('API Key'));
    await user.type(screen.getByLabelText('API Key'), 'replacement-key');
    await user.click(screen.getByRole('button', { name: '保存服务器' }));

    expect(adapter).toHaveBeenCalledWith('save_server', expect.objectContaining({ apiKey: 'replacement-key' }));
  });

  it('switches settings categories instead of rendering every section at once', async () => {
    const user = userEvent.setup();
    setInvokeAdapterForTests(async (command) => {
      if (command === 'load_preferences') return { ok: true, value: { theme: 'system', defaultLayout: 'auto', defaultDirection: 'ltr', cacheMaxBytes: 2_147_483_648 } };
      if (command === 'list_servers') return { ok: true, value: [] };
      throw new Error(`Unexpected command: ${command}`);
    });
    renderSettings();

    expect(await screen.findByRole('region', { name: '服务器' })).toBeInTheDocument();
    expect(screen.queryByRole('heading', { name: '数据迁移' })).not.toBeInTheDocument();
    await user.click(screen.getByRole('link', { name: /同步/ }));
    // 导入与导出各自是一行；旧的一体化「数据迁移」不再出现。
    expect(screen.getByRole('button', { name: '导出数据' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: '导入数据' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: '数据迁移' })).not.toBeInTheDocument();
    expect(screen.queryByRole('region', { name: '服务器' })).not.toBeInTheDocument();
  });

  it('loads, saves, and immediately applies ordinary preferences', async () => {
    const user = userEvent.setup();
    const loaded = { theme: 'dark', defaultLayout: 'double', defaultDirection: 'rtl', cacheMaxBytes: 4_294_967_296, prefetchPages: 1, coverConcurrency: 4, startupRoute: 'home', cardStyle: 'wide', upscaleBackend: 'off', upscaleModel: '', decensorModel: '', customCss: '' };
    const adapter = vi.fn(async (command: string, args?: Record<string, unknown>) => {
      if (command === 'load_preferences') return { ok: true, value: loaded };
      if (command === 'list_servers') return { ok: true, value: [] };
      if (command === 'save_preferences') return { ok: true, value: args?.input };
      throw new Error(`Unexpected command: ${command}`);
    });
    setInvokeAdapterForTests(adapter);

    renderSettings('appearance');

    expect(await screen.findByRole('radio', { name: '深色' })).toBeChecked();
    expect(document.documentElement).toHaveAttribute('data-theme', 'dark');
    expect(document.querySelector('meta[name="theme-color"]')).toHaveAttribute('content', '#09090b');

    // No save button: a change is the save. The old form let a toggle look
    // applied while nothing had been written. There is no autosave caption
    // either — the applied theme is the confirmation.
    await user.click(screen.getByRole('radio', { name: '浅色' }));

    await vi.waitFor(() => expect(document.documentElement).toHaveAttribute('data-theme', 'light'));
    expect(screen.queryByText(/自动保存/)).not.toBeInTheDocument();
    expect(document.querySelector('meta[name="theme-color"]')).toHaveAttribute('content', '#f3eee4');
    // Saving one section still writes the whole snapshot.
    expect(adapter).toHaveBeenCalledWith('save_preferences', {
      input: { ...DEFAULT_PREFERENCES, ...loaded, theme: 'light' },
    });
  });

  it('keeps reader defaults in the reading section and the cache cap in advanced', async () => {
    const loaded = { theme: 'dark', defaultLayout: 'double', defaultDirection: 'rtl', cacheMaxBytes: 4_294_967_296, prefetchPages: 1, coverConcurrency: 4, startupRoute: 'home', cardStyle: 'wide', upscaleBackend: 'off', upscaleModel: '', decensorModel: '', customCss: '' };
    setInvokeAdapterForTests(async (command: string) => {
      if (command === 'load_preferences') return { ok: true, value: loaded };
      if (command === 'list_servers') return { ok: true, value: [] };
      if (command === 'inference_list_models') return { ok: true, value: [] };
      throw new Error(`Unexpected command: ${command}`);
    });

    const view = renderSettings('reading');
    expect(await screen.findByRole('radio', { name: '双页' })).toBeChecked();
    expect(screen.getByRole('radio', { name: '从右到左' })).toBeChecked();
    // The cache cap lives in 通用, inside its row's floating menu.
    expect(screen.queryByLabelText('图片缓存上限')).not.toBeInTheDocument();
    view.unmount();

    renderSettings('general');
    await userEvent.setup().click(await screen.findByRole('button', { name: '图片缓存上限' }));
    expect(await within(screen.getByRole('dialog', { name: '图片缓存上限' })).findByRole('spinbutton', { name: '图片缓存上限' })).toHaveValue(4);
    expect(screen.queryByRole('radio', { name: '双页' })).not.toBeInTheDocument();
  });

  it('themes through custom CSS instead of a separate accent preference', async () => {
    const loaded = { theme: 'light', defaultLayout: 'auto', defaultDirection: 'ltr', cacheMaxBytes: 2_147_483_648, prefetchPages: 1, coverConcurrency: 4, startupRoute: 'home', cardStyle: 'wide', upscaleBackend: 'off', upscaleModel: '', decensorModel: '', customCss: '' };
    const adapter = vi.fn(async (command: string, args?: Record<string, unknown>) => {
      if (command === 'load_preferences') return { ok: true, value: loaded };
      if (command === 'list_servers') return { ok: true, value: [] };
      if (command === 'save_preferences') return { ok: true, value: args?.input };
      throw new Error(`Unexpected command: ${command}`);
    });
    setInvokeAdapterForTests(adapter);

    renderSettings('appearance');
    const user = userEvent.setup();
    await user.click(await screen.findByRole('button', { name: '自定义' }));
    const customMenu = screen.getByRole('dialog', { name: '自定义' });
    // 高级层级才暴露 CSS 编辑器；基础层是配色卡片。
    await user.click(within(customMenu).getByRole('button', { name: '高级' }));
    await within(customMenu).findByRole('textbox', { name: '自定义 CSS' });

    // The accent picker is gone: it set --brand-vermilion as an inline style on
    // the root, which outranked the same variable in a preset's :root block —
    // applying a theme then appeared to do nothing.
    expect(screen.queryByLabelText('自定义强调色')).not.toBeInTheDocument();
    expect(document.documentElement.style.getPropertyValue('--brand-vermilion')).toBe('');

    fireEvent.change(within(customMenu).getByRole('textbox', { name: '自定义 CSS' }), { target: { value: ':root { --brand-vermilion: #1f6f8b; }' } });

    await vi.waitFor(() => expect(document.getElementById('yomika-custom-css')?.textContent)
      .toBe(':root { --brand-vermilion: #1f6f8b; }'));
  });

  it('exposes reader preload, cover concurrency, and upscale settings', async () => {
    const user = userEvent.setup();
    const loaded = { theme: 'system', defaultLayout: 'auto', defaultDirection: 'ltr', cacheMaxBytes: 2_147_483_648, prefetchPages: 1, coverConcurrency: 4, startupRoute: 'home', cardStyle: 'wide', upscaleBackend: 'off', upscaleModel: '', decensorModel: '', customCss: '' };
    const adapter = vi.fn(async (command: string, args?: Record<string, unknown>) => {
      if (command === 'load_preferences') return { ok: true, value: loaded };
      if (command === 'list_servers') return { ok: true, value: [] };
      if (command === 'save_preferences') return { ok: true, value: args?.input };
      if (command === 'inference_list_models') return { ok: true, value: [
        { id: 'realcugan-2x-conservative', version: '2022.02.27', scale: 2 },
        { id: 'waifu2x-upconv7', version: '1', scale: 2, kind: 'upscale' },
        // No manifest means no recorded scale, so this one cannot be run and
        // must not be offered as a choice.
        { id: 'mystery-model', version: '1', scale: null },
      ] };
      throw new Error(`Unexpected command: ${command}`);
    });
    setInvokeAdapterForTests(adapter);

    renderSettings('reading');
    await user.click(await screen.findByRole('button', { name: '预加载页数' }));
    const preload = await within(screen.getByRole('dialog', { name: '预加载页数' })).findByRole('spinbutton', { name: '预加载页数' });
    // Ten pages, not five: a LAN page is a few hundred KB.
    expect(preload).toHaveAttribute('max', '10');
    await user.clear(preload);
    await user.type(preload, '8');
    await user.keyboard('{Escape}');
    await user.click(screen.getByRole('button', { name: '封面并发请求' }));
    const concurrency = within(screen.getByRole('dialog', { name: '封面并发请求' })).getByRole('spinbutton', { name: '封面并发请求' });
    await user.clear(concurrency);
    await user.type(concurrency, '2');
    await user.keyboard('{Escape}');
    // One switch for the feature, and nothing that configures it until it is on.
    // The backend list used to carry 关闭 and the model list 未选择, so turning
    // upscaling on meant knowing which two unrelated controls to change.
    expect(screen.queryByLabelText('超分模型')).not.toBeInTheDocument();
    expect(screen.queryByLabelText('超分后端')).not.toBeInTheDocument();
    await user.click(screen.getByRole('link', { name: '高级' }));
    await user.click(await screen.findByRole('switch', { name: '启用超分' }));
    await user.keyboard('{Escape}');

    // Installed models are offered by name, with the scale the model itself
    // produces; typing a name from memory was a silent failure at upscale time.
    await user.click(screen.getByRole('button', { name: '超分模型' }));
    expect(await screen.findByRole('button', { name: 'Real-CUGAN 2x 通用' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /下载Real-CUGAN/ })).toBeNull();
    expect(screen.getAllByLabelText('超分模型').length).toBeGreaterThan(0);
    await user.keyboard('{Escape}');
    expect(screen.queryByLabelText('超分后端')).not.toBeInTheDocument();
    // Turning it on picks a backend and the one runnable model, rather than
    // leaving two controls still saying "no".
    await vi.waitFor(() => expect(adapter).toHaveBeenCalledWith('save_preferences', {
      input: { ...DEFAULT_PREFERENCES, ...loaded, prefetchPages: 8, coverConcurrency: 2, upscaleBackend: 'auto', upscaleModel: 'realcugan-2x-conservative' },
    }));

  });

  it('imports a decensor zip through the unified model input', async () => {
    const user = userEvent.setup();
    const loaded = { theme: 'system', defaultLayout: 'auto', defaultDirection: 'ltr', cacheMaxBytes: 2_147_483_648, prefetchPages: 1, coverConcurrency: 4, startupRoute: 'home', cardStyle: 'wide', upscaleBackend: 'off', upscaleModel: '', decensorModel: '', customCss: '' };
    let installed: unknown[] = [];
    const adapter = vi.fn(async (command: string, args?: Record<string, unknown>) => {
      if (command === 'load_preferences') return { ok: true, value: loaded };
      if (command === 'list_servers') return { ok: true, value: [] };
      if (command === 'save_preferences') return { ok: true, value: args?.input };
      if (command === 'inference_list_models') return { ok: true, value: installed };
      if (command === 'inference_import_model_path') {
        installed = [{ id: 'aletheia-lens', version: '1', scale: null, kind: 'decensor', components: [
          { id: 'mrcnn', name: 'Mask R-CNN', role: '遮挡区域检测', path: 'mrcnn/weights.onnx' },
          { id: 'deepcreampy-bar', name: 'DeepCreamPy Bar', role: '条状遮挡修补', path: 'deepcreampy/bar.onnx' },
          { id: 'deepcreampy-mosaic', name: 'DeepCreamPy Mosaic', role: '马赛克修补', path: 'deepcreampy/mosaic.onnx' },
          { id: 'fatal-pixels', name: 'Fatal Pixels', role: '修复结果增强', path: 'esrgan/4x-Fatal-Pixels.onnx' },
        ] }];
        return { ok: true, value: installed[0] };
      }
      throw new Error(`Unexpected command: ${command}`);
    });
    setInvokeAdapterForTests(adapter);
    renderSettings('advanced');
    const toggle = await screen.findByRole('switch', { name: '启用去码' });
    expect(toggle).not.toBeDisabled();
    await user.click(toggle);
    expect(await screen.findByRole('alert')).toHaveTextContent('去码模型不完整');
    // The bundle now travels by disk path: Rust reads the file itself instead
    // of the front end shipping hundreds of MB of numbers across the bridge.
    setModelPickerForTests(() => Promise.resolve('E:\models\bundle.zip'));
    await user.click(screen.getByRole('button', { name: '选择模型文件…' }));
    await vi.waitFor(() => expect(adapter).toHaveBeenCalledWith('inference_import_model_path', { input: { path: 'E:\models\bundle.zip' } }));
    const enabledToggle = screen.getByRole('switch', { name: '启用去码' });
    await vi.waitFor(() => expect(enabledToggle).toBeEnabled());
    await user.click(enabledToggle);
    await vi.waitFor(() => expect(adapter).toHaveBeenCalledWith('save_preferences', {
      input: { ...DEFAULT_PREFERENCES, ...loaded, decensorModel: 'aletheia-lens' },
    }));
  });

  it('downloads the model named by each model option', async () => {
    const user = userEvent.setup();
    const adapter = vi.fn(async (command: string) => {
      if (command === 'load_preferences') return { ok: true, value: DEFAULT_PREFERENCES };
      if (command === 'list_servers') return { ok: true, value: [] };
      if (command === 'inference_list_models') return { ok: true, value: [] };
      if (command === 'model_release_download_default') return { ok: true, value: null };
      return { ok: true, value: [] };
    });
    setInvokeAdapterForTests(adapter);
    renderSettings('advanced');

    await user.click(await screen.findByRole('button', { name: '超分模型' }));
    await user.click(await screen.findByRole('button', { name: '下载waifu2x' }));
    expect(adapter).toHaveBeenCalledWith('model_release_download_default', { modelId: 'waifu2x-upconv7' });
    await user.keyboard('{Escape}');

    await user.click(screen.getByRole('button', { name: '遮挡区域检测模型' }));
    await user.click(await screen.findByRole('button', { name: '下载Mask R-CNN' }));
    expect(adapter).toHaveBeenCalledWith('model_release_download_default', { modelId: 'aletheia-lens' });
  });

  it('offers hosted upscale models that are not on disk yet', async () => {
    const user = userEvent.setup();
    // 只列已安装的模型，手机端就永远等不到 real-cugan：既没有导入入口，也没有
    // 下载入口。目录里的条目要跟着已安装的一起出现，并带上各自的下载按钮。
    const adapter = vi.fn(async (command: string) => {
      if (command === 'load_preferences') return { ok: true, value: DEFAULT_PREFERENCES };
      if (command === 'list_servers') return { ok: true, value: [] };
      if (command === 'inference_list_models') return {
        ok: true,
        value: [{ id: 'anime4k-hq', version: '2', scale: 2, kind: 'upscale', components: [] }],
      };
      if (command === 'model_release_list_upscalers') return {
        ok: true,
        value: {
          tag: 'models-v1',
          models: [
            {
              id: 'realcugan-2x-conservative',
              label: 'Real-CUGAN 2x 通用（保守版）',
              scale: 2,
              version: '2022.02.27',
              source: 'https://github.com/bilibili/ailab/tree/main/Real-CUGAN',
              minInputEdge: 20,
              files: [{ name: 'realcugan-2x-conservative.onnx', size: 5272599, sha256: 'a'.repeat(64) }],
            },
            {
              id: 'realcugan-2x-denoise3x',
              label: 'Real-CUGAN 2x 漫画（强降噪）',
              scale: 2,
              version: '2022.02.27',
              source: 'https://github.com/bilibili/ailab/tree/main/Real-CUGAN',
              minInputEdge: 20,
              files: [{ name: 'realcugan-2x-denoise3x.onnx', size: 5272599, sha256: 'b'.repeat(64) }],
            },
            // 目录重复了已经装上的 id：列表里不能出现第二行。
            {
              id: 'anime4k-hq',
              label: 'Anime4K 重复项',
              scale: 2,
              version: '2',
              files: [{ name: 'anime4k-hq.onnx', size: 1, sha256: 'c'.repeat(64) }],
            },
          ],
        },
      };
      if (command === 'model_release_download_default') return { ok: true, value: null };
      return { ok: true, value: [] };
    });
    setInvokeAdapterForTests(adapter);
    renderSettings('advanced');

    await user.click(await screen.findByRole('button', { name: '超分模型' }));
    await user.click(await screen.findByRole('button', { name: '下载Real-CUGAN 2x 漫画（强降噪）' }));
    await waitFor(() => expect(adapter).toHaveBeenCalledWith('model_release_download_default', { modelId: 'realcugan-2x-denoise3x' }));

    const menu = screen.getByRole('dialog', { name: '超分模型' });
    // 已安装的 anime4k-hq 只有一行：目录里同名那条不再另起一行，也就没有下载
    // 按钮。行名取目录那份——装之前装之后是同一个名字。
    expect(within(menu).getAllByRole('button', { name: 'Anime4K 重复项' })).toHaveLength(1);
    expect(within(menu).queryByRole('button', { name: '下载Anime4K 重复项' })).toBeNull();
  });

  it('shows the download progress where the download was started', async () => {
    const user = userEvent.setup();
    let finishDownload: (() => void) | undefined;
    const adapter = vi.fn(async (command: string) => {
      if (command === 'load_preferences') return { ok: true, value: DEFAULT_PREFERENCES };
      if (command === 'list_servers') return { ok: true, value: [] };
      if (command === 'inference_list_models') return { ok: true, value: [] };
      if (command === 'model_release_list_upscalers') return {
        ok: true,
        value: {
          tag: 'models-v1',
          models: [{
            id: 'realcugan-2x-denoise3x',
            label: 'Real-CUGAN 2x 漫画（强降噪）',
            scale: 2,
            version: '2022.02.27',
            source: 'https://github.com/bilibili/ailab/tree/main/Real-CUGAN',
            minInputEdge: 20,
            files: [{ name: 'realcugan-2x-denoise3x.onnx', size: 5272599, sha256: 'b'.repeat(64) }],
          }],
        },
      };
      // 挂住下载：进度条要在下载进行中才存在。
      if (command === 'model_release_download_default') {
        await new Promise<void>((resolve) => { finishDownload = resolve; });
        return { ok: true, value: null };
      }
      return { ok: true, value: [] };
    });
    setInvokeAdapterForTests(adapter);
    renderSettings('advanced');

    // 下载入口只有二级菜单里那一个。行上曾经还有一个：同一件事两个入口，而值那一格
    // 本来只放得下一句话，多一个按钮就先把它挤没了。行负责选，下载在选项自己那一行。
    expect(screen.queryByRole('button', { name: '下载Real-CUGAN 2x 漫画（强降噪）' })).toBeNull();
    await user.click(await screen.findByRole('button', { name: '超分模型' }));
    await user.click(await screen.findByRole('button', { name: '下载Real-CUGAN 2x 漫画（强降噪）' }));
    await waitFor(() => expect(adapter).toHaveBeenCalledWith('model_release_download_default', { modelId: 'realcugan-2x-denoise3x' }));

    // 设置项那边不再画第二条：两条进度同时出现时，看的人不知道该信哪一条。
    expect(document.querySelector('.settings-group > .model-download-status')).toBeNull();

    // 进度挂在菜单里它自己那一项下面——也就是点「下载」的地方。以前进度画在设置项上，
    // 正好在菜单那层遮罩后面，点完下载根本看不到。
    const menu = screen.getByRole('dialog', { name: '超分模型' });
    const status = menu.querySelector('.model-download-status');
    expect(status).not.toBeNull();
    expect(status?.closest('.settings-choice-option')?.textContent).toContain('Real-CUGAN 2x 漫画（强降噪）');
    // 槽是常驻的，出现/消失靠 is-open：卸载的节点没有过渡可放。
    expect(status?.closest('.model-download-slot')).toHaveClass('is-open');
    // 右边不写百分比：条的长短已经把话说完了。
    expect(menu.querySelector('.model-download-percent')).toBeNull();
    expect(status).toHaveAttribute('role', 'progressbar');
    // 后端还没报总数时是不定量条：没有 aria-valuenow，走扫光。
    expect(status).not.toHaveAttribute('aria-valuenow');
    expect(menu.querySelector('.model-download-track')).toHaveClass('is-indeterminate');

    // 报了总数就是定量条：填充宽度跟着走，仍然不写数字。
    await act(async () => emitTauriEvent('model-download-progress', { path: 'realcugan-2x-denoise3x', completed: 50, total: 200 }));
    expect(status).toHaveAttribute('aria-valuenow', '25');
    const fill = menu.querySelector<HTMLElement>('.model-download-fill');
    expect(fill?.style.width).toBe('25%');
    expect(menu.querySelector('.model-download-track')).not.toHaveClass('is-indeterminate');

    // 下载收尾：槽收回去（内容还在，动画由 is-open 驱动）。
    await act(async () => finishDownload?.());
    expect(status?.closest('.model-download-slot')).not.toHaveClass('is-open');
  });

  it('shows cache usage by rendition and clears unprotected images', async () => {
    const user = userEvent.setup();
    // Keyed on whether the cache was cleared rather than on a call count: the
    // number of stats refreshes is an implementation detail.
    let cleared = false;
    const adapter = vi.fn(async (command: string) => {
      if (command === 'load_preferences') return { ok: true, value: { theme: 'system', defaultLayout: 'auto', defaultDirection: 'ltr', cacheMaxBytes: 2_147_483_648 } };
      if (command === 'list_servers') return { ok: true, value: [] };
      if (command === 'cache_stats') {
        return { ok: true, value: !cleared ? {
          bytes: 7168,
          entries: 4,
          byRendition: {
            cover: { bytes: 1024, entries: 1 },
            'page-thumbnail': { bytes: 2048, entries: 1 },
            'reader-page': { bytes: 4096, entries: 2 },
            enhanced: { bytes: 1024, entries: 1 },
            decensored: { bytes: 1024, entries: 1 },
            inference: { bytes: 1024, entries: 1 },
            other: { bytes: 0, entries: 0 },
          },
        } : {
          bytes: 128,
          entries: 1,
          byRendition: {
            cover: { bytes: 0, entries: 0 },
            'page-thumbnail': { bytes: 0, entries: 0 },
            'reader-page': { bytes: 128, entries: 1 },
            other: { bytes: 0, entries: 0 },
          },
        } };
      }
      if (command === 'cache_clear_images') {
        cleared = true;
        return { ok: true, value: { removedEntries: 3, removedFiles: 3, bytesFreed: 7040, protectedBytes: 128 } };
      }
      throw new Error(`Unexpected command: ${command}`);
    });
    setInvokeAdapterForTests(adapter);

    renderSettings('general');

    await userEvent.setup().click(await screen.findByRole('link', { name: /通用/ }));
    await user.click(await screen.findByRole('button', { name: '图片缓存' }));
    const cacheMenu = await screen.findByRole('dialog', { name: '图片缓存' });
    expect(await within(cacheMenu).findByText('7 KB')).toBeInTheDocument();
    const breakdown = screen.getByLabelText('图片缓存明细');
    expect(breakdown).toHaveTextContent(/封面\s*1\s*KB/);
    expect(breakdown).toHaveTextContent(/页缩略图\s*2\s*KB/);
    expect(breakdown).toHaveTextContent(/阅读页\s*4\s*KB/);
    expect(breakdown).toHaveTextContent(/超分结果\s*1\s*KB/);
    expect(breakdown).toHaveTextContent(/去码结果\s*1\s*KB/);
    expect(breakdown).toHaveTextContent(/推理缓存\s*1\s*KB/);
    await user.click(within(cacheMenu).getByRole('button', { name: '清空图片缓存' }));
    expect(adapter).toHaveBeenCalledWith('cache_clear_images', {});
    expect(await screen.findByText('已释放 6.88 KB，保留 128 B 受保护缓存')).toBeInTheDocument();
    expect(within(screen.getByRole('dialog', { name: '图片缓存' })).getAllByText('128 B')[0]).toBeInTheDocument();
  });

  it('shows a preference loading error', async () => {
    setInvokeAdapterForTests(async (command) => {
      if (command === 'load_preferences') return { ok: false, error: { code: 'INVALID_RESPONSE', message: '偏好数据损坏', retryable: false } };
      if (command === 'list_servers') return { ok: true, value: [] };
      throw new Error(`Unexpected command: ${command}`);
    });

    renderSettings();

    expect(await screen.findByRole('alert')).toHaveTextContent('偏好数据损坏');
  });

  it('retries a recoverable server list error in settings', async () => {
    const user = userEvent.setup();
    let attempts = 0;
    setInvokeAdapterForTests(async (command) => {
      if (command === 'load_preferences') return { ok: true, value: { theme: 'system', defaultLayout: 'auto', defaultDirection: 'ltr', cacheMaxBytes: 2_147_483_648 } };
      if (command === 'list_servers') {
        attempts += 1;
        return attempts === 1
          ? { ok: false, error: { code: 'PLATFORM_UNAVAILABLE', message: '服务器列表暂时不可用', retryable: true } }
          : { ok: true, value: [{ id: 'scope-a', name: 'Home', baseUrl: 'https://example.com', scopeId: 'scope-a' }] };
      }
      throw new Error(`Unexpected command: ${command}`);
    });

    renderSettings();

    await userEvent.setup().click(await screen.findByRole('link', { name: /通用/ }));
    await screen.findByRole('alert');
    await user.click(screen.getByRole('button', { name: '重试读取服务器' }));
    expect(await screen.findByText('Home')).toBeInTheDocument();
  });

  it('imports legacy ordinary preferences and applies the returned snapshot', async () => {
    const user = userEvent.setup();
    const imported = { preferences: { theme: 'light', defaultLayout: 'webtoon', defaultDirection: 'rtl', cacheMaxBytes: 1_073_741_824 }, importedCount: 3 };
    const adapter = vi.fn(async (command: string) => {
      if (command === 'load_preferences') return { ok: true, value: { theme: 'dark', defaultLayout: 'auto', defaultDirection: 'ltr', cacheMaxBytes: 2_147_483_648 } };
      if (command === 'list_servers') return { ok: true, value: [] };
      if (command === 'import_legacy_preferences') return { ok: true, value: imported };
      throw new Error(`Unexpected command: ${command}`);
    });
    setInvokeAdapterForTests(adapter);
    renderSettings('sync');

    await userEvent.setup().click(await screen.findByRole('link', { name: /同步/ }));
    await user.click(await screen.findByRole('button', { name: '导入数据' }));
    const importMenu = screen.getByRole('dialog', { name: '导入数据' });
    await user.type(within(importMenu).getByLabelText('导出 JSON'), 'encoded-config');
    await user.click(within(importMenu).getByRole('button', { name: '导入数据' }));

    expect(await screen.findByText('已导入 3 项偏好设置')).toBeInTheDocument();
    // The imported snapshot lands across sections: theme in 通用, reader
    // defaults in 阅读.
    await user.keyboard('{Escape}');
    await user.click(screen.getByRole('link', { name: /样式/ }));
    expect(screen.getByRole('radio', { name: '浅色' })).toBeChecked();
    await user.click(screen.getByRole('link', { name: /阅读/ }));
    expect(screen.getByRole('radio', { name: '条漫' })).toBeChecked();
    expect(screen.getByRole('radio', { name: '从右到左' })).toBeChecked();
    expect(adapter).toHaveBeenCalledWith('import_legacy_preferences', { encoded: 'encoded-config' });
  });

  it('exports the checked sync scope as the sync document', async () => {
    const user = userEvent.setup();
    // 导出走原生侧那一份：本地日志折成同步文档，所以这里不再逐个表去取。取不到
    // 就会抛——「不再逐表取」这条正是这个 mock 守着的。
    const adapter = vi.fn(async (command: string) => {
      if (command === 'load_preferences') return { ok: true, value: DEFAULT_PREFERENCES };
      if (command === 'list_servers') return { ok: true, value: [{ id: 'scope-a', name: 'Home', baseUrl: 'https://example.com', scopeId: 'scope-a' }] };
      if (command === 'list_sync_accounts') return { ok: true, value: [] };
      if (command === 'export_scoped_data') {
        return {
          ok: true,
          value: {
            text: '{"kind":"yomika-scope-export","schemaVersion":1,"exportedAt":"2026-09-22 10:00:00","categories":["history"],"document":{"version":1,"epoch":0,"objects":{}}}',
            objects: 3,
            categories: ['history'],
          },
        };
      }
      throw new Error(`Unexpected command: ${command}`);
    });
    setInvokeAdapterForTests(adapter);
    renderSettings('sync');

    await user.click(await screen.findByRole('link', { name: /同步/ }));
    await user.click(await screen.findByRole('button', { name: '导出数据' }));
    const exportMenu = await screen.findByRole('dialog', { name: '导出数据' });
    await user.click(within(exportMenu).getByRole('button', { name: '导出数据' }));

    // 没账户时用默认集合：记录与设置全勾，凭证不勾（原生侧也没有属于它的对象）。
    await waitFor(() => expect(adapter).toHaveBeenCalledWith('export_scoped_data', {
      categories: JSON.stringify(DEFAULT_DATA_TRANSFER_SCOPE),
    }));
    expect(await screen.findByText('已导出 3 项：全部记录与设置')).toBeInTheDocument();
    const exported = (within(exportMenu).getByLabelText('导出 JSON') as HTMLTextAreaElement).value;
    expect(JSON.parse(exported)).toMatchObject({ kind: 'yomika-scope-export', schemaVersion: 1 });
  });

  it('imports a scoped export through the checked scope', async () => {
    const user = userEvent.setup();
    const adapter = vi.fn(async (command: string) => {
      if (command === 'load_preferences') return { ok: true, value: DEFAULT_PREFERENCES };
      if (command === 'list_servers') return { ok: true, value: [] };
      if (command === 'list_sync_accounts') return { ok: true, value: [] };
      if (command === 'import_scoped_data') {
        return { ok: true, value: { applied: 4, skipped: 2, categories: ['history'] } };
      }
      throw new Error(`Unexpected command: ${command}`);
    });
    setInvokeAdapterForTests(adapter);
    renderSettings('sync');

    await user.click(await screen.findByRole('link', { name: /同步/ }));
    await user.click(await screen.findByRole('button', { name: '导入数据' }));
    const importMenu = screen.getByRole('dialog', { name: '导入数据' });
    // 粘贴一份本机的导出：userEvent.type 会把 `{{` 当成转义，所以直接改值。
    const scopedExport = '{"kind":"yomika-scope-export","schemaVersion":1,"document":{"version":1,"epoch":0,"objects":{}}}';
    fireEvent.change(within(importMenu).getByLabelText('导出 JSON'), { target: { value: scopedExport } });
    await user.click(within(importMenu).getByRole('button', { name: '导入数据' }));

    await waitFor(() => expect(adapter).toHaveBeenCalledWith('import_scoped_data', {
      payload: scopedExport,
      categories: JSON.stringify(DEFAULT_DATA_TRANSFER_SCOPE),
    }));
    // 类别没勾的留在门外，报数要说清楚——不然「导了一半」看着像丢了数据。
    expect(await screen.findByText('已导入 4 项，跳过 2 项（类别未勾选）')).toBeInTheDocument();
  });

  it('exports records and credentials together through one passphrase, in one file', async () => {
    // 范围里勾了凭据，「导出数据」就先要口令，然后**一份**文件装两半：记录折好之后交给
    // 原生侧，和凭据一起锁进同一份密文。曾经那是两颗按钮、两条路，同一次迁移要点两回。
    const user = userEvent.setup();
    const adapter = vi.fn(async (command: string, args?: Record<string, unknown>) => {
      if (command === 'load_preferences') return { ok: true, value: DEFAULT_PREFERENCES };
      if (command === 'save_preferences') return { ok: true, value: args?.input };
      if (command === 'list_servers') return { ok: true, value: [] };
      if (command === 'list_sync_accounts') return { ok: true, value: [] };
      if (command === 'export_scoped_data') {
        return { ok: true, value: { text: SCOPED_EXPORT_TEXT, objects: 2, categories: [] } };
      }
      if (command === 'export_credentials') {
        return { ok: true, value: { text: '{"kind":"yomika-credentials","schemaVersion":1}', servers: 1, ehAccounts: 1, syncAccounts: 1, records: 2, skipped: 0 } };
      }
      throw new Error(`Unexpected command: ${command}`);
    });
    setInvokeAdapterForTests(adapter);
    renderSettings('sync');

    await user.click(await screen.findByRole('link', { name: /同步/ }));
    await checkCredentialScope(user);
    await user.click(await screen.findByRole('button', { name: '导出数据' }));
    const exportMenu = screen.getByRole('dialog', { name: '导出数据' });
    // 没有「导出凭据…」这一步了：导出数据点下去，接着弹的就是口令。
    expect(within(exportMenu).queryByRole('button', { name: /导出凭据/ })).toBeNull();
    await user.click(within(exportMenu).getByRole('button', { name: '导出数据' }));

    // 导出要输两遍：这个口令是文件唯一的防线，输错了文件就再也打不开。
    const dialog = await screen.findByRole('dialog', { name: '给凭据文件设个口令' });
    // 文件里装的是刚勾的那几类——对话框自己说出来，省得回头翻范围。
    expect(within(dialog).getByText(/文件里有记录与设置、LRR 服务器、E-H 账户、同步账户/)).toBeInTheDocument();
    const passphrase = within(dialog).getByLabelText('口令', { exact: true });
    const confirm = within(dialog).getByLabelText('确认口令', { exact: true });
    await user.type(passphrase, 'a-long-passphrase');
    await user.type(confirm, 'a-different-one');
    expect(within(dialog).getByText('两次输入的口令不一致')).toBeInTheDocument();
    expect(adapter).not.toHaveBeenCalledWith('export_credentials', expect.anything());

    await user.clear(confirm);
    await user.type(confirm, 'a-long-passphrase');
    await user.click(within(dialog).getByRole('button', { name: '导出' }));

    // 记录先折出来（同一套合并规则），再连着凭据一起加密。
    await waitFor(() => expect(adapter).toHaveBeenCalledWith('export_scoped_data', {
      categories: JSON.stringify(DEFAULT_DATA_TRANSFER_SCOPE),
    }));
    await waitFor(() => expect(adapter).toHaveBeenCalledWith('export_credentials', {
      passphrase: 'a-long-passphrase',
      categories: CREDENTIAL_SCOPE,
      records: SCOPED_EXPORT_TEXT,
    }));
    expect(await screen.findByText('已导出一份口令加密的文件：记录与设置 2 项 · 服务器 1 · E-H 账户 1 · 同步账户 1')).toBeInTheDocument();
    // 密文进了导出框，可以复制走。
    expect((within(exportMenu).getByLabelText('导出 JSON') as HTMLTextAreaElement).value).toContain('yomika-credentials');
  });

  it('exports credentials only for the classes the transfer scope checks', async () => {
    const user = userEvent.setup();
    const adapter = vi.fn(async (command: string, args?: Record<string, unknown>) => {
      if (command === 'load_preferences') return { ok: true, value: DEFAULT_PREFERENCES };
      if (command === 'save_preferences') return { ok: true, value: args?.input };
      if (command === 'list_servers') return { ok: true, value: [] };
      if (command === 'list_sync_accounts') return { ok: true, value: [] };
      if (command === 'export_scoped_data') {
        return { ok: true, value: { text: SCOPED_EXPORT_TEXT, objects: 0, categories: [] } };
      }
      if (command === 'export_credentials') {
        return { ok: true, value: { text: '{"kind":"yomika-credentials","schemaVersion":1}', servers: 0, ehAccounts: 1, syncAccounts: 0, records: 0, skipped: 0 } };
      }
      throw new Error(`Unexpected command: ${command}`);
    });
    setInvokeAdapterForTests(adapter);
    renderSettings('sync');

    await user.click(await screen.findByRole('link', { name: /同步/ }));

    // 先看默认：一个凭据类都没勾，导出就是**明文**的记录那一份，不会弹口令
    // （口令只在范围里勾了凭据时才要）。
    await user.click(await screen.findByRole('button', { name: '导出数据' }));
    const exportMenu = screen.getByRole('dialog', { name: '导出数据' });
    await user.click(within(exportMenu).getByRole('button', { name: '导出数据' }));
    await waitFor(() => expect(adapter).toHaveBeenCalledWith('export_scoped_data', {
      categories: JSON.stringify(DEFAULT_DATA_TRANSFER_SCOPE),
    }));
    expect(screen.queryByRole('dialog', { name: '给凭据文件设个口令' })).toBeNull();
    expect(adapter).not.toHaveBeenCalledWith('export_credentials', expect.anything());
    await user.keyboard('{Escape}');

    // 只勾 E-H 账户：文件里就只有这一类，别的凭据不跟着走。
    await user.click(await screen.findByRole('button', { name: '导入导出范围' }));
    const panel = await screen.findByRole('dialog', { name: '导入导出范围' });
    await user.click(within(panel).getByRole('checkbox', { name: '导入导出E-H 账户' }));
    await vi.waitFor(() => expect(adapter).toHaveBeenCalledWith('save_preferences', {
      input: expect.objectContaining({ dataTransferScope: [...DEFAULT_DATA_TRANSFER_SCOPE, 'eh_account'] }),
    }));
    await user.keyboard('{Escape}');

    await user.click(await screen.findByRole('button', { name: '导出数据' }));
    await user.click(within(await screen.findByRole('dialog', { name: '导出数据' })).getByRole('button', { name: '导出数据' }));
    const dialog = await screen.findByRole('dialog', { name: '给凭据文件设个口令' });
    await user.type(within(dialog).getByLabelText('口令', { exact: true }), 'a-long-passphrase');
    await user.type(within(dialog).getByLabelText('确认口令', { exact: true }), 'a-long-passphrase');
    await user.click(within(dialog).getByRole('button', { name: '导出' }));

    await waitFor(() => expect(adapter).toHaveBeenCalledWith('export_credentials', {
      passphrase: 'a-long-passphrase',
      categories: JSON.stringify(['eh_account']),
      records: SCOPED_EXPORT_TEXT,
    }));
  });

  it('asks for the passphrase before importing a credentials file', async () => {
    const user = userEvent.setup();
    const adapter = vi.fn(async (command: string, args?: Record<string, unknown>) => {
      if (command === 'load_preferences') return { ok: true, value: DEFAULT_PREFERENCES };
      if (command === 'save_preferences') return { ok: true, value: args?.input };
      if (command === 'list_servers') return { ok: true, value: [] };
      if (command === 'list_sync_accounts') return { ok: true, value: [] };
      if (command === 'import_credentials') {
        return { ok: true, value: { servers: 1, ehAccounts: 0, syncAccounts: 1, records: 3, recordsSkipped: false } };
      }
      throw new Error(`Unexpected command: ${command}`);
    });
    setInvokeAdapterForTests(adapter);
    renderSettings('sync');

    await user.click(await screen.findByRole('link', { name: /同步/ }));
    await user.click(await screen.findByRole('button', { name: '导入数据' }));
    const importMenu = screen.getByRole('dialog', { name: '导入数据' });
    const envelope = '{"kind":"yomika-credentials","schemaVersion":1,"salt":"c2FsdA==","nonce":"bm9uY2U=","payload":"Y2lwaGVy"}';
    fireEvent.change(within(importMenu).getByLabelText('导出 JSON'), { target: { value: envelope } });

    // 一个凭据类都没勾：说清要去勾上，而不是开一个注定空手而归的口令对话框。
    await user.click(within(importMenu).getByRole('button', { name: '导入数据' }));
    expect(await screen.findByText(/先在「导入导出范围」里勾上要导入的凭据类/)).toBeInTheDocument();
    expect(screen.queryByRole('dialog', { name: '输入凭据文件的口令' })).toBeNull();

    await user.keyboard('{Escape}');
    await checkCredentialScope(user);

    await user.click(await screen.findByRole('button', { name: '导入数据' }));
    const retryMenu = await screen.findByRole('dialog', { name: '导入数据' });
    fireEvent.change(within(retryMenu).getByLabelText('导出 JSON'), { target: { value: envelope } });
    await user.click(within(retryMenu).getByRole('button', { name: '导入数据' }));

    // 认出是凭据文件就先要口令，而不是把它当记录去导。
    const dialog = await screen.findByRole('dialog', { name: '输入凭据文件的口令' });
    await user.type(within(dialog).getByLabelText('口令', { exact: true }), 'a-long-passphrase');
    await user.click(within(dialog).getByRole('button', { name: '导入' }));

    await waitFor(() => expect(adapter).toHaveBeenCalledWith('import_credentials', {
      payload: envelope,
      passphrase: 'a-long-passphrase',
      categories: CREDENTIAL_SCOPE,
      recordCategories: JSON.stringify(DEFAULT_DATA_TRANSFER_SCOPE),
    }));
    // 文件里那一半记录与设置也一起落地了（口令解开之后两半同时写回）。
    expect(await screen.findByText('已导入 3 项记录与设置 · 服务器 1 · E-H 账户 0 · 同步账户 1')).toBeInTheDocument();
  });

  it('imports a readoshi worker v3 export into the matching server scope', async () => {
    const user = userEvent.setup();
    const serverScope = readoshiServerScope('https://example.com');
    const adapter = vi.fn(async (command: string) => {
      if (command === 'load_preferences') return { ok: true, value: DEFAULT_PREFERENCES };
      if (command === 'list_servers') return { ok: true, value: [{ id: 'scope-a', name: 'Home', baseUrl: 'https://example.com', scopeId: 'scope-a' }] };
      if (command === 'import_worker_export') return { ok: true, value: { history: 2, historyRemoved: 1, watchlist: 1, watchlistRemoved: 1 } };
      if (command === 'dedup_import_readoshi') return { ok: true, value: null };
      throw new Error();
    });
    setInvokeAdapterForTests(adapter);
    renderSettings('sync');

    await user.click(await screen.findByRole('link', { name: /同步/ }));
    await user.click(await screen.findByRole('button', { name: '导入数据' }));
    const importMenu = screen.getByRole('dialog', { name: '导入数据' });
    const envelope = JSON.stringify({
      version: 3,
      scope: 'token-and-server-md5',
      serverScope,
      exportedAt: '2026-09-13T12:21:55.353Z',
      sections: {
        history: { history: JSON.stringify({ histories: [{ id: 'a1', page: 148, time: 1789292133362 }] }) },
        watchlist: { watchlist: JSON.stringify({ items: [{ id: 'w1', addedAt: 1788539817490 }] }) },
        dedupe: { dedupe: JSON.stringify(['aaa|bbb']) },
      },
    });
    // JSON braces collide with userEvent key syntax; set the value directly.
    fireEvent.change(within(importMenu).getByLabelText('导出 JSON'), { target: { value: envelope } });
    await user.click(within(importMenu).getByRole('button', { name: '导入数据' }));

    expect(await screen.findByText(/已导入：阅读 2 · 待看 1 · 重复关系 1/)).toBeInTheDocument();
    expect(adapter).toHaveBeenCalledWith('import_worker_export', expect.objectContaining({
      input: expect.objectContaining({
        scopeId: 'scope-a',
        history: { entries: [{ archiveId: 'a1', pageIndex: 148, visitedAt: '2026-09-13 09:35:33.362' }], deletedIds: [] },
        watchlist: { entries: [{ archiveId: 'w1', addedAt: '2026-09-04 16:36:57.490' }], tombstones: [] },
      }),
    }));
    expect(adapter).toHaveBeenCalledWith('dedup_import_readoshi', expect.objectContaining({
      input: expect.objectContaining({
        scopeId: 'scope-a',
        pairs: [{ leftArchiveId: 'aaa', rightArchiveId: 'bbb', source: 'readoshi', diagnostics: null }],
      }),
    }));
  });

  it('refuses a worker v3 export from an unconfigured server', async () => {
    const user = userEvent.setup();
    setInvokeAdapterForTests(async (command) => {
      if (command === 'load_preferences') return { ok: true, value: DEFAULT_PREFERENCES };
      if (command === 'list_servers') return { ok: true, value: [] };
      throw new Error();
    });
    renderSettings('sync');

    await user.click(await screen.findByRole('link', { name: /同步/ }));
    await user.click(await screen.findByRole('button', { name: '导入数据' }));
    const importMenu = screen.getByRole('dialog', { name: '导入数据' });
    const envelope = JSON.stringify({ version: 3, scope: 'token-and-server-md5', serverScope: 'f4fe9bbfa7d17b5bcd601ca76192b539', exportedAt: '2026-09-13T12:21:55.353Z', sections: {} });
    fireEvent.change(within(importMenu).getByLabelText('导出 JSON'), { target: { value: envelope } });
    await user.click(within(importMenu).getByRole('button', { name: '导入数据' }));

    expect(await screen.findByText(/导出属于其他 LANraragi 服务器/)).toBeInTheDocument();
  });

  it('shows legacy import failure without changing preferences', async () => {
    const user = userEvent.setup();
    setInvokeAdapterForTests(async (command) => {
      if (command === 'load_preferences') return { ok: true, value: { theme: 'dark', defaultLayout: 'auto', defaultDirection: 'ltr', cacheMaxBytes: 2_147_483_648 } };
      if (command === 'list_servers') return { ok: true, value: [] };
      if (command === 'import_legacy_preferences') return { ok: false, error: { code: 'INVALID_RESPONSE', message: '旧配置无有效普通偏好', retryable: false } };
      throw new Error(`Unexpected command: ${command}`);
    });
    renderSettings('sync');

    await userEvent.setup().click(await screen.findByRole('link', { name: /同步/ }));
    await user.click(await screen.findByRole('button', { name: '导入数据' }));
    const importMenu = screen.getByRole('dialog', { name: '导入数据' });
    await user.type(within(importMenu).getByLabelText('导出 JSON'), 'secret-only');
    await user.click(within(importMenu).getByRole('button', { name: '导入数据' }));

    expect(await screen.findByText('旧配置无有效普通偏好')).toBeInTheDocument();
    await user.keyboard('{Escape}');
    await user.click(screen.getByRole('link', { name: /通用/ }));
    await user.click(screen.getByRole('link', { name: /样式/ }));
    expect(screen.getByRole('radio', { name: '深色' })).toBeChecked();
  });

  it('persists the floating bottom bar preference from the appearance section', async () => {
    const user = userEvent.setup();
    const adapter = vi.fn(async (command: string, args?: Record<string, unknown>) => {
      if (command === 'load_preferences') return { ok: true, value: DEFAULT_PREFERENCES };
      if (command === 'list_servers') return { ok: true, value: [] };
      if (command === 'save_preferences') return { ok: true, value: args?.input };
      return { ok: true, value: [] };
    });
    setInvokeAdapterForTests(adapter);
    renderSettings('appearance');

    // 悬浮底栏是样式分区里的一行开关；翻开关即保存。
    const floatingBar = await screen.findByRole('switch', { name: '悬浮底栏' });
    await user.click(floatingBar);
    await vi.waitFor(() => expect(adapter).toHaveBeenCalledWith('save_preferences', { input: { ...DEFAULT_PREFERENCES, floatingNav: true } }));
  });

  it('customizes bottom bar items with only 档案库 pinned', async () => {
    const user = userEvent.setup();
    const adapter = vi.fn(async (command: string, args?: Record<string, unknown>) => {
      if (command === 'load_preferences') return { ok: true, value: DEFAULT_PREFERENCES };
      if (command === 'list_servers') return { ok: true, value: [] };
      if (command === 'save_preferences') return { ok: true, value: args?.input };
      return { ok: true, value: [] };
    });
    setInvokeAdapterForTests(adapter);
    renderSettings('appearance');

    await user.click(await screen.findByRole('button', { name: '底栏项目' }));
    const menu = screen.getByRole('dialog', { name: '底栏项目' });
    // 固定项禁用且勾选，无法被取消。
    const pinned = within(menu).getByRole('checkbox', { name: '底栏显示档案库' });
    expect(pinned).toBeDisabled();
    expect(pinned).toHaveAttribute('aria-checked', 'true');
    // 勾选 待看（追加到末尾）、取消 历史。
    await user.click(within(menu).getByRole('checkbox', { name: '底栏显示待看' }));
    await vi.waitFor(() => expect(adapter).toHaveBeenCalledWith('save_preferences', {
      input: { ...DEFAULT_PREFERENCES, bottomNavItems: ['home', 'library', 'history', 'watchlist', 'settings', 'to-read'] },
    }));
    await user.click(within(menu).getByRole('checkbox', { name: '底栏显示历史' }));
    await vi.waitFor(() => expect(adapter).toHaveBeenCalledWith('save_preferences', {
      input: { ...DEFAULT_PREFERENCES, bottomNavItems: ['home', 'library', 'watchlist', 'settings', 'to-read'] },
    }));
    // 行值随之更新（默认 5 项 − 历史 + 待看 = 5 项）。
    expect(screen.getByRole('button', { name: '底栏项目' })).toBeEnabled();
    expect(screen.getByText('5 项')).toBeInTheDocument();

    // 设置不再是固定项：可以取消勾选，并且真的写进偏好。取消掉也不会失联——
    // 没收进底栏的页面统一出现在「更多」里。
    const settings = within(menu).getByRole('checkbox', { name: '底栏显示设置' });
    expect(settings).toBeEnabled();
    expect(settings).toHaveAttribute('aria-checked', 'true');
    await user.click(settings);
    await vi.waitFor(() => expect(adapter).toHaveBeenCalledWith('save_preferences', {
      input: { ...DEFAULT_PREFERENCES, bottomNavItems: ['home', 'library', 'watchlist', 'to-read'] },
    }));
    expect(within(menu).getByRole('checkbox', { name: '底栏显示设置' })).toHaveAttribute('aria-checked', 'false');
    // 详情页功能按钮的默认值同样是 4 项，所以计数要读在它自己那一行上。
    expect(within(screen.getByRole('button', { name: '底栏项目' })).getByText('4 项')).toBeInTheDocument();
  });

  it('filters the compact bottom bar by preference and leaves the desktop sidebar whole', async () => {
    const original = window.matchMedia;
    window.matchMedia = ((query: string) => ({
      matches: query === COMPACT_WIDTH_QUERY,
      media: query,
      onchange: null,
      addEventListener: () => {},
      removeEventListener: () => {},
      addListener: () => {},
      removeListener: () => {},
      dispatchEvent: () => false,
    })) as unknown as typeof window.matchMedia;
    try {
      setInvokeAdapterForTests(async (command) => {
        if (command === 'load_preferences') return { ok: true, value: { ...DEFAULT_PREFERENCES, bottomNavItems: ['home', 'library', 'downloads', 'settings'] } };
        if (command === 'list_servers') return { ok: true, value: [] };
        throw new Error(`Unexpected command: ${command}`);
      });

      const compact = render(
        <MemoryRouter initialEntries={['/']}><App /></MemoryRouter>,
      );
      const compactNav = await compact.findByRole('navigation', { name: '移动导航' });
      const compactNames = Array.from(compactNav.querySelectorAll('a')).map((link) => link.textContent);
      // 结尾的「更多」是入口本身（独立页面 /more），不是底栏放不下的那个页面。
      expect(compactNames).toEqual(['首页', '档案库', '本地档案', '设置', '更多']);
      compact.unmount();

      // 桌面侧边栏不受该偏好影响，仍然完整。
      const desktop = render(
        <MemoryRouter initialEntries={['/']}><App /></MemoryRouter>,
      );
      const sideNav = await desktop.findByRole('navigation', { name: '主导航' });
      const sideNames = Array.from(sideNav.querySelectorAll('a')).map((link) => link.textContent);
      expect(sideNames).toEqual(['首页', '档案库', '历史', '收藏夹', '待看', '本地档案', '设置']);
    } finally {
      window.matchMedia = original;
    }
  });

  it('drills into one section at a time in the compact layout', async () => {
    const user = userEvent.setup();
    // jsdom never matches a width query, so the compact layout has to be asked
    // for explicitly. Everything else (the theme's prefers-color-scheme probe)
    // keeps reporting no match.
    const original = window.matchMedia;
    window.matchMedia = ((query: string) => ({
      matches: query === COMPACT_WIDTH_QUERY,
      media: query,
      onchange: null,
      addEventListener: () => {},
      removeEventListener: () => {},
      addListener: () => {},
      removeListener: () => {},
      dispatchEvent: () => false,
    })) as unknown as typeof window.matchMedia;
    try {
      setInvokeAdapterForTests(async (command) => {
        if (command === 'load_preferences') return { ok: true, value: { theme: 'system', defaultLayout: 'auto', defaultDirection: 'ltr', cacheMaxBytes: 2_147_483_648 } };
        if (command === 'list_servers') return { ok: true, value: [] };
        throw new Error(`Unexpected command: ${command}`);
      });
      renderSettings();

      // The list first: no section content, and every section reachable.
      expect(await screen.findByRole('button', { name: /关于/ })).toBeInTheDocument();
      expect(screen.queryByRole('region', { name: '服务器' })).not.toBeInTheDocument();

      await user.click(screen.getByRole('button', { name: /通用/ }));
      expect(await screen.findByRole('heading', { name: '通用' })).toBeInTheDocument();
      expect(screen.getByRole('region', { name: '服务器' })).toBeInTheDocument();
      // One section at a time: the list is gone rather than sitting above it.
      expect(screen.queryByRole('button', { name: /关于/ })).not.toBeInTheDocument();

      await user.click(screen.getByRole('button', { name: '返回设置分类' }));
      expect(await screen.findByRole('button', { name: /关于/ })).toBeInTheDocument();
      expect(screen.queryByRole('region', { name: '服务器' })).not.toBeInTheDocument();
    } finally {
      window.matchMedia = original;
    }
  });

  it('applies a basic color scheme as soon as it is picked', async () => {
    const user = userEvent.setup();
    const loaded = { theme: 'system', defaultLayout: 'auto', defaultDirection: 'ltr', cacheMaxBytes: 2_147_483_648, prefetchPages: 1, coverConcurrency: 4, startupRoute: 'home', cardStyle: 'wide', upscaleBackend: 'off', upscaleModel: '', decensorModel: '', customCss: '' };
    setInvokeAdapterForTests(async (command: string, args) => {
      if (command === 'load_preferences') return { ok: true, value: loaded };
      if (command === 'save_preferences') return { ok: true, value: (args as { input: typeof loaded }).input };
      if (command === 'list_servers') return { ok: true, value: [] };
      if (command === 'cache_stats') return { ok: true, value: { bytes: 0, entries: 0, maxBytes: 2_147_483_648, byRendition: { cover: { bytes: 0, entries: 0 }, 'page-thumbnail': { bytes: 0, entries: 0 }, 'reader-page': { bytes: 0, entries: 0 }, other: { bytes: 0, entries: 0 } } } };
      throw new Error(`Unexpected command: ${command}`);
    });
    renderSettings();

    // 基础层默认就在前面：配色卡片点选即套用，卡片名即方案名。
    await user.click(await screen.findByRole('link', { name: /样式/ }));
    await user.click(await screen.findByRole('button', { name: '自定义' }));
    const customMenu = await screen.findByRole('dialog', { name: '自定义' });
    const celadon = COLOR_SCHEMES.find((scheme) => scheme.id === 'celadon')!;
    const card = within(customMenu).getByRole('button', { name: /青瓷/ });
    await user.click(card);
    expect(card).toHaveAttribute('aria-pressed', 'true');
    // The picked card stays marked, and no save step stands between the click
    // and the stylesheet.
    await vi.waitFor(() => {
      expect(document.getElementById('yomika-custom-css')?.textContent).toBe(celadon.css);
    });
  });
});

it('saves the selected detail actions from the appearance settings container', async () => {
  const user = userEvent.setup();
  const adapter = vi.fn(async (command: string, args?: Record<string, unknown>) => ({ ok: true, value: command === 'load_preferences' ? DEFAULT_PREFERENCES : command === 'save_preferences' ? args?.input : [] }));
  setInvokeAdapterForTests(adapter);
  renderSettings('appearance');
  await user.click(await screen.findByRole('button', { name: '详情页功能按钮' }));
  const panel = screen.getByRole('dialog', { name: '详情页功能按钮' });
  expect(within(panel).getByRole('checkbox', { name: '详情页显示下载' })).toHaveAttribute('aria-checked', 'true');
  expect(within(panel).getByRole('checkbox', { name: '详情页显示编辑' })).toHaveAttribute('aria-checked', 'false');
  await user.click(within(panel).getByRole('checkbox', { name: '详情页显示编辑' }));
  await vi.waitFor(() => expect(adapter).toHaveBeenCalledWith('save_preferences', { input: expect.objectContaining({ detailActions: ['read', 'readingList', 'favorites', 'download', 'edit'] }) }));
});

it('defaults the detail time fact to the publish date and saves the added-date choice', async () => {
  const user = userEvent.setup();
  const adapter = vi.fn(async (command: string, args?: Record<string, unknown>) => ({ ok: true, value: command === 'load_preferences' ? DEFAULT_PREFERENCES : command === 'save_preferences' ? args?.input : [] }));
  setInvokeAdapterForTests(adapter);
  renderSettings('appearance');
  await user.click(await screen.findByRole('button', { name: '详情页时间' }));
  const panel = screen.getByRole('dialog', { name: '详情页时间' });
  expect(within(panel).getByRole('button', { name: '发布时间' }).closest('.settings-choice-option')).toHaveClass('is-active');
  await user.click(within(panel).getByRole('button', { name: '添加时间' }));
  await vi.waitFor(() => expect(adapter).toHaveBeenCalledWith('save_preferences', { input: expect.objectContaining({ detailDateKind: 'added' }) }));
});

it('does not overwrite newer detail action edits with an earlier save response', async () => {
  const user = userEvent.setup();
  let finishFirst!: (value: unknown) => void;
  let firstInput: unknown;
  const adapter = vi.fn(async (command: string, args?: Record<string, unknown>) => {
    if (command === 'load_preferences') return { ok: true, value: DEFAULT_PREFERENCES };
    if (command === 'save_preferences') {
      if (!firstInput) { firstInput = args?.input; return new Promise((resolve) => { finishFirst = resolve; }); }
      return { ok: true, value: args?.input };
    }
    return { ok: true, value: [] };
  });
  setInvokeAdapterForTests(adapter);
  renderSettings('appearance');
  await user.click(await screen.findByRole('button', { name: '详情页功能按钮' }));
  await user.click(screen.getByRole('checkbox', { name: '详情页显示编辑' }));
  await vi.waitFor(() => expect(firstInput).toBeDefined());
  await user.click(screen.getByRole('checkbox', { name: '详情页显示下载' }));
  await act(async () => { finishFirst({ ok: true, value: firstInput }); });
  expect(screen.getByRole('checkbox', { name: '详情页显示下载' })).toHaveAttribute('aria-checked', 'false');
  await vi.waitFor(() => expect(adapter.mock.calls.filter(([command]) => command === 'save_preferences')).toHaveLength(2));
  expect(screen.getByRole('checkbox', { name: '详情页显示下载' })).toHaveAttribute('aria-checked', 'false');
  expect(screen.getByRole('checkbox', { name: '详情页显示编辑' })).toHaveAttribute('aria-checked', 'true');
});
