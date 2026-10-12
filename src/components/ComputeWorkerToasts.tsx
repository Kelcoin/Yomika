import { useEffect } from 'react';

import { getNativeComputeRepository } from '../repositories/nativeComputeRepository';
import { useToast, type ToastMeta } from './Toast';

/** 界面要说的这件事只有两种：换代中（还能自己回来）、坏了（起不来了）。
 *
 * 「换代中」只对应宿主的 `starting`：那是**这一代正在回来**（进程已经在起，或者崩溃后
 * 的退避已经排好）。`stopped` 不属于这两种里的任何一种——它的意思是「没有要跑的东西，
 * 也就没有 worker」，进程按需起、闲下来就把缓存交回再退出。把 `stopped` 也读成「正在
 * 恢复」，那句话就会从闲置回收那一刻起永远挂在提示里。
 *
 * 为什么是 toast 而不是常驻提示条（`ComputeWorkerNotice` 已经删掉）：这条信息与 toast
 * 说的是同一件事，两者并排只会让人看到两遍；而常驻条一旦落进 `broken` 就再也没人撤掉
 * 它——宿主每轮重播同一个 broken（`manager.rs` 的 `maybe_spawn`），屏幕上就是一句永远
 * 下不去的「计算进程不可用」。改成 toast 之后同一句话自己会走，且**同一次故障只说一次**：
 * 宿主每 500ms 重播的状态由下面的 key 折掉，不重复弹。 */
type WorkerToast = { key: string; text: string; state: 'recovering' | 'unavailable'; type: 'info' | 'error'; action?: ToastMeta['action'] };

/** 多久问一次。500ms 是 §12.3「worker 被杀/起不来时界面最多 2 秒内给到状态」留出的余量：
 * 一次调用很小，而换代本身要走过 IPC 关闭 → 宿主记账 → 下一代的退避，不是瞬间的事。 */
const POLL_MS = 500;

/** toast 自己会收，但这条信息重要到值得多停一会儿（默认 info 只停 3.6 秒）。 */
const NOTICE_MS = 7000;

/** §12.3：worker 被杀/起不来时界面要给到「正在恢复 / 不可用」。状态只有 IPC 问得到，
 * 而计算进程**空闲时**被杀同样要报（没有任务会去替它说话）。
 *
 * 为什么记住「见过哪一代 ready」：第一次起进程也是 stopped → starting，那不是恢复。
 * 只有见过 ready 之后又看到 starting，才说明这一代掉了、正在换代。
 *
 * 挂在 App 里而不是阅读器里：计算进程不只服务阅读器，整本预扫也用它；挂在某一条路由上
 * 的话，从阅读器退出来就看不见了。 */
export function ComputeWorkerToasts({ pollMs = POLL_MS }: { pollMs?: number }) {
  const { showToast } = useToast();
  useEffect(() => {
    let disposed = false;
    let seenReadyEpoch = -1;
    // 上一句说过的状态：宿主会把同一个 broken 每轮重播出来，靠它只弹一次。
    let lastKey = '';
    const repository = getNativeComputeRepository();
    const say = (notice: WorkerToast) => {
      if (notice.key === lastKey) return;
      lastKey = notice.key;
      showToast(notice.text, notice.type, NOTICE_MS, {
        testId: 'compute-worker-status',
        attributes: { 'data-worker-state': notice.state },
        action: notice.action,
      });
    };
    const tick = async () => {
      const result = await repository.workerStatus();
      // 问不到就什么都不说：报「不知道」会和一个真的坏掉的状态长得一样，
      // 这一栏的意义正是把两种状态分开。
      if (disposed || !result.ok) return;
      const status = result.value;
      if (status.kind === 'ready') {
        seenReadyEpoch = status.epoch;
        lastKey = '';
        return;
      }
      if (status.kind === 'broken') {
        say({
          key: `unavailable:${status.reason}`,
          text: `计算进程不可用：${status.reason || '起不来了'}`,
          state: 'unavailable',
          type: 'error',
          // 常驻条删掉之后，「坏了」这条路只剩这张 toast 能放一颗按钮，而宿主确实留着一道
          // 门（`compute_retry_worker`：清掉 broken、重新按需拉起）。点完把 `lastKey` 清掉：
          // 重试失败要再说一次，成功之后下一次坏掉也要能再报；而清掉之后每轮重播同一个
          // broken 只会被 `say` 折成一条，不会变成每半秒弹一次。
          action: { label: '重试', run: () => { lastKey = ''; void repository.retryWorker(); } },
        });
        return;
      }
      // 见过 ready 之后的 `starting` 才是换代：带上第几代，人知道它真在回来。
      if (status.kind === 'starting' && seenReadyEpoch >= 0) {
        say({
          key: `recovering:${status.epoch}`,
          text: `计算进程正在恢复（第 ${status.epoch} 代）：这一页先用原图`,
          state: 'recovering',
          type: 'info',
        });
        return;
      }
      // 其余（`stopped`、以及第一次启动的 `starting`）都不是「坏了」也不是「正在恢复」：
      // 没有要跑的东西就没有 worker，下一次提交会把它按需叫起来。
      lastKey = '';
    };
    void tick();
    const timer = window.setInterval(() => { void tick(); }, pollMs);
    return () => {
      disposed = true;
      window.clearInterval(timer);
    };
  }, [pollMs, showToast]);
  return null;
}
