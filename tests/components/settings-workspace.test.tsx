import { fireEvent, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, vi } from 'vitest';
import { MemoryRouter } from 'react-router-dom';

import { App } from '../../src/app/App';
import { resetInvokeAdapterForTests, setInvokeAdapterForTests } from '../../src/bridge/invoke';
import { resetFilePickerForTests, setDirectoryPickerForTests } from '../../src/bridge/filePicker';
import { COMPACT_WIDTH_QUERY } from '../../src/lib/useMediaQuery';
import { DEFAULT_PREFERENCES } from '../../src/repositories/nativeSettingsRepository';
import { CSS_THEME_PRESETS } from '../../src/lib/cssThemePresets';

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

    await user.click(screen.getByRole('button', { name: 'LANraragi 文档' }));
    expect(adapter).toHaveBeenCalledWith('open_external_url', { url: 'https://sugoi.gitbook.io/lanraragi' });
    expect(screen.queryByText('仓库')).not.toBeInTheDocument();
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
    const toggle = await screen.findByRole('switch', { name: '同步删除 E-Hentai 收藏' });
    expect(toggle).toHaveClass('switch-control');
    const confirmation = screen.getByRole('switch', { name: '每次确认收藏同步删除' });
    expect(confirmation).toBeDisabled();
    await user.click(toggle);
    await user.click(confirmation);
    await vi.waitFor(() => expect(adapter).toHaveBeenCalledWith('save_preferences', { input: { ...DEFAULT_PREFERENCES, ehFavoriteDeleteSync: true, confirmEhFavoriteDelete: false } }));
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
    const toggle = await screen.findByRole('switch', { name: '启用去码' });
    expect(screen.getByRole('button', { name: 'Mask R-CNN · 1' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'DeepCreamPy Bar · 1' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'DeepCreamPy Mosaic · 1' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Fatal Pixels · 1' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /^下载/ })).toBeNull();
    expect(screen.getByText('遮挡区域检测')).toBeInTheDocument();
    expect(toggle).toBeEnabled();
    expect(toggle).toHaveClass('switch-control');
    expect(toggle).toHaveAttribute('aria-checked', 'false');
    await user.click(toggle);
    expect(toggle).toHaveAttribute('aria-checked', 'true');
    expect(screen.getByRole('region', { name: '模型导入' })).toBeInTheDocument();
    expect(screen.queryByLabelText('目标目录')).not.toBeInTheDocument();
    expect(screen.queryByText('修补被审查的区域')).not.toBeInTheDocument();
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
    await user.click(await screen.findByRole('button', { name: 'waifu2x' }));
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

    await user.click(await screen.findByRole('button', { name: 'Anime4K' }));
    expect(screen.getAllByRole('button', { name: 'Anime4K' })).toHaveLength(2);
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
    expect(await screen.findByRole('heading', { name: 'Home' })).toBeInTheDocument();
    expect(screen.getByText('https://example.com')).toBeInTheDocument();
    expect(screen.getByText('已配置')).toBeInTheDocument();
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

    expect(await screen.findByRole('heading', { name: 'Home' })).toBeInTheDocument();
    expect(screen.queryByText('secret')).not.toBeInTheDocument();
    expect(adapter).toHaveBeenCalledWith('save_server', expect.objectContaining({
      server: expect.objectContaining({ name: 'Home', baseUrl: 'https://example.com' }),
      apiKey: 'secret',
    }));
  });

  it('opens an existing server with its identity prefilled for API key replacement', async () => {
    const user = userEvent.setup();
    const adapter = vi.fn(async (command: string) => {
      if (command === 'load_preferences') return { ok: true, value: { theme: 'system', defaultLayout: 'auto', defaultDirection: 'ltr', cacheMaxBytes: 2_147_483_648 } };
      if (command === 'list_servers') return { ok: true, value: [{ id: 'scope-a', name: 'Home', baseUrl: 'https://example.com', scopeId: 'scope-a' }] };
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
    expect(screen.getByRole('heading', { name: '数据迁移' })).toBeInTheDocument();
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
    expect(screen.queryByLabelText('图片缓存上限')).not.toBeInTheDocument();
    view.unmount();

    renderSettings('general');
    expect(await screen.findByLabelText('图片缓存上限')).toHaveValue(4);
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
    await screen.findByLabelText('自定义 CSS');

    // The accent picker is gone: it set --brand-vermilion as an inline style on
    // the root, which outranked the same variable in a preset's :root block —
    // applying a theme then appeared to do nothing.
    expect(screen.queryByLabelText('自定义强调色')).not.toBeInTheDocument();
    expect(document.documentElement.style.getPropertyValue('--brand-vermilion')).toBe('');

    fireEvent.change(screen.getByLabelText('自定义 CSS'), { target: { value: ':root { --brand-vermilion: #1f6f8b; }' } });

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
    const preload = await screen.findByLabelText('预加载页数');
    // Ten pages, not five: a LAN page is a few hundred KB.
    expect(preload).toHaveAttribute('max', '10');
    await user.clear(preload);
    await user.type(preload, '8');
    const concurrency = screen.getByLabelText('封面并发请求');
    await user.clear(concurrency);
    await user.type(concurrency, '2');
    // One switch for the feature, and nothing that configures it until it is on.
    // The backend list used to carry 关闭 and the model list 未选择, so turning
    // upscaling on meant knowing which two unrelated controls to change.
    expect(screen.queryByLabelText('超分模型')).not.toBeInTheDocument();
    expect(screen.queryByLabelText('超分后端')).not.toBeInTheDocument();
    await user.click(screen.getByRole('link', { name: '高级' }));
    await user.click(await screen.findByRole('switch', { name: '启用超分' }));

    // Installed models are offered by name, with the scale the model itself
    // produces; typing a name from memory was a silent failure at upscale time.
    await user.click(screen.getByRole('button', { name: 'Real-ESRGAN' }));
    expect(screen.queryByRole('button', { name: /下载Real-ESRGAN/ })).toBeNull();
    expect(screen.getAllByLabelText('超分模型').length).toBeGreaterThan(0);
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
    const file = new File(['zip'], 'bundle.zip', { type: 'application/zip' });
    Object.defineProperty(file, 'arrayBuffer', { value: async () => new Uint8Array([1, 2, 3]).buffer });
    const input = document.querySelector('input[type="file"]') as HTMLInputElement;
    fireEvent.change(input, { target: { files: [file] } });
    await vi.waitFor(() => expect(adapter).toHaveBeenCalledWith('inference_import_model_file', { input: { file: [1, 2, 3], filename: 'bundle.zip' } }));
    await vi.waitFor(() => expect(toggle).toBeEnabled());
    await user.click(toggle);
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

    await user.click(await screen.findByRole('button', { name: 'waifu2x' }));
    await user.click(screen.getByRole('button', { name: '下载waifu2x' }));
    expect(adapter).toHaveBeenCalledWith('model_release_download_default', { modelId: 'waifu2x-upconv7' });

    await user.click(screen.getByRole('button', { name: 'Mask R-CNN' }));
    await user.click(screen.getByRole('button', { name: '下载Mask R-CNN' }));
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
    expect(await screen.findByText('7 KB')).toBeInTheDocument();
    const breakdown = screen.getByLabelText('图片缓存明细');
    expect(breakdown).toHaveTextContent('封面 1 KB');
    expect(breakdown).toHaveTextContent('页缩略图 2 KB');
    expect(breakdown).toHaveTextContent('阅读页 4 KB');
    expect(breakdown).toHaveTextContent('超分结果 1 KB');
    expect(breakdown).toHaveTextContent('去码结果 1 KB');
    expect(breakdown).toHaveTextContent('推理缓存 1 KB');
    await user.click(screen.getByRole('button', { name: '清空图片缓存' }));
    expect(adapter).toHaveBeenCalledWith('cache_clear_images', {});
    expect(await screen.findByText('已释放 6.88 KB，保留 128 B 受保护缓存')).toBeInTheDocument();
    expect(within(screen.getByRole('region', { name: '图片缓存' })).getByText('128 B')).toBeInTheDocument();
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
    expect(await screen.findByRole('heading', { name: 'Home' })).toBeInTheDocument();
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
    await user.type(screen.getByLabelText('导出 JSON'), 'encoded-config');
    await user.click(screen.getByRole('button', { name: '导入数据' }));

    expect(await screen.findByText('已导入 3 项偏好设置')).toBeInTheDocument();
    // The imported snapshot lands across sections: theme in 通用, reader
    // defaults in 阅读.
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
      if (command === 'list_watchlist') return { ok: true, value: [{ scopeId: 'scope-a', archiveId: 'a2', addedAt: '2026-08-30T00:00:00Z', updatedAt: '2026-08-30T00:00:00Z', deviceId: 'device-a', revision: 1, deleted: false }] };
      throw new Error(`Unexpected command: ${command}`);
    });
    renderSettings('sync');

    await user.click(await screen.findByRole('link', { name: /同步/ }));
    await user.click(screen.getByRole('button', { name: '导出数据' }));

    expect(await screen.findByText('已导出 2 项本地记录')).toBeInTheDocument();
    const exported = JSON.parse((screen.getByLabelText('导出 JSON') as HTMLTextAreaElement).value);
    expect(exported).toMatchObject({ schemaVersion: 1, scopeId: 'scope-a', deleted: [] });
    expect(exported.items.map((item: { archiveId: string }) => item.archiveId)).toEqual(['a1', 'a2']);
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
    await user.type(screen.getByLabelText('导出 JSON'), 'secret-only');
    await user.click(screen.getByRole('button', { name: '导入数据' }));

    expect(await screen.findByText('旧配置无有效普通偏好')).toBeInTheDocument();
    await user.click(screen.getByRole('link', { name: /通用/ }));
    await user.click(screen.getByRole('link', { name: /样式/ }));
    expect(screen.getByRole('radio', { name: '深色' })).toBeChecked();
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
      expect(await screen.findByRole('link', { name: /关于/ })).toBeInTheDocument();
      expect(screen.queryByRole('region', { name: '服务器' })).not.toBeInTheDocument();

      await user.click(screen.getByRole('link', { name: /通用/ }));
      expect(await screen.findByRole('heading', { name: '通用' })).toBeInTheDocument();
      expect(screen.getByRole('region', { name: '服务器' })).toBeInTheDocument();
      // One section at a time: the list is gone rather than sitting above it.
      expect(screen.queryByRole('link', { name: /关于/ })).not.toBeInTheDocument();

      await user.click(screen.getByRole('button', { name: '返回设置分类' }));
      expect(await screen.findByRole('link', { name: /关于/ })).toBeInTheDocument();
      expect(screen.queryByRole('region', { name: '服务器' })).not.toBeInTheDocument();
    } finally {
      window.matchMedia = original;
    }
  });

  it('applies a preset theme as soon as it is picked', async () => {
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

    // Each preset card names the theme and what it changes, so it is found by a
    // prefix rather than an exact label.
    await user.click(await screen.findByRole('link', { name: /样式/ }));
    const paperCss = CSS_THEME_PRESETS.find((preset) => preset.id === 'paper-reading')!.css;
    await user.click(await screen.findByRole('button', { name: /^纸张阅读/ }));
    expect((screen.getByLabelText('自定义 CSS') as HTMLTextAreaElement).value).toBe(paperCss);
    // The picked card stays marked, and no save step stands between the click
    // and the stylesheet.
    expect(screen.getByRole('button', { name: /^纸张阅读/ })).toHaveAttribute('aria-pressed', 'true');

    await vi.waitFor(() => {
      expect(document.getElementById('yomika-custom-css')?.textContent).toBe(paperCss);
    });
  });
});
