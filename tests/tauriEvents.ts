/** jsdom 里的 Tauri 事件总线。
 *
 * `@tauri-apps/api/event` 的 `listen` 要走 `__TAURI_INTERNALS__`，jsdom 里没有，
 * 于是它直接 reject（应用里那句 `.catch(() => {})` 正好把它咽掉）——结果是**所有由
 * 事件驱动的 UI 在测试里都到不了**：模型下载进度就是一条（进度事件到了才有定量条）。
 *
 * 这里放一个内存里的最小实现，`tests/setup.ts` 把 `@tauri-apps/api/event` 换掉。
 * 测试里用 `emitTauriEvent('model-download-progress', { ... })` 发一条，和真实后端的
 * 载荷形状一致（`{ event, id, payload }`）。
 */
type TauriEventHandler = (event: { event: string; id: number; payload: unknown }) => void;

const listeners = new Map<string, Set<TauriEventHandler>>();

export function registerTauriListener(name: string, handler: TauriEventHandler): () => void {
  const set = listeners.get(name) ?? new Set<TauriEventHandler>();
  set.add(handler);
  listeners.set(name, set);
  return () => { set.delete(handler); };
}

export function emitTauriEvent(name: string, payload: unknown): void {
  for (const handler of [...(listeners.get(name) ?? [])]) handler({ event: name, id: 0, payload });
}

/** 每个测试之间不留监听器：组件卸载时本来会注销，但断言失败的用例会跳过那一步。 */
export function resetTauriEvents(): void {
  listeners.clear();
}
