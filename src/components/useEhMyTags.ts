import { useEffect, useState } from 'react';

import {
  buildMyTagPresentation,
  isEhMyTagsPriorityEnabled,
  subscribeEhMyTagsPriority,
  type EhMyTagPresentation,
} from '../lib/ehMyTags';
import { NativeEhRepository } from '../repositories/nativeEhRepository';

const repository = new NativeEhRepository();

/** The active account's "My Tags" as a card/detail presentation, loaded at most
 * once per session and shared by every consumer (library rows, rail cards,
 * detail pages) through this module cache.
 *
 * The switch is applied imperatively through `setEhMyTagsPriorityEnabled`, so
 * turning the setting on starts the one fetch (and its one page read); turning
 * it off just empties every consumer's presentation. */
let cache: { accountId: string; presentation: EhMyTagPresentation } | undefined;
let inflight: Promise<void> | undefined;
const listeners = new Set<() => void>();

function notify(): void {
  for (const listener of listeners) listener();
}

async function loadPresentation(): Promise<void> {
  const accounts = await repository.listAccounts();
  if (!accounts.ok) return;
  const active = accounts.value.find((account) => account.isActive);
  if (!active) return;
  if (cache?.accountId === active.id) return;
  let stored = await repository.listMyTags(active.id);
  // A first run against a fresh install has nothing cached yet: one fetch
  // stores the site's list, then the same shape answers every consumer.
  if (stored.ok && stored.value.length === 0) {
    const fetched = await repository.fetchMyTags(active.id);
    if (fetched.ok) stored = { ok: true, value: fetched.value };
  }
  if (!stored.ok) return;
  cache = { accountId: active.id, presentation: buildMyTagPresentation(stored.value) };
  notify();
}

/** Watched mytags for every list and detail page. Consumers call the hook; the
 * fetch happens once and the module cache answers the rest. */
export function useEhMyTags(): EhMyTagPresentation {
  const [, setVersion] = useState(0);
  const presentation = cache?.presentation ?? { priority: [], colors: new Map() };
  useEffect(() => {
    const sync = () => setVersion((value) => value + 1);
    listeners.add(sync);
    // The flag lives in the lib module; the feature's own load listens there.
    const unsubscribeFlag = subscribeEhMyTagsPriority(() => {
      sync();
      if (isEhMyTagsPriorityEnabled() && !cache && !inflight) {
        inflight = loadPresentation().finally(() => { inflight = undefined; });
      }
    });
    if (isEhMyTagsPriorityEnabled() && !cache && !inflight) {
      inflight = loadPresentation().finally(() => { inflight = undefined; });
    }
    return () => {
      listeners.delete(sync);
      unsubscribeFlag();
    };
  }, []);
  return isEhMyTagsPriorityEnabled() ? presentation : { priority: [], colors: new Map() };
}
