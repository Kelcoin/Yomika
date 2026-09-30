import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { MemoryRouter, useLocation } from 'react-router-dom';

import { resetInvokeAdapterForTests, setInvokeAdapterForTests } from '../../src/bridge/invoke';
import { ToastProvider } from '../../src/components/Toast';
import { UpdateNotice } from '../../src/components/UpdateNotice';

afterEach(() => {
  resetInvokeAdapterForTests();
  window.localStorage.clear();
});

const RELEASE = {
  ok: true,
  value: {
    current: '1.0.0',
    latest: '1.2.0',
    updateAvailable: true,
    pageUrl: 'https://github.com/Kelcoin/Yomika/releases/tag/v1.2.0',
    publishedAt: '2026-09-30T00:00:00Z',
  },
};
const UP_TO_DATE = {
  ok: true,
  value: {
    current: '1.2.0',
    latest: '1.2.0',
    updateAvailable: false,
    pageUrl: 'https://github.com/Kelcoin/Yomika/releases/latest',
    publishedAt: null,
  },
};
/** 盘上一份老版本，目录里已经是新的：这就是「模型可以更新」。 */
const MODELS_INSTALLED_OLD = {
  ok: true,
  value: [{ id: 'realcugan-2x-denoise3x', version: '2022.02.27', scale: 2, kind: 'upscale', components: [] }],
};
const MODELS_CURRENT = { ok: true, value: [{ id: 'realcugan-2x-denoise3x', version: '2024.01.01', scale: 2, kind: 'upscale', components: [] }] };
const CATALOG_NEW = {
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
const CATALOG_EMPTY = { ok: true, value: { tag: 'models-v1', models: [] } };

/** 「去更新」不改弹层自己的状态来标记跳转，跳转发生在路由上，所以要在这里看。 */
function LocationProbe() {
  const location = useLocation();
  return <span data-testid="location">{`${location.pathname}${location.search}`}</span>;
}

function renderNotice() {
  return render(
    <MemoryRouter initialEntries={['/library']}>
      <ToastProvider>
        <UpdateNotice />
        <LocationProbe />
      </ToastProvider>
    </MemoryRouter>,
  );
}

describe('update notice', () => {
  it('offers the release page when this binary is behind', async () => {
    const user = userEvent.setup();
    const adapter = vi.fn(async (command: string) => {
      if (command === 'app_release_latest') return RELEASE;
      if (command === 'inference_list_models') return MODELS_CURRENT;
      if (command === 'model_release_list_upscalers') return CATALOG_NEW;
      if (command === 'open_external_url') return { ok: true, value: null };
      return { ok: true, value: [] };
    });
    setInvokeAdapterForTests(adapter);
    renderNotice();

    const dialog = await screen.findByRole('dialog');
    expect(within(dialog).getByText('有新版本 1.2.0')).toBeInTheDocument();
    // 说明里要写清「你现在是什么版本」，否则只有「有新版本」等于没说。
    expect(dialog.textContent).toContain('1.0.0');

    await user.click(within(dialog).getByRole('button', { name: '前往下载' }));
    await waitFor(() => expect(adapter).toHaveBeenCalledWith('open_external_url', {
      url: 'https://github.com/Kelcoin/Yomika/releases/tag/v1.2.0',
    }));
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
  });

  it('remembers a skipped version instead of asking again on every launch', async () => {
    const user = userEvent.setup();
    const adapter = vi.fn(async (command: string) => {
      if (command === 'app_release_latest') return RELEASE;
      if (command === 'inference_list_models') return { ok: true, value: [] };
      if (command === 'model_release_list_upscalers') return CATALOG_EMPTY;
      return { ok: true, value: [] };
    });
    setInvokeAdapterForTests(adapter);
    renderNotice();

    const dialog = await screen.findByRole('dialog');
    await user.click(within(dialog).getByRole('button', { name: '跳过该版本' }));
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    // 记的是「这个版本」：下一版还会来说一声。
    expect(window.localStorage.getItem('yomika.update.skipped-version')).toBe('1.2.0');
  });

  it('stays quiet about a version that was already skipped', async () => {
    window.localStorage.setItem('yomika.update.skipped-version', '1.2.0');
    const adapter = vi.fn(async (command: string) => {
      if (command === 'app_release_latest') return RELEASE;
      if (command === 'inference_list_models') return { ok: true, value: [] };
      if (command === 'model_release_list_upscalers') return CATALOG_EMPTY;
      return { ok: true, value: [] };
    });
    setInvokeAdapterForTests(adapter);
    renderNotice();

    await waitFor(() => expect(adapter).toHaveBeenCalledWith('app_release_latest', {}));
    expect(screen.queryByRole('dialog')).toBeNull();
  });

  it('sends model updates to the advanced settings page', async () => {
    const user = userEvent.setup();
    const adapter = vi.fn(async (command: string) => {
      if (command === 'app_release_latest') return UP_TO_DATE;
      if (command === 'inference_list_models') return MODELS_INSTALLED_OLD;
      if (command === 'model_release_list_upscalers') return CATALOG_NEW;
      return { ok: true, value: [] };
    });
    setInvokeAdapterForTests(adapter);
    renderNotice();

    const dialog = await screen.findByRole('dialog');
    // 模型这条不自己去下载：它把人送到高级设置，那里每个模型右侧有更新键。
    expect(within(dialog).getByText('有模型可以更新')).toBeInTheDocument();
    expect(dialog.textContent).toContain('Real-CUGAN 2x 漫画（强降噪）');

    await user.click(within(dialog).getByRole('button', { name: '去更新' }));
    await waitFor(() => expect(screen.getByTestId('location')).toHaveTextContent('/settings?section=advanced'));
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
  });

  it('moves on to the model prompt once the release one is skipped', async () => {
    const user = userEvent.setup();
    const adapter = vi.fn(async (command: string) => {
      if (command === 'app_release_latest') return RELEASE;
      if (command === 'inference_list_models') return MODELS_INSTALLED_OLD;
      if (command === 'model_release_list_upscalers') return CATALOG_NEW;
      return { ok: true, value: [] };
    });
    setInvokeAdapterForTests(adapter);
    renderNotice();

    const first = await screen.findByRole('dialog');
    expect(within(first).getByText('有新版本 1.2.0')).toBeInTheDocument();
    await user.click(within(first).getByRole('button', { name: '跳过该版本' }));

    // 一次检查里可能两件事都要说：跳过第一件不该把第二件也吞掉。
    const second = await screen.findByRole('dialog');
    expect(within(second).getByText('有模型可以更新')).toBeInTheDocument();
  });

  it('stays silent when nothing can be reached', async () => {
    const adapter = vi.fn(async (command: string) => {
      if (command === 'app_release_latest') {
        return { ok: false, error: { code: 'APP_RELEASE_UNREACHABLE', message: '查不到最新版本：timeout', retryable: true } };
      }
      if (command === 'inference_list_models') {
        return { ok: false, error: { code: 'INFERENCE_UNAVAILABLE', message: '列不出来', retryable: false } };
      }
      if (command === 'model_release_list_upscalers') {
        return { ok: false, error: { code: 'MODEL_CATALOG_FETCH_FAILED', message: '离线', retryable: true } };
      }
      return { ok: true, value: [] };
    });
    setInvokeAdapterForTests(adapter);
    renderNotice();

    await waitFor(() => expect(adapter).toHaveBeenCalledWith('app_release_latest', {}));
    // 离线不是用户要处理的问题：启动时蹦一句网络错误只会添乱。
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(screen.queryByText(/查不到最新版本/)).toBeNull();
  });
});
