import { afterEach, describe, expect, it } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import { ComputeWorkerNotice } from '../../src/components/ComputeWorkerNotice';
import { resetInvokeAdapterForTests, setInvokeAdapterForTests } from '../../src/bridge/invoke';

/** 宿主 `compute_worker_status` 的替身：`current` 是可变的那一格，用例跑的时候换它。 */
function installHost(current: { status: unknown }, commands: string[]) {
  setInvokeAdapterForTests(async (command: string) => {
    commands.push(command);
    if (command === 'compute_worker_status') return { ok: true, value: current.status };
    if (command === 'compute_retry_worker') return { ok: true, value: null };
    return { ok: false, error: { code: 'COMPUTE_NOT_FOUND', message: command, retryable: false } };
  });
}

/** 每一格都等 poll 把话说完（`pollMs` 给得很小，所以这里不用假时钟）。 */
const notice = () => screen.queryByTestId('compute-worker-status');

afterEach(() => {
  resetInvokeAdapterForTests();
});

describe('compute worker notice', () => {
  it('only calls it a restart after this session has actually seen a ready worker', async () => {
    const commands: string[] = [];
    const current = { status: { kind: 'stopped' } as unknown };
    installHost(current, commands);
    render(<ComputeWorkerNotice pollMs={20} />);
    // 第一次起进程之前也是 stopped：那不是「恢复」，不该报。
    // 「不该报」这种断言自己证明不了什么——它得有个证人说明宿主**问过了**才成立，
    // 所以这里等的不是「没有那条状态」，而是「问过一次了，那一格确实是 stopped」。
    const waitForAnotherCall = async (before: number) => {
      await waitFor(() => expect(commands.filter((name) => name === 'compute_worker_status').length).toBeGreaterThan(before));
    };
    const statusCalls = () => commands.filter((name) => name === 'compute_worker_status').length;
    await waitForAnotherCall(0);
    expect(notice()).toBeNull();
    // 起来过一代。
    let seen = statusCalls();
    current.status = { kind: 'ready', epoch: 1, peerPid: 4242, limitsApplied: true, limitsNote: null };
    await waitForAnotherCall(seen);
    expect(notice()).toBeNull();
    // 这一代掉了，宿主要起下一代：界面这时才该说「正在恢复」，而且带上第几代。
    seen = statusCalls();
    current.status = { kind: 'starting', epoch: 2 };
    await waitFor(() => expect(notice()).not.toBeNull());
    expect(notice()?.getAttribute('data-worker-state')).toBe('recovering');
    expect(notice()?.textContent).toContain('正在恢复');
    expect(notice()?.textContent).toContain('第 2 代');
    // 回来了就撤掉：这条状态不该赖在屏幕上。
    seen = statusCalls();
    current.status = { kind: 'ready', epoch: 2, peerPid: 4243, limitsApplied: true, limitsNote: null };
    await waitForAnotherCall(seen);
    await waitFor(() => expect(notice()).toBeNull());
  });

  it('says unavailable and offers the retry the host actually exposes', async () => {
    const commands: string[] = [];
    const current = { status: { kind: 'broken', reason: '60 秒内重启次数到顶，不再自动重试' } as unknown };
    installHost(current, commands);
    render(<ComputeWorkerNotice pollMs={20} />);
    await waitFor(() => expect(notice()).not.toBeNull());
    // broken 不分先后：从没起来过也算「不可用」。
    expect(notice()?.getAttribute('data-worker-state')).toBe('unavailable');
    expect(notice()?.textContent).toContain('不可用');
    expect(notice()?.textContent).toContain('不再自动重试');
    screen.getByRole('button', { name: '重试' }).click();
    await waitFor(() => expect(commands).toContain('compute_retry_worker'));
  });

  it('says nothing at all when the status itself cannot be read', async () => {
    const commands: string[] = [];
    setInvokeAdapterForTests(async (command: string) => {
      commands.push(command);
      return { ok: false, error: { code: 'INVALID_RESPONSE', message: '解不出来', retryable: false } };
    });
    render(<ComputeWorkerNotice pollMs={20} />);
    await waitFor(() => expect(commands.length).toBeGreaterThan(1));
    // 「问不到」不许画成「坏了」：这一栏存在的意义就是把两种状态分开。
    expect(notice()).toBeNull();
  });
});
