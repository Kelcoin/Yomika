import { invokeCommand, VoidResponseSchema } from '../bridge/invoke';
import { isMobileDevice } from './layoutMode';

/** 触感档位。原生侧把这几档映射到系统预置的振动效果。 */
export type HapticKind = 'light' | 'medium' | 'heavy' | 'selection';

/** 一次触感反馈：长按「按住了」、以及以后别的确认动作走这里。
 *
 * 发射即忘——反馈拿不到不该影响按钮本身，所以失败的 promise 在这里就被吃掉。 */
export function hapticFeedback(kind: HapticKind = 'medium'): void {
  if (typeof navigator === 'undefined' || !isMobileDevice()) return;
  void invokeCommand('haptic_feedback', { kind }, VoidResponseSchema).catch(() => {});
}
