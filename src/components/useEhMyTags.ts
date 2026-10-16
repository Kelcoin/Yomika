import { useEffect, useState } from 'react';

import {
  buildMyTagPresentation,
  isEhMyTagsPriorityEnabled,
  subscribeEhMyTagsPriority,
  type EhMyTagPresentation,
} from '../lib/ehMyTags';
import { NativeEhRepository } from '../repositories/nativeEhRepository';
import { ehAccountRevision, subscribeEhAccountsChanged } from '../lib/ehAccountChanges';

const repository = new NativeEhRepository();

/** The active account's "My Tags" as a card/detail presentation, loaded at most
 * once per account revision and shared by every consumer (library rows, rail cards,
 * detail pages) through this module cache.
 *
 * The switch is applied imperatively through `setEhMyTagsPriorityEnabled`, so
 * turning the setting on starts the one fetch (and its one page read); turning
 * it off just empties every consumer's presentation. */
const EMPTY_PRESENTATION: EhMyTagPresentation = { priority: [], colors: new Map() };
let cache: { revision: number; presentation: EhMyTagPresentation } | undefined;
let inflight: { revision: number; promise: Promise<void> } | undefined;
const listeners = new Set<() => void>();

function notify(): void {
  for (const listener of listeners) listener();
}

async function loadPresentation(revision: number): Promise<void> {
  const accounts = await repository.listAccounts();
  if (revision !== ehAccountRevision() || !accounts.ok) return;
  const active = accounts.value.find((account) => account.isActive);
  if (!active) {
    cache = { revision, presentation: EMPTY_PRESENTATION };
    notify();
    return;
  }
  let stored = await repository.listMyTags(active.id);
  if (revision !== ehAccountRevision()) return;
  // A first run against a fresh install has nothing cached yet: one fetch
  // stores the site's list, then the same shape answers every consumer.
  if (stored.ok && stored.value.length === 0) {
    const fetched = await repository.fetchMyTags(active.id);
    if (fetched.ok) stored = { ok: true, value: fetched.value };
  }
  if (revision !== ehAccountRevision() || !stored.ok) return;
  cache = { revision, presentation: buildMyTagPresentation(stored.value) };
  notify();
}

function ensureLoaded(): void {
  const revision = ehAccountRevision();
  if (!isEhMyTagsPriorityEnabled() || cache?.revision === revision || inflight?.revision === revision) return;
  const promise = loadPresentation(revision).finally(() => {
    if (inflight?.promise === promise) inflight = undefined;
  });
  inflight = { revision, promise };
}

/** Watched mytags for every list and detail page. Consumers call the hook; the
 * fetch happens once and the module cache answers the rest. */
export function useEhMyTags(): EhMyTagPresentation {
  const [, setVersion] = useState(0);
  const presentation = cache?.revision === ehAccountRevision() ? cache.presentation : EMPTY_PRESENTATION;
  useEffect(() => {
    const sync = () => setVersion((value) => value + 1);
    listeners.add(sync);
    // The flag lives in the lib module; the feature's own load listens there.
    const update = () => {
      sync();
      ensureLoaded();
    };
    const unsubscribeFlag = subscribeEhMyTagsPriority(update);
    const unsubscribeAccounts = subscribeEhAccountsChanged(update);
    update();
    return () => {
      listeners.delete(sync);
      unsubscribeFlag();
      unsubscribeAccounts();
    };
  }, []);
  return isEhMyTagsPriorityEnabled() ? presentation : EMPTY_PRESENTATION;
}
