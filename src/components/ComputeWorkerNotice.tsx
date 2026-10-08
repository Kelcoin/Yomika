import { useEffect, useState } from 'react';
import { getNativeComputeRepository } from '../repositories/nativeComputeRepository';

/** 界面要说的这件事只有两种：换代中（还能自己回来）、坏了（要人点一下）。 */
type WorkerNotice = { state: 'recovering' | 'unavailable'; epoch?: number; reason?: string };

/** 多久问一次。500ms 是「2 秒内给到状态」这条门槛留出的余量：一次调用很小，
 * 而换代本身要走过 IPC 关闭 → 宿主记账 → 下一代的退避，不是瞬间的事。 */
const POLL_MS = 500;

/** §12.3：「worker 被杀/起不来时，界面最多 2 秒内给到『正在恢复 / 不可用』状态；
 * 重启期间导航/关闭仍可操作」。
 *
 * 为什么是轮询而不是等任务失败顺带报：这个状态只有 IPC 问得到，而计算进程**空闲时**
 * 被杀同样要报（没有任务会去替它说话）。一次 500ms 的小调用换的是「计算进程不在」这件事
 * 在界面上有落点，而不是靠某件任务失败猜出来。
 *
 * 为什么记住「见过哪一代 ready」：第一次起进程也是 stopped → starting，那不是恢复。
 * 只有见过 ready 之后又看到 starting/stopped，才说明这一代掉了、正在换代。`stopped`
 * 也照实说——枚举自己的注释就是「没有要跑的东西，也就没有 worker。不是『坏了』」，
 * 所以那句话不能写成「不可用」，只能写成「不在，正在恢复」。
 *
 * 挂在 App 里而不是阅读器里：计算进程不只服务阅读器，整本预扫也用它；挂在某一条路由上
 * 的话，从阅读器退出来就看不见了。 */
export function ComputeWorkerNotice({ pollMs = POLL_MS }: { pollMs?: number }) {
  const [notice, setNotice] = useState<WorkerNotice>();
  useEffect(() => {
    let disposed = false;
    let seenReadyEpoch = -1;
    const repository = getNativeComputeRepository();
    const tick = async () => {
      const result = await repository.workerStatus();
      // 问不到就什么都不说：报「不知道」会和一个真的坏掉的状态长得一样，
      // 而这一栏的存在意义正是把两种状态分开。
      if (disposed || !result.ok) return;
      const status = result.value;
      if (status.kind === 'ready') {
        seenReadyEpoch = status.epoch;
        setNotice(undefined);
        return;
      }
      if (status.kind === 'broken') {
        setNotice({ state: 'unavailable', reason: status.reason });
        return;
      }
      if (seenReadyEpoch >= 0) {
        setNotice(status.kind === 'starting' ? { state: 'recovering', epoch: status.epoch } : { state: 'recovering' });
      }
    };
    void tick();
    const timer = window.setInterval(() => { void tick(); }, pollMs);
    return () => {
      disposed = true;
      window.clearInterval(timer);
    };
  }, [pollMs]);
  if (!notice) return null;
  return (
    <div className="compute-worker-notice" role="status" data-testid="compute-worker-status" data-worker-state={notice.state}>
      <span>
        {notice.state === 'unavailable'
          ? `计算进程不可用：${notice.reason ?? '起不来了'}`
          : notice.epoch === undefined
            ? '计算进程不在，正在恢复：这一页先用原图'
            : `计算进程正在恢复（第 ${notice.epoch} 代）：这一页先用原图`}
      </span>
      {notice.state === 'unavailable' ? (
        <button
          type="button"
          className="compute-worker-retry"
          onClick={() => { void getNativeComputeRepository().retryWorker(); }}
        >
          重试
        </button>
      ) : null}
    </div>
  );
}
