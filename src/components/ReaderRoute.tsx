import { usePageActive } from '../app/RetainedPage';
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { ArrowLeft, RotateCcw } from 'lucide-react';

import { NativeLibraryRepository } from '../repositories/nativeLibraryRepository';
import { ReaderScreen } from './ReaderScreen';
import { LoadingIndicator } from './LoadingIndicator';
import { getPrefetchPages, type ReaderLayoutPreference, type ReadingDirection } from '../domain/reader';
import { pickServer } from '../domain/server';
import { dlssnrTransform, getNativeImageCache, remoteTransform, type DlssnrSource } from '../lib/nativeImageCache';
import { checkDlssnrAvailability } from '../lib/dlssnrGate';
import { useToast } from './Toast';
import { usePreferences } from '../app/preferences';
import { parseRemoteOps } from '../repositories/nativeComputeCenterRepository';
import { parseDlssnrPasses, serializeDlssnrPasses } from '../repositories/nativeDlssnrRepository';
import type { ImageHandle } from '../lib/unifiedImageCache';
import { useReturnNavigation } from '../lib/useReturnNavigation';

const repository = new NativeLibraryRepository();
const imageCache = getNativeImageCache();

interface ReaderContext {
  generation: number;
  serverId: string;
  scopeId: string;
  archiveId: string;
  paths: string[];
}

/** How much of the session's enhanced output stays in memory.
 *
 * Derived renditions used to be dropped as soon as their page left the reader's
 * window — and because the page had already had its attempt, it came back
 * *un*-enhanced and stayed that way for the rest of the sitting. They are held
 * for the whole session now, under a budget: the shared image cache only evicts
 * entries nobody holds a reference to, so holding everything would pin every
 * upscaled page in memory and push the cache past its own limit. */
const DERIVED_SESSION_BUDGET_BYTES = 64 * 1024 * 1024;

export function ReaderRoute({ archiveId }: { archiveId: string }) {
  const pageActive = usePageActive();
  const pageActiveRef = useRef(pageActive);
  pageActiveRef.current = pageActive;
  const [searchParams] = useSearchParams();
  const goBack = useReturnNavigation();
  const { showToast } = useToast();
  const { preferences, save } = usePreferences();
  /** DLSSNR 与远端处理要先检查本机能力或配对信息。
   *
   * 但「设置里开了」只是一句**持久化**的意图：它可能来自另一台机器、或者那个 DLL
   * 已经被换掉。本地超分/去码的模型在不在问得出来，DLSSNR 能不能跑要问原生（见下）。 */
  const [dlssnrReady, setDlssnrReady] = useState(false);
  const dlssnrRequested = preferences.dlssnrEnabled;
  const preferencesRef = useRef(preferences);
  preferencesRef.current = preferences;
  /** 已经就「这台机器跑不了 DLSSNR」说过一次的那句话：同一条理由只说一遍，不然每翻
   * 一页都弹一次。 */
  const dlssnrNoticeRef = useRef<string>();
  useEffect(() => {
    if (!dlssnrRequested) {
      setDlssnrReady(false);
      dlssnrNoticeRef.current = undefined;
      return;
    }
    let cancelled = false;
    void checkDlssnrAvailability(true).then((availability) => {
      if (cancelled) return;
      setDlssnrReady(availability.ready);
      if (availability.ready) {
        dlssnrNoticeRef.current = undefined;
        return;
      }
      const reason = availability.reason ?? '这台机器现在跑不了 DLSSNR';
      if (dlssnrNoticeRef.current === reason) return;
      dlssnrNoticeRef.current = reason;
      if (!availability.disable) {
        // 问不到现状：这一次不排队，也不动那个开关——它在别的设备上可能是有效的，
        // 而偏好是同步的。
        showToast(`DLSSNR 这一步这次跳过：${reason}`, 'error');
        return;
      }
      showToast(`DLSSNR 不可用：${reason}。已自动关闭，可在设置页重新配置后再打开。`, 'error');
      // 写回偏好：留在 true 的话每次进阅读器都要重问一遍，而且开关看着是开的。
      const current = preferencesRef.current;
      void save({ ...current, dlssnrEnabled: false });
    });
    return () => { cancelled = true; };
  }, [dlssnrRequested, save, showToast]);
  const [dlssnrWanted, setDlssnrWanted] = useState(false);
  const dlssnrConfigured = dlssnrRequested && dlssnrReady && dlssnrWanted;
  const remoteOps = useMemo(
    () => parseRemoteOps(preferences.remoteComputeOps),
    [preferences.remoteComputeOps],
  );
  const remoteConfigured = remoteOps.enabled
    && !preferences.computeCenterEnabled
    && remoteOps.pairedDevices.some((device) => device.address === preferences.remoteComputeUrl && device.token === preferences.remoteComputeToken)
    && preferences.remoteComputeUrl.trim() !== ''
    && preferences.remoteComputeToken.trim() !== '';
  // 队列回调只依赖稳定值，设置改了就靠这两个 ref 取最新的一份（改设置本身会让
  // derived 重新排队，见下面的 enhancementToken）。
  const dlssnrPassesRef = useRef(preferences.dlssnrPasses);
  dlssnrPassesRef.current = preferences.dlssnrPasses;
  const remoteOpsRef = useRef(remoteOps);
  remoteOpsRef.current = remoteOps;
  const prefetchDistance = preferences.prefetchPages;
  // A backend with no model runs the nearest-neighbour fallback, which returns
  // the same pixels at four times the bytes — strictly worse than the plain
  // page. Upscaling therefore needs a model, not just a backend.
  const upscaleConfigured = preferences.upscaleBackend !== 'off' && preferences.upscaleModel !== '';
  // Settings grant availability; every reading session starts with original images.
  const decensorConfigured = preferences.decensorModel !== '';
  /** Per-session overrides for the two enhancements, driven from the reader's own
   * toolbar. Settings decide whether a model exists; these decide whether this
   * sitting uses it, which is the only way to see what either one does to the
   * page in front of you. */
  const [upscaleWanted, setUpscaleWanted] = useState(false);
  const [decensorWanted, setDecensorWanted] = useState(false);
  /** Whether the user has already chosen this sitting's upscale state. Once
   * they touch the toggle, the auto-enable must not flip it back behind them
   * when the metadata (size) arrives later. */
  const upscaleChosenRef = useRef(false);
  useLayoutEffect(() => {
    setUpscaleWanted(false);
    setDecensorWanted(false);
    setDlssnrWanted(false);
    upscaleChosenRef.current = false;
  }, [archiveId]);
  useEffect(() => { if (!upscaleConfigured) setUpscaleWanted(false); }, [upscaleConfigured]);
  useEffect(() => { if (!decensorConfigured) setDecensorWanted(false); }, [decensorConfigured]);
  useEffect(() => { if (!dlssnrRequested) setDlssnrWanted(false); }, [dlssnrRequested]);
  const upscaleEnabled = upscaleConfigured && upscaleWanted;
  const decensorEnabled = decensorConfigured && decensorWanted;
  /** 处理中那枚小胶囊写什么：正在跑哪一档就说哪一档。远端/DLSSNR 在链路上另算一步，
   * 它失败时本机那一版会顶上（见下面的降级），所以这里说的是「正在算」而不是
   * 「一定会变」。 */
  const [derivingStage, setDerivingStage] = useState<'decensor' | 'upscale' | 'dlssnr' | 'remote'>();
  const derivingLabel = derivingStage === 'decensor' ? '去码处理中…'
    : derivingStage === 'upscale' ? '超分处理中…'
      : derivingStage === 'dlssnr' ? 'DLSSNR 处理中…'
        : derivingStage === 'remote' ? '远端处理中…' : '处理中…';
  /** Bumped whenever a switch flips, so the reader drops the renditions it is
   * holding instead of showing the previous answer until the next page turn. */
  const [enhancementToken, setEnhancementToken] = useState(0);
  // The page param is absent only when the key itself is missing: `?page=0`
  // is an explicit request for the first page (from the detail page's
  // thumbnail grid), not "no page requested".
  const pageParam = searchParams.get('page');
  const requestedPage = pageParam === null
    ? undefined
    : Math.max(0, Number(pageParam) || 0);
  /** Which server this reader session is bound to: an explicit `?server=` id
   * from the linking card wins over the default (first configured) server. */
  const serverParam = searchParams.get('server');
  /** Incognito reading: no progress, no history. The reader shows a marker so it
   * is obvious the session is not being recorded. */
  const incognito = searchParams.get('incognito') === '1';
  const [scopeId, setScopeId] = useState<string>();
  const [initialPage, setInitialPage] = useState(0);
  /** Reading mode and direction for this archive: its own record if it has one,
   * otherwise the global preference. Both were previously ignored — the reader
   * always started on `auto`/`ltr`, which made the two settings do nothing. */
  const [readingLayout, setReadingLayout] = useState<ReaderLayoutPreference>('auto');
  const [readingDirection, setReadingDirection] = useState<ReadingDirection>('ltr');
  const [title, setTitle] = useState('阅读器');
  const [pages, setPages] = useState<string[]>([]);
  const [error, setError] = useState<string>();
  const [retryToken, setRetryToken] = useState(0);
  /** Cover, tags and byte size for the overview panel. Fetched once alongside
   * the manifest; the panel is the only consumer. */
  const [info, setInfo] = useState<{ cover?: string | undefined; tags?: string[] | undefined; sizeBytes?: number | undefined }>();
  // Readoshi's auto rule: an archive whose pages average at or above the
  // threshold starts this sitting already upscaled — small covers gain nothing
  // from upscaling, dense pages do. The size loads with the optional overview
  // facts, so this runs whenever that lands, and only before a manual choice.
  useEffect(() => {
    if (!upscaleConfigured || !preferences.upscaleAutoEnable || upscaleChosenRef.current) return;
    const sizeBytes = info?.sizeBytes ?? 0;
    if (!sizeBytes || pages.length === 0) return;
    if (sizeBytes / pages.length >= preferences.upscaleAutoThresholdBytes) setUpscaleWanted(true);
  }, [upscaleConfigured, preferences.upscaleAutoEnable, preferences.upscaleAutoThresholdBytes, info?.sizeBytes, pages.length]);
  const coverHandleRef = useRef<ImageHandle>();
  const contextRef = useRef<ReaderContext>();
  const pageHandlesRef = useRef(new Map<number, ImageHandle>());
  const thumbnailHandlesRef = useRef(new Map<number, ImageHandle>());
  const pendingPagesRef = useRef(new Map<number, Promise<string | undefined>>());
  const derivedHandlesRef = useRef(new Map<number, ImageHandle>());
  const retiredDerivedRef = useRef(new Map<number, ImageHandle[]>());
  const derivedAttemptedRef = useRef(new Set<number>());
  const visiblePagesRef = useRef<ReadonlySet<number>>(new Set());
  /** 这一页最终由谁来算：远端的桌面端 > 本机 DLSSNR > 本机超分/去码。三者是同一
   * 件事的三种做法，不叠着跑（叠起来一页要过三个模型，而它们的产物都只是中间
   * 结果）；本地超分/去码是前两者的输入。 */
  const derivedQueueRef = useRef<Array<{ pageIndex: number; generation: number; decensorModel: string; upscaleModel: string; engine: 'remote' | 'dlssnr' | 'local'; prefetch: boolean }>>([]);
  const derivedGenerationRef = useRef(0);
  const derivedBusyRef = useRef(false);
  /** 每页一次任务的取消牌（正在跑或正在排队的那一个）。切页、换开关、离开阅读器时
   * 全部 abort——前端 abort 会顺着 `taskId` 叫停原生那侧的循环（见 nativeImageCache）。 */
  const derivedAbortsRef = useRef(new Map<number, AbortController>());
  /** 任务号的来源：同一页重跑（换模型、改层参数）必须是新的号，否则旧任务的取消会
   * 误伤新任务。 */
  const derivedTaskSeqRef = useRef(0);
  /** 已经说过一次的「某一档没跑成」：按阶段 + 模型去重。 */
  const censoredFailureRef = useRef(new Set<string>());
  const upscaleFailureRef = useRef(new Set<string>());
  const dlssnrFailureRef = useRef(new Set<string>());
  const generationRef = useRef(0);
  const mountedRef = useRef(true);

  /** The reader's eviction of a page that has left its window.
   *
   * Only the plain page goes: the derived rendition is kept for the session, so
   * stepping back over a spread shows the enhanced page at once instead of
   * running the model again. */
  const releasePage = useCallback((pageIndex: number) => {
    const handle = pageHandlesRef.current.get(pageIndex);
    pageHandlesRef.current.delete(pageIndex);
    if (handle) imageCache.release(handle);
  }, []);

  /** Hold a finished derived rendition for the session, dropping the oldest once
   * the session is over its budget.
   *
   * The same page can gain a *better* rendition while the session runs — with both
   * enhancements on, the de-censored page arrives first and the enlarged one
   * replaces it a few seconds later — so this is also the place that swaps one in.
   * The order inside matters: the new handle is registered and rendered first, and
   * the old one is released after that. The other way round the page would point at
   * a revoked URL for however long the two updates are apart.
   *
   * `derivedBytesRef` is carried incrementally rather than recomputed: the old
   * version walked the whole map on every insert, and with a session holding
   * dozens of pages that is exactly the O(n²) work the reader does not need. The
   * map's insertion order *is* the LRU order — a page that gains a new rendition
   * moves to the end. */
  const derivedBytesRef = useRef(0);
  const retainDerived = useCallback((pageIndex: number, handle: ImageHandle) => {
    const held = derivedHandlesRef.current;
    const existing = held.get(pageIndex);
    // 已经是这一版了：不动。第二次落到同一个句柄只可能是「先给去码结果、超分那一步
    // 再失败，留下的就是它」——这时候既不该换，也不该把它释放掉。
    if (existing === handle) return;
    if (existing) {
      held.delete(pageIndex);
      derivedBytesRef.current -= existing.bytes;
    }
    held.set(pageIndex, handle);
    derivedBytesRef.current += handle.bytes;
    const dropped: number[] = [];
    while (derivedBytesRef.current > DERIVED_SESSION_BUDGET_BYTES && held.size > 1) {
      const oldest = [...held.keys()].find((index) => !visiblePagesRef.current.has(index));
      if (oldest === undefined) break;
      const evicted = held.get(oldest);
      held.delete(oldest);
      if (!evicted) break;
      derivedBytesRef.current -= evicted.bytes;
      imageCache.release(evicted);
      const retired = retiredDerivedRef.current.get(oldest);
      if (retired) {
        retiredDerivedRef.current.delete(oldest);
        for (const handle of retired) imageCache.release(handle);
      }
      // Its attempt is un-spent again, or a page whose result was dropped for
      // room would never be enhanced a second time.
      derivedAttemptedRef.current.delete(oldest);
      dropped.push(oldest);
    }
    setDerivedPages((current) => {
      const next = new Map(current).set(pageIndex, handle.url);
      for (const index of dropped) next.delete(index);
      return next;
    });
    // The image component decodes the new URL before swapping its src. Keep the
    // previous URL alive until that swap has actually loaded in the DOM.
    if (existing) {
      const retired = retiredDerivedRef.current.get(pageIndex) ?? [];
      retired.push(existing);
      retiredDerivedRef.current.set(pageIndex, retired);
    }
  }, []);

  const releaseDisplayedPredecessors = useCallback((pageIndex: number, url: string) => {
    const current = derivedHandlesRef.current.get(pageIndex);
    const retired = retiredDerivedRef.current.get(pageIndex);
    if (!retired) return;
    if (current ? current.url !== url : retired.some((handle) => handle.url === url)) return;
    retiredDerivedRef.current.delete(pageIndex);
    for (const handle of retired) imageCache.release(handle);
  }, []);

  const releaseAllPages = useCallback(() => {
    for (const handle of pageHandlesRef.current.values()) imageCache.release(handle);
    pageHandlesRef.current.clear();
    // 离开阅读器时把正在跑的原生推理也掐掉：那一件重活占着全局闸，而用户已经在别处了。
    for (const controller of derivedAbortsRef.current.values()) controller.abort();
    derivedAbortsRef.current.clear();
    for (const handle of derivedHandlesRef.current.values()) imageCache.release(handle);
    derivedHandlesRef.current.clear();
    for (const retired of retiredDerivedRef.current.values()) {
      for (const handle of retired) imageCache.release(handle);
    }
    retiredDerivedRef.current.clear();
    derivedBytesRef.current = 0;
    derivedAttemptedRef.current.clear();
    derivedQueueRef.current = [];
    visiblePagesRef.current = new Set();
    derivedGenerationRef.current += 1;
    setDerivedPages((current) => current.size === 0 ? current : new Map());
    for (const handle of thumbnailHandlesRef.current.values()) imageCache.release(handle);
    thumbnailHandlesRef.current.clear();
    if (coverHandleRef.current) imageCache.release(coverHandleRef.current);
    coverHandleRef.current = undefined;
    pendingPagesRef.current.clear();
  }, []);

  // Small per-page rendition for the thumbnail panel; the reader-page rendition
  // would pull every page of the archive in at full size.
  const loadPageThumbnail = useCallback(async (pageIndex: number) => {
    const context = contextRef.current;
    if (!context || pageIndex < 0 || pageIndex >= context.paths.length) return undefined;
    const existing = thumbnailHandlesRef.current.get(pageIndex);
    if (existing) return existing.url;
    try {
      const handle = await imageCache.load({
        scopeId: context.scopeId,
        serverId: context.serverId,
        archiveId: context.archiveId,
        pageIndex,
        rendition: 'page-thumbnail',
      });
      if (!mountedRef.current || contextRef.current?.generation !== context.generation) {
        imageCache.release(handle);
        return undefined;
      }
      const occupied = thumbnailHandlesRef.current.get(pageIndex);
      if (occupied) {
        imageCache.release(handle);
        return occupied.url;
      }
      thumbnailHandlesRef.current.set(pageIndex, handle);
      return handle.url;
    } catch {
      return undefined;
    }
  }, []);

  const loadPage = useCallback(async (pageIndex: number, signal?: AbortSignal) => {
    const context = contextRef.current;
    const path = context?.paths[pageIndex];
    if (!context || !path || pageIndex < 0) return undefined;
    const existing = pageHandlesRef.current.get(pageIndex);
    if (existing) return existing.url;
    const pending = pendingPagesRef.current.get(pageIndex);
    if (pending) return pending;

    const promise = (async () => {
      const handle = await imageCache.load({
        scopeId: context.scopeId,
        serverId: context.serverId,
        archiveId: context.archiveId,
        pageIndex,
        rendition: 'reader-page',
        sourcePath: path,
      }, signal ? { signal } : {});
      const current = contextRef.current;
      if (!mountedRef.current || !current || current.generation !== context.generation || signal?.aborted) {
        imageCache.release(handle);
        return undefined;
      }
      const occupied = pageHandlesRef.current.get(pageIndex);
      if (occupied) {
        imageCache.release(handle);
        return occupied.url;
      }
      pageHandlesRef.current.set(pageIndex, handle);
      return handle.url;
    })().catch(() => undefined);
    pendingPagesRef.current.set(pageIndex, promise);
    void promise.then(() => {
      if (pendingPagesRef.current.get(pageIndex) === promise) pendingPagesRef.current.delete(pageIndex);
    }, () => {
      if (pendingPagesRef.current.get(pageIndex) === promise) pendingPagesRef.current.delete(pageIndex);
    });
    return promise;
  }, []);

  /** Derived renditions by page index, swapped in when they arrive.
   *
   * `loadPage` used to await these before resolving, so a page was not shown
   * until inference for it had finished — seconds per page, and one run for every
   * page of the prefetch window at once. That is what made the reader look frozen
   * with upscaling on. The plain page goes up immediately and the enhanced one
   * replaces it when it is ready; because that is a `src` swap on a slot whose
   * transform never changes, the zoom survives it.
   *
   * One at a time, and only for pages actually on screen: prefetched neighbours
   * are not worth an ONNX run each, and running several at once only made every
   * one of them slower. */
  const [derivedPages, setDerivedPages] = useState<ReadonlyMap<number, string>>(() => new Map());
  /** 正在处理（去码 / 超分）的页。一页在 CPU 上要好几秒，两样一起开近二十秒——
   * 手上没有别的信号，用户会以为按钮点了个寂寞。 */
  const [derivingPages, setDerivingPages] = useState<ReadonlySet<number>>(() => new Set());
  const markDeriving = useCallback((index: number, active: boolean) => {
    setDerivingPages((current) => {
      if (current.has(index) === active) return current;
      const next = new Set(current);
      if (active) next.add(index); else next.delete(index);
      return next;
    });
  }, []);

  const releaseDerived = useCallback(() => {
    derivedGenerationRef.current += 1;
    for (const controller of derivedAbortsRef.current.values()) controller.abort();
    derivedAbortsRef.current.clear();
    for (const [pageIndex, handle] of derivedHandlesRef.current) {
      if (visiblePagesRef.current.has(pageIndex)) {
        const retired = retiredDerivedRef.current.get(pageIndex) ?? [];
        retired.push(handle);
        retiredDerivedRef.current.set(pageIndex, retired);
      } else {
        imageCache.release(handle);
      }
    }
    derivedHandlesRef.current.clear();
    derivedBytesRef.current = 0;
    derivedAttemptedRef.current.clear();
    derivedQueueRef.current = [];
    // 设置换了就是新的一轮：上一轮说过的「某一档没跑成」不该让这一轮闭嘴。
    censoredFailureRef.current.clear();
    upscaleFailureRef.current.clear();
    dlssnrFailureRef.current.clear();
    setDerivingPages((current) => current.size === 0 ? current : new Set());
    setDerivingStage(undefined);
    setDerivedPages((current) => current.size === 0 ? current : new Map());
  }, []);

  /** 某一档失败了就说一次：对应用户明确打开的那个开关。
   *
   * 每档只报一次（按阶段 + 模型去重），不然每一页都会再弹一遍；失败细节仍在错误日志
   * 里（`nativeImageCache` 对阅读器那几版都记）。四开组合里「去码失败、超分成功」这类
   * 结果因此是**可见的降级**，不是静默换图。 */
  const noticeStageFailure = useCallback((stage: 'decensor' | 'upscale' | 'dlssnr', model: string, seen: Set<string>) => {
    const key = `${stage}:${model}`;
    if (seen.has(key)) return;
    seen.add(key);
    const label = stage === 'decensor' ? '去码' : stage === 'upscale' ? '超分' : 'DLSSNR';
    showToast(`${label}这一步没跑成，这一页显示的是可用的那一版（细节在错误日志里）。`, 'error');
  }, [showToast]);

  const runDerivedQueue = useCallback(async () => {
    if (derivedBusyRef.current) return;
    derivedBusyRef.current = true;
    try {
      while (derivedQueueRef.current.length > 0) {
        const job = derivedQueueRef.current.shift();
        if (!job) break;
        const { pageIndex } = job;
        const context = contextRef.current;
        if (!context || !mountedRef.current) break;
        derivedAttemptedRef.current.add(pageIndex);
        if (!await loadPage(pageIndex) || job.generation !== derivedGenerationRef.current) continue;
        // 从这一刻起页面上会压一枚「处理中」的小胶囊，失败与否都在 finally 里收掉。
        markDeriving(pageIndex, true);
        setDerivingStage(job.decensorModel ? 'decensor' : job.upscaleModel ? 'upscale' : job.engine === 'local' ? undefined : job.engine);
        // 一次任务一个取消牌：切页 / 换开关 / 离开阅读器时把它掐掉。原生那侧一次只
        // 允许一件重活，不掐的话用户要看的那一页排在旧任务后面。
        const taskBase = `${context.generation}:${job.generation}:${pageIndex}:${derivedTaskSeqRef.current += 1}`;
        const controller = new AbortController();
        derivedAbortsRef.current.set(pageIndex, controller);
        try {
          const identity = { scopeId: context.scopeId, serverId: context.serverId, archiveId: context.archiveId, pageIndex };
          /** 第一步：去码（双开时也单独跑，不再塞进超分那一次调用里）。
           *
           * 这两步是**先后两件事**，不是一件事：去码产物先上屏（几秒就能看到），
           * 超分再它之上换成最终那一版。以前去码被折进超分调用内部，于是「去码成功、
           * 超分失败」时前端手上什么都没有——页面上还是原图。 */
          const censored = job.decensorModel
            ? await imageCache.load(
              { ...identity, rendition: 'decensored', modelId: job.decensorModel, taskId: `${taskBase}:decensor` },
              { signal: controller.signal },
            ).catch(() => undefined)
            : undefined;
          // Abort is a lifecycle transition, not a failed processing stage. Do
          // not continue into fallback/notice handling after the controller has
          // been cancelled while the native request was in flight.
          if (controller.signal.aborted) {
            if (censored) imageCache.release(censored);
            continue;
          }
          if (censored && mountedRef.current && contextRef.current?.generation === context.generation && job.generation === derivedGenerationRef.current) {
            retainDerived(pageIndex, censored);
          }
          const stillCurrent = job.generation === derivedGenerationRef.current;
          // 第二步：超分。起点是上一步的产物；去码没跑成（或没开）就从原图放大——
          // 一次「只有超分」的降级，页面上会写明这一点（见下面的 notice）。
          if (stillCurrent && job.upscaleModel) setDerivingStage('upscale');
          const enhanced = stillCurrent && job.upscaleModel
            ? await imageCache.load({
              ...identity,
              rendition: 'enhanced',
              modelId: job.upscaleModel,
              ...(censored && job.decensorModel
                ? { decensorModelId: job.decensorModel, source: 'decensored' as const }
                : { source: 'reader-page' as const }),
              taskId: `${taskBase}:enhanced`,
            }, { signal: controller.signal }).catch(() => undefined)
            : undefined;
          if (controller.signal.aborted) {
            if (enhanced) imageCache.release(enhanced);
            continue;
          }
          // 优先级就是结果本身：超分 > 去码 > 原图。两条互不依赖，所以四种组合各有
          // 一版能显示的东西，不再有「两样都开着时什么都看不到」。
          const local = enhanced ?? censored;
          if (local && mountedRef.current && contextRef.current?.generation === context.generation && job.generation === derivedGenerationRef.current) {
            retainDerived(pageIndex, local);
          }
          if (job.decensorModel && !censored) {
            noticeStageFailure('decensor', job.decensorModel, censoredFailureRef.current);
          }
          if (job.upscaleModel && !enhanced) {
            noticeStageFailure('upscale', job.upscaleModel, upscaleFailureRef.current);
          }
          /** 远端 / DLSSNR 那一步的输入：本地做了什么就从那一步的产物接着做。 */
          const baseRendition: DlssnrSource = enhanced
            ? 'enhanced'
            : censored
              ? 'decensored'
              : 'reader-page';
          let derived = local;
          if (job.engine === 'dlssnr' || job.engine === 'remote') {
            setDerivingStage(job.engine);
            // 远端 / DLSSNR 是「这一页最终由谁画」里更高的一档，产物替代本地产物
            // （本地那一版只是它的输入，收掉）。
            const processed = await imageCache.load(job.engine === 'dlssnr'
              ? {
                ...identity,
                rendition: 'dlssnr',
                transform: dlssnrTransform(baseRendition, serializeDlssnrPasses(
                  parseDlssnrPasses(dlssnrPassesRef.current),
                )),
                // 起点是按「产出它的模型」存的：两个 id 一并送过去，原生那侧才算得出
                // 同一个 revision。
                ...(job.decensorModel ? { decensorModelId: job.decensorModel } : {}),
                ...(job.upscaleModel ? { modelId: job.upscaleModel } : {}),
                taskId: `${taskBase}:${job.engine}`,
              }
              : {
                ...identity,
                rendition: 'remote',
                transform: remoteTransform({
                  device: preferences.remoteComputeUrl,
                  source: baseRendition,
                  op: remoteOpsRef.current.op.op,
                  modelId: remoteOpsRef.current.op.modelId,
                  scale: remoteOpsRef.current.op.scale,
                  passes: JSON.stringify(remoteOpsRef.current.op.dlssnrPasses),
                }),
                ...(job.decensorModel ? { decensorModelId: job.decensorModel } : {}),
                ...(job.upscaleModel ? { modelId: job.upscaleModel } : {}),
                taskId: `${taskBase}:${job.engine}`,
              }, { signal: controller.signal }).catch(() => undefined);
            if (controller.signal.aborted) {
              if (processed) imageCache.release(processed);
              continue;
            }
            if (processed) {
              derived = processed;
            } else if (job.engine === 'dlssnr') {
              // DLSSNR 这一档失败时本地那一版顶上（没有本地版本就是原图），并且要说一
              // 次原因：不然用户看到的是「开着却没反应」。
              noticeStageFailure('dlssnr', 'dlssnr', dlssnrFailureRef.current);
            }
            // 不写「远端失败」的提示：远端地址与令牌的失败在错误日志里，而且那一档本
            // 来就是本机处理的可选替代（本机这一版已经画出来了）。
          }
          if (!derived) continue;
          if (!mountedRef.current || contextRef.current?.generation !== context.generation || job.generation !== derivedGenerationRef.current) {
            imageCache.release(derived);
            continue;
          }
          // 落到这里第二次只可能是「先把去码结果给用户看、再换成超分结果」那条渐进
          // 路径：`retainDerived` 会把这一页换到更好的那一版（同一版则什么都不做），
          // 而不是把更好的那一版丢掉。
          retainDerived(pageIndex, derived);
          // Yield between pages so navigation/input can be serviced promptly on
          // slower devices while the native inference worker continues.
          await new Promise<void>((resolve) => setTimeout(resolve, 0));
        } finally {
          if (controller.signal.aborted) derivedAttemptedRef.current.delete(pageIndex);
          derivedAbortsRef.current.delete(pageIndex);
          markDeriving(pageIndex, false);
          setDerivingStage(undefined);
        }
      }
    } finally {
      derivedBusyRef.current = false;
    }
  }, [loadPage, retainDerived, markDeriving, noticeStageFailure]);

  useEffect(() => { if (pageActive) void runDerivedQueue(); }, [pageActive, runDerivedQueue]);

  /** Called by the reader with the pages actually on screen. */
  const requestDerived = useCallback((indexes: readonly number[]) => {
    visiblePagesRef.current = new Set(indexes);
    if (!decensorEnabled && !upscaleEnabled && !dlssnrConfigured && !remoteConfigured) return;
    const engine: 'remote' | 'dlssnr' | 'local' = remoteConfigured
      ? 'remote'
      : dlssnrConfigured
        ? 'dlssnr'
        : 'local';
    let queued = false;
    const context = contextRef.current;
    // DLSSNR gets one look-ahead page after the visible work. Never fill the
    // entire image prefetch window with GPU jobs.
    const lookahead = dlssnrConfigured && !remoteConfigured && context
      ? Math.max(...indexes, -1) + 1
      : -1;
    const wanted = [...indexes, ...(lookahead >= 0 && context && lookahead < context.paths.length ? [lookahead] : [])];
    derivedQueueRef.current = derivedQueueRef.current.filter((job) => wanted.includes(job.pageIndex));
    for (const [index, controller] of derivedAbortsRef.current) {
      if (!wanted.includes(index)) controller.abort();
    }
    for (const index of wanted) {
      if (derivedAttemptedRef.current.has(index) || derivedQueueRef.current.some((job) => job.pageIndex === index)) continue;
      derivedQueueRef.current.push({
        pageIndex: index,
        generation: derivedGenerationRef.current,
        decensorModel: decensorEnabled ? preferences.decensorModel : '',
        upscaleModel: upscaleEnabled ? preferences.upscaleModel : '',
        engine,
        prefetch: !indexes.includes(index),
      });
      queued = true;
    }
    derivedQueueRef.current.sort((a, b) => Number(a.prefetch) - Number(b.prefetch));
    if (queued) void runDerivedQueue();
  }, [decensorEnabled, dlssnrConfigured, preferences.decensorModel, preferences.upscaleModel, remoteConfigured, runDerivedQueue, upscaleEnabled]);

  // A switch above the canvas changed what the derived renditions would be, so
  // everything held under the old answer is dropped and re-requested.
  useLayoutEffect(() => {
    releaseDerived();
  }, [
    decensorEnabled,
    dlssnrConfigured,
    enhancementToken,
    preferences.decensorModel,
    preferences.dlssnrPasses,
    preferences.upscaleModel,
    releaseDerived,
    remoteConfigured,
    remoteOps,
    upscaleEnabled,
  ]);

  useEffect(() => {
    mountedRef.current = true;
    const generation = generationRef.current + 1;
    generationRef.current = generation;
    const controller = new AbortController();
    contextRef.current = undefined;
    releaseAllPages();
    setScopeId(undefined);
    setPages([]);
    setError(undefined);

    void (async () => {
      const servers = await repository.listServers();
      if (!mountedRef.current || !servers.ok || !servers.value.length) {
        if (mountedRef.current) setError(servers.ok ? '尚未配置服务器' : servers.error.message);
        return;
      }
      const server = pickServer(servers.value, serverParam);
      if (!server) {
        if (mountedRef.current) setError('尚未配置服务器');
        return;
      }
      const manifest = await repository.loadReaderManifest(server.id, archiveId);
      if (!mountedRef.current || !manifest.ok) {
        if (mountedRef.current && !manifest.ok) setError(manifest.error.message);
        return;
      }
      const context: ReaderContext = {
        generation,
        serverId: server.id,
        scopeId: server.scopeId,
        archiveId,
        paths: manifest.value.pages,
      };
      contextRef.current = context;
      setScopeId(server.scopeId);
      setTitle(manifest.value.title);
      // Overview facts load in the background: the panel is optional chrome, so
      // it must not delay the first page.
      void repository.loadArchiveMetadata(server.id, archiveId).then((metadata) => {
        if (!mountedRef.current || contextRef.current !== context || !metadata.ok) return;
        setInfo((current) => ({
          ...current,
          tags: metadata.value.tags ? metadata.value.tags.split(',').map((tag) => tag.trim()).filter(Boolean) : [],
          sizeBytes: metadata.value.size,
        }));
      });
      void imageCache.load({ scopeId: server.scopeId, serverId: server.id, archiveId, rendition: 'cover', pageIndex: 0 })
        .then((handle) => {
          if (!mountedRef.current || contextRef.current !== context) {
            imageCache.release(handle);
            return;
          }
          coverHandleRef.current = handle;
          setInfo((current) => ({ ...current, cover: handle.url }));
        })
        .catch(() => undefined);
      const progress = await repository.loadProgress(server.scopeId, archiveId);
      if (!mountedRef.current || contextRef.current !== context) return;
      const firstPage = requestedPage !== undefined
        ? Math.min(requestedPage, Math.max(0, manifest.value.pages.length - 1))
        : progress.ok && progress.value
        ? Math.min(progress.value.pageIndex, Math.max(0, manifest.value.pages.length - 1))
        : 0;
      setInitialPage(firstPage);
      // Reading mode and direction: the archive's own record wins over the global
      // default, because it is the more specific answer. The stored layout only
      // distinguishes paged from continuous — whether paged meant single, double
      // or auto was never recorded, so that part comes from the preference.
      const stored = progress.ok ? progress.value : null;
      setReadingLayout(stored?.layout === 'continuous' ? 'webtoon' : preferences.defaultLayout);
      setReadingDirection(stored?.direction ?? preferences.defaultDirection);
      const indices = [firstPage, ...getPrefetchPages(firstPage, manifest.value.pages.length, prefetchDistance)];
      const loaded = await Promise.all(indices.map(async (index) => [index, await loadPage(index, controller.signal)] as const));
      if (!mountedRef.current || contextRef.current !== context) return;
      // Only the page the reader opens on is required. A failed neighbour
      // prefetch must not block reading a page that loaded fine.
      if (!loaded.find(([index]) => index === firstPage)?.[1]) {
        setError('阅读页面加载失败');
        return;
      }
      const pageSources = Array<string>(manifest.value.pages.length).fill('');
      for (const [index, source] of loaded) if (source) pageSources[index] = source;
      setPages(pageSources);
    })();

    return () => {
      mountedRef.current = false;
      controller.abort();
      if (contextRef.current?.generation === generation) contextRef.current = undefined;
      releaseAllPages();
    };
  }, [archiveId, loadPage, prefetchDistance, preferences.defaultDirection, preferences.defaultLayout, releaseAllPages, requestedPage, serverParam, retryToken]);

  // Reader failures used to render as inline text only, on a shell-free route
  // with no way out. Surface them through the shared toast as well.
  useEffect(() => {
    if (error) showToast(error, 'error');
  }, [error, showToast]);

  if (error) {
    // The canvas holds the message and a retry icon, and leaving
    // is the top bar's job rather than a second competing button.
    return (
      <main className="reader-screen reader-screen-error">
        <header className="reader-error-bar">
          <button className="reader-icon-button" type="button" onClick={goBack} aria-label="返回上一页"><ArrowLeft aria-hidden="true" /></button>
          <strong>{title}</strong>
        </header>
        <section className="reader-error">
          <p role="alert">{error}</p>
          <button type="button" className="reader-retry-button" aria-label="重试加载" onClick={() => setRetryToken((value) => value + 1)}>
            <RotateCcw aria-hidden="true" />
          </button>
        </section>
      </main>
    );
  }
  // Not just a placeholder: clearing `pages` above when `archiveId` changes routes
  // through here, which unmounts ReaderScreen and is what stops one archive's page
  // index, zoom and per-index page shapes from carrying into the next. React
  // Router reuses this element across param changes, so nothing else would.
  if (pages.length === 0) return <main className="reader-screen reader-screen-loading"><LoadingIndicator label="正在加载页面" size="lg" /></main>;
  return (
    <ReaderScreen
      archiveId={archiveId}
      title={title}
      pages={pages}
      initialPage={initialPage}
      layout={readingLayout}
      direction={readingDirection}
      loadPage={loadPage}
      loadPageThumbnail={loadPageThumbnail}
      prefetchDistance={prefetchDistance}
      releasePage={releasePage}
      info={info}
      upscale={{
        configured: upscaleConfigured,
        active: upscaleEnabled,
        toggle: () => { upscaleChosenRef.current = true; setUpscaleWanted((value) => !value); setEnhancementToken((value) => value + 1); },
      }}
      decensor={{
        configured: decensorConfigured,
        active: decensorEnabled,
        toggle: () => { setDecensorWanted((value) => !value); setEnhancementToken((value) => value + 1); },
      }}
      dlssnr={{
        configured: dlssnrRequested && dlssnrReady,
        active: dlssnrConfigured,
        toggle: () => setDlssnrWanted((value) => !value),
      }}
      derivedPages={derivedPages}
      derivingPages={derivingPages}
      derivingLabel={derivingLabel}
      onVisiblePages={requestDerived}
      onDerivedDisplayed={releaseDisplayedPredecessors}
      onProgress={(pageIndex, reading) => {
        if (!scopeId || incognito) return;
        void repository.saveProgress({
          scopeId,
          archiveId,
          pageIndex,
          pageCount: pages.length,
          layout: reading.layout === 'webtoon' ? 'continuous' : 'paged',
          direction: reading.direction,
        });
      }}
      incognito={incognito}
    />
  );
}
