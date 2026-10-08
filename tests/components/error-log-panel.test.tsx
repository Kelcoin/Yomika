import { act, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, vi } from 'vitest';

import { ERROR_LOG_REFRESH_MS, ErrorLogPanel, useErrorLog } from '../../src/components/ErrorLogPanel';
import { ToastProvider } from '../../src/components/Toast';
import { resetInvokeAdapterForTests, setInvokeAdapterForTests } from '../../src/bridge/invoke';

afterEach(() => {
  resetInvokeAdapterForTests();
  vi.restoreAllMocks();
});

/** 菜单里的那块面板，状态由它自己的 hook 提供（与设置页里挂的是同一条线）。 */
function Harness() {
  const state = useErrorLog();
  return <ErrorLogPanel state={state} />;
}

const windowEntry = {
  at: '2026-09-28T10:00:00.000Z',
  level: 'error',
  source: 'window',
  message: 'Uncaught Error: boom',
  detail: JSON.stringify({ file: 'http://tauri.localhost/assets/index.js', line: 8, column: 12, stack: 'Error: boom\n at Fo (index.js:6:1)\n at Gs (index.js:8:2)' }),
};
const panicEntry = {
  at: 'epoch:1790589509529',
  level: 'error',
  source: 'core/panic',
  message: 'state() called before manage()',
  detail: 'src/commands/compute_center.rs:761',
};

function serve(entries: unknown[], overrides: Record<string, unknown> = {}) {
  const adapter = vi.fn(async (command: string) => {
    if (overrides[command]) return overrides[command];
    if (command === 'error_log_read') return { ok: true, value: entries };
    if (command === 'app_build_info') {
      return { ok: true, value: { version: '1.0.0', buildTime: '1790000000', commit: 'abcdef123456', profile: 'release', identifier: 'app.yomika', platform: 'windows', os: 'windows', arch: 'x86_64' } };
    }
    if (command === 'platform_capabilities') {
      return { ok: true, value: { platform: 'windows', native: true, secureStorage: true, fileSystem: true, backgroundTasks: false, nativeInference: true } };
    }
    return { ok: true, value: undefined };
  });
  setInvokeAdapterForTests(adapter);
  return adapter;
}

function renderPanel() {
  return render(<ToastProvider><Harness /></ToastProvider>);
}

describe('error log panel', () => {
  it('folds each entry to a title line and expands it into 错误详情 and 堆栈跟踪', async () => {
    const user = userEvent.setup();
    serve([windowEntry]);
    renderPanel();

    expect(await screen.findByText('Uncaught Error: boom')).toBeInTheDocument();
    // 折起来时只有标题：明细与栈都不在。
    expect(screen.queryByText('错误详情')).not.toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: /Uncaught Error: boom/ }));

    expect(screen.getByText('错误详情')).toBeInTheDocument();
    // 明细里那个 JSON 被拆成两段：**在哪**是一行，栈按行展开。
    expect(screen.getByText('http://tauri.localhost/assets/index.js:8:12')).toBeInTheDocument();
    expect(screen.getByText('堆栈跟踪')).toBeInTheDocument();
    expect(screen.getByText(/at Fo \(index\.js:6:1\)/)).toBeInTheDocument();
  });

  it('leaves the running count out of the panel head, so the title stands alone', async () => {
    serve([panicEntry]);
    renderPanel();

    await screen.findByText('state() called before manage()');
    // 用户报的「顶部标题下方的小字」：那行「本次运行 N 条，上次运行 M 条。」已经去掉。
    // 上次运行的记录本来就带着「上次运行 · 」的来源前缀，区分不靠这行字。
    expect(screen.queryByText(/本次运行/)).not.toBeInTheDocument();
    expect(screen.queryByText(/上次运行/)).not.toBeInTheDocument();
  });

  it('shows a panic location as the detail with no stack section', async () => {
    const user = userEvent.setup();
    serve([panicEntry]);
    renderPanel();

    await user.click(await screen.findByRole('button', { name: /state\(\) called before manage\(\)/ }));

    expect(screen.getByText('src/commands/compute_center.rs:761')).toBeInTheDocument();
    expect(screen.queryByText('堆栈跟踪')).not.toBeInTheDocument();
  });

  it('keeps 相关信息 folded, and spells out device, app and build facts when opened', async () => {
    const user = userEvent.setup();
    serve([panicEntry]);
    renderPanel();

    const toggle = await screen.findByRole('button', { name: '相关信息' });
    expect(toggle).toHaveAttribute('aria-expanded', 'false');
    expect(screen.queryByText('编译信息')).not.toBeInTheDocument();

    await user.click(toggle);
    expect(screen.getByText('设备信息')).toBeInTheDocument();
    expect(screen.getByText('应用信息')).toBeInTheDocument();
    expect(screen.getByText('编译信息')).toBeInTheDocument();
    // 版本、提交号与包标识来自 app_build_info：报问题时最先要抄的就是这几个。
    expect(screen.getByText('v1.0.0')).toBeInTheDocument();
    expect(screen.getByText('abcdef123456')).toBeInTheDocument();
    expect(screen.getByText('app.yomika')).toBeInTheDocument();
    expect(screen.getByText('x86_64')).toBeInTheDocument();
  });

  it('lays the four actions along the bottom instead of behind a ⋮', async () => {
    serve([panicEntry]);
    renderPanel();

    await screen.findByText('state() called before manage()');
    // 用户要的：刷新按钮与 ⋮ 都去掉，四个动作铺在面板底部、各带一枚图标。
    expect(screen.queryByRole('button', { name: '刷新日志' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: '日志操作' })).not.toBeInTheDocument();

    const group = screen.getByRole('group', { name: '日志操作' });
    const buttons = within(group).getAllByRole('button');
    expect(buttons.map((button) => button.textContent)).toEqual(['复制日志', '导出日志', '错误反馈', '清空日志']);
    for (const button of buttons) {
      expect(button.querySelector('svg[aria-hidden="true"]'), `${button.textContent} 要有 SVG 图标`).not.toBeNull();
    }
  });

  it('refreshes itself while it is open, so a new failure shows up with nothing to press', async () => {
    vi.useFakeTimers();
    try {
      const entries: unknown[] = [panicEntry];
      serve(entries);
      renderPanel();
      await act(async () => { await vi.advanceTimersByTimeAsync(0); });
      expect(screen.getByText('state() called before manage()')).toBeInTheDocument();

      entries.unshift({ at: '2026-09-28T11:00:00.000Z', level: 'error', source: 'bridge/list_archives', message: '晚一点才发生的那一次失败' });
      expect(screen.queryByText('晚一点才发生的那一次失败')).not.toBeInTheDocument();

      await act(async () => { await vi.advanceTimersByTimeAsync(ERROR_LOG_REFRESH_MS); });
      expect(screen.getByText('晚一点才发生的那一次失败')).toBeInTheDocument();
    } finally {
      vi.useRealTimers();
    }
  });

  it('clears both rounds only after the confirmation, and says how many went', async () => {
    const user = userEvent.setup();
    const adapter = serve([panicEntry], { error_log_clear: { ok: true, value: 1 } });
    renderPanel();

    await screen.findByText('state() called before manage()');
    await user.click(screen.getByRole('button', { name: '清空日志' }));

    // 破坏性动作先问一句，问之前不写。
    expect(adapter).not.toHaveBeenCalledWith('error_log_clear', {});
    const dialog = await screen.findByRole('dialog', { name: '清空日志' });
    await user.click(within(dialog).getByRole('button', { name: '清空' }));

    await waitFor(() => expect(adapter).toHaveBeenCalledWith('error_log_clear', {}));
    // 清空之后整块列表收起来（顶上那行计数已经不在界面上，落点是空的列表本身）。
    expect(screen.queryByRole('list', { name: '错误记录' })).not.toBeInTheDocument();
    expect(screen.getByRole('status')).toHaveTextContent('已清空 1 条记录');
  });

  it('copies the whole log, header and 相关信息 included', async () => {
    const user = userEvent.setup();
    const adapter = serve([panicEntry]);
    renderPanel();

    await screen.findByText('state() called before manage()');
    await user.click(screen.getByRole('button', { name: '复制日志' }));

    await waitFor(() => expect(adapter).toHaveBeenCalledWith('write_clipboard_text', {
      text: expect.stringContaining('# Yomika 错误日志'),
    }));
    const call = adapter.mock.calls.find(([command]) => command === 'write_clipboard_text') as unknown as [string, { text: string }] | undefined;
    const copied = call?.[1].text ?? '';
    expect(copied).toContain('core/panic');
    expect(copied).toContain('src/commands/compute_center.rs:761');
    expect(copied).toContain('提交: abcdef123456');
  });
});
