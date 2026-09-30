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

export function App() {
  const location = useLocation();
  const { pathname } = location;
  const reading = pathname.startsWith('/reader/');
  const workspaceLocation = useRef<typeof location | undefined>(reading ? undefined : location);
  if (!reading) workspaceLocation.current = location;
  const readers = useRef(new Map<string, typeof location>());
  const readerParams = new URLSearchParams(location.search);
  const readerKey = `${pathname}:${readerParams.get('server') ?? ''}:${readerParams.get('incognito') ?? ''}`;
  if (reading) readers.current.set(readerKey, location);
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
      </ToastProvider>
    </PreferencesProvider>
  );
}
