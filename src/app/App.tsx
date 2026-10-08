import { RetainedPage } from './RetainedPage';
import { AppShell } from '../components/AppShell';
import { useEffect, useRef } from 'react';
import { Route, Routes, useLocation, useNavigate } from 'react-router-dom';
import { preloadLazyPages, ReaderRoutes, WorkspaceRoutes } from './routes';
import { PreferencesProvider, usePreferences } from './preferences';
import { startTagTranslationUpdates, stopTagTranslationUpdates } from '../lib/tagTranslationService';
import { installErrorLogging } from '../lib/errorLog';
import { installPressFeedback } from '../lib/pressFeedback';
import { SplashFrame } from '../components/SplashFrame';
import { ToastProvider } from '../components/Toast';
import { UpdateNotice } from '../components/UpdateNotice';
import { ComputeWorkerNotice } from '../components/ComputeWorkerNotice';

/** Applies the 启动时打开 preference, once, and only while the app is still on
 * the route it launched at — a later visit to the home page is the user's own
 * navigation and must not be hijacked. */
function StartupRoute() {
  const { preferences, loading } = usePreferences();
  const navigate = useNavigate();
  const { pathname } = useLocation();
  const applied = useRef(false);
  useEffect(() => {
    if (loading || applied.current) return;
    applied.current = true;
    if (preferences.startupRoute === 'library' && pathname === '/') navigate('/library', { replace: true });
  }, [loading, navigate, pathname, preferences.startupRoute]);
  return null;
}

/** 同时保留（挂着不卸载）的阅读器数量上限。
 *
 * 保留是为了切走再切回来时不丢滚动位置、不重新拉页面，但 RetainedPage 只给
 * 内容加 `hidden`，子树从不卸载：每多一个保留的阅读器，就多一整页 DOM、一份
 * 页面句柄/缩略图句柄，以及一份「派生渲染」句柄（实测 21–27 MB/页）。没人释放
 * 的旧阅读器累积起来，就是「阅读档案时内存高达 8G、退出后过一段时间仍居高不下
 * 的 4G」里那部分回不来的内存（释放只有 ReaderRoute 卸载时才会走到）。
 * 因此只留当前正在读的这一个 + 最近读过的那一个，更早的在离场时就卸载掉，
 * 让它的 releaseAllPages 真正执行。 */
const MAX_RETAINED_READERS = 2;

export function App() {
  const location = useLocation();
  const { pathname } = location;
  const reading = pathname.startsWith('/reader/');
  const workspaceLocation = useRef<typeof location | undefined>(reading ? undefined : location);
  if (!reading) workspaceLocation.current = location;
  const readers = useRef(new Map<string, typeof location>());
  const readerParams = new URLSearchParams(location.search);
  const readerKey = `${pathname}:${readerParams.get('server') ?? ''}:${readerParams.get('incognito') ?? ''}`;
  if (reading) {
    // 重进已有的档案要挪到最近端（delete 再 set 才改得动 Map 的顺序），
    // 这样下面淘汰的总是「最久没读的那一个」。
    readers.current.delete(readerKey);
    readers.current.set(readerKey, location);
    while (readers.current.size > MAX_RETAINED_READERS) {
      const oldest = readers.current.keys().next();
      // 正在读的那个就是刚插进去的最近项，正常轮不到它；万一上限被改成 0，
      // 也不能把本次渲染的活跃阅读器淘汰掉（那会让它反复卸载重建）。
      if (oldest.done || oldest.value === readerKey) break;
      readers.current.delete(oldest.value);
    }
  }
  useEffect(() => {
    // 没人接住的错误要有地方去：设置页的「错误日志」读的就是这里记下的内容。
    const stopErrorLogging = installErrorLogging();
    // 触屏没有 hover，`is-pressed` 就是"按下去"那一瞬间的反馈。
    const stopPressFeedback = installPressFeedback();
    const suppressNativeMenu = (event: Event) => event.preventDefault();
    document.addEventListener('contextmenu', suppressNativeMenu);
    const updateLifecycle = () => {
      if (document.visibilityState === 'hidden') stopTagTranslationUpdates();
      else startTagTranslationUpdates();
    };
    updateLifecycle();
    document.addEventListener('visibilitychange', updateLifecycle);
    // 启动稳定后把懒加载的页面取回来：不然切到那些页面时 Suspense 会把整页换成
    // 加载动画，闪一下（chunk 只在第一次进入时缺）。
    preloadLazyPages();
    return () => {
      stopErrorLogging();
      stopPressFeedback();
      document.removeEventListener('contextmenu', suppressNativeMenu);
      document.removeEventListener('visibilitychange', updateLifecycle);
      stopTagTranslationUpdates();
    };
  }, []);
  return (
    <PreferencesProvider>
      <SplashFrame />
      <StartupRoute />
      <ToastProvider>
        {workspaceLocation.current && <RetainedPage active={!reading}>
          <Routes location={workspaceLocation.current}><Route path="*" element={<AppShell><WorkspaceRoutes /></AppShell>} /></Routes>
        </RetainedPage>}
        {[...readers.current].map(([key, saved]) => <RetainedPage key={key} active={reading && readerKey === key}>
          <Routes location={saved}><Route path="*" element={<ReaderRoutes />} /></Routes>
        </RetainedPage>)}
        {/* 版本提醒挂在所有页面之外：在阅读器里也该收到，而它自己不做任何渲染。 */}
        <UpdateNotice />
        {/* 计算进程的状态也是全应用一条：阅读器要用它，整本预扫也用它（§12.3）。 */}
        <ComputeWorkerNotice />
      </ToastProvider>
    </PreferencesProvider>
  );
}
