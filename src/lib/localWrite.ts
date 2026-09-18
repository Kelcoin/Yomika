/** 「刚写了本地数据」的信号。
 *
 * 仓库层写完只管喊一声，谁需要谁订阅（自动同步就靠它把一串写入合并成一次推送）。
 * 反过来让仓库直接 import 同步调度器会绕成环——调度器本来就要读仓库。
 */
const listeners = new Set<() => void>();

export function notifyLocalWrite(): void {
  for (const listener of listeners) listener();
}

export function onLocalWrite(listener: () => void): () => void {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}

export function resetLocalWriteForTests(): void {
  listeners.clear();
}
