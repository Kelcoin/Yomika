import { act, fireEvent, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, vi } from 'vitest';
import { MemoryRouter } from 'react-router-dom';

import { App } from '../../src/app/App';
import { resetInvokeAdapterForTests, setInvokeAdapterForTests } from '../../src/bridge/invoke';
import { resetFilePickerForTests, setDirectoryPickerForTests } from '../../src/bridge/filePicker';
import { COMPACT_WIDTH_QUERY } from '../../src/lib/useMediaQuery';
import { DEFAULT_PREFERENCES } from '../../src/repositories/nativeSettingsRepository';
import { COLOR_SCHEMES } from '../../src/lib/cssThemePresets';
import { readoshiServerScope } from '../../src/lib/readoshiScope';

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
    // and the file input lives beside the row, with no second level to open.
    expect(screen.getByRole('button', { name: '选择模型文件…' })).toBeInTheDocument();
    expect(document.querySelector('input[type="file"]')).not.toBeNull();
    expect(screen.queryByRole('dialog', { name: '模型导入' })).toBeNull();
    expect(adapter.mock.calls.filter(([command]) => command === 'inference_list_models')).toHaveLength(1);
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
    // Home 的名字旁挂着「当前」徽章，且没有可关的开关。
    expect(await screen.findByText('当前')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: '当前' })).toBeNull();
    const officeToggle = await screen.findByRole('button', { name: '启用' });
    await user.click(officeToggle);

    expect(adapter).toHaveBeenCalledWith('set_server_enabled', { serverId: 'scope-b', enabled: true });
    // The rows swap in place: Office now carries the badge, Home offers 启用.
    expect(await screen.findByText('当前')).toBeInTheDocument();
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
        { id: 'realesr-general', version: '2026.09.2', scale: 4 },
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
    expect(await screen.findByRole('button', { name: 'Real-ESRGAN' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /下载Real-ESRGAN/ })).toBeNull();
    expect(screen.getAllByLabelText('超分模型').length).toBeGreaterThan(0);
    await user.keyboard('{Escape}');
    expect(screen.queryByLabelText('超分后端')).not.toBeInTheDocument();
    // Turning it on picks a backend and the one runnable model, rather than
    // leaving two controls still saying "no".
    await vi.waitFor(() => expect(adapter).toHaveBeenCalledWith('save_preferences', {
      input: { ...DEFAULT_PREFERENCES, ...loaded, prefetchPages: 8, coverConcurrency: 2, upscaleBackend: 'auto', upscaleModel: 'realesr-general' },
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
      if (command === 'inference_import_model_file') {
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
    // The bundle arrives through the import row's own file input.
    await user.click(screen.getByRole('button', { name: '选择模型文件…' }));
    const file = new File(['zip'], 'bundle.zip', { type: 'application/zip' });
    Object.defineProperty(file, 'arrayBuffer', { value: async () => new Uint8Array([1, 2, 3]).buffer });
    const input = document.querySelector('input[type="file"]') as HTMLInputElement;
    fireEvent.change(input, { target: { files: [file] } });
    await vi.waitFor(() => expect(adapter).toHaveBeenCalledWith('inference_import_model_file', { input: { file: [1, 2, 3], filename: 'bundle.zip' } }));
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
    expect(breakdown).toHaveTextContent('封面 1 KB');
    expect(breakdown).toHaveTextContent('页缩略图 2 KB');
    expect(breakdown).toHaveTextContent('阅读页 4 KB');
    expect(breakdown).toHaveTextContent('超分结果 1 KB');
    expect(breakdown).toHaveTextContent('去码结果 1 KB');
    expect(breakdown).toHaveTextContent('推理缓存 1 KB');
    await user.click(within(cacheMenu).getByRole('button', { name: '清空图片缓存' }));
    expect(adapter).toHaveBeenCalledWith('cache_clear_images', {});
    expect(await screen.findByText('已释放 6.88 KB，保留 128 B 受保护缓存')).toBeInTheDocument();
    expect(within(screen.getByRole('dialog', { name: '图片缓存' })).getByText('128 B')).toBeInTheDocument();
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

  it('exports local records as the unified migration envelope', async () => {
    const user = userEvent.setup();
    setInvokeAdapterForTests(async (command) => {
      if (command === 'load_preferences') return { ok: true, value: { theme: 'system', defaultLayout: 'auto', defaultDirection: 'ltr', cacheMaxBytes: 2_147_483_648 } };
      if (command === 'list_servers') return { ok: true, value: [{ id: 'scope-a', name: 'Home', baseUrl: 'https://example.com', scopeId: 'scope-a' }] };
      if (command === 'list_reading_history') return { ok: true, value: [{ scopeId: 'scope-a', archiveId: 'a1', pageIndex: 4, visitedAt: '2026-09-01T00:00:00Z', deviceId: 'device-a', revision: 1 }] };
      if (command === 'list_reading_list') return { ok: true, value: [] };
      throw new Error(`Unexpected command: ${command}`);
    });
    renderSettings('sync');

    await user.click(await screen.findByRole('link', { name: /同步/ }));
    await user.click(await screen.findByRole('button', { name: '导出数据' }));
    const exportMenu = await screen.findByRole('dialog', { name: '导出数据' });
    await user.click(within(exportMenu).getByRole('button', { name: '导出数据' }));

    // 收藏夹 is the server-side LANraragi 🔖 Favorites category, so the export
    // carries the history and the local 待看 list only — no watchlist mirror
    // and no tombstones.
    expect(await screen.findByText('已导出 1 项本地记录')).toBeInTheDocument();
    const exported = JSON.parse((within(exportMenu).getByLabelText('导出 JSON') as HTMLTextAreaElement).value);
    expect(exported).toMatchObject({ schemaVersion: 1, scopeId: 'scope-a' });
    expect(exported).not.toHaveProperty('deleted');
    expect(exported.items.map((item: { archiveId: string }) => item.archiveId)).toEqual(['a1']);
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

  it('customizes bottom bar items with 档案库 and 设置 pinned', async () => {
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
      expect(compactNames).toEqual(['首页', '档案库', '下载', '设置']);
      compact.unmount();

      // 桌面侧边栏不受该偏好影响，仍然完整。
      const desktop = render(
        <MemoryRouter initialEntries={['/']}><App /></MemoryRouter>,
      );
      const sideNav = await desktop.findByRole('navigation', { name: '主导航' });
      const sideNames = Array.from(sideNav.querySelectorAll('a')).map((link) => link.textContent);
      expect(sideNames).toEqual(['首页', '档案库', '历史', '收藏夹', '待看', '下载', '设置']);
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
