/** Account credentials can change without the ID changing. Shared account
 * presentations use this revision instead of treating IDs as login lifetimes. */
let revision = 0;
const listeners = new Set<() => void>();

export function ehAccountRevision(): number { return revision; }

export function notifyEhAccountsChanged(): void {
  revision += 1;
  for (const listener of listeners) listener();
}

export function subscribeEhAccountsChanged(listener: () => void): () => void {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}
