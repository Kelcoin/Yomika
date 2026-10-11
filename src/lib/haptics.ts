import { invokeCommand, VoidResponseSchema } from '../bridge/invoke';

/** 触感档位。原生侧把这几档映射到系统预置的振动效果（见 `MobileHost.vibrate`）。 */
export type HapticKind = 'light' | 'medium' | 'heavy' | 'selection';

/** 只有手机有马达，判据与 `AppShell` 首帧那份 UA 正则**同一份口径**。
 *
 * 不看 `platform_capabilities`：那是异步的，而长按 450ms 后的确认要立刻发出去；桌面
 * 上少发这一趟 IPC 才是重点（`haptic_feedback` 在桌面是空操作，没有代价，但每秒按十次
 * 也不该往原生侧跑）。
 */
function hasMotor(): boolean {
  if (typeof navigator === 'undefined') return false;
  return /Android|iPhone|iPad|iPod/i.test(navigator.userAgent);
}

/** 一次触感反馈：长按「按住了」、以及以后别的确认动作走这里。
 *
 * 发射即忘——反馈拿不到不该影响按钮本身，所以失败的 promise 在这里就被吃掉。 */
export function hapticFeedback(kind: HapticKind = 'medium'): void {
  if (!hasMotor()) return;
  void invokeCommand('haptic_feedback', { kind }, VoidResponseSchema).catch(() => {});
}
