import { afterEach, describe, expect, it } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { ComputeWorkerToasts } from '../../src/components/ComputeWorkerToasts';
import { ToastProvider } from '../../src/components/Toast';
import { resetInvokeAdapterForTests, setInvokeAdapterForTests } from '../../src/bridge/invoke';

/** 宿主 `compute_worker_status` 的替身：`current` 是可变的那一格，用例跑的时候换它。 */
function installHost(current: { status: unknown }, commands: string[]) {
  setInvokeAdapterForTests(async (command: string) => {
    commands.push(command);
    if (command === 'compute_worker_status') return { ok: true, value: current.status };
    return { ok: false, error: { code: 'COMPUTE_NOT_FOUND', message: command, retryable: false } };
  });
}

/** 这条状态落在 toast 卡片上：同一个 `data-testid` / `data-worker-state`（§12.3 的仪器
 * 量的是它们，不是满页找词）。 */
const notice = () => screen.queryByTestId('compute-worker-status');

function renderBridge() {
  // 提示条本身是 toast，所以必须挂在 provider 里——和 App 里的挂法一致。
  return render(<ToastProvider><ComputeWorkerToasts pollMs={20} /></ToastProvider>);
}

afterEach(() => {
  resetInvokeAdapterForTests();
});

describe('compute worker toasts', () => {
  it('only calls it a restart after this session has actually seen a ready worker', async () => {
    const commands: string[] = [];
    const current = { status: { kind: 'stopped' } as unknown };
    installHost(current, commands);
    renderBridge();
    // 第一次起进程之前也是 stopped：那不是「恢复」，不该报。
    // 「不该报」这种断言自己证明不了什么——它得有个证人说明宿主**问过了**才成立，
    // 所以这里等的不是「没有那条状态」，而是「问过一次了，那一格确实是 stopped」。
    const waitForAnotherCall = async (before: number) => {
      await waitFor(() => expect(commands.filter((name) => name === 'compute_worker_status').length).toBeGreaterThan(before));
    };
    const statusCalls = () => commands.filter((name) => name === 'compute_worker_status').length;
    await waitForAnotherCall(0);
    expect(notice()).toBeNull();
    // 还没有起来过的时候，宿主也会停在 `starting`（第一代正在起）：那是「第一次起」，
    // 不是「换代」——这一格报出去，每台机器一开阅读器就会先收到一句「正在恢复」。
    current.status = { kind: 'starting', epoch: 1 };
    await waitForAnotherCall(statusCalls());
    expect(notice()).toBeNull();
    // 起来过一代。
    let seen = statusCalls();
    current.status = { kind: 'ready', epoch: 1, peerPid: 4242, limitsApplied: true, limitsNote: null };
    await waitForAnotherCall(seen);
    expect(notice()).toBeNull();
    // 这一代掉了，宿主要起下一代：界面这时才该说「正在恢复」，而且带上第几代。
    current.status = { kind: 'starting', epoch: 2 };
    await waitFor(() => expect(notice()).not.toBeNull());
    expect(notice()?.getAttribute('data-worker-state')).toBe('recovering');
    expect(notice()?.textContent).toContain('正在恢复');
    expect(notice()?.textContent).toContain('第 2 代');
    // 同一个 starting 宿主会每轮重播：不许因为它重复弹第二张（常驻条当年就是栽在这里）。
    const shown = statusCalls();
    await waitForAnotherCall(shown);
    expect(screen.getAllByTestId('compute-worker-status')).toHaveLength(1);
  });

  it('says unavailable once per failure instead of pinning it on the screen', async () => {
    const commands: string[] = [];
    const current = { status: { kind: 'broken', reason: '60 秒内重启次数到顶，不再自动重试' } as unknown };
    installHost(current, commands);
    renderBridge();
    await waitFor(() => expect(notice()).not.toBeNull());
    // broken 不分先后：从没起来过也算「不可用」。
    expect(notice()?.getAttribute('data-worker-state')).toBe('unavailable');
    expect(notice()?.textContent).toContain('不可用');
    expect(notice()?.textContent).toContain('不再自动重试');
    // 宿主的 `maybe_spawn` 每轮都会重播同一个 broken，而这张 toast 说的是同一件事：
    // 只说一次，不叠第二张（叠起来就是那张「永远下不去」的常驻条）。
    let seen = commands.filter((name) => name === 'compute_worker_status').length;
    await waitFor(() => expect(commands.filter((name) => name === 'compute_worker_status').length).toBeGreaterThan(seen));
    expect(screen.getAllByTestId('compute-worker-status')).toHaveLength(1);
    // 它是 toast：自己会走。
    expect(screen.getByRole('button', { name: '关闭提示' })).toBeInTheDocument();
    // 关掉之后宿主还在说同一件事：**不许**再弹一张。这一条才是去重的承重点——toast 自己
    // 那条「同文去重」只认得还在屏上的那几张，关掉之后它认不出来；宿主每 500ms 重播一次，
    // 没有这一层，屏幕上就变成每半秒弹一次、永远关不完（常驻条是同一个病、另一种形状）。
    fireEvent.click(screen.getByRole('button', { name: '关闭提示' }));
    await waitFor(() => expect(notice()).toBeNull());
    seen = commands.filter((name) => name === 'compute_worker_status').length;
    await waitFor(() => expect(commands.filter((name) => name === 'compute_worker_status').length).toBeGreaterThan(seen));
    await waitFor(() => expect(commands.filter((name) => name === 'compute_worker_status').length).toBeGreaterThan(seen + 1));
    expect(notice(), '同一次故障关掉之后不许再自己回来').toBeNull();
  });

  it('keeps the host retry reachable now that the permanent notice is gone', async () => {
    const commands: string[] = [];
    const current = { status: { kind: 'broken', reason: '和主程序不是同一次构建' } as unknown };
    installHost(current, commands);
    renderBridge();
    await waitFor(() => expect(notice()).not.toBeNull());
    // 常驻条上那颗「重试」是这条路唯一的入口（宿主留 `compute_retry_worker` 清 broken 再按需
    // 拉起），条子删掉之后它必须跟着搬到 toast 上——否则 worker 一旦坏掉，界面上再也没有
    // 任何地方能把它叫回来，只能重启应用。
    const retry = screen.getByRole('button', { name: '重试' });
    fireEvent.click(retry);
    await waitFor(() => expect(commands).toContain('compute_retry_worker'));
    // 按钮留在卡上：重试没成功时人还得能再按一次（两次都算数）。
    fireEvent.click(screen.getByRole('button', { name: '重试' }));
    await waitFor(() => expect(commands.filter((name) => name === 'compute_retry_worker')).toHaveLength(2));
  });

  it('says nothing at all when the status itself cannot be read', async () => {
    const commands: string[] = [];
    setInvokeAdapterForTests(async (command: string) => {
      commands.push(command);
      return { ok: false, error: { code: 'INVALID_RESPONSE', message: '解不出来', retryable: false } };
    });
    renderBridge();
    await waitFor(() => expect(commands.length).toBeGreaterThan(1));
    // 「问不到」不许画成「坏了」：这一栏存在的意义就是把两种状态分开。
    expect(notice()).toBeNull();
  });
});
