import { useEffect, useState } from 'react';

import {
  clearTagTranslations,
  installTagTranslations,
  normalizeTranslationDb,
  subscribeTagTranslations,
  type TranslationMap,
} from './tags';

export const TAG_TRANSLATION_DB_URL = 'https://fastly.jsdelivr.net/gh/EhTagTranslation/DatabaseReleases/db.html.json';
export const TAG_TRANSLATION_CACHE_KEY = 'yomika.ehtag.translation.v1';
export const TAG_TRANSLATION_UPDATE_INTERVAL_MS = 3 * 24 * 60 * 60 * 1_000;
export const TAG_TRANSLATION_REQUEST_TIMEOUT_MS = 10 * 60 * 1_000;

interface TranslationCache {
  schemaVersion: 1;
  sourceVersion: string;
  updatedAt: number;
  translations: TranslationMap;
}

interface TagTranslationServiceOptions {
  storage?: Pick<Storage, 'getItem' | 'setItem'>;
  fetcher?: typeof fetch;
  now?: () => number;
  retryDelays?: readonly number[];
  requestTimeoutMs?: number;
  setTimer?: typeof window.setTimeout;
  clearTimer?: typeof window.clearTimeout;
}

export interface TagTranslationService {
  initialize(): Promise<void>;
  refresh(): Promise<void>;
  start(): void;
  stop(): void;
  /** 功能开关（docs/30 设置项）：关闭时停更并卸载翻译，打开时从缓存秒级恢复。 */
  setEnabled(enabled: boolean): void;
  isEnabled(): boolean;
  getSourceVersion(): string | undefined;
  subscribe(listener: () => void): () => void;
}

function isTranslationMap(value: unknown): value is TranslationMap {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  return Object.values(value).every((namespace) => namespace
    && typeof namespace === 'object'
    && !Array.isArray(namespace)
    && Object.values(namespace).every((translation) => typeof translation === 'string'));
}

function readCache(storage: Pick<Storage, 'getItem'>): TranslationCache | undefined {
  try {
    const raw = storage.getItem(TAG_TRANSLATION_CACHE_KEY);
    if (!raw) return undefined;
    const value = JSON.parse(raw) as Partial<TranslationCache>;
    if (value.schemaVersion !== 1
      || typeof value.sourceVersion !== 'string'
      || typeof value.updatedAt !== 'number'
      || !Number.isFinite(value.updatedAt)
      || !isTranslationMap(value.translations)) return undefined;
    return value as TranslationCache;
  } catch {
    return undefined;
  }
}

function readSourceVersion(raw: unknown): string {
  const head = (raw as { head?: { committer?: { when?: unknown }; sha?: unknown } })?.head;
  if (typeof head?.committer?.when === 'string') return head.committer.when;
  if (typeof head?.sha === 'string') return head.sha;
  return '';
}

export function createTagTranslationService(options: TagTranslationServiceOptions = {}): TagTranslationService {
  const storage = options.storage ?? (() => {
    try {
      return window.localStorage;
    } catch {
      let memory: string | null = null;
      return {
        getItem: () => memory,
        setItem: (_key: string, value: string) => { memory = value; },
      };
    }
  })();
  const fetcher = options.fetcher ?? window.fetch.bind(window);
  let enabled = true;
  const serviceListeners = new Set<() => void>();
  const notifyService = () => { for (const listener of [...serviceListeners]) listener(); };
  const now = options.now ?? Date.now;
  const retryDelays = options.retryDelays ?? [500, 1_500, 3_000, 5_000];
  const requestTimeoutMs = options.requestTimeoutMs ?? TAG_TRANSLATION_REQUEST_TIMEOUT_MS;
  const setTimer = options.setTimer ?? window.setTimeout.bind(window);
  const clearTimer = options.clearTimer ?? window.clearTimeout.bind(window);
  let cacheLoaded = false;
  let cache: TranslationCache | undefined;
  let inFlight: Promise<void> | undefined;
  let periodicTimer: number | undefined;
  let retryTimer: number | undefined;
  let requestTimeoutTimer: number | undefined;
  let requestController: AbortController | undefined;
  let cancelRetryDelay: (() => void) | undefined;
  let lastAttemptAt: number | undefined;
  let generation = 0;
  let active = false;

  const waitForRetry = (delay: number): Promise<void> => new Promise((resolve, reject) => {
    let settled = false;
    let localTimer: number | undefined;
    let cancel: () => void;
    const finish = (callback: () => void) => {
      if (settled) return;
      settled = true;
      if (retryTimer === localTimer) retryTimer = undefined;
      if (cancelRetryDelay === cancel) cancelRetryDelay = undefined;
      callback();
    };
    localTimer = setTimer(() => finish(resolve), delay);
    retryTimer = localTimer;
    cancel = () => finish(() => reject(new DOMException('Aborted', 'AbortError')));
    cancelRetryDelay = cancel;
  });

  const download = async (operationGeneration: number): Promise<TranslationCache> => {
    let lastError: unknown;
    for (const delay of [0, ...retryDelays]) {
      if (operationGeneration !== generation) throw new DOMException('Aborted', 'AbortError');
      if (delay > 0) await waitForRetry(delay);
      const controller = new AbortController();
      requestController = controller;
      const localTimeoutTimer = setTimer(() => controller.abort(), requestTimeoutMs);
      requestTimeoutTimer = localTimeoutTimer;
      try {
        const response = await fetcher(`${TAG_TRANSLATION_DB_URL}?_=${now()}`, {
          cache: 'no-store',
          signal: controller.signal,
        });
        if (!response.ok) throw new Error(`Tag translation download failed with HTTP ${response.status}`);
        const raw = await response.json() as unknown;
        const translations = normalizeTranslationDb(raw);
        if (Object.keys(translations).length === 0) throw new Error('Tag translation database is empty');
        return {
          schemaVersion: 1,
          sourceVersion: readSourceVersion(raw),
          updatedAt: now(),
          translations,
        };
      } catch (error) {
        lastError = error;
        if (operationGeneration !== generation) throw error;
      } finally {
        clearTimer(localTimeoutTimer);
        if (requestTimeoutTimer === localTimeoutTimer) requestTimeoutTimer = undefined;
        if (requestController === controller) requestController = undefined;
      }
    }
    throw lastError instanceof Error ? lastError : new Error('Tag translation download failed');
  };

  const refresh = (): Promise<void> => {
    if (inFlight) return inFlight;
    const operationGeneration = generation;
    const operation = download(operationGeneration)
      .then((next) => {
        if (operationGeneration !== generation) return;
        cache = next;
        try {
          storage.setItem(TAG_TRANSLATION_CACHE_KEY, JSON.stringify(next));
        } catch {
          // The downloaded database remains usable for this session.
        }
        installTagTranslations(next.translations);
        notifyService();
      })
      .catch(() => undefined)
      .finally(() => {
        if (operationGeneration === generation) lastAttemptAt = now();
        if (inFlight === operation) inFlight = undefined;
      });
    inFlight = operation;
    return operation;
  };

  const initialize = (): Promise<void> => {
    if (!cacheLoaded) {
      cacheLoaded = true;
      cache = readCache(storage);
      if (cache) installTagTranslations(cache.translations);
    }
    if (cache && now() - cache.updatedAt <= TAG_TRANSLATION_UPDATE_INTERVAL_MS) return Promise.resolve();
    return refresh();
  };

  const scheduleNextUpdate = () => {
    if (!active) return;
    if (periodicTimer !== undefined) clearTimer(periodicTimer);
    const baseline = Math.max(cache?.updatedAt ?? 0, lastAttemptAt ?? 0);
    const delay = baseline > 0
      ? Math.max(0, TAG_TRANSLATION_UPDATE_INTERVAL_MS - (now() - baseline))
      : TAG_TRANSLATION_UPDATE_INTERVAL_MS;
    periodicTimer = setTimer(async () => {
      periodicTimer = undefined;
      await refresh();
      scheduleNextUpdate();
    }, delay);
  };

  return {
    initialize,
    refresh,
    start() {
      if (!enabled) return;
      if (active) {
        scheduleNextUpdate();
        return;
      }
      active = true;
      void initialize().finally(scheduleNextUpdate);
    },
    stop() {
      active = false;
      generation += 1;
      if (periodicTimer !== undefined) clearTimer(periodicTimer);
      if (retryTimer !== undefined) clearTimer(retryTimer);
      if (requestTimeoutTimer !== undefined) clearTimer(requestTimeoutTimer);
      periodicTimer = undefined;
      retryTimer = undefined;
      requestTimeoutTimer = undefined;
      cancelRetryDelay?.();
      cancelRetryDelay = undefined;
      requestController?.abort();
      requestController = undefined;
      inFlight = undefined;
    },
    setEnabled(next: boolean) {
      if (enabled === next) return;
      enabled = next;
      if (next) {
        // 与 start() 同一套生命周期：从缓存恢复 + 按需刷新 + 排程。
        active = true;
        void initialize().finally(scheduleNextUpdate);
        return;
      }
      // 关闭：停更并卸载翻译（数据缓存保留，重新打开秒级恢复）。
      stop();
      clearTagTranslations();
      notifyService();
    },
    isEnabled: () => enabled,
    getSourceVersion: () => cache?.sourceVersion,
    subscribe(listener: () => void) {
      serviceListeners.add(listener);
      return () => serviceListeners.delete(listener);
    },
  };
}

const tagTranslationService = createTagTranslationService();

export const initializeTagTranslations = () => tagTranslationService.initialize();
export const refreshTagTranslations = () => tagTranslationService.refresh();
export const startTagTranslationUpdates = () => tagTranslationService.start();
export const stopTagTranslationUpdates = () => tagTranslationService.stop();
export const setTagTranslationServiceEnabled = (enabled: boolean) => tagTranslationService.setEnabled(enabled);
export const getTagTranslationSourceVersion = () => tagTranslationService.getSourceVersion();
export function subscribeTagTranslationService(listener: () => void): () => void {
  return tagTranslationService.subscribe(listener);
}

export function useTagTranslations(): number {
  const [revision, setRevision] = useState(0);
  useEffect(() => {
    return subscribeTagTranslations(() => setRevision((value) => value + 1));
  }, []);
  return revision;
}
