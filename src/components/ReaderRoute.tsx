import { usePageActive } from '../app/RetainedPage';
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { useSearchParams } from 'react-router-dom';
import { ArrowLeft, RotateCcw } from 'lucide-react';
import { z } from 'zod';

import { NativeLibraryRepository } from '../repositories/nativeLibraryRepository';
import { NativeCacheRepository } from '../repositories/nativeCacheRepository';
import { getNativeComputeRepository } from '../repositories/nativeComputeRepository';
import { invokeCommand, VoidResponseSchema } from '../bridge/invoke';
import { ReaderScreen, useReaderChrome } from './ReaderScreen';
import { useWindowDrag } from './WindowControls';
import { LoadingIndicator } from './LoadingIndicator';
import { RETRYABLE_COMPUTE_ERROR_CODES } from '../domain/compute';
import { getPrefetchPages, pickDerivedEvictionVictim, sweepOrder, type ReaderLayoutPreference, type ReadingDirection } from '../domain/reader';
import { pickServer } from '../domain/server';
import { dlssnrTransform, getNativeImageCache, remoteTransform, renditionErrorCode, type DlssnrSource } from '../lib/nativeImageCache';
import { checkDlssnrAvailability } from '../lib/dlssnrGate';
import { logError } from '../lib/errorLog';
import { useToast } from './Toast';
import { usePreferences } from '../app/preferences';
import {
  NativeComputeCenterRepository,
  parseRemoteOps,
  remoteServiceReady,
  type RemoteCapabilities,
  type RemoteService,
} from '../repositories/nativeComputeCenterRepository';
import { parseDlssnrPasses, serializeDlssnrPasses } from '../repositories/nativeDlssnrRepository';
import { loadLocalRenditions, loadReaderComputedPage, READER_UPSCALE_STAGE_ID, type ReaderPageEngine, type ReaderPageFailure } from '../lib/readerComputedPage';
import type { ImageCacheIdentity } from '../domain/cache';
import { imageResidentBytes, type ImageHandle } from '../lib/unifiedImageCache';
import { useReturnNavigation } from '../lib/useReturnNavigation';
import { useMediaQuery } from '../lib/useMediaQuery';
import { COARSE_POINTER_QUERY } from '../lib/horizontalScroller';
import { shouldAutoEnableUpscale } from '../lib/autoUpscale';

const repository = new NativeLibraryRepository();
const imageCache = getNativeImageCache();
const computeRepository = getNativeComputeRepository();
const cacheRepository = new NativeCacheRepository();

/** 清掉这次阅读会话留在盘上的「成品」（超分 / DLSSNR 的产物）。
 *
 * 这些产物只在本次会话里有意义，可它们和封面、缩略图、原页躺在同一张 `cache_entries`
 * 里，走同一条配额 + LRU：真机上 2.84 GiB 的 DLSSNR 产物把 4 GiB 的配额吃到 90%，
 * LRU 只好去挤别人的封面。用户的口径是「进出阅读模式各清一次，彻底防残留」，所以不
 * 指望配额。封面、缩略图、原页**不动**——它们下一趟还要用，也不是这一趟算出来的。
 *
 * 必须带上是哪一本：两本阅读器可以同时挂在保留里（`MAX_RETAINED_READERS = 2`），
 * 不带范围会把另一本还在读的产物一起删掉。`scopeId` 要等清单到手才有，所以还没拿到时
 * 直接返回——effect 会随着 `scopeId` 落定再跑一次。
 *
 * 失败不做事：`invokeCommand` 自己记错误日志，这里没有可补救的。 */
function purgeReaderProducts(
  scopeId: string | undefined,
  archiveId: string,
): Promise<unknown> | undefined {
  if (!scopeId) return undefined;
  return cacheRepository.purgeReaderRenditions(scopeId, archiveId);
}

/** 进入这一本时那次清理最多等多久。
 *
 * 派生队列必须等清理落地（理由见 `sessionPurged` 那个 effect），但清理本身不该有能力拦住
 * 阅读：超时就放行，只是这一次的窗口没关上——`created_at < CURRENT_TIMESTAMP` 那条条件还在
 * 兜同一秒里写下的行。 */
const PURGE_GATE_TIMEOUT_MS = 2_000;

/** 让 Rust 把「已经释放、但 Windows 还挂在进程工作集里」的那些页交还给系统。
 *
 * 增强一页的中转缓冲是几百 MB 级的（25MP 的放大输出就是 256MB），Rust 释放之后内核
 * 不一定马上从工作集里收回去，实测退出阅读器之后仍有 4GB 落不下来。所以只在
 * **用户离开这一本**的那一刻调（阅读器转后台、或它被卸载），缺页的代价落在没人看的
 * 时候。
 *
 * 绝不能每页都调：超分模型和 `nvngx_dlssnr.dll`（约 165MB）是常驻的，工作集一被
 * 清空它们也跟着走，下一页第一张图就要重新从磁盘读回这几百 MB——省的是任务管理器里
 * 的数字，赔的是翻页卡顿。 */
function trimProcessMemory(): void {
  // 失败也不做事：`invokeCommand` 自己记错误日志并返回 Result，这里没有可补救的。
  void invokeCommand('trim_process_memory', {}, VoidResponseSchema);
}

/** 让 Rust 把 DLSSNR 缓存的工作区交回给系统（只交纹理，不清工作集）。
 *
 * 工作区与它内部每个 NGX feature 的资源是按「层数 × 页面积」占**提交内存**的：
 * 实测一页 2731×4096 跑五层，进程提交内存从 45MB 涨到 9.5GB，交回之后立刻回到
 * 1.0GB 上下（`docs/69`）。它跟进程同寿、按可用资源保留，所以「没人再看图」的时候必须
 * 交回；代价只是下一页第一趟重建 feature（几十到几百毫秒）。
 *
 * 与 `trimProcessMemory` 分开：那条会顺手把 165MB 的 DLL 与 240MB 的 ONNX 一起扫出
 * 工作集，下一页第一张图要重新读盘，所以只留给「离开这一本」那一刻；这条只交回几个
 * GB 的纹理，整本预处理停下来一会儿之后也可以做。 */
function releaseDlssnrWorkspaces(): void {
  void invokeCommand('dlssnr_release_workspaces', {}, z.number().int().nonnegative());
  // ONNX sessions are also caches, not process-lifetime allocations.
  void invokeCommand('inference_release_sessions', {}, z.number().int().nonnegative());
}

/** 整本预处理停下来多久之后交回 DLSSNR 的工作区。
 *
 * 翻页是阵发的：连翻几页时每一页都会重排一次队列，只有真的停手了才值得交回。定成
 * 30 秒是因为重建 feature 是几十到几百毫秒（`src-tauri/src/dlssnr/workspace.rs` 顶部
 * 那组数字），宽限期给足就不会把「用户还在看」误判成「用户走了」。 */
const WORKSPACE_IDLE_RELEASE_MS = 30_000;

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

/** 字节预算之外再兜一个「至少留住几页」的下限，以及它的硬上限。
 *
 * `DERIVED_SESSION_BUDGET_BYTES` 是按一页 3–6MB 定的（见 docs/44），但 DLSSNR 三档
 * 设置下真实成品能到 20MB 以上：用户库里一个 501 页的档案留着 133 页、合计 2.9GB，
 * 单页 21–27MB。那样 64MB 只装得下两页——预扫是从当前位置往后由近到远灌进来的，可
 * 「下一页」永远落在预算之外、刚算完就被挤掉，用户翻过去还是要现读一遍，看起来就像
 * 整本预处理根本没生效。所以预算按「可见页 + 下面这几页」折算：正常体积的档案碰不到
 * 下限（字节预算先到），单页很大的档案才吃到它；硬上限保证那种档案也不撑爆会话。 */
const DERIVED_MIN_RESIDENT_PAGES = 4;
const DERIVED_SESSION_CEILING_BYTES = 256 * 1024 * 1024;

/** 一页派生结果的三档，顺序就是优先级。
 *
 * `visible` 是屏幕上那一页，`neighbour` 是预取窗口里的，`background` 是整本预处理
 * 顺手做的。用户看不见的那些页算得再快，也不该让正在看的那一页等一等——取件顺序
 * 见 `runDerivedQueue`。 */
type DerivedTier = 'visible' | 'neighbour' | 'background';
const DERIVED_TIER_ORDER: Record<DerivedTier, number> = { visible: 0, neighbour: 1, background: 2 };

/** 加载态 / 失败态那条顶栏的外壳：和阅读态那两条栏共用 `useReaderChrome`。
 *
 * 为什么要有这层外壳：这条顶栏原来是一块常显的条，而加载完成后那两条栏会自己藏
 * 起来——同一次进入阅读模式、同一块屏幕，前后却是两副样子。行为一致就不能有两份
 * 实现，所以指针落点判定、出场动画、4.5s 自动隐藏都走阅读器那套共享件。
 *
 * 这一支还没有 `ReaderState`，所以「有没有被唤出」就放在这里的 `useState` 里：共享件
 * 只吃一个布尔，不关心它从哪来。初值 `false`——进阅读模式的第一眼不该顶着一排控件。 */
function ReaderRouteChromeShell({ className, title, goBack, children }: { className: string; title: string; goBack: () => void; children: ReactNode }) {
  // 保留页在后台时不走表，和阅读态同一个理由。
  const pageActive = usePageActive();
  const coarsePointer = useMediaQuery(COARSE_POINTER_QUERY);
  const rootRef = useRef<HTMLElement>(null);
  const [chromeVisible, setChromeVisible] = useState(false);
  const { topPresence, hoverTarget, setHover, handleCanvasClick, keepAlive, clearHover } = useReaderChrome({
    rootRef,
    visible: chromeVisible,
    active: pageActive,
    onToggle: () => setChromeVisible((value) => !value),
    onHide: () => setChromeVisible(false),
  });
  // 这一屏同样整屏盖住了自绘标题栏，所以这条栏也自己会拖（用户报的那一条：加载慢
  // 或卡住时它是屏幕上唯一一条栏，而没有它就没法移动窗口）。
  const windowDrag = useWindowDrag();
  return (
    <main
      className={`reader-screen ${className}`}
      ref={rootRef}
      onClick={handleCanvasClick}
      // 与阅读态同一条判定：指针落进上/下感应带（或栏本身）才唤出，画面中部不动它。
      onMouseMove={(event) => { if (!coarsePointer) setHover(hoverTarget(event)); }}
      onMouseLeave={clearHover}
    >
      {topPresence.mounted && (
        <header className={`reader-error-bar${topPresence.leaving ? ' is-leaving' : ''}`} onClick={keepAlive} {...windowDrag}>
          <button className="reader-icon-button" type="button" onClick={goBack} aria-label="返回上一页"><ArrowLeft aria-hidden="true" /></button>
          <strong>{title}</strong>
        </header>
      )}
      {children}
    </main>
  );
}

export function ReaderRoute({ archiveId }: { archiveId: string }) {
  const pageActive = usePageActive();
  const pageActiveRef = useRef(pageActive);
  pageActiveRef.current = pageActive;
  /** 进入这一本时那次清理有没有落地。
   *
   * 派生队列必须等它（闸门在 `runDerivedQueue` 里，只有那一个入口）：清理只认「语句执行
   * 那一刻已经在表里」的行（`created_at < CURRENT_TIMESTAMP`），可它是 fire-and-forget 的，
   * 而队列在同一提交里就开始写产物，两边抢的是同一把 DB 锁——万一清理被挡了一秒以上，这一秒
   * 里算出来的成品就会被它自己的清理删掉。可见页靠内存句柄还活着，当场看不到；等切回来重新
   * 取页就是「图片消失」。等它落地（最多 `PURGE_GATE_TIMEOUT_MS`）就没有这个窗口。 */
  const [sessionPurged, setSessionPurged] = useState(false);
  const [searchParams] = useSearchParams();
  const goBack = useReturnNavigation();
  const { showToast } = useToast();
  const { preferences, save } = usePreferences();
  /** 远端那一档配了什么：只有「用不用」与「配过哪台设备」。
   *
   * 处理方式（哪一档、哪个模型、放大几倍）不在这里——它跟随**对面**那份设置，见
   * `RemoteOpsSchema` 的注释。这一段要排在下面 DLSSNR 那段之前：本地那次检查在走远端
   * 时整段不跑（见那里的注释）。 */
  const remoteOps = useMemo(
    () => parseRemoteOps(preferences.remoteComputeOps),
    [preferences.remoteComputeOps],
  );
  const remoteConfigured = remoteOps.enabled
    && !preferences.computeCenterEnabled
    && remoteOps.pairedDevices.some((device) => device.address === preferences.remoteComputeUrl && device.token === preferences.remoteComputeToken)
    && preferences.remoteComputeUrl.trim() !== ''
    && preferences.remoteComputeToken.trim() !== '';
  const centerRepository = useMemo(() => new NativeComputeCenterRepository(), []);
  /** 对面有哪些处理服务能用：连上远端之后，阅读器里那三枚开关**按这份清单**说话。
   *
   * 从前这里看的是本机装没装模型（`upscaleModel !== ''` 那一套），于是手机上「连上了
   * 远端」和「三枚按钮全是灰的」同时出现——它本来就没有、也不需要那些模型。清单到手
   * 之前三档一律不可用：宁可先不显示，也不能先按本机的答案显示一遍再跳。
   *
   * 拉清单失败（对面没开着）就是「一档都没有」，不弹错：阅读器不该在打开一本漫画的
   * 时候先报一句网络错。 */
  const [remoteCapabilities, setRemoteCapabilities] = useState<{ address: string; value: RemoteCapabilities }>();
  const remoteAddress = preferences.remoteComputeUrl.trim();
  useEffect(() => {
    if (!remoteConfigured) {
      setRemoteCapabilities(undefined);
      return;
    }
    let cancelled = false;
    // 探一次就把三枚开关打回灰的，在用户眼里就是「又断了一次」：对面刚起、网络抖一下都会
    // 让第一次问不到。所以①**不**先抹掉上一次的答案（留着的那份正是「它原来有什么」，
    // 只在地址变了时才算过期，见下面的 `remoteServiceUp`）；②失败短退避重试两次。
    void (async () => {
      for (let attempt = 0; attempt < 3; attempt += 1) {
        const result = await centerRepository.remoteCapabilities(remoteAddress, preferences.remoteComputeToken);
        if (cancelled) return;
        if (result.ok) {
          setRemoteCapabilities({ address: remoteAddress, value: result.value });
          return;
        }
        if (attempt < 2) await new Promise((resolve) => { window.setTimeout(resolve, 400 * (attempt + 1)); });
        if (cancelled) return;
      }
    })();
    return () => { cancelled = true; };
  }, [centerRepository, remoteConfigured, remoteAddress, preferences.remoteComputeToken]);
  /** 只有「这一台」的清单算数：换设备的瞬间旧答案（另一个地址）一律过期。 */
  const remoteServiceUp = (service: RemoteService) => remoteServiceReady(
    remoteCapabilities?.address === remoteAddress ? remoteCapabilities.value : undefined,
    service,
  );
  /** DLSSNR 与远端处理要先检查本机能力或配对信息。
   *
   * 但「设置里开了」只是一句**持久化**的意图：它可能来自另一台机器、或者那个 DLL
   * 已经被换掉。本地超分的模型在不在问得出来，DLSSNR 能不能跑要问原生（见下）。 */
  const [dlssnrReady, setDlssnrReady] = useState(false);
  const dlssnrRequested = preferences.dlssnrEnabled;
  const preferencesRef = useRef(preferences);
  preferencesRef.current = preferences;
  /** 已经就「这台机器跑不了 DLSSNR」说过一次的那句话：同一条理由只说一遍，不然每翻
   * 一页都弹一次。 */
  const dlssnrNoticeRef = useRef<string>();
  useEffect(() => {
    // 走远端时这一趟本机不跑 DLSSNR：本地那份检查（有没有 DLL、版本对不对）说的不是
    // 这一件事，而且它在手机上必然失败——真去问，就会把用户手动打开的开关自动关掉。
    if (remoteConfigured) return;
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
  }, [dlssnrRequested, remoteConfigured, save, showToast]);
  const [dlssnrWanted, setDlssnrWanted] = useState(false);
  // 队列回调只依赖稳定值，设置改了就靠这两个 ref 取最新的一份（改设置本身会让
  // derived 重新排队，见下面的 enhancementToken）。
  const dlssnrPassesRef = useRef(preferences.dlssnrPasses);
  dlssnrPassesRef.current = preferences.dlssnrPasses;
  const prefetchDistance = preferences.prefetchPages;
  // A backend with no model runs the nearest-neighbour fallback, which returns
  // the same pixels at four times the bytes — strictly worse than the plain
  // page. Upscaling therefore needs a model, not just a backend.
  //
  // 走远端时这两条都不看本机：一档在这一台能不能用，由**对面**那份能力清单说了算。
  const upscaleConfigured = remoteConfigured
    ? remoteServiceUp('upscale')
    : preferences.upscaleBackend !== 'off' && preferences.upscaleModel !== '';
  // Settings grant availability; every reading session starts with original images.
  /** 一档在这一次阅读里到底能不能用：远端看对面的清单，本机看自己跑不跑得起来。 */
  const dlssnrAvailable = remoteConfigured ? remoteServiceUp('dlssnr') : dlssnrRequested && dlssnrReady;
  const dlssnrConfigured = dlssnrAvailable && dlssnrWanted;
  /** Per-session overrides for the two enhancements, driven from the reader's own
   * toolbar. Settings decide whether a model exists; these decide whether this
   * sitting uses it, which is the only way to see what either one does to the
   * page in front of you. */
  const [upscaleWanted, setUpscaleWanted] = useState(false);
  /** Whether the user has already chosen this sitting's upscale state. Once
   * they touch the toggle, the auto-enable must not flip it back behind them
   * when the metadata (size) arrives later. */
  const upscaleChosenRef = useRef(false);
  useLayoutEffect(() => {
    setUpscaleWanted(false);
    setDlssnrWanted(false);
    upscaleChosenRef.current = false;
  }, [archiveId]);
  useEffect(() => { if (!upscaleConfigured) setUpscaleWanted(false); }, [upscaleConfigured]);
  useEffect(() => { if (!dlssnrAvailable) setDlssnrWanted(false); }, [dlssnrAvailable]);
  const upscaleEnabled = upscaleConfigured && upscaleWanted;
  /** 处理中那枚小胶囊写什么：正在跑哪一档就说哪一档。远端/DLSSNR 在链路上另算一步，
   * 它失败时本机那一版会顶上（见下面的降级），所以这里说的是「正在算」而不是
   * 「一定会变」。 */
  const [derivingStage, setDerivingStage] = useState<'upscale' | 'dlssnr' | 'remote'>();
  const derivingLabel = derivingStage === 'upscale' ? '超分处理中…'
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
  /** Reading mode and direction for this archive. The layout comes from this
   * archive's own record when it says "continuous", otherwise from the global
   * preference; the direction comes from the preference alone — see the loader
   * below for why the stored direction no longer decides it. Both were previously
   * ignored — the reader always started on `auto`/`ltr`, which made the two
   * settings do nothing. */
  const [readingLayout, setReadingLayout] = useState<ReaderLayoutPreference>('auto');
  const [readingDirection, setReadingDirection] = useState<ReadingDirection>('ltr');
  const [title, setTitle] = useState('阅读器');
  const [pages, setPages] = useState<string[]>([]);
  const [error, setError] = useState<string>();
  const [retryToken, setRetryToken] = useState(0);
  /** Cover, tags and byte size for the overview panel. Fetched once alongside
   * the manifest; the panel is the only consumer. */
  const [info, setInfo] = useState<{ cover?: string | undefined; tags?: string[] | undefined; sizeBytes?: number | undefined }>();
  // 自动开启超分整条规则（体积那一半 + 标签那一半）都在 `shouldAutoEnableUpscale` 里：
  // 体积那一半是「平均一页比阈值**小**才值得超分」，本来就大的页不该自己开起来。
  // 体积从 overview facts 里拿（字节），平均一页 = size / 页数。
  useEffect(() => {
    if (!upscaleConfigured || upscaleChosenRef.current) return;
    if (!preferences.upscaleAutoEnable) { setUpscaleWanted(false); return; }
    if (!info?.sizeBytes || !info.tags || pages.length === 0) return;
    setUpscaleWanted(shouldAutoEnableUpscale(info.tags, {
      enabled: true, pageCount: pages.length, sizeBytes: info.sizeBytes,
      tagMode: preferences.upscaleAutoTagMode,
      thresholdBytes: preferences.upscaleAutoThresholdBytes,
      whitelist: preferences.upscaleAutoWhitelist,
      blacklist: preferences.upscaleAutoBlacklist,
    }));
  }, [upscaleConfigured, preferences.upscaleAutoEnable, preferences.upscaleAutoTagMode, preferences.upscaleAutoThresholdBytes, preferences.upscaleAutoWhitelist, preferences.upscaleAutoBlacklist, info?.sizeBytes, info?.tags, pages.length]);
  const coverHandleRef = useRef<ImageHandle>();
  const contextRef = useRef<ReaderContext>();
  const pageHandlesRef = useRef(new Map<number, ImageHandle>());
  // A shared raw handle can be warmed by compute and retained by the screen.
  // Only the screen knows its complete retention window (including swipe slots
  // and recently visited pages), so compute must not infer ownership by viewport.
  const screenOwnedPagesRef = useRef(new Set<number>());
  const thumbnailHandlesRef = useRef(new Map<number, ImageHandle>());
  const pendingPagesRef = useRef(new Map<number, Promise<string | undefined>>());
  const derivedHandlesRef = useRef(new Map<number, ImageHandle>());
  const retiredDerivedRef = useRef(new Map<number, ImageHandle[]>());
  const derivedAttemptedRef = useRef(new Set<number>());
  const visiblePagesRef = useRef<ReadonlySet<number>>(new Set());
  /** 这一页最终由谁来算：远端的桌面端 > 本机 DLSSNR > 本机超分。三者是同一
   * 件事的三种做法，不叠着跑（叠起来一页要过三个模型，而它们的产物都只是中间
   * 结果）；本地超分是前两者的输入。
   *
   * `remoteChain` 是交给远端的那一串（按顺序做哪几档），做几档由**阅读器里开着
   * 哪几档**决定，模型与参数不跟着走。 */
  const derivedQueueRef = useRef<Array<{ pageIndex: number; generation: number; upscaleModel: string; engine: 'remote' | 'dlssnr' | 'local'; remoteChain: readonly RemoteService[]; tier: DerivedTier }>>([]);
  const derivedGenerationRef = useRef(0);
  const derivedBusyRef = useRef(false);
  const activeDerivedRef = useRef<{ pageIndex: number; tier: DerivedTier; controller: AbortController }>();
  /** 正在跑 / 排队的那一页属于哪一档。叫停的时候要按档位判断：后台预处理那一档
   * 按定义就不在可见页的范围内，不能因为它「不在范围内」被掐掉。 */
  const derivedTierRef = useRef(new Map<number, DerivedTier>());
  /** 这本档案里还没轮到、也还没算过的页，按 `sweepOrder` 摆好。
   *
   * 做成游标而不是两百条队列项，是因为队列每次可见页变化都要重排一遍：两百条会
   * 跟着每一次翻页重扫。游标一次只交出一页，重排永远是常数级。 */
  const derivedSweepRef = useRef<{ generation: number; anchor: number; order: number[] }>();
  /** 后台预处理已经算出来的页。
   *
   * 它只用来让**预处理自己**不重复捡起同一页：翻页会让游标按新位置重排，重排出来
   * 的顺序里还留在后退方向上的那些页就是已经做过的。前台请求不看这一份——预算把
   * 结果挤出会话之后，用户真的翻到那一页时仍然要重新算给他看（尝试记录那时已经被
   * `retainDerived` 还回去了），否则页面上还是原图。 */
  const derivedWarmedRef = useRef(new Set<number>());
  /** 当前这一轮的模型与档位。后台任务是从游标上补进队列的，取不到 `requestDerived`
   * 的局部变量，所以在排这一轮的时候在这里留一份。 */
  const derivedConfigRef = useRef<{ upscaleModel: string; engine: 'remote' | 'dlssnr' | 'local'; remoteChain: readonly RemoteService[] }>({ upscaleModel: '', engine: 'local', remoteChain: [] });
  /** 每页一次任务的取消牌（正在跑或正在排队的那一个）。切页、换开关、离开阅读器时
   * 全部 abort——前端 abort 会顺着 `taskId` 叫停原生那侧的循环（见 nativeImageCache）。 */
  const derivedAbortsRef = useRef(new Map<number, AbortController>());
  /** 任务号的来源：同一页重跑（换模型、改层参数）必须是新的号，否则旧任务的取消会
   * 误伤新任务。 */
  const derivedTaskSeqRef = useRef(0);
  const derivedBackgroundRetryAtRef = useRef(0);
  const derivedRetryTimerRef = useRef<ReturnType<typeof setTimeout>>();
  /** 已经说过一次的「某一档没跑成」：按阶段 + 模型去重。 */
  const upscaleFailureRef = useRef(new Set<string>());
  const dlssnrFailureRef = useRef(new Set<string>());
  /** 已经说过一次的「引擎交代」与「点名要显卡却没给上」：都按内容去重。
   *
   * 同一台机器上每翻一页都会得到同一条回退原因，说一遍就够了；不按页去重是因为
   * 这句话讲的是**这台机器**，不是这一页。 */
  const engineNoticeRef = useRef(new Set<string>());
  const generationRef = useRef(0);
  const mountedRef = useRef(true);

  /** The reader's eviction of a page that has left its window.
   *
   * Only the plain page goes: the derived rendition is kept for the session, so
   * stepping back over a spread shows the enhanced page at once instead of
   * running the model again. */
  const releasePage = useCallback((pageIndex: number) => {
    screenOwnedPagesRef.current.delete(pageIndex);
    const handle = pageHandlesRef.current.get(pageIndex);
    pageHandlesRef.current.delete(pageIndex);
    if (handle) imageCache.release(handle);
  }, []);

  /** Hold a finished derived rendition for the session, dropping the one the reader
   * is least likely to need next once the session is over its budget (`pickDerivedEvictionVictim`).
   *
   * The same page can gain a *better* rendition while the session runs — with DLSSNR
   * on, the local enlarged page arrives first and the DLSSNR one replaces it a few
   * seconds later — so this is also the place that swaps one in.
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
  /** 这一轮会话里见过最大的一页派生结果，用来把「至少留住几页」折算成字节
   * （见 `DERIVED_MIN_RESIDENT_PAGES`）。只增不减：预算不该在页与页之间来回抖。 */
  const derivedPeakBytesRef = useRef(0);
  const retainDerived = useCallback((pageIndex: number, handle: ImageHandle) => {
    const held = derivedHandlesRef.current;
    const existing = held.get(pageIndex);
    // 已经是这一版了：不动。第二次落到同一个句柄只可能是「同一档换了模型又算回同一版」——
    // 这时候既不该换，也不该把它释放掉。
    if (existing === handle) return;
    if (existing) {
      held.delete(pageIndex);
      derivedBytesRef.current -= imageResidentBytes(existing);
    }
    held.set(pageIndex, handle);
    derivedBytesRef.current += imageResidentBytes(handle);
    derivedPeakBytesRef.current = Math.max(derivedPeakBytesRef.current, imageResidentBytes(handle));
    const dropped: number[] = [];
    const visible = visiblePagesRef.current;
    const budget = Math.min(
      DERIVED_SESSION_CEILING_BYTES,
      Math.max(
        DERIVED_SESSION_BUDGET_BYTES,
        derivedPeakBytesRef.current * (visible.size + DERIVED_MIN_RESIDENT_PAGES),
      ),
    );
    while (derivedBytesRef.current > budget && held.size > 1) {
      // 丢「离正在读的那一页最远」的那一页，不是「最早算出来的」那一页：预扫是从
      // 当前页往后由近到远灌进来的，最早进来的正好是马上要翻到的（见
      // `pickDerivedEvictionVictim`）。
      const anchor = visible.size > 0 ? Math.min(...visible) : pageIndex;
      const victim = pickDerivedEvictionVictim([...held.keys()], visible, anchor);
      if (victim === undefined) break;
      const evicted = held.get(victim);
      held.delete(victim);
      if (!evicted) break;
      derivedBytesRef.current -= imageResidentBytes(evicted);
      imageCache.release(evicted);
      const retired = retiredDerivedRef.current.get(victim);
      if (retired) {
        retiredDerivedRef.current.delete(victim);
        for (const handle of retired) imageCache.release(handle);
      }
      // Its attempt is un-spent again, or a page whose result was dropped for
      // room would never be enhanced a second time. 后台预处理过的页也一样：它只是
      // 不再被预处理重复捡起来（见 `derivedWarmedRef`），用户真的翻回去时仍然要
      // 重新算给他看。
      derivedAttemptedRef.current.delete(victim);
      dropped.push(victim);
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

  /** 无人看图一段时间之后把 DLSSNR 的工作区交回（见 `releaseDlssnrWorkspaces`）。
   *
   * 交回是「滚回上一页就得重建」的代价换几个 GB 的提交内存，所以判据是**队列空了**
   * 而不是「翻页了」：只有没人再要下一张的时候挂着的那几份纹理才没有意义。定时器归
   * 阅读器生命周期管——`releaseAllPages` 与离开这一本都会取消它，免得离开之后还朝
   * 后端发一次没人需要的请求。 */
  const workspaceReleaseRef = useRef<number>();
  const cancelWorkspaceRelease = useCallback(() => {
    if (workspaceReleaseRef.current === undefined) return;
    window.clearTimeout(workspaceReleaseRef.current);
    workspaceReleaseRef.current = undefined;
  }, []);
  const scheduleWorkspaceRelease = useCallback(() => {
    cancelWorkspaceRelease();
    workspaceReleaseRef.current = window.setTimeout(() => {
      workspaceReleaseRef.current = undefined;
      releaseDlssnrWorkspaces();
    }, WORKSPACE_IDLE_RELEASE_MS);
  }, [cancelWorkspaceRelease]);

  const releaseAllPages = useCallback(() => {
    if (derivedRetryTimerRef.current !== undefined) clearTimeout(derivedRetryTimerRef.current);
    derivedRetryTimerRef.current = undefined;
    derivedBackgroundRetryAtRef.current = 0;
    cancelWorkspaceRelease();
    for (const handle of pageHandlesRef.current.values()) imageCache.release(handle);
    pageHandlesRef.current.clear();
    screenOwnedPagesRef.current.clear();
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
    derivedPeakBytesRef.current = 0;
    derivedAttemptedRef.current.clear();
    derivedQueueRef.current = [];
    derivedTierRef.current.clear();
    derivedSweepRef.current = undefined;
    derivedWarmedRef.current.clear();
    visiblePagesRef.current = new Set();
    derivedGenerationRef.current += 1;
    setDerivedPages((current) => current.size === 0 ? current : new Map());
    for (const handle of thumbnailHandlesRef.current.values()) imageCache.release(handle);
    thumbnailHandlesRef.current.clear();
    if (coverHandleRef.current) imageCache.release(coverHandleRef.current);
    coverHandleRef.current = undefined;
    pendingPagesRef.current.clear();
  }, [cancelWorkspaceRelease]);

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

  const loadPage = useCallback(async (pageIndex: number, signal?: AbortSignal, screenOwned = true) => {
    const context = contextRef.current;
    const path = context?.paths[pageIndex];
    if (!context || !path || pageIndex < 0) return undefined;
    // Claim before either fast path or await: a screen request can join a raw
    // load started by the sweep, and must own that handle when it lands.
    if (screenOwned) screenOwnedPagesRef.current.add(pageIndex);
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
  /** 正在处理（超分 / DLSSNR）的页。一页在 CPU 上要好几秒，两样一起开更久——
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

  /** 把这一本已经算好的派生渲染全部还回去。
   *
   * 默认把**正在显示的那几页**的旧句柄退到 `retiredDerivedRef` 而不是直接放掉：
   * 设置换了、新的一轮还没算出来，屏幕上不该先白一下（旧 URL 还能继续显示）。
   * `dropVisible` 用在没有屏幕可闪的场合——阅读器已经被切到后台了，留着这一页
   * 21–27 MB 的派生结果没有任何人能看见（501 页的实测案例就这样攒到 2.9 GB）。 */
  const releaseDerived = useCallback((options?: { dropVisible?: boolean }) => {
    derivedGenerationRef.current += 1;
    if (derivedRetryTimerRef.current !== undefined) clearTimeout(derivedRetryTimerRef.current);
    derivedRetryTimerRef.current = undefined;
    derivedBackgroundRetryAtRef.current = 0;
    for (const controller of derivedAbortsRef.current.values()) controller.abort();
    derivedAbortsRef.current.clear();
    for (const [pageIndex, handle] of derivedHandlesRef.current) {
      if (!options?.dropVisible && visiblePagesRef.current.has(pageIndex)) {
        const retired = retiredDerivedRef.current.get(pageIndex) ?? [];
        retired.push(handle);
        retiredDerivedRef.current.set(pageIndex, retired);
      } else {
        imageCache.release(handle);
      }
    }
    derivedHandlesRef.current.clear();
    if (options?.dropVisible) {
      for (const retired of retiredDerivedRef.current.values()) {
        for (const handle of retired) imageCache.release(handle);
      }
      retiredDerivedRef.current.clear();
      // 隐藏着的阅读器一页都看不见，重新显示时 ReaderScreen 会再把可见页报上来。
      visiblePagesRef.current = new Set();
    }
    derivedBytesRef.current = 0;
    derivedPeakBytesRef.current = 0;
    derivedAttemptedRef.current.clear();
    derivedQueueRef.current = [];
    derivedTierRef.current.clear();
    derivedSweepRef.current = undefined;
    derivedWarmedRef.current.clear();
    // 设置换了就是新的一轮：上一轮说过的「某一档没跑成」不该让这一轮闭嘴。
    upscaleFailureRef.current.clear();
    dlssnrFailureRef.current.clear();
    engineNoticeRef.current.clear();
    setDerivingPages((current) => current.size === 0 ? current : new Set());
    setDerivingStage(undefined);
    setDerivedPages((current) => current.size === 0 ? current : new Map());
  }, []);

  /** 某一档失败了就说一次：对应用户明确打开的那个开关。
   *
   * 每档只报一次（按阶段 + 模型去重），不然每一页都会再弹一遍；失败细节仍在错误日志
   * 里（`nativeImageCache` 对阅读器那几版都记）。「超分失败、DLSSNR 成功」这类
   * 结果因此是**可见的降级**，不是静默换图。 */
  const noticeStageFailure = useCallback((stage: 'upscale' | 'dlssnr', model: string, seen: Set<string>) => {
    const key = `${stage}:${model}`;
    if (seen.has(key)) return;
    seen.add(key);
    const label = stage === 'upscale' ? '超分' : 'DLSSNR';
    showToast(`${label}这一步没跑成，这一页显示的是可用的那一版（细节在错误日志里）。`, 'error');
  }, [showToast]);

  /** 引擎交代：这一版**不是**首选那条运行库算的。
   *
   * 「点的是显卡、跑的是 CPU」这句话以前没人说，界面只显示成功——所以这里必须开口
   * （docs/71:126：auto 可以显式回退，但要展示原因）。同一台机器上每翻一页都是同一条
   * 原因，所以按内容去重而不是按页。 */
  const noticeEngineFallback = useCallback((model: string, engine: ReaderPageEngine) => {
    const fallback = engine.fallback;
    if (!fallback) return;
    const key = `fallback:${model}:${fallback.requested}:${fallback.used}:${fallback.reason}`;
    if (engineNoticeRef.current.has(key)) return;
    engineNoticeRef.current.add(key);
    showToast(`这一页没有用 ${fallback.requested} 算：实际用的是 ${fallback.used}（${fallback.reason}）。`, 'info');
  }, [showToast]);

  /** 超分这一步没成。分两种说法：点名要显卡却没给上，是**强制失败**，不是普通降级。
   *
   * `Gpu` 是承诺（docs/71 §5.1/§12.1）：拿不到显卡、或这个模型在这条运行库上实测不通过
   * 就直接失败，绝不能悄悄用 CPU 顶上——所以它的措辞必须与「后台这一步没跑成」不同，
   * 否则用户会以为只是慢了一档。 */
  const noticeUpscaleFailure = useCallback((model: string, failure: ReaderPageFailure) => {
    if (failure.code === 'GPU_BACKEND_UNAVAILABLE' || failure.code === 'GPU_OUTPUT_INVALID') {
      const key = `gpu:${model}:${failure.code}`;
      if (engineNoticeRef.current.has(key)) return;
      engineNoticeRef.current.add(key);
      // 占掉「超分没跑成」那个位子：这条话已经把这一页交代清楚了，别再弹第二遍。
      upscaleFailureRef.current.add(`upscale:${model}`);
      showToast(`点名要显卡这一步没跑成：${failure.code}。这一页显示的是可用的那一版。`, 'error');
      return;
    }
    noticeStageFailure('upscale', model, upscaleFailureRef.current);
  }, [showToast, noticeStageFailure]);

  /** 把后台游标上的下一页放进队列。
   *
   * 整本预处理是一件一件做的：队列里同时只有一条后台任务，剩下的还在游标上。这样
   * 「翻一页就重排一次队列」永远是常数级的——把整本排成任务列表的话，每次可见页
   * 变化都要重扫两百条。 */
  const pumpSweep = useCallback(() => {
    if (Date.now() < derivedBackgroundRetryAtRef.current) return;
    const context = contextRef.current;
    const sweep = derivedSweepRef.current;
    if (!context || !sweep || sweep.generation !== derivedGenerationRef.current) return;
    const config = derivedConfigRef.current;
    while (sweep.order.length > 0) {
      const pageIndex = sweep.order.shift();
      if (pageIndex === undefined) break;
      if (derivedAttemptedRef.current.has(pageIndex) || derivedWarmedRef.current.has(pageIndex)) continue;
      if (derivedQueueRef.current.some((job) => job.pageIndex === pageIndex)) continue;
      derivedQueueRef.current.push({ pageIndex, generation: sweep.generation, ...config, tier: 'background' });
      return;
    }
  }, []);

  const runDerivedQueue = useCallback(async function drainDerivedQueue() {
    // 进入这一本时那次清理还没落地就不开工（见 `sessionPurged` 的注释）：清理只认「执行那一刻
    // 已经在表里」的行，而它和队列抢同一把 DB 锁——晚到一秒就会把这一秒里算出来的成品删掉。
    // 闸门只有这一处：队列空转与三档开关两个入口都从这儿进，放在入口上就会留下第二条路。
    if (!sessionPurged) return;
    if (derivedBusyRef.current) return;
    derivedBusyRef.current = true;
    // 又有活要干了：把挂起的「交回工作区」取消掉，这一趟排空时会重新排一个。
    cancelWorkspaceRelease();
    try {
      for (;;) {
        // 用户已经离开阅读器（路由被留在后面）时不该再占着那一道全局推理闸：整本
        // 预处理是这次阅读起的头，人不在就没有理由继续跑下去。
        if (!pageActiveRef.current) break;
        // 队列空了就从后台游标补一件。前台任务永远排在它前面——预处理是顺手做的，
        // 不是承诺：正在读的那一页等不到结果，这个功能就是坏的。
        if (derivedQueueRef.current.length === 0) pumpSweep();
        if (derivedQueueRef.current.length === 0) break;
        derivedQueueRef.current.sort((a, b) => DERIVED_TIER_ORDER[a.tier] - DERIVED_TIER_ORDER[b.tier]);
        if (derivedQueueRef.current[0]?.tier !== 'visible' && Date.now() < derivedBackgroundRetryAtRef.current) break;
        const job = derivedQueueRef.current.shift();
        if (!job) break;
        const { pageIndex } = job;
        const context = contextRef.current;
        if (!context || !mountedRef.current) break;
        derivedAttemptedRef.current.add(pageIndex);
        if (!await loadPage(pageIndex, undefined, false)) {
          // 源页这一次没读出来（LRR 掉线 / 超时 / 一时取不到）。这一页**没有**做过，
          // 不能把「尝试过」记在它头上：记上以后整本预扫剩下的部分和用户真的翻到它时
          // 都会跳过它，于是这一页在这次阅读里永远是原图——「翻页了也不处理」。
          derivedAttemptedRef.current.delete(pageIndex);
          continue;
        }
        if (job.generation !== derivedGenerationRef.current) {
          if (contextRef.current === context && !screenOwnedPagesRef.current.has(pageIndex)) releasePage(pageIndex);
          continue;
        }
        // 从这一刻起页面上会压一枚「处理中」的小胶囊，失败与否都在 finally 里收掉。
        markDeriving(pageIndex, true);
        setDerivingStage(job.upscaleModel ? 'upscale' : job.engine === 'local' ? undefined : job.engine);
        // 一次任务一个取消牌：切页 / 换开关 / 离开阅读器时把它掐掉。原生那侧一次只
        // 允许一件重活，不掐的话用户要看的那一页排在旧任务后面。
        const taskBase = `${context.generation}:${job.generation}:${pageIndex}:${derivedTaskSeqRef.current += 1}`;
        const controller = new AbortController();
        derivedAbortsRef.current.set(pageIndex, controller);
        derivedTierRef.current.set(pageIndex, job.tier);
        activeDerivedRef.current = { pageIndex, tier: job.tier, controller };
        // 用户正看着的这几页是前台：原生那侧让它们插到后台整本预扫前面，并且会掐掉
        // 正在跑的后台那一件。判据是 tier——`visible` 是当前窗口里的页，其它（预扫
        // 的 `background`、邻页的 `neighbour`）都往后站。
        const priority = job.tier === 'visible' ? ('foreground' as const) : ('background' as const);
        /** 这件任务最后报出来的失败码。`loadLocalRenditions` 的返回值里**没有**它（返回值只答
         * 「谁落地了」），失败只从 `onFailure` 这一条路出来，所以这里得自己接住。 */
        let jobFailure: ReaderPageFailure | undefined;
        try {
          const identity = { scopeId: context.scopeId, serverId: context.serverId, archiveId: context.archiveId, pageIndex };
          /** 本地这一步（超分）在这一版里是**一条链**，任何一档都先走它。
           *
           * 为什么要一条链：链的产物只有内容寻址的落点、没有按修订号登记的缓存行——出了
           * 这件任务，没人能按身份把它找回来。8-g① 在取产物那一步把行补上了
           * （`cache::adopt_published_blob`），所以更高档（dlssnr / remote）终于能把本地
           * 这一版当**输入**按身份读回来：它们接着这条路往下多走一步，不再各走一条
           * 「只有宿主会在进程里跑模型」的旧命令。
           *
           * 这一版没成，阅读器照旧显示原图（§9.1 ⑦）。 */
          const chainUpscaleModel = job.upscaleModel || undefined;
          const enhancedFromPageIdentity: ImageCacheIdentity = {
            ...identity,
            rendition: 'enhanced',
            modelId: job.upscaleModel,
            source: 'reader-page',
            priority,
            taskId: `${taskBase}:enhanced`,
          };
          const renditions = await loadLocalRenditions({
            repository: computeRepository,
            cache: imageCache,
            signal: controller.signal,
            scopeId: context.scopeId,
            archiveId: context.archiveId,
            pageIndex,
            generation: job.generation,
            priority,
            upscaleModel: chainUpscaleModel,
            enhancedFromPageIdentity,
            onEngine: (model, engine) => noticeEngineFallback(model, engine),
            // 链路上的诊断必须落到 error.log：产物解不开、租借拿不到这些**不弹提示**，
            // 没人接这条线时用户在日志里只能看到一个静悄悄失败的页面。
            onDiagnostic: (message, detail) => logError('reader/compute', message, detail),
            // 本地这一版没落地时的原因（`loadLocalRenditions` 判的），只可能是超分这一步。
            onFailure: (_stage, model, failure) => {
              jobFailure = failure;
              noticeUpscaleFailure(model, failure);
            },
          });
          const enhanced = renditions.enhanced;
          // 从这儿往下两条路共用：谁拿到了句柄谁进这套账。
          if (controller.signal.aborted) {
            if (enhanced) imageCache.release(enhanced);
            continue;
          }
          // 优先级就是结果本身：超分 > 原图。
          const local = enhanced;
          if (local && mountedRef.current && contextRef.current?.generation === context.generation && job.generation === derivedGenerationRef.current) {
            retainDerived(pageIndex, local);
          }
          if (job.upscaleModel && !enhanced) {
            noticeStageFailure('upscale', job.upscaleModel, upscaleFailureRef.current);
          }
          /** 远端 / DLSSNR 那一步的输入：本地做了什么就从那一步的产物接着做。 */
          const baseRendition: DlssnrSource = enhanced ? 'enhanced' : 'reader-page';
          /** 这一档（DLSSNR / 远端）自己那一份失败。它**不走**本地链的 `onFailure`：那条路
           * 报的是「本地哪一阶段没落地」，这里报的是「后面这一步没算出来」。两处都归到
           * `jobFailure` 上，下面那句「阵发失败不算做过」才看得见它——只报个提示、不带码的
           * 话，队列满/worker 被杀这类现场问题会把这一页永久记成「做过了」（docs/71:645 第四句）。 */
          let engineFailure: ReaderPageFailure | undefined;
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
                // 起点是按「产出它的模型」存的：本地那一版用的是哪个超分模型，
                // 原生那侧才算得出同一个 revision。
                ...(job.upscaleModel ? { modelId: job.upscaleModel } : {}),
                priority,
                taskId: `${taskBase}:${job.engine}`,
              }
              : {
                ...identity,
                rendition: 'remote',
                // 只报「这一页要做哪几档」；模型、放大倍数、层参数都由对面那份设置决定。
                transform: remoteTransform({
                  device: preferences.remoteComputeUrl,
                  source: baseRendition,
                  chain: job.remoteChain,
                }),
                ...(job.upscaleModel ? { modelId: job.upscaleModel } : {}),
                taskId: `${taskBase}:${job.engine}`,
              }, { signal: controller.signal }).catch((error: unknown) => {
              // 失败不抛给外面（这一档本来就是可选的高档，本地那一版已经画出来了），
              // 但**码要留下**：`RenditionError` 带着原生那句的 code，见下面的判定。
              const code = renditionErrorCode(error);
              if (code !== undefined) {
                // `exactOptionalPropertyTypes` 下 `message?: string` 不能收 `string | undefined`，
                // 所以有文案才带上这一栏。
                engineFailure = error instanceof Error ? { code, message: error.message } : { code };
              }
              return undefined;
            });
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
            // 这一步失败也要算进 `jobFailure`：下面判「阵发失败不算做过」时认的就是它。
            if (engineFailure) jobFailure = engineFailure;
            // 不写「远端失败」的提示：远端地址与令牌的失败在错误日志里，而且那一档本
            // 来就是本机处理的可选替代（本机这一版已经画出来了）。
          }
          if (!controller.signal.aborted && job.generation === derivedGenerationRef.current
              && jobFailure && RETRYABLE_COMPUTE_ERROR_CODES.has(jobFailure.code)) {
            // Keep foreground navigation available, but stop asking the same
            // unavailable worker about every page in the background sweep.
            derivedAttemptedRef.current.delete(pageIndex);
            // Let the idle release timer fire first. Retrying at exactly the
            // same deadline cancels that timer and keeps the cached pressure.
            const delay = jobFailure.code === 'COMPUTE_UNAVAILABLE' ? WORKSPACE_IDLE_RELEASE_MS + 1_000 : 5_000;
            derivedBackgroundRetryAtRef.current = Date.now() + delay;
            if (job.tier === 'background') derivedSweepRef.current?.order.unshift(pageIndex);
            if (derivedRetryTimerRef.current !== undefined) clearTimeout(derivedRetryTimerRef.current);
            derivedRetryTimerRef.current = setTimeout(() => {
              derivedRetryTimerRef.current = undefined;
              if (mountedRef.current && pageActiveRef.current) void drainDerivedQueue();
            }, delay);
          }
          if (!derived) {
            // 一页什么都没落地，它就**不算「做过」**——但只对阵发性的失败这样算。worker 被杀、
            // 队列满、超时都是现场问题（看门狗会把 worker 拉回来），而「做过」这个记号是给
            // `requestDerived` 和整本预扫跳过用的：记上以后用户翻回去也只有原图，这一页在这
            // 一次阅读里再也拿不到结果——那正是 docs/71:645 第四句要防的事。模型没装、输入
            // 坏了这类再问一次还是同一个结果，记着才对（不然每翻一次就重撞一次）。同一件事
            // 在「源页这一次没读出来」那条路上已经办过一次。
            if (jobFailure !== undefined && RETRYABLE_COMPUTE_ERROR_CODES.has(jobFailure.code)) {
              derivedAttemptedRef.current.delete(pageIndex);
            }
            continue;
          }
          if (!mountedRef.current || contextRef.current?.generation !== context.generation || job.generation !== derivedGenerationRef.current) {
            imageCache.release(derived);
            continue;
          }
          // 落到这里第二次只可能是「本地那一版先上屏、再换成 DLSSNR / 远端结果」那条
          // 渐进路径：`retainDerived` 会把这一页换到更好的那一版（同一版则什么都不做），
          // 而不是把更好的那一版丢掉。
          retainDerived(pageIndex, derived);
          // 后台预处理这一页就算做完了，记一笔：内存预算以后把它挤出会话时不再重算
          // （整本预处理要是有「做完又重做」的页，它永远走不到后面）。
          if (job.tier === 'background' && !jobFailure) derivedWarmedRef.current.add(pageIndex);
          // Yield between pages so navigation/input can be serviced promptly on
          // slower devices while the native inference worker continues.
          await new Promise<void>((resolve) => setTimeout(resolve, 0));
        } finally {
          if (activeDerivedRef.current?.controller === controller) activeDerivedRef.current = undefined;
          if (controller.signal.aborted) {
            derivedAttemptedRef.current.delete(pageIndex);
            // 被「让位」掐掉的后台任务退回游标队首：整本预处理不该因为让了一次路就
            // 永远漏掉这一页（让位只发生在用户翻页时，所以它很快会再轮到）。
            if (job.tier === 'background') derivedSweepRef.current?.order.unshift(pageIndex);
          }
          // The sweep owns only background-only sources. The screen may retain
          // this page beyond visible+prefetch, or claim it during computation.
          // Revoking its shared handle here would leave a stale loadedPages URL.
          if (contextRef.current === context && !screenOwnedPagesRef.current.has(pageIndex)) {
            releasePage(pageIndex);
          }
          derivedAbortsRef.current.delete(pageIndex);
          derivedTierRef.current.delete(pageIndex);
          markDeriving(pageIndex, false);
          setDerivingStage(undefined);
        }
      }
    } finally {
      derivedBusyRef.current = false;
      // 队列排空了（这一趟没有新的活进来）：过一会儿把 DLSSNR 的工作区交回。
      scheduleWorkspaceRelease();
    }
  }, [cancelWorkspaceRelease, loadPage, retainDerived, markDeriving, noticeStageFailure, noticeEngineFallback, noticeUpscaleFailure, prefetchDistance, releasePage, scheduleWorkspaceRelease, sessionPurged]);

  useEffect(() => { if (pageActive) void runDerivedQueue(); }, [pageActive, runDerivedQueue]);

  // 用户离开这一本（切到别的档案或别的页面）时，把它的派生渲染当场放掉：这时它
  // 一页都不显示，留着只占内存——实测一页 21–27 MB，501 页那份档案攒到 2.9 GB，
  // 而它正是「阅读档案时 8G、退出后仍回不去 4G」里回不去的那部分。
  // 重新激活时 ReaderScreen 会把可见页重新报给 `requestDerived`，按需再算（尝试
  // 记录已经被上面的 release 清空，所以不会误以为「这一页做过了」而跳过）。
  // 普通页图与缩略图**不放**：它们是压缩后的字节（共享缓存本身有 96 MiB 上限），
  // 而且 ReaderScreen 的取页逻辑在隐藏期间直接 return，回来时不会重取，放掉就是
  // 一整屏白图。
  // 进出这一本各清一次盘上的「成品」（超分 / DLSSNR 的产物）：见 `purgeReaderProducts`。
  //
  // 触发点是 `pageActive`，**不是挂载 / 卸载**：阅读器被 `RetainedPage` 收着时从不卸载
  // （`App.tsx` 的 readers 表只给子树加 `hidden`），卸载只在「第三本把它挤掉」时才发生，
  // 那已经是下一次阅读了——真机上「读完一本回书架」那一半因此从来没跑过。
  // `pageActive` 说的正是「这一本就是当前路由」：切到另一本会翻成 false（各自清各自的），
  // 应用转后台不会（路由没变；`App.tsx` 的 visibilitychange 只停标签翻译）。
  //
  // 两半分开写，而不是一个 effect 带清理函数：那样翻成 false 时清理函数与函数体会连着跑
  // 两遍，也就是两次删文件循环。这里只在真的离开时清一次。
  useEffect(() => {
    if (pageActive) return;
    void purgeReaderProducts(scopeId, archiveId);
  }, [pageActive, scopeId, archiveId]);
  // 进来那一次：清掉上一趟留下的（上次可能崩了，或者离开那一半没走完）。
  //
  // 这一次要**等它落地**（见 `sessionPurged`）再让派生队列开工。超时或清理失败都放行：
  // 宁可留着残留，也不能让阅读卡在一次清理上。
  useEffect(() => {
    if (!scopeId) return;
    let cancelled = false;
    setSessionPurged(false);
    const landed = purgeReaderProducts(scopeId, archiveId) ?? Promise.resolve();
    const gate = Promise.race([
      landed.then(() => undefined, () => undefined),
      new Promise<void>((resolve) => { setTimeout(resolve, PURGE_GATE_TIMEOUT_MS); }),
    ]);
    void gate.then(() => { if (!cancelled) setSessionPurged(true); });
    return () => { cancelled = true; };
  }, [scopeId, archiveId]);

  useEffect(() => {
    if (pageActive) return;
    releaseDerived({ dropVisible: true });
    // 页都放掉了，顺手把工作集也还给系统（见 `trimProcessMemory`）。
    trimProcessMemory();
    // 还有另一半内存不归工作集管：DLSSNR 缓存的工作区（实测几个 GB 的提交内存，
    // 见 `releaseDlssnrWorkspaces`）。离开这一本时正好一起交回。
    cancelWorkspaceRelease();
    releaseDlssnrWorkspaces();
  }, [pageActive, releaseDerived, cancelWorkspaceRelease]);

  /** Called by the reader with the pages actually on screen.
   *
   * 这个函数只负责「屏幕上这几页 + 预取窗口」——它说的就是可见范围，改不得。整本
   * 预处理是**另一件事**：可见页排完之后，从游标上继续往后做（见 `pumpSweep`），
   * 所以一本两百页的档案不会只剩视口里那几页有结果。 */
  const requestDerived = useCallback((indexes: readonly number[]) => {
    visiblePagesRef.current = new Set(indexes);
    if (!upscaleEnabled && !dlssnrConfigured) {
      // 增强全关：这一轮连同后台预处理一起作废，重新打开时从头排一次。
      //
      // 这里不再带 `!remoteConfigured`：走远端时上面这三个值本身就是「对面清单里能用、
      // 而且这次开着」的那几档，三档全关就是「这次不做处理」。从前那个条件让「配了远端
      // 但一档都没开」也排一整本预扫——每一页都白跑一趟远端。
      derivedSweepRef.current = undefined;
      return;
    }
    const engine: 'remote' | 'dlssnr' | 'local' = remoteConfigured
      ? 'remote'
      : dlssnrConfigured
        ? 'dlssnr'
        : 'local';
    /** 交给远端的那一串：阅读器里开着哪几档就做哪几档，顺序固定「超分 → DLSSNR」
     *  ——超分出来的像素是 DLSSNR 更好的输入。模型与参数不跟着走（对面
     *  按自己那份设置跑），所以这一串变了才需要重算。 */
    const remoteChain: readonly RemoteService[] = remoteConfigured
      ? [
        ...(upscaleEnabled ? (['upscale'] as const) : []),
        ...(dlssnrConfigured ? (['dlssnr'] as const) : []),
      ]
      : [];
    const upscaleModel = upscaleEnabled ? preferences.upscaleModel : '';
    // 后台任务从游标补进队列时取不到这里的局部变量，所以在排这一轮的时候留一份。
    derivedConfigRef.current = { upscaleModel, engine, remoteChain };
    let queued = false;
    const context = contextRef.current;
    // Only pages already inside the reader's configured preload window enter
    // inference. Visible pages keep priority; the same policy applies to all
    // local stages so turning to a preloaded page shows its finished rendition.
    const neighbours = context && indexes.length > 0
      ? getPrefetchPages(indexes[0]!, context.paths.length, prefetchDistance)
      : [];
    const wanted = [...new Set([...indexes, ...neighbours])];
    const active = activeDerivedRef.current;
    if (active) {
      // 不在这次要的范围内就叫停——后台预处理那一件除外：它按定义就不在可见页的
      // 范围里，拿 `wanted` 去筛它等于整本预处理永远只做第一页。这也是原来「只处理
      // 视口内的图片」的另一半原因。
      if (active.tier !== 'background' && !wanted.includes(active.pageIndex)) active.controller.abort();
      // 用户翻到了一页还没有结果的页：正在跑的那一件让开。预处理是顺手做的，不是承诺。
      if (active.tier === 'background' && indexes.some((index) => !derivedAttemptedRef.current.has(index))) {
        active.controller.abort();
      }
    }
    // 只重排「看得见的那一档」：后台预处理排好的队不该因为滚了一下就被丢掉——但已经
    // 排上的活要跟着新的可见页**换档**。翻到一页时如果队列里那一件还挂着上一刻的档位
    // （预取窗口按 `neighbour` 排进来的），`runDerivedQueue` 就只把它交给 worker 的
    // background：用户正在看的那一页反而排在刚翻过去的那一页后面按后台跑，看起来就是
    // 「队列不跟着翻页更新」。升档不是丢活，`neighbour` ↔ `visible` 之间来回换不影响
    // `derivedAttemptedRef`，也不影响后台游标。
    const visible = new Set(indexes);
    derivedQueueRef.current = derivedQueueRef.current
      .filter((job) => job.tier === 'background' || wanted.includes(job.pageIndex))
      .map((job) => {
        if (job.tier === 'background') return job;
        const tier: DerivedTier = visible.has(job.pageIndex) ? 'visible' : 'neighbour';
        return tier === job.tier ? job : { ...job, tier };
      });
    for (const [index, controller] of derivedAbortsRef.current) {
      if (wanted.includes(index)) continue;
      if (derivedTierRef.current.get(index) === 'background') continue;
      controller.abort();
    }
    for (const index of wanted) {
      // `derivedWarmedRef` 故意不参与这里：后台算过、又被内存预算挤掉的页，用户真的
      // 翻到它时必须重新给一次结果——跳过它就等于页面上还是原图。
      if (derivedAttemptedRef.current.has(index) || derivedQueueRef.current.some((job) => job.pageIndex === index)) continue;
      derivedQueueRef.current.push({
        pageIndex: index,
        generation: derivedGenerationRef.current,
        upscaleModel,
        engine,
        remoteChain,
        tier: visible.has(index) ? 'visible' : 'neighbour',
      });
      queued = true;
    }
    // 整本预处理的游标。位置变了就重排一次：顺序跟着「接下来会读到哪儿」走，而不是
    // 跟着打开这本档案时的那一页走。已经算过的页在取件时会被跳过。
    const anchor = indexes[0];
    if (context && anchor !== undefined) {
      const sweep = derivedSweepRef.current;
      if (!sweep || sweep.generation !== derivedGenerationRef.current || sweep.anchor !== anchor) {
        derivedSweepRef.current = { generation: derivedGenerationRef.current, anchor, order: sweepOrder(anchor, context.paths.length) };
      }
    }
    // 队列里可能已经有后台那一档的活，所以这里不能只看 `queued`。
    // 等清理落地那一关在 `runDerivedQueue` 里（闸门只设一处）。
    if (queued || derivedQueueRef.current.length > 0) void runDerivedQueue();
  }, [dlssnrConfigured, prefetchDistance, preferences.upscaleModel, remoteConfigured, runDerivedQueue, upscaleEnabled]);

  // A switch above the canvas changed what the derived renditions would be, so
  // everything held under the old answer is dropped and re-requested.
  useLayoutEffect(() => {
    releaseDerived();
  }, [
    dlssnrConfigured,
    enhancementToken,
    preferences.dlssnrPasses,
    preferences.upscaleModel,
    releaseDerived,
    remoteConfigured,
    upscaleEnabled,
  ]);

  useEffect(() => {
    mountedRef.current = true;
    const generation = generationRef.current + 1;
    generationRef.current = generation;
    // 「我是不是最新那一遍」不能拿 `contextRef.current` 来判：它要到**新那一遍取回 manifest
    // 时**才换（见下面 `contextRef.current = context`），而旧那一遍的信号早就被 abort 了——
    // 浏览器里每次 IPC 上百毫秒，这段空隙足够旧那一遍走完剩下的 await，把必然 AbortError 的
    // 取页读成「阅读页面加载失败」，而那个错误没人清，于是新那一遍的页面被错误屏盖住。
    // 代数在 setup 里就 +1，新那一遍一开始跑，旧那一遍立刻认得出来。
    const stillCurrent = () => mountedRef.current && generationRef.current === generation;
    const controller = new AbortController();
    contextRef.current = undefined;
    releaseAllPages();
    setScopeId(undefined);
    setPages([]);
    setError(undefined);

    void (async () => {
      const servers = await repository.listServers();
      if (!stillCurrent()) return;
      if (!servers.ok || !servers.value.length) {
        setError(servers.ok ? '尚未配置服务器' : servers.error.message);
        return;
      }
      const server = pickServer(servers.value, serverParam);
      if (!server) {
        setError('尚未配置服务器');
        return;
      }
      const manifest = await repository.loadReaderManifest(server.id, archiveId);
      if (!stillCurrent()) return;
      if (!manifest.ok) {
        setError(manifest.error.message);
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
        if (!stillCurrent() || !metadata.ok) return;
        setInfo((current) => ({
          ...current,
          tags: metadata.value.tags ? metadata.value.tags.split(',').map((tag) => tag.trim()).filter(Boolean) : [],
          sizeBytes: metadata.value.size,
        }));
      });
      void imageCache.load({ scopeId: server.scopeId, serverId: server.id, archiveId, rendition: 'cover', pageIndex: 0 })
        .then((handle) => {
          if (!stillCurrent()) {
            imageCache.release(handle);
            return;
          }
          coverHandleRef.current = handle;
          setInfo((current) => ({ ...current, cover: handle.url }));
        })
        .catch(() => undefined);
      const progress = await repository.loadProgress(server.scopeId, archiveId);
      if (!stillCurrent()) return;
      const firstPage = requestedPage !== undefined
        ? Math.min(requestedPage, Math.max(0, manifest.value.pages.length - 1))
        : progress.ok && progress.value
        ? Math.min(progress.value.pageIndex, Math.max(0, manifest.value.pages.length - 1))
        : 0;
      setInitialPage(firstPage);
      // Reading mode and direction. The layout still lets the archive's own record
      // win for the one thing it can distinguish — paged vs continuous — because
      // "I scrolled this one" is about *this* archive and nothing else.
      //
      // The direction is not that kind of fact. It used to be read from the same
      // record (`stored?.direction ?? preferences.defaultDirection`), which made
      // the setting unable to take effect on any archive that had been opened once
      // before, and made two archives disagree with each other for no reason the
      // user could see. 设置里那一条现在是**这一次翻页的方向**（标题也从「默认方向」
      // 改成了「翻页方向」），所以它说了算；阅读器里那颗方向按钮是这一趟的临时翻转。
      // `direction` 仍然随进度写回去（`saveProgress` 的载荷与它同步出去的那一列都
      // 还要求这个字段），但进入阅读模式时不再读它。
      const stored = progress.ok ? progress.value : null;
      setReadingLayout(stored?.layout === 'continuous' ? 'webtoon' : preferences.defaultLayout);
      setReadingDirection(preferences.defaultDirection);
      // ReaderScreen owns asynchronous neighbouring-page loading. Waiting for
      // Promise.all(prefetch) here made a ready first page wait for a slow LRR
      // neighbour, delaying navigation even though no compute was needed.
      const firstSource = await loadPage(firstPage, controller.signal);
      if (!stillCurrent()) return;
      if (!firstSource) {
        setError('阅读页面加载失败');
        return;
      }
      const pageSources = Array<string>(manifest.value.pages.length).fill('');
      pageSources[firstPage] = firstSource;
      setPages(pageSources);
    })();

    return () => {
      mountedRef.current = false;
      controller.abort();
      if (contextRef.current?.generation === generation) contextRef.current = undefined;
      releaseAllPages();
      // 阅读器真的卸载了（离开工作区、或它被保留上限挤掉）：连普通页与缩略图都
      // 一起放掉之后，这里才值得清一次工作集。
      trimProcessMemory();
    };
  }, [archiveId, loadPage, prefetchDistance, preferences.defaultDirection, preferences.defaultLayout, releaseAllPages, requestedPage, serverParam, retryToken]);

  // Reader failures used to render as inline text only, on a shell-free route
  // with no way out. Surface them through the shared toast as well.
  useEffect(() => {
    if (error) showToast(error, 'error');
  }, [error, showToast]);

  if (error) {
    // The canvas holds the fact and a retry icon, and leaving
    // is the top bar's job rather than a second competing button.
    //
    // 画布上只说「加载失败」：宿主原话通常是传输层的句子，自带服务器地址、端口与
    // 请求路径（`连不上 http://192.168.x.x:3000/api/archives/a1/files`），整屏铺开
    // 也读不出该做什么（用户报的那一条）。原话照旧走共享 toast 与 error.log——
    // 现场留在日志里，界面只说结论。
    return (
      <ReaderRouteChromeShell className="reader-screen-error" title={title} goBack={goBack}>
        <section className="reader-error">
          <p role="alert">加载失败</p>
          <button type="button" className="reader-retry-button" aria-label="重试加载" onClick={() => setRetryToken((value) => value + 1)}>
            <RotateCcw aria-hidden="true" />
          </button>
        </section>
      </ReaderRouteChromeShell>
    );
  }
  // Not just a placeholder: clearing `pages` above when `archiveId` changes routes
  // through here, which unmounts ReaderScreen and is what stops one archive's page
  // index, zoom and per-index page shapes from carrying into the next. React
  // Router reuses this element across param changes, so nothing else would.
  //
  // 加载态带的是和失败态同一条顶栏：这一支原来只画一个转圈，而阅读器的 chrome
  // 要等第一页到达才唤得出来，于是「加载慢/卡住就退不出去」。顶栏的样式沿用
  // `.reader-error-bar`（同一条 M3 small top app bar，见 `src/styles/reader.css`
  // 里 `.reader-screen-loading:has(.reader-error-bar)` 那条规则），行为则和加载完成后
  // 那两条栏一样是**默认隐藏、落到带上才出现**（用户报的 ③）。
  if (pages.length === 0) {
    return (
      <ReaderRouteChromeShell className="reader-screen-loading" title={title} goBack={goBack}>
        <LoadingIndicator label="正在加载页面" size="lg" />
      </ReaderRouteChromeShell>
    );
  }
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
      dlssnr={{
        // 「能不能用」按上面那个 `dlssnrAvailable`：走远端时看对面的清单，本机时看
        // 自己的 DLL 跑不跑得起来。从前这里写死本机那两个值，于是连上远端也还是灰的。
        configured: dlssnrAvailable,
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
        const progress = {
          scopeId,
          archiveId,
          pageIndex,
          pageCount: pages.length,
          layout: reading.layout === 'webtoon' ? 'continuous' as const : 'paged' as const,
          direction: reading.direction,
          allowProgressRegression: preferencesRef.current.allowProgressRegression,
        };
        void repository.saveProgress(progress).then((result) => {
          if (!result.ok) showToast(`阅读进度保存失败：${result.error.message}`, 'error');
        }).catch((error: unknown) => {
          showToast(`阅读进度保存失败：${String(error)}`, 'error');
        });
      }}
      incognito={incognito}
    />
  );
}
