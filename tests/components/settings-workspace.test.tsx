import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, vi } from 'vitest';
import { MemoryRouter } from 'react-router-dom';

import { App } from '../../src/app/App';
import { RetainedPage } from '../../src/app/RetainedPage';
import { SettingsWorkspace } from '../../src/components/SettingsWorkspace';
import { ConfirmDialog } from '../../src/components/ConfirmDialog';
import { PreferencesProvider } from '../../src/app/preferences';
import * as platformBridge from '../../src/bridge/platform';
import { resetInvokeAdapterForTests, setInvokeAdapterForTests } from '../../src/bridge/invoke';
import { resetFilePickerForTests, setDirectoryPickerForTests, setModelPickerForTests, setSavePickerForTests, setTextFilePickerForTests } from '../../src/bridge/filePicker';
import { COMPACT_WIDTH_QUERY } from '../../src/lib/useMediaQuery';
import { DEFAULT_PREFERENCES } from '../../src/repositories/nativeSettingsRepository';
import { COLOR_SCHEMES } from '../../src/lib/cssThemePresets';
import { readoshiServerScope } from '../../src/lib/readoshiScope';
import { emitTauriEvent } from '../tauriEvents';
import { resetOverlayBackGuardForTests } from '../../src/lib/overlayBackGuard';

/** 空转两拍：浮层自己关掉时会调 `history.back()` 吃掉自己的守卫，jsdom 为它发的
 * `popstate` 是异步的——抢在它前面发用户那一下，两次返回会撞在一起。 */
async function settle() {
  await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); });
  await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); });
}

afterEach(() => {
  resetInvokeAdapterForTests();
  resetFilePickerForTests();
  delete (window as { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__;
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

it.each(['realcugan-2x-denoise3x', 'waifu2x-upconv7'])('opens adjustable weights with a selected default when the active model is %s', async (activeModel) => {
  const user = userEvent.setup();
  const adapter = vi.fn(async (command: string, args?: Record<string, unknown>) => {
    if (command === 'load_preferences') return { ok: true, value: { ...DEFAULT_PREFERENCES, upscaleBackend: 'auto', upscaleModel: activeModel } };
    if (command === 'save_preferences') return { ok: true, value: args?.input };
    if (command === 'inference_list_models') return { ok: true, value: ['realcugan-2x-conservative', 'realcugan-2x-denoise3x'].map((id) => ({ id, version: '1', scale: 2, kind: 'upscale', components: [] })) };
    return { ok: true, value: [] };
  });
  setInvokeAdapterForTests(adapter);
  renderSettings('advanced');
  await user.click(await screen.findByRole('button', { name: '超分模型' }));
  expect(within(screen.getByRole('dialog', { name: '超分模型' })).getAllByRole('button', { name: 'Real-CUGAN' })).toHaveLength(1);
  await user.click(screen.getByRole('button', { name: '设置Real-CUGAN' }));
  const menu = screen.getByRole('dialog', { name: 'Real-CUGAN 设置' });
  expect(within(menu).getByRole('group', { name: '降噪力度' })).toBeInTheDocument();
  expect(within(menu).getByRole('button', { name: activeModel === 'waifu2x-upconv7' ? '保守' : '强降噪' })).toHaveAttribute('aria-pressed', 'true');
  expect(within(menu).getAllByRole('heading')).toHaveLength(1);
  expect(within(menu).queryByText('2×')).toBeNull();
  await user.click(within(menu).getByRole('button', { name: '保守' }));
  await waitFor(() => expect(adapter).toHaveBeenCalledWith('save_preferences', { input: expect.objectContaining({ upscaleModel: 'realcugan-2x-conservative', upscaleOutputScale: 0 }) }));
  await user.click(screen.getByRole('dialog', { name: 'Real-CUGAN 设置' }).closest('.settings-choice-overlay')!);
  expect(screen.getByRole('dialog', { name: '超分模型' })).toBeInTheDocument();
  await user.keyboard('{Escape}');
  expect(screen.queryByRole('button', { name: '降噪力度' })).toBeNull();
  expect(screen.queryByRole('button', { name: '超分倍率' })).toBeNull();
});

it('deletes downloaded family weights after confirmation and selects a remaining model', async () => {
  const user = userEvent.setup();
  let models = ['waifu2x-upconv7', 'realcugan-2x-conservative', 'realcugan-2x-denoise3x', 'span-nomosuni-photo'].map((id) => ({ id, version: '1', scale: 2, kind: 'upscale', components: [] }));
  const adapter = vi.fn(async (command: string, args?: Record<string, unknown>) => {
    if (command === 'load_preferences') return { ok: true, value: { ...DEFAULT_PREFERENCES, upscaleBackend: 'auto', upscaleModel: 'realcugan-2x-denoise3x' } };
    if (command === 'save_preferences') return { ok: true, value: args?.input };
    if (command === 'inference_list_models') return { ok: true, value: models };
    if (command === 'inference_remove_models') {
      models = models.filter((model) => !(args?.modelIds as string[]).includes(model.id));
      return { ok: true, value: models };
    }
    return { ok: true, value: [] };
  });
  setInvokeAdapterForTests(adapter);
  renderSettings('advanced');
  await user.click(await screen.findByRole('button', { name: '超分模型' }));
  expect(screen.queryByRole('button', { name: '删除Waifu2x' })).toBeNull();
  expect(screen.queryByRole('button', { name: /设置NomosUni/ })).toBeNull();
  expect(screen.getByRole('button', { name: /删除NomosUni/ })).toBeInTheDocument();
  await user.click(screen.getByRole('button', { name: '删除Real-CUGAN' }));
  expect(adapter).not.toHaveBeenCalledWith('inference_remove_models', expect.anything());
  await user.click(screen.getByRole('button', { name: '确认删除Real-CUGAN' }));
  expect(adapter).toHaveBeenCalledWith('inference_remove_models', { modelIds: ['realcugan-2x-conservative', 'realcugan-2x-denoise3x'] });
  await waitFor(() => expect(adapter).toHaveBeenCalledWith('save_preferences', { input: expect.objectContaining({ upscaleModel: 'waifu2x-upconv7', upscaleBackend: 'auto' }) }));
  expect(screen.getByRole('dialog', { name: '超分模型' })).toBeInTheDocument();
  expect(screen.queryByRole('button', { name: '删除Real-CUGAN' })).toBeNull();
});

/** 本机导出的那份记录文本：`export_scoped_data` 的回包，也是迁移文件里 records 的内容。 */
const SCOPED_EXPORT_TEXT = '{"kind":"yomika-scope-export","schemaVersion":1,"document":{"version":1,"epoch":0,"objects":{"a":1,"b":2}}}';

/** 新版迁移文件（docs/30）：一份明文 JSON，装什么由导出弹层的勾选决定。 */
const DATA_EXPORT_TEXT = JSON.stringify({
  kind: 'yomika-export',
  schemaVersion: 1,
  exportedAt: '2026-09-26 10:00:00',
  items: ['records', 'lrr_servers'],
  records: JSON.parse(SCOPED_EXPORT_TEXT),
  servers: [{ scopeId: 'scope-a', name: 'Home', baseUrl: 'https://lrr.test', enabled: true, apiKey: 'key-1' }],
  ehAccounts: [],
  skipped: 0,
});

describe('settings workspace', () => {
  it.each([
    ['yomika.advanced-models', [null]],
    ['yomika.advanced-upscale-catalog', [null]],
    ['yomika.compute-center-status', { running: true }],
  ])('ignores a malformed %s snapshot before rendering advanced settings', async (key, value) => {
    for (const cacheKey of ['yomika.advanced-models', 'yomika.advanced-upscale-catalog', 'yomika.compute-center-status']) localStorage.removeItem(cacheKey);
    localStorage.setItem(key as string, JSON.stringify(value));
    setInvokeAdapterForTests(async (command) => {
      if (command === 'load_preferences') return { ok: true, value: DEFAULT_PREFERENCES };
      if (command === 'model_release_list_upscalers') return { ok: true, value: { tag: 'v1', models: [] } };
      if (command === 'compute_center_status') return { ok: true, value: { running: false, port: 47653, addresses: [], token: '', capabilities: [], canStart: true } };
      return { ok: true, value: [] };
    });
    renderSettings('advanced');
    expect(await screen.findByRole('switch', { name: '启用超分' })).toBeInTheDocument();
    expect(screen.queryByText('界面这一块渲染出错了，已记入错误日志。')).not.toBeInTheDocument();
  });

  it('shows and saves background startup controls only on Windows', async () => {
    const user = userEvent.setup();
    Object.defineProperty(window, '__TAURI_INTERNALS__', { configurable: true, value: { invoke: async () => false } });
    const adapter = vi.fn(async (command: string, args?: Record<string, unknown>) => {
      if (command === 'app_security_status') return { ok: true, value: { locked: false, passwordEnabled: false, biometricEnabled: false, lockOnBackground: false, hidePreview: false, biometricAvailable: false, previewProtectionAvailable: true } };
      if (command === 'app_security_ready') return { ok: true, value: null };
      if (command === 'load_preferences') return { ok: true, value: DEFAULT_PREFERENCES };
      if (command === 'save_preferences') return { ok: true, value: args?.input };
      if (command === 'platform_capabilities') return { ok: true, value: { platform: 'windows', native: true, secureStorage: true, fileSystem: true, backgroundTasks: false, nativeInference: true } };
      if (command === 'list_servers') return { ok: true, value: [] };
      return { ok: true, value: [] };
    });
    setInvokeAdapterForTests(adapter);
    renderSettings('general');
    await user.click(await screen.findByRole('switch', { name: '开机自启' }));
    await waitFor(() => expect(adapter).toHaveBeenCalledWith('save_preferences', { input: { ...DEFAULT_PREFERENCES, startWithWindows: true } }));
    await user.click(screen.getByRole('switch', { name: '关闭到托盘' }));
    await waitFor(() => expect(adapter).toHaveBeenCalledWith('save_preferences', { input: { ...DEFAULT_PREFERENCES, startWithWindows: true, closeToTray: true } }));
  });
  it('opens About links through the native external browser command', async () => {
    const user = userEvent.setup();
    const adapter = vi.fn(async (command: string, _args?: Record<string, unknown>) => {
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
    // 点开才是菜单——菜单里才读取列表，四个动作铺在底部（顶上没有刷新按钮）。
    const about = await screen.findByRole('region', { name: '关于' });
    const row = within(about).getByRole('button', { name: '错误日志' });
    expect(row).toHaveTextContent('1 条');
    expect(screen.queryByRole('dialog', { name: '错误日志' })).not.toBeInTheDocument();

    await user.click(row);
    const menu = await screen.findByRole('dialog', { name: '错误日志' });
    // 顶上那行「本次运行 N 条，上次运行 M 条。」已经去掉：留下来的是记录本身。
    expect(within(menu).queryByText(/本次运行/)).not.toBeInTheDocument();
    expect(within(menu).getByText('bridge/list_archives')).toBeInTheDocument();
    expect(within(menu).getByText('LANraragi 不可达')).toBeInTheDocument();
    // 顶上那两句说明文字已经去掉：留着的都是眼下的事实。
    expect(menu.textContent).not.toContain('每次启动重新记录');

    // 四个动作铺在面板底部（顶上没有 ⋮ 了）：复制、导出、错误反馈、清空。
    await user.click(within(menu).getByRole('button', { name: '导出日志' }));
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

    // 顶上那行「本次运行 N 条，上次运行 M 条。」已经去掉：区分靠每条自己的来源前缀。
    await vi.waitFor(() => expect(within(menu).getByText('上次运行 · eh/in-app-login')).toBeInTheDocument());
    expect(menu.textContent).not.toContain('本次运行');
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
    renderSettings('data');
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
    renderSettings('data');
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
  it('no longer offers a manual history prune in settings — that lives on the history shelf', async () => {
    // 清理的入口在历史页：多选之后清掉选中的记录。设置里那条「立即清理」按年龄清，
    // 要清哪几条只有看着列表的人知道，所以整行都撤了。
    const adapter = vi.fn(async (command: string) => {
      if (command === 'load_preferences') return { ok: true, value: DEFAULT_PREFERENCES };
      return { ok: true, value: [] };
    });
    setInvokeAdapterForTests(adapter);
    renderSettings('general');
    await screen.findByRole('button', { name: '图片缓存' });
    expect(screen.queryByRole('button', { name: '历史记录清理' })).toBeNull();
    expect(adapter.mock.calls.some(([command]) => command === 'prune_history')).toBe(false);
  });

  it('says the model list is still loading instead of claiming nothing is installed', async () => {
    localStorage.removeItem('yomika.advanced-models');
    localStorage.removeItem('yomika.advanced-upscale-catalog');
    // 模型列表还没回来时，开关只说「正在读取模型…」。以前卡片底部还有一行状态
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
    expect(screen.queryByText(/尚未安装/)).toBeNull();
    expect(screen.queryByText(/正在读取已安装模型|正在读取模型索引/)).toBeNull();
  });

  it('shows cached model detection while refreshing after a restart', async () => {
    localStorage.setItem('yomika.advanced-models', '[]');
    const adapter = vi.fn(async (command: string) => {
      if (command === 'load_preferences') return { ok: true, value: DEFAULT_PREFERENCES };
      if (command === 'list_servers') return { ok: true, value: [] };
      if (command === 'inference_list_models') return new Promise(() => {});
      return { ok: true, value: [] };
    });
    setInvokeAdapterForTests(adapter);
    renderSettings('advanced');
    const upscale = await screen.findByRole('switch', { name: '启用超分' });
    expect(upscale.closest('.settings-row')).toHaveTextContent('尚未安装可用的超分模型');
    expect(upscale).toBeDisabled();
    expect(adapter).toHaveBeenCalledWith('inference_list_models', {});
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
    expect(await screen.findByRole('button', { name: 'Waifu2x' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: '下载Waifu2x' })).toBeNull();
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

  it('keeps the model list in one fixed order: the built-ins first, then ids', async () => {
    const user = userEvent.setup();
    // 用户 2026-10-18：模型下载完成会导致顺序发生变化，另外让 anime4k 和 waifu2x 放到上面。
    // 顺序不能跟着「装了什么」「目录怎么排」走——那两处都会在下载完成/目录刷新后变——
    // 所以内置两档（Anime4K 的 shader 链、随包 waifu2x）永远最前，其余按 id 排。
    // 列表顺序会读 localStorage 里的快照，上一个用例留下的目录快照（常常是空目录）
    // 会让这一条测到「目录没来」的情形——整文件跑时红、单跑时绿就是这么来的。
    localStorage.removeItem('yomika.advanced-models');
    localStorage.removeItem('yomika.advanced-upscale-catalog');
    const adapter = vi.fn(async (command: string) => {
      if (command === 'load_preferences') return { ok: true, value: DEFAULT_PREFERENCES };
      if (command === 'list_servers') return { ok: true, value: [] };
      if (command === 'inference_list_models') return {
        ok: true,
        value: [{ id: 'realcugan-2x-conservative', version: '1', scale: 2, kind: 'upscale', components: [] }],
      };
      if (command === 'model_release_list_upscalers') return {
        ok: true,
        value: {
          tag: 'v1',
          models: [
            { id: 'realesr-general-x4v3', label: 'Real-ESRGAN 通用 x4', scale: 4, version: '1', files: [{ name: 'model.onnx', size: 1, sha256: 'a'.repeat(64) }] },
            { id: 'waifu2x-upconv7', label: 'waifu2x', scale: 2, version: '1', files: [{ name: 'model.onnx', size: 1, sha256: 'b'.repeat(64) }] },
            { id: 'anime4k-hq', label: 'Anime4K', scale: 2, version: '1', files: [{ name: 'model.onnx', size: 1, sha256: 'c'.repeat(64) }] },
          ],
        },
      };
      return { ok: true, value: [] };
    });
    setInvokeAdapterForTests(adapter);
    renderSettings('advanced');

    await user.click(await screen.findByRole('button', { name: '超分模型' }));
    const menu = await screen.findByRole('dialog', { name: '超分模型' });
    // 目录是异步来的：菜单先开、目录后到。整文件跑时这一步的时序与单跑不同，
    // 直接读会读到「目录还没来」的那一版（只有已装模型），所以要等到目录落地。
    await vi.waitFor(() => {
      const rows = [...menu.querySelectorAll('.settings-choice-option-main')];
      expect(rows.some((row) => (row.textContent ?? '').includes('Anime4K'))).toBe(true);
    });
    const order = [...menu.querySelectorAll('.settings-choice-option-main')].map((row) => row.textContent ?? '');
    // 断言自带实际顺序：顺序类缺陷的失败信息必须能直接读出「现在是怎样」。
    expect(order[0], `实际顺序：${order.join(' | ')}`).toContain('Anime4K');
    expect(order[1]).toContain('Waifu2x');
    // 其余按 id 排：realcugan… 在 realesr… 之前。这条断言是「顺序不随安装状态走」的
    // 承重部分——目录里 realesr 排在 waifu2x 前面，装没装都改不了它落到最后。
    expect(order[2]).toContain('Real-CUGAN');
    expect(order[3]).toContain('Real-ESRGAN');
  });

  it('collapses model menu rows that share an id into one option', async () => {
    const user = userEvent.setup();
    // 后端按版本各出一条记录，选项的值是 id：两个版本照旧渲染成两行一模一样的
    // 「waifu2x」。同一 id 只能有一行。
    const upscaleRecord = (version: string) => ({
      id: 'waifu2x-upconv7', version, scale: 2, kind: 'upscale',
      components: [],
    });
    const adapter = vi.fn(async (command: string) => {
      if (command === 'load_preferences') return { ok: true, value: DEFAULT_PREFERENCES };
      if (command === 'list_servers') return { ok: true, value: [] };
      if (command === 'inference_list_models') return {
        ok: true,
        value: [upscaleRecord('1'), upscaleRecord('2')],
      };
      return { ok: true, value: [] };
    });
    setInvokeAdapterForTests(adapter);
    renderSettings('advanced');

    await user.click(await screen.findByRole('button', { name: '超分模型' }));
    const menu = screen.getByRole('dialog', { name: '超分模型' });
    expect(within(menu).getAllByRole('button', { name: 'Waifu2x' })).toHaveLength(1);
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

  it('deletes a server configuration from its editor and updates the rows in place', async () => {
    // 删除配置只删服务器本身：档案、进度与阅读历史都挂在同一个 scope id 上，
    // 重新添加同一地址还能接上，所以后端返回剩下的一台，面板就地更新。
    const user = userEvent.setup();
    const adapter = vi.fn(async (command: string, args?: Record<string, unknown>) => {
      if (command === 'load_preferences') return { ok: true, value: { theme: 'system', defaultLayout: 'auto', defaultDirection: 'ltr', cacheMaxBytes: 2_147_483_648 } };
      if (command === 'list_servers') return { ok: true, value: [
        { id: 'scope-a', name: 'Home', baseUrl: 'https://a.example.com', scopeId: 'scope-a', enabled: true },
        { id: 'scope-b', name: 'Office', baseUrl: 'https://b.example.com', scopeId: 'scope-b', enabled: false },
      ] };
      if (command === 'read_server_api_key') return { ok: true, value: 'key-a' };
      if (command === 'delete_server') {
        expect(args).toEqual({ serverId: 'scope-a' });
        return { ok: true, value: [
          { id: 'scope-b', name: 'Office', baseUrl: 'https://b.example.com', scopeId: 'scope-b', enabled: true },
        ] };
      }
      throw new Error(`Unexpected command: ${command}`);
    });
    setInvokeAdapterForTests(adapter);

    renderSettings();

    await user.click(await screen.findByRole('link', { name: /通用/ }));
    await user.click(await screen.findByRole('button', { name: '编辑 Home' }));
    // 编辑态才有「删除配置」，且它先开一层确认：配置删掉就回不来了。
    await user.click(await screen.findByRole('button', { name: /删除配置/ }));
    expect(await screen.findByText('删除「Home」的配置？')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: '删除' }));

    expect(adapter).toHaveBeenCalledWith('delete_server', { serverId: 'scope-a' });
    await waitFor(() => expect(screen.queryByText('Home')).toBeNull());
    expect(screen.getByText('Office')).toBeInTheDocument();
    expect(await screen.findByText('已删除服务器 Home 的配置')).toBeInTheDocument();
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
    await user.click(screen.getByRole('link', { name: /^数据$/ }));
    // 导入与导出各自是一行；旧的一体化「数据迁移」不再出现。
    expect(screen.getByRole('button', { name: '导出数据' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: '导入数据' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: '数据迁移' })).not.toBeInTheDocument();
    expect(screen.queryByRole('region', { name: '服务器' })).not.toBeInTheDocument();
  });

  it('loads, saves, and immediately applies ordinary preferences', async () => {
    const user = userEvent.setup();
    const loaded = { theme: 'dark', defaultLayout: 'double', defaultDirection: 'rtl', cacheMaxBytes: 4_294_967_296, prefetchPages: 1, coverConcurrency: 4, startupRoute: 'home', cardStyle: 'wide', upscaleBackend: 'off', upscaleModel: '', customCss: '' };
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
    expect(document.querySelector('meta[name="theme-color"]')).toHaveAttribute('content', '#121412');
    expect(localStorage.getItem('yomika.last-theme')).toBe('dark');

    // No save button: a change is the save. The old form let a toggle look
    // applied while nothing had been written. There is no autosave caption
    // either — the applied theme is the confirmation.
    await user.click(screen.getByRole('radio', { name: '浅色' }));

    await vi.waitFor(() => expect(document.documentElement).toHaveAttribute('data-theme', 'light'));
    expect(screen.queryByText(/自动保存/)).not.toBeInTheDocument();
    expect(document.querySelector('meta[name="theme-color"]')).toHaveAttribute('content', '#fbf8f3');
    expect(localStorage.getItem('yomika.last-theme')).toBe('light');
    // Saving one section still writes the whole snapshot.
    expect(adapter).toHaveBeenCalledWith('save_preferences', {
      input: { ...DEFAULT_PREFERENCES, ...loaded, theme: 'light' },
    });
  });

  it('bridges the displayed functional CSS canvas as native hex', async () => {
    const bridge = vi.spyOn(platformBridge, 'setSystemBarStyle').mockResolvedValue({ ok: true, value: undefined });
    setInvokeAdapterForTests(async (command: string) => {
      if (command === 'load_preferences') return { ok: true, value: {
        ...DEFAULT_PREFERENCES, theme: 'dark', customCss: ':root { --surface-canvas: rgba(30, 40, 50, 0.5); }',
      } };
      if (command === 'list_servers') return { ok: true, value: [] };
      return { ok: true, value: [] };
    });
    try {
      renderSettings('appearance');
      await waitFor(() => expect(bridge).toHaveBeenCalledWith(true, '#801e2832'));
      expect(document.querySelector('meta[name="theme-color"]')).toHaveAttribute('content', '#1e283280');
      expect(localStorage.getItem('yomika.last-theme')).toBe('dark');
    } finally {
      bridge.mockRestore();
      document.getElementById('yomika-custom-css')?.remove();
      localStorage.removeItem('yomika.last-custom-css');
    }
  });

  it('keeps reader defaults in the reading section and the cache cap in advanced', async () => {
    const loaded = { theme: 'dark', defaultLayout: 'double', defaultDirection: 'rtl', cacheMaxBytes: 4_294_967_296, prefetchPages: 1, coverConcurrency: 4, startupRoute: 'home', cardStyle: 'wide', upscaleBackend: 'off', upscaleModel: '', customCss: '' };
    setInvokeAdapterForTests(async (command: string) => {
      if (command === 'load_preferences') return { ok: true, value: loaded };
      if (command === 'list_servers') return { ok: true, value: [] };
      if (command === 'inference_list_models') return { ok: true, value: [] };
      throw new Error(`Unexpected command: ${command}`);
    });

    const view = renderSettings('reading');
    expect(await screen.findByRole('radio', { name: '双页' })).toBeChecked();
    expect(screen.getByRole('radio', { name: '从右到左' })).toBeChecked();
    // 这一档说的是「往哪一侧翻是下一页」——它管的不再只是「第一次进入时的兜底值」，
    // 所以标题不叫「默认方向」了。判据钉在名称上：改回旧标题就转红。
    expect(screen.getByRole('button', { name: '翻页方向' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: '默认方向' })).not.toBeInTheDocument();
    // The cache cap lives in 通用, inside its row's floating menu.
    expect(screen.queryByLabelText('图片缓存上限')).not.toBeInTheDocument();
    view.unmount();

    renderSettings('general');
    await userEvent.setup().click(await screen.findByRole('button', { name: '图片缓存上限' }));
    expect(await within(screen.getByRole('dialog', { name: '图片缓存上限' })).findByRole('slider', { name: '图片缓存上限' })).toHaveValue('4');
    expect(screen.queryByRole('radio', { name: '双页' })).not.toBeInTheDocument();
  });

  it('themes through custom CSS instead of a separate accent preference', async () => {
    const loaded = { theme: 'light', defaultLayout: 'auto', defaultDirection: 'ltr', cacheMaxBytes: 2_147_483_648, prefetchPages: 1, coverConcurrency: 4, startupRoute: 'home', cardStyle: 'wide', upscaleBackend: 'off', upscaleModel: '', customCss: '' };
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
    const loaded = { theme: 'system', defaultLayout: 'auto', defaultDirection: 'ltr', cacheMaxBytes: 2_147_483_648, prefetchPages: 1, coverConcurrency: 4, startupRoute: 'home', cardStyle: 'wide', upscaleBackend: 'off', upscaleModel: '', customCss: '' };
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
    const preload = await within(screen.getByRole('dialog', { name: '预加载页数' })).findByRole('slider', { name: '预加载页数' });
    // Ten pages, not five: a LAN page is a few hundred KB.
    expect(preload).toHaveAttribute('max', '10');
    fireEvent.change(preload, { target: { value: '8' } });
    await user.keyboard('{Escape}');
    await user.click(screen.getByRole('button', { name: '封面并发请求' }));
    const concurrency = within(screen.getByRole('dialog', { name: '封面并发请求' })).getByRole('slider', { name: '封面并发请求' });
    fireEvent.change(concurrency, { target: { value: '2' } });
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
    expect(await screen.findByRole('button', { name: 'Real-CUGAN' })).toBeInTheDocument();
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

  it('imports a model zip through the unified model input', async () => {
    const user = userEvent.setup();
    const loaded = { theme: 'system', defaultLayout: 'auto', defaultDirection: 'ltr', cacheMaxBytes: 2_147_483_648, prefetchPages: 1, coverConcurrency: 4, startupRoute: 'home', cardStyle: 'wide', upscaleBackend: 'off', upscaleModel: '', customCss: '' };
    let installed: unknown[] = [];
    const adapter = vi.fn(async (command: string, args?: Record<string, unknown>) => {
      if (command === 'load_preferences') return { ok: true, value: loaded };
      if (command === 'list_servers') return { ok: true, value: [] };
      if (command === 'save_preferences') return { ok: true, value: args?.input };
      if (command === 'inference_list_models') return { ok: true, value: installed };
      if (command === 'inference_import_model_path') {
        installed = [{ id: 'waifu2x-upconv7', version: '1', scale: 2, kind: 'upscale', components: [] }];
        return { ok: true, value: installed[0] };
      }
      throw new Error(`Unexpected command: ${command}`);
    });
    setInvokeAdapterForTests(adapter);
    renderSettings('advanced');
    // 只有磁盘上的模型才认得出来：导入之前它就说没有可用的模型，而开关本身
    // 只等「模型列表读回来了」（空表也算读回来），点下去只会被告知没装。
    const toggle = await screen.findByRole('switch', { name: '启用超分' });
    expect(screen.getByText('尚未安装可用的超分模型')).toBeInTheDocument();
    expect(toggle).toBeEnabled();
    // The bundle now travels by disk path: Rust reads the file itself instead
    // of the front end shipping hundreds of MB of numbers across the bridge.
    setModelPickerForTests(() => Promise.resolve('E:\\models\\bundle.zip'));
    await user.click(screen.getByRole('button', { name: '选择模型文件…' }));
    await vi.waitFor(() => expect(adapter).toHaveBeenCalledWith('inference_import_model_path', { input: { path: 'E:\\models\\bundle.zip' } }));
    const enabledToggle = screen.getByRole('switch', { name: '启用超分' });
    await vi.waitFor(() => expect(enabledToggle).toBeEnabled());
    expect(screen.getByText('用超分模型放大阅读画面')).toBeInTheDocument();
    // 导入那一次刷新就够了：翻开关不该再去重读模型列表。
    const modelListReads = adapter.mock.calls.filter(([command]) => command === 'inference_list_models').length;
    await user.click(enabledToggle);
    await vi.waitFor(() => expect(adapter).toHaveBeenCalledWith('save_preferences', {
      input: expect.objectContaining({ upscaleModel: 'waifu2x-upconv7' }),
    }));
    // 翻开关不去重读模型列表：导入那一次刷新就够了。
    expect(adapter.mock.calls.filter(([command]) => command === 'inference_list_models')).toHaveLength(modelListReads);
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

    // 目录还没读回来（这一跑全是空表）：没有该换的东西，就没有小签——「不知道」
    // 不能画成「有更新」。
    expect(screen.queryByText('有更新')).toBeNull();

    await user.click(await screen.findByRole('button', { name: '超分模型' }));
    await user.click(await screen.findByRole('button', { name: '下载Waifu2x' }));
    expect(adapter).toHaveBeenCalledWith('model_release_download_default', { modelId: 'waifu2x-upconv7' });
    await user.keyboard('{Escape}');
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
    await user.click(await screen.findByRole('button', { name: '下载Real-CUGAN' }));
    await waitFor(() => expect(adapter).toHaveBeenCalledWith('model_release_download_default', { modelId: 'realcugan-2x-conservative' }));

    const menu = screen.getByRole('dialog', { name: '超分模型' });
    // 已安装的 anime4k-hq 只有一行：目录里同名那条不再另起一行，也就没有下载
    // 按钮。行名取目录那份——装之前装之后是同一个名字。
    expect(within(menu).getAllByRole('button', { name: 'Anime4K' })).toHaveLength(1);
    expect(within(menu).queryByRole('button', { name: '下载Anime4K' })).toBeNull();
  });

  it('offers the update on a model whose catalog version moved on', async () => {
    const user = userEvent.setup();
    const adapter = vi.fn(async (command: string) => {
      if (command === 'load_preferences') return { ok: true, value: DEFAULT_PREFERENCES };
      if (command === 'list_servers') return { ok: true, value: [] };
      // 盘上那份还是老版本；目录里已经是新的了（后端把版本编进安装路径，
      // 所以下载新版本不需要先删旧的）。
      if (command === 'inference_list_models') return {
        ok: true,
        value: [{ id: 'realcugan-2x-denoise3x', version: '2022.02.27', scale: 2, kind: 'upscale', components: [] }],
      };
      if (command === 'model_release_list_upscalers') return {
        ok: true,
        value: {
          tag: 'models-v1',
          models: [{
            id: 'realcugan-2x-denoise3x',
            label: 'Real-CUGAN 2x 漫画（强降噪）',
            scale: 2,
            version: '2024.01.01',
            files: [{ name: 'realcugan-2x-denoise3x.onnx', size: 5272599, sha256: 'b'.repeat(64) }],
          }],
        },
      };
      if (command === 'model_release_download_default') return { ok: true, value: null };
      return { ok: true, value: [] };
    });
    setInvokeAdapterForTests(adapter);
    renderSettings('advanced');

    // 这一份 fixture 正好也是「有模型可以更新」：启动检查会盖一层弹窗上来，先把那层
    // 收掉再操作页面（弹窗自己的行为在 update-notice.test.tsx 里验）。
    await user.click(await screen.findByRole('button', { name: '跳过该版本' }));
    // 设置项自己挂着标记：不打开菜单也该知道「这一项里有东西该换了」。它是名称旁的
    // 一枚小签（`span`），不是行尾那种能点的东西——能点的是菜单里那一行。
    const upscaleRow = screen.getByRole('button', { name: '超分模型' });
    const mark = within(upscaleRow).getByText('有更新');
    expect(mark.tagName).toBe('SPAN');
    expect(mark.closest('.settings-row-copy')).not.toBeNull();
    await user.click(await screen.findByRole('button', { name: '超分模型' }));
    // 同一个下载动作，只是说法变了：装着的那个不是最新版，就该能再点一次。
    const update = await screen.findByRole('button', { name: '更新Real-CUGAN' });
    expect(screen.queryByRole('button', { name: '下载Real-CUGAN' })).toBeNull();
    await user.click(update);
    await waitFor(() => expect(adapter).toHaveBeenCalledWith('model_release_download_default', { modelId: 'realcugan-2x-denoise3x' }));
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
    expect(screen.queryByRole('button', { name: '下载Real-CUGAN' })).toBeNull();
    await user.click(await screen.findByRole('button', { name: '超分模型' }));
    await user.click(await screen.findByRole('button', { name: '下载Real-CUGAN' }));
    await waitFor(() => expect(adapter).toHaveBeenCalledWith('model_release_download_default', { modelId: 'realcugan-2x-denoise3x' }));

    // 设置项那边不再画第二条：两条进度同时出现时，看的人不知道该信哪一条。
    expect(document.querySelector('.settings-group > .archive-card-progress')).toBeNull();

    // 进度挂在菜单里它自己那一项下面——也就是点「下载」的地方。以前进度画在设置项上，
    // 正好在菜单那层遮罩后面，点完下载根本看不到。
    const menu = screen.getByRole('dialog', { name: '超分模型' });
    const status = menu.querySelector('.archive-card-progress');
    expect(status).not.toBeNull();
    expect(status?.closest('.settings-choice-option')?.textContent).toContain('Real-CUGAN');
    // 槽是常驻的，出现/消失靠 is-open：卸载的节点没有过渡可放。
    expect(status?.closest('.model-download-slot')).toHaveClass('is-open');
    // 画的条就是档案卡那一条：同一个组件、同一套类名，不是另写一条像它的。
    expect(status?.classList.contains('archive-card-progress')).toBe(true);
    // 右边不写百分比：条的长短已经把话说完了。
    expect(status?.textContent ?? '').not.toContain('%');
    expect(status).toHaveAttribute('role', 'progressbar');
    expect(status).toHaveAttribute('aria-label', 'Real-CUGAN下载进度');
    // 后端还没报总数时是不定量条：没有 aria-valuenow，走扫光。
    expect(status).not.toHaveAttribute('aria-valuenow');
    expect(status).toHaveClass('is-indeterminate');

    // 报了总数就是定量条：填充跟着走，仍然不写数字。
    await act(async () => emitTauriEvent('model-download-progress', { path: 'realcugan-2x-denoise3x', completed: 50, total: 200 }));
    expect(status).toHaveAttribute('aria-valuenow', '25');
    // 下载条走合成层模式：填充层宽度钉死 100%，进度靠 clip-path 的右边缘往里收——每帧只改
    // 合成属性，不重排整行（阅读进度那条仍按绝对宽度走，见 tests/components/card-progress-bar.test.tsx）。
    // jsdom 里没有排版引擎（轨道宽度量出来是 0），右边缘落在「半径 + 直边」的 calc 形式上；
    // 真宽度由工装页去量（debug_outputs/progress-bar/）。
    const fill = menu.querySelector<HTMLElement>('.archive-card-progress-fill');
    expect(status).toHaveClass('is-composited');
    expect(fill?.style.width).toBe('100%');
    expect(fill?.style.clipPath).toContain('calc(var(--radius-card) + (100% - 2 * var(--radius-card)) * 0.25)');
    expect(status).not.toHaveClass('is-indeterminate');

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
    renderSettings('data');

    await userEvent.setup().click(await screen.findByRole('link', { name: /^数据$/ }));
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

  it('exports the selected data categories', async () => {
    const user = userEvent.setup();
    // 导出走原生侧那一份：本地日志折成同步文档，所以这里不再逐个表去取。取不到
    // 就会抛——「不再逐表取」这条正是这个 mock 守着的。
    const adapter = vi.fn(async (command: string) => {
      if (command === 'load_preferences') return { ok: true, value: DEFAULT_PREFERENCES };
      if (command === 'list_servers') return { ok: true, value: [{ id: 'scope-a', name: 'Home', baseUrl: 'https://example.com', scopeId: 'scope-a' }] };
      if (command === 'export_data') {
        return {
          ok: true,
          value: {
            text: '{"kind":"yomika-export","schemaVersion":1,"items":["progress","history"],"records":{"kind":"yomika-scope-export"}}',
            items: ['progress', 'history', 'watchlist', 'search_presets', 'dedup', 'app_settings'],
            records: 3,
            servers: 0,
            ehAccounts: 0,
            skipped: 0,
            categories: ['history'],
          },
        };
      }
      if (command === 'save_text_file') return { ok: true, value: 'C:/tmp/yomika-export.json' };
      throw new Error(`Unexpected command: ${command}`);
    });
    setInvokeAdapterForTests(adapter);
    setSavePickerForTests(async () => 'C:/tmp/yomika-export.json');
    renderSettings('data');

    await user.click(await screen.findByRole('link', { name: /^数据$/ }));
    await user.click(await screen.findByRole('button', { name: '导出数据' }));
    const exportMenu = await screen.findByRole('dialog', { name: '导出数据' });
    // 六类记录与设置默认全勾；凭据默认不勾。这一颗按钮自己就折文本、选路径、写盘——
    // 不需要先按一次别的按钮（这就是「点了像没反应」的修法）。
    await user.click(within(exportMenu).getByRole('button', { name: '导出为文件' }));

    await waitFor(() => expect(adapter).toHaveBeenCalledWith('export_data', {
      items: ['progress', 'history', 'watchlist', 'search_presets', 'dedup', 'app_settings'],
    }));
    expect(await screen.findByText('已导出到 C:/tmp/yomika-export.json（记录与设置 3 项）')).toBeInTheDocument();
  });

  it('writes the export to a file the user picks', async () => {
    // 「导出为文件」与「复制」是两条并列的出口：手机上「可粘贴的文本」并不好用。
    const user = userEvent.setup();
    const adapter = vi.fn(async (command: string) => {
      if (command === 'load_preferences') return { ok: true, value: DEFAULT_PREFERENCES };
      if (command === 'list_servers') return { ok: true, value: [] };
      if (command === 'export_data') {
        return { ok: true, value: { text: SCOPED_EXPORT_TEXT, items: ['records'], records: 2, servers: 0, ehAccounts: 0, skipped: 0 } };
      }
      if (command === 'save_text_file') return { ok: true, value: 'C:/tmp/yomika-export.json' };
      throw new Error(`Unexpected command: ${command}`);
    });
    setInvokeAdapterForTests(adapter);
    setSavePickerForTests(async () => 'C:/tmp/yomika-export.json');
    renderSettings('data');

    await user.click(await screen.findByRole('link', { name: /^数据$/ }));
    await user.click(await screen.findByRole('button', { name: '导出数据' }));
    const menu = screen.getByRole('dialog', { name: '导出数据' });

    await user.click(within(menu).getByRole('button', { name: '导出为文件' }));
    // 写下去的就是那一次导出折出来的文本。
    await waitFor(() => expect(adapter).toHaveBeenCalledWith('export_data', expect.anything()));
    await waitFor(() => expect(adapter).toHaveBeenCalledWith('save_text_file', {
      path: 'C:/tmp/yomika-export.json',
      contents: SCOPED_EXPORT_TEXT,
    }));
  });

  it('imports a legacy scoped export', async () => {
    const user = userEvent.setup();
    const adapter = vi.fn(async (command: string) => {
      if (command === 'load_preferences') return { ok: true, value: DEFAULT_PREFERENCES };
      if (command === 'list_servers') return { ok: true, value: [] };
      if (command === 'import_scoped_data') {
        return { ok: true, value: { applied: 4, skipped: 2, categories: ['history'] } };
      }
      throw new Error(`Unexpected command: ${command}`);
    });
    setInvokeAdapterForTests(adapter);
    renderSettings('data');

    await user.click(await screen.findByRole('link', { name: /^数据$/ }));
    await user.click(await screen.findByRole('button', { name: '导入数据' }));
    const importMenu = screen.getByRole('dialog', { name: '导入数据' });
    // 粘贴一份本机的导出：userEvent.type 会把 `{{` 当成转义，所以直接改值。
    const scopedExport = '{"kind":"yomika-scope-export","schemaVersion":1,"document":{"version":1,"epoch":0,"objects":{}}}';
    fireEvent.change(within(importMenu).getByLabelText('导出 JSON'), { target: { value: scopedExport } });
    await user.click(within(importMenu).getByRole('button', { name: '导入数据' }));

    await waitFor(() => expect(adapter).toHaveBeenCalledWith('import_scoped_data', {
      payload: scopedExport,
      categories: JSON.stringify(['progress', 'history', 'watchlist', 'search_presets', 'dedup', 'app_settings']),
    }));
    expect(await screen.findByText('已导入 4 项，跳过 2 项')).toBeInTheDocument();
  });

  it('imports a file the user picks through the same import path', async () => {
    // 「从文件导入」= 选文件 + 读回来 + 走同一次导入（认种类、认口令都是那一套）。
    const user = userEvent.setup();
    const adapter = vi.fn(async (command: string) => {
      if (command === 'load_preferences') return { ok: true, value: DEFAULT_PREFERENCES };
      if (command === 'list_servers') return { ok: true, value: [] };
      if (command === 'read_text_file') return { ok: true, value: '{"kind":"yomika-scope-export","schemaVersion":1,"document":{"version":1,"epoch":0,"objects":{}}}' };
      if (command === 'import_scoped_data') return { ok: true, value: { applied: 2, skipped: 0, categories: [] } };
      throw new Error(`Unexpected command: ${command}`);
    });
    setInvokeAdapterForTests(adapter);
    setTextFilePickerForTests(async () => 'C:/tmp/yomika-export.json');
    renderSettings('data');

    await user.click(await screen.findByRole('link', { name: /^数据$/ }));
    await user.click(await screen.findByRole('button', { name: '导入数据' }));
    const menu = screen.getByRole('dialog', { name: '导入数据' });
    await user.click(within(menu).getByRole('button', { name: '从文件导入' }));

    await waitFor(() => expect(adapter).toHaveBeenCalledWith('read_text_file', { path: 'C:/tmp/yomika-export.json' }));
    await waitFor(() => expect(adapter).toHaveBeenCalledWith('import_scoped_data', expect.objectContaining({
      payload: expect.stringContaining('yomika-scope-export'),
    })));
    // 导入成功之后框会清空（和粘贴那条路一样），所以看的是报数。
    expect(await screen.findByText('已导入 2 项')).toBeInTheDocument();
  });

  it('warns about sensitive content when credentials are exported', async () => {
    const user = userEvent.setup();
    const adapter = vi.fn(async (command: string, args?: Record<string, unknown>) => {
      if (command === 'load_preferences') return { ok: true, value: DEFAULT_PREFERENCES };
      if (command === 'list_servers') return { ok: true, value: [] };
      if (command === 'export_data') {
        return { ok: true, value: { text: DATA_EXPORT_TEXT, items: args?.items as string[], records: 2, servers: 0, ehAccounts: 1, skipped: 0 } };
      }
      if (command === 'save_text_file') return { ok: true, value: 'C:/tmp/yomika-export.json' };
      throw new Error(`Unexpected command: ${command}`);
    });
    setInvokeAdapterForTests(adapter);
    setSavePickerForTests(async () => 'C:/tmp/yomika-export.json');
    renderSettings('data');

    await user.click(await screen.findByRole('link', { name: /^数据$/ }));
    await user.click(await screen.findByRole('button', { name: '导出数据' }));
    const exportMenu = await screen.findByRole('dialog', { name: '导出数据' });

    // 默认六类记录与设置，不含凭据：面板不提醒，导出完成的 toast 是普通成功。
    await user.click(within(exportMenu).getByRole('button', { name: '导出为文件' }));
    await vi.waitFor(() => expect(adapter).toHaveBeenCalledWith('export_data', {
      items: ['progress', 'history', 'watchlist', 'search_presets', 'dedup', 'app_settings'],
    }));
    expect(within(exportMenu).queryByText(/切勿分享/)).toBeNull();
    expect(await screen.findByText('已导出到 C:/tmp/yomika-export.json（记录与设置 2 项 · E-H 账户 1）')).toBeInTheDocument();

    // 勾上 E-H 账户：面板立刻提醒包含敏感信息，导出完成后再用 toast 说一次。
    await user.click(within(exportMenu).getByRole('checkbox', { name: '导出E-Hentai 账户' }));
    expect(within(exportMenu).getByText(/切勿分享/)).toBeInTheDocument();
    await user.click(within(exportMenu).getByRole('button', { name: '导出为文件' }));
    await vi.waitFor(() => expect(adapter).toHaveBeenCalledWith('export_data', {
      items: ['progress', 'history', 'watchlist', 'search_presets', 'dedup', 'app_settings', 'eh_account'],
    }));
    // 带凭据的导出仍然是**成功**：说清「这份文件敏感」靠文案，不靠红态——
    // 红态是留给「导出失败了」的。
    expect((await screen.findByText(/含 API Key、Cookie 等敏感信息，请妥善保管/)).closest('.toast-card'))
      .toHaveClass('is-success');
  });

  it('imports a data file through dynamically generated checkboxes', async () => {
    const user = userEvent.setup();
    const adapter = vi.fn(async (command: string, _args?: Record<string, unknown>) => {
      if (command === 'load_preferences') return { ok: true, value: DEFAULT_PREFERENCES };
      if (command === 'list_servers') return { ok: true, value: [] };
      if (command === 'import_data') {
        // 服务器在弹层里被取消勾选了：即使文件里有，也不会落地（报数为 0）。
        return { ok: true, value: { records: 2, servers: 0, ehAccounts: 0, skipped: 0 } };
      }
      throw new Error(`Unexpected command: ${command}`);
    });
    setInvokeAdapterForTests(adapter);
    renderSettings('data');

    await user.click(await screen.findByRole('link', { name: /^数据$/ }));
    await user.click(await screen.findByRole('button', { name: '导入数据' }));
    const importMenu = screen.getByRole('dialog', { name: '导入数据' });
    fireEvent.change(within(importMenu).getByLabelText('导出 JSON'), { target: { value: DATA_EXPORT_TEXT } });
    await user.click(within(importMenu).getByRole('button', { name: '导入数据' }));

    // 解析出文件里实际装着的两类，默认全选；取消一个再导入，取消的类不落地。
    expect(within(importMenu).getByRole('checkbox', { name: '导入记录与设置' })).toBeChecked();
    const servers = within(importMenu).getByRole('checkbox', { name: '导入LANraragi 服务器' });
    expect(servers).toBeChecked();
    await user.click(servers);

    await user.click(within(importMenu).getByRole('button', { name: '导入所选' }));
    await waitFor(() => expect(adapter).toHaveBeenCalledWith('import_data', {
      payload: DATA_EXPORT_TEXT,
      items: ['records'],
    }));
    expect(await screen.findByText('已导入：记录与设置 2 项')).toBeInTheDocument();
  });

  it('tells the user an old passphrase file is no longer supported', async () => {
    const user = userEvent.setup();
    setInvokeAdapterForTests(async (command: string) => {
      if (command === 'load_preferences') return { ok: true, value: DEFAULT_PREFERENCES };
      if (command === 'list_servers') return { ok: true, value: [] };
      throw new Error(`Unexpected command: ${command}`);
    });
    renderSettings('data');

    await user.click(await screen.findByRole('link', { name: /^数据$/ }));
    await user.click(await screen.findByRole('button', { name: '导入数据' }));
    const importMenu = screen.getByRole('dialog', { name: '导入数据' });
    const envelope = '{"kind":"yomika-credentials","schemaVersion":1,"salt":"c2FsdA==","nonce":"bm9uY2U=","payload":"Y2lwaGVy"}';
    fireEvent.change(within(importMenu).getByLabelText('导出 JSON'), { target: { value: envelope } });
    await user.click(within(importMenu).getByRole('button', { name: '导入数据' }));

    // 口令链路移除了：旧加密文件明确说不再支持，而不是给一句看不懂的解析错误。
    expect(await screen.findByText(/口令导入已移除/)).toBeInTheDocument();
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
    renderSettings('data');

    await user.click(await screen.findByRole('link', { name: /^数据$/ }));
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
    renderSettings('data');

    await user.click(await screen.findByRole('link', { name: /^数据$/ }));
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
    renderSettings('data');

    await userEvent.setup().click(await screen.findByRole('link', { name: /^数据$/ }));
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
    expect(screen.queryByRole('switch', { name: '液态玻璃' })).not.toBeInTheDocument();
    await user.click(floatingBar);
    await vi.waitFor(() => expect(adapter).toHaveBeenCalledWith('save_preferences', { input: { ...DEFAULT_PREFERENCES, floatingNav: true } }));
    await user.click(await screen.findByRole('switch', { name: '液态玻璃' }));
    await vi.waitFor(() => expect(adapter).toHaveBeenCalledWith('save_preferences', { input: { ...DEFAULT_PREFERENCES, floatingNav: true, liquidGlassNav: true } }));
    await user.click(floatingBar);
    expect(screen.queryByRole('switch', { name: '液态玻璃' })).not.toBeInTheDocument();
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
      input: { ...DEFAULT_PREFERENCES, bottomNavItems: ['home', 'library', 'history', 'watchlist', 'to-read'] },
    }));
    await user.click(within(menu).getByRole('checkbox', { name: '底栏显示历史' }));
    await vi.waitFor(() => expect(adapter).toHaveBeenCalledWith('save_preferences', {
      input: { ...DEFAULT_PREFERENCES, bottomNavItems: ['home', 'library', 'watchlist', 'to-read'] },
    }));
    // 默认四项，取消历史、加入待看后仍是四项。
    expect(screen.getByRole('button', { name: '底栏项目' })).toBeEnabled();
    expect(within(screen.getByRole('button', { name: '底栏项目' })).getByText('4 项')).toBeInTheDocument();

    expect(within(menu).queryByRole('checkbox', { name: '底栏显示设置' })).toBeNull();
    const home = within(menu).getByRole('checkbox', { name: '底栏显示首页' });
    expect(home).toBeDisabled();
    expect(home).toHaveAttribute('aria-checked', 'true');
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
      // 设置与未选择的项目转移至首页顶栏。
      expect(compactNames).toEqual(['首页', '档案库', '本地档案']);
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
      const landingHeading = screen.getByRole('heading', { name: '设置', level: 2 });
      expect(landingHeading.parentElement).toHaveClass('settings-compact-heading');
      expect(within(landingHeading.parentElement!).queryByRole('button')).toBeNull();
      expect(screen.queryByRole('region', { name: '服务器' })).not.toBeInTheDocument();

      await user.click(screen.getByRole('button', { name: /通用/ }));
      expect(await screen.findByRole('heading', { name: '通用' })).toBeInTheDocument();
      expect(screen.getByRole('heading', { name: '通用' }).parentElement).toHaveClass('settings-compact-heading');
      expect(screen.getByRole('region', { name: '服务器' })).toBeInTheDocument();
      // One section at a time: the list is gone rather than sitting above it.
      expect(screen.queryByRole('button', { name: /关于/ })).not.toBeInTheDocument();

      await user.click(screen.getByRole('button', { name: '返回设置分类' }));
      expect(await screen.findByRole('button', { name: /关于/ })).toBeInTheDocument();
      expect(screen.queryByRole('region', { name: '服务器' })).not.toBeInTheDocument();

      // 系统返回手势（Tauri 把返回键/滑动交给 webview 的 goBack）走的是同一层：
      // 先退回分类列表，而不是把整个设置页带回上一页。守卫条目是 pushState 压的，
      // 设备上按返回就是浏览器退一格——这里也真退一格。只手动发 `popstate` 已经不行：
      // 退几层看的是**落地那一格的层号**（同一次手势会被补发成两个事件）。
      await settle();
      resetOverlayBackGuardForTests();
      window.history.replaceState({}, '');
      await user.click(screen.getByRole('button', { name: /通用/ }));
      expect(await screen.findByRole('heading', { name: '通用' })).toBeInTheDocument();
      await settle();
      act(() => { window.history.back(); });
      await settle();
      await settle();
      expect(await screen.findByRole('button', { name: /关于/ })).toBeInTheDocument();
      expect(screen.queryByRole('region', { name: '服务器' })).not.toBeInTheDocument();
    } finally {
      window.matchMedia = original;
      resetOverlayBackGuardForTests();
    }
  });

  it('retires a hidden compact settings guard before another page opens a dialog', async () => {
    const original = window.matchMedia;
    window.matchMedia = ((query: string) => ({ matches: query === COMPACT_WIDTH_QUERY, media: query,
      onchange: null, addEventListener: () => {}, removeEventListener: () => {}, addListener: () => {}, removeListener: () => {}, dispatchEvent: () => false,
    })) as unknown as typeof window.matchMedia;
    try {
      setInvokeAdapterForTests(async (command) => command === 'load_preferences'
        ? { ok: true, value: DEFAULT_PREFERENCES } : { ok: true, value: [] });
      function Owner({ active, dialog = false }: { active: boolean; dialog?: boolean }) {
        return <MemoryRouter><PreferencesProvider><RetainedPage active={active}><SettingsWorkspace /></RetainedPage>
          {dialog && <ConfirmDialog title="Other page" description="A separate page" onConfirm={async () => {}} onClose={() => {}} />}
        </PreferencesProvider></MemoryRouter>;
      }
      const view = render(<Owner active />);
      fireEvent.click(await screen.findByRole('button', { name: /通用/ }));
      expect(await screen.findByRole('heading', { name: '通用' })).toBeInTheDocument();
      act(() => { window.history.pushState({}, '', '/other-page'); });
      view.rerender(<Owner active={false} />);
      view.rerender(<Owner active={false} dialog />);
      expect(window.history.state?.yomikaOverlay).toBe(1);
      view.rerender(<Owner active />);
      expect(await screen.findByRole('heading', { name: '设置', level: 2 })).toBeInTheDocument();
      expect(screen.queryByRole('heading', { name: '通用' })).not.toBeInTheDocument();
      view.unmount();
      await settle();
    } finally {
      window.matchMedia = original;
      resetOverlayBackGuardForTests();
      window.history.replaceState({}, '', '/');
    }
  });

  it('applies a basic color scheme as soon as it is picked', async () => {
    const user = userEvent.setup();
    const loaded = { theme: 'system', defaultLayout: 'auto', defaultDirection: 'ltr', cacheMaxBytes: 2_147_483_648, prefetchPages: 1, coverConcurrency: 4, startupRoute: 'home', cardStyle: 'wide', upscaleBackend: 'off', upscaleModel: '', customCss: '' };
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

  it('clears a picked basic color scheme on the way into the advanced editor, and keeps CSS the user wrote', async () => {
    const user = userEvent.setup();
    const loaded = { ...DEFAULT_PREFERENCES, customCss: '' };
    setInvokeAdapterForTests(async (command: string, args) => {
      if (command === 'load_preferences') return { ok: true, value: loaded };
      if (command === 'save_preferences') return { ok: true, value: (args as { input: typeof loaded }).input };
      if (command === 'list_servers') return { ok: true, value: [] };
      return { ok: true, value: [] };
    });

    renderSettings('appearance');
    await user.click(await screen.findByRole('button', { name: '自定义' }));
    const menu = await screen.findByRole('dialog', { name: '自定义' });

    // 基础层的卡片写进的就是 customCss 本身，所以那张「选中的基础配色」进了高级编辑器
    // 就会变成一段没人写过的正文。它得被清掉，框里空着等用户写。
    await user.click(within(menu).getByRole('button', { name: /青瓷/ }));
    await user.click(within(menu).getByRole('button', { name: '高级' }));
    expect(await within(menu).findByRole('textbox', { name: '自定义 CSS' })).toHaveValue('');

    // 反过来，用户自己在高级里写的 CSS 不等于任何一套基础配色，来回切层级不能动它。
    const own = ':root { --brand-vermilion: #1f6f8b; }';
    fireEvent.change(within(menu).getByRole('textbox', { name: '自定义 CSS' }), { target: { value: own } });
    await user.click(within(menu).getByRole('button', { name: '基础' }));
    await user.click(within(menu).getByRole('button', { name: '高级' }));
    expect(within(menu).getByRole('textbox', { name: '自定义 CSS' })).toHaveValue(own);
  });

  it('keeps a menu open when a drag that started inside it ends outside', async () => {
    const user = userEvent.setup();
    const loaded = { ...DEFAULT_PREFERENCES, customCss: '' };
    setInvokeAdapterForTests(async (command: string, args) => {
      if (command === 'load_preferences') return { ok: true, value: loaded };
      if (command === 'save_preferences') return { ok: true, value: (args as { input: typeof loaded }).input };
      if (command === 'list_servers') return { ok: true, value: [] };
      return { ok: true, value: [] };
    });

    renderSettings('appearance');
    await user.click(await screen.findByRole('button', { name: '自定义' }));
    const menu = await screen.findByRole('dialog', { name: '自定义' });
    await user.click(within(menu).getByRole('button', { name: '高级' }));
    const textarea = await within(menu).findByRole('textbox', { name: '自定义 CSS' });
    const overlay = document.querySelector('.settings-choice-overlay');
    if (!overlay) throw new Error('自定义菜单没有渲染出遮罩');

    // textarea 右下角的原生缩放柄：按下落在面板里，松开时指针已经出了面板。浏览器会为这
    // 一对补一次 click，落点是按下与松开的最近公共祖先——也就是遮罩本身。它和「点外面」
    // 长得一模一样，只有按下时的落点分得开，所以菜单不能因此关掉。
    fireEvent.pointerDown(textarea);
    fireEvent.click(overlay);
    expect(screen.getByRole('dialog', { name: '自定义' })).toBeInTheDocument();

    // 真在遮罩上按下、又在遮罩上松开（点外面）仍然是「点外面」，菜单要关。
    fireEvent.pointerDown(overlay);
    fireEvent.click(overlay);
    expect(screen.queryByRole('dialog', { name: '自定义' })).not.toBeInTheDocument();
    await settle();
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
  await user.click(within(panel).getByRole('checkbox', { name: '详情页显示清除阅读进度' }));
  await vi.waitFor(() => expect(adapter).toHaveBeenCalledWith('save_preferences', { input: expect.objectContaining({ detailActions: ['read', 'readingList', 'favorites', 'download', 'edit', 'clearProgress'] }) }));
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
