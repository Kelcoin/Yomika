import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';

import type { CommandResult } from '../domain/result';
import { setSystemBarStyle } from '../bridge/platform';
import { SYNC_COMPLETED_EVENT, setAutoSyncEnabled, startAutoSync } from '../lib/autoSync';
import { startHistoryMaintenance } from '../lib/historyMaintenance';
import { getNativeImageCache } from '../lib/nativeImageCache';
import { setEhMyTagsPriorityEnabled } from '../lib/ehMyTags';
import { initializeTagTranslations, setTagTranslationServiceEnabled } from '../lib/tagTranslationService';
import { refreshTagCounts, setTagCountOrderEnabled } from '../lib/tagCountService';
import { upgradeCssThemePreset } from '../lib/cssThemePresets';
import { syncSystemInsets } from '../lib/safeArea';
import {
  DEFAULT_PREFERENCES,
  NativeSettingsRepository,
  type LegacyPreferenceImport,
  type PreferenceSnapshot,
} from '../repositories/nativeSettingsRepository';

interface PreferencesContextValue {
  preferences: PreferenceSnapshot;
  loading: boolean;
  error: string | undefined;
  save: (input: PreferenceSnapshot) => Promise<CommandResult<PreferenceSnapshot>>;
  importLegacy: (encoded: string) => Promise<CommandResult<LegacyPreferenceImport>>;
}

const PreferencesContext = createContext<PreferencesContextValue | undefined>(undefined);
const repository = new NativeSettingsRepository();


function applyTheme(theme: PreferenceSnapshot['theme']) {
  if (theme === 'system') document.documentElement.removeAttribute('data-theme');
  else document.documentElement.dataset.theme = theme;
  let themeColor = document.querySelector<HTMLMetaElement>('meta[name="theme-color"]');
  if (!themeColor) {
    themeColor = document.createElement('meta');
    themeColor.name = 'theme-color';
    document.head.append(themeColor);
  }
  const dark = theme === 'dark' || (theme === 'system' && window.matchMedia?.('(prefers-color-scheme: dark)').matches);
  themeColor.content = dark ? '#09090b' : '#f3eee4';
  // 系统栏图标与窗口底色也跟着这个主题：Android 上系统栏是透明的（内容画到边），
  // 图标明暗由应用说了算——跟着系统主题走的话，深色应用碰上浅色系统就是深色图标
  // 落在深色栏上（「状态栏很突兀」有一半是它）。
  void setSystemBarStyle(dark, themeColor.content);
}

function applyPreferences(preferences: PreferenceSnapshot) {
  applyTheme(preferences.theme);
  getNativeImageCache().setMaxConcurrentFetches(preferences.coverConcurrency);
  setEhMyTagsPriorityEnabled(preferences.ehMyTagsPriority);
  // SFW 模式走根属性：模糊与显隐是纯 CSS 合同，样式自定义无需知道开关。
  if (preferences.sfwMode) document.documentElement.dataset.sfw = 'true';
  else delete document.documentElement.dataset.sfw;
  try { window.localStorage.setItem('yomika.last-sfw-mode', String(preferences.sfwMode)); } catch { /* storage unavailable */ }
  applyCustomCss(preferences.customCss);
  // 标签翻译与补全排序的开关（docs/30）：镜像给下一帧用，服务开关即时生效。
  const tagTranslationOn = preferences.tagTranslationEnabled;
  setTagTranslationServiceEnabled(tagTranslationOn);
  setTagCountOrderEnabled(preferences.tagCountOrderEnabled);
  // 频次数据只在它自己的开关打开时拉：那是十几 MB 的一份表（mokurin000/e-hentai-tag-count），
  // 与翻译库不是一件事。从前它挂在翻译那个条件里——关了翻译仍然下载它，开着排序开关
  // 但关掉翻译时反而不下载。`refresh()` 自带版本检查与并发去重，重复调用是空转。
  if (preferences.tagCountOrderEnabled) void refreshTagCounts().catch(() => undefined);
  try { window.localStorage.setItem('yomika.last-tag-translation', String(tagTranslationOn)); } catch { /* storage unavailable */ }
  writeNavMirror(preferences);
}

const CUSTOM_CSS_ELEMENT_ID = 'yomika-custom-css';
/** Mirror of the last applied custom CSS. Preferences arrive through IPC, so
 * without this mirror the first frames of every launch painted the default
 * scheme and then flipped — the mirror applies synchronously at import time. */
const LAST_CUSTOM_CSS_KEY = 'yomika.last-custom-css';

/** 自定义样式走 **adoptedStyleSheets**（CSSOM），不走 `<style>` 元素：Tauri 启动时
 * 给 CSP 的 style-src 注入 nonce，`'unsafe-inline'` 随之失效，运行时创建的
 * `<style>` 会被 CSP 全部拒绝（自定义样式因此整体失效过一次）。构造样式表不是
 * 内联样式，CSP 不检查，且在文档样式中排最后——恰好保证覆盖应用令牌。
 * 回退：环境没有 adoptedStyleSheets（旧 jsdom）时仍走 `<style>` 元素。 */
function applyCustomCssSheet(css: string): boolean {
  if (typeof CSSStyleSheet === 'undefined' || !('replaceSync' in CSSStyleSheet.prototype)) return false;
  if (!('adoptedStyleSheets' in document)) return false;
  const existing = (window as { __yomikaCustomSheet?: CSSStyleSheet }).__yomikaCustomSheet;
  if (existing) {
    existing.replaceSync(css);
    return true;
  }
  if (!css.trim()) return true;
  const sheet = new CSSStyleSheet();
  sheet.replaceSync(css);
  (window as { __yomikaCustomSheet?: CSSStyleSheet }).__yomikaCustomSheet = sheet;
  document.adoptedStyleSheets = [...document.adoptedStyleSheets, sheet];
  return true;
}

/** 底栏的形态也走镜像：悬浮还是贴底、显示哪几项，都是偏好里的一行，而偏好是 IPC 回来
 * 的——不镜像的话每次启动都会先画一版贴底栏，等偏好到了再换成悬浮的（明明开着悬浮，
 * 启动瞬间却闪一下固定栏）。写与读都在本地存储里，与自定义 CSS 那条镜像同一个理由。
 *
 * 存的是**形态**不是整份偏好：读回来的值只用来画第一帧，真正的偏一到就整份替换。 */
const LAST_NAV_KEY = 'yomika.last-nav';

type NavMirror = Pick<PreferenceSnapshot, 'floatingNav' | 'bottomNavItems'>;

function writeNavMirror(preferences: PreferenceSnapshot) {
  try {
    window.localStorage.setItem(LAST_NAV_KEY, JSON.stringify({
      floatingNav: preferences.floatingNav,
      bottomNavItems: preferences.bottomNavItems,
    }));
  } catch { /* storage can be unavailable */ }
}

/** 首帧用的底栏形态。只认形状对得上的值：镜像被手改坏时宁可回落默认，也不要拿一个
 * 不认识的东西去画底栏（真正的偏一到就整份覆盖）。 */
function readNavMirror(): Partial<NavMirror> {
  try {
    const raw = window.localStorage.getItem(LAST_NAV_KEY);
    if (!raw) return {};
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed !== 'object' || parsed === null) return {};
    const value = parsed as { floatingNav?: unknown; bottomNavItems?: unknown };
    return {
      ...(typeof value.floatingNav === 'boolean' ? { floatingNav: value.floatingNav } : {}),
      // 元素只验到「是字符串」：认得哪几个 key 的是底栏自己（AppShell 的
      // NAV_KEY_ROUTES），不认识的 key 在那边会被过滤掉——所以这里的断言安全，
      // 也不必把路由表搬到 app 层来。
      ...(Array.isArray(value.bottomNavItems)
        ? { bottomNavItems: value.bottomNavItems.filter((item): item is string => typeof item === 'string') as PreferenceSnapshot['bottomNavItems'] }
        : {}),
    };
  } catch {
    return {};
  }
}

// Runs when the module is imported, before React renders anything.
try {
  if (window.localStorage.getItem('yomika.last-sfw-mode') === 'true') document.documentElement.dataset.sfw = 'true';
  const cached = window.localStorage.getItem(LAST_CUSTOM_CSS_KEY);
  if (cached) applyCustomCss(cached);
  // 标签翻译必须在 React 首帧前就位，否则已上屏的卡片带着原始标签等重渲染
  // ——「启动后部分没生效」的根源。镜像关闭时 setEnabled 会卸载并保持原样。
  if (window.localStorage.getItem('yomika.last-tag-translation') !== 'false') {
    setTagTranslationServiceEnabled(true);
    void initializeTagTranslations();
  }
} catch { /* storage can be unavailable */ }

/** User CSS goes into one managed <style> at the end of head, so it overrides
 * the design tokens without the app having to know what it contains. It is also
 * the only theming surface: the accent-colour preference that used to sit beside
 * it said less than `--brand-vermilion: …` does here. */
function applyCustomCss(css: string) {
  if (typeof document === 'undefined') return;
  try {
    if (window.localStorage.getItem(LAST_CUSTOM_CSS_KEY) !== css) window.localStorage.setItem(LAST_CUSTOM_CSS_KEY, css);
  } catch { /* storage can be unavailable */ }
  if (applyCustomCssSheet(css)) {
    document.getElementById(CUSTOM_CSS_ELEMENT_ID)?.remove();
    return;
  }
  const existing = document.getElementById(CUSTOM_CSS_ELEMENT_ID);
  if (!css.trim()) {
    existing?.remove();
    return;
  }
  const element = existing ?? document.createElement('style');
  element.id = CUSTOM_CSS_ELEMENT_ID;
  element.textContent = css;
  if (!existing) document.head.append(element);
}

export function PreferencesProvider({ children }: { children: ReactNode }) {
  // 首帧就用镜像里的底栏形态：`.is-floating-nav` 与底栏的 `is-floating` 都读它，
  // 等 IPC 回来再整份替换（见 LAST_NAV_KEY）。
  const [preferences, setPreferences] = useState<PreferenceSnapshot>(() => ({ ...DEFAULT_PREFERENCES, ...readNavMirror() }));
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string>();
  // Saves carry complete snapshots for backwards compatibility with the native
  // command. Serialize them so an automatic safety write (for example, turning
  // off an unavailable DLSSNR capability) cannot race a user edit and lose the
  // later intent.
  const saveQueueRef = useRef(Promise.resolve());

  /** 读一次原生偏好并落到界面上：启动时一次，同步拉回别处的改动后再来一次。 */
  const reload = useCallback(async () => {
    const result = await repository.load();
    if (result.ok) {
      const preferences = { ...result.value, customCss: upgradeCssThemePreset(result.value.customCss) };
      setPreferences(preferences);
      applyPreferences(preferences);
      setError(undefined);
    } else {
      setError(result.error.message);
    }
    setLoading(false);
    return result.ok;
  }, []);

  useEffect(() => { void reload(); }, [reload]);

  // 系统栏高度只有原生侧有（见 lib/safeArea）：启动时问一次，之后原生自己写变量。
  useEffect(() => { void syncSystemInsets(); }, []);

  // 自动同步与历史清理的触发点（启动、回前台、写入、联网、定时）在这里装上；
  // 拉回到别的设备的改动时，偏好得重读一次，否则界面上还是本机这份。
  useEffect(() => {
    const stopSync = startAutoSync();
    const stopMaintenance = startHistoryMaintenance();
    const onApplied = () => { void reload(); };
    window.addEventListener(SYNC_COMPLETED_EVENT, onApplied);
    return () => {
      window.removeEventListener(SYNC_COMPLETED_EVENT, onApplied);
      stopSync();
      stopMaintenance();
    };
  }, [reload]);

  useEffect(() => { setAutoSyncEnabled(preferences.autoSync); }, [preferences.autoSync]);

  function save(input: PreferenceSnapshot): Promise<CommandResult<PreferenceSnapshot>> {
    const operation = saveQueueRef.current.then(async () => {
      const result = await repository.save(input);
      if (result.ok) {
        setPreferences(result.value);
        applyPreferences(result.value);
        setError(undefined);
      }
      return result;
    });
    // Keep the queue alive after a failed save while preserving the failure for
    // the caller that initiated this particular operation.
    saveQueueRef.current = operation.then(() => undefined, () => undefined);
    return operation;
  }

  async function importLegacy(encoded: string): Promise<CommandResult<LegacyPreferenceImport>> {
    const result = await repository.importLegacy(encoded);
    if (result.ok) {
      const preferences = { ...result.value.preferences, customCss: upgradeCssThemePreset(result.value.preferences.customCss) };
      setPreferences(preferences);
      applyPreferences(preferences);
      setError(undefined);
    }
    return result;
  }

  const value = useMemo(
    () => ({ preferences, loading, error, save, importLegacy }),
    [preferences, loading, error],
  );
  return <PreferencesContext.Provider value={value}>{children}</PreferencesContext.Provider>;
}

export function usePreferences(): PreferencesContextValue {
  const value = useContext(PreferencesContext);
  if (!value) throw new Error('PreferencesProvider is missing');
  return value;
}

export function useProgressBarVisibility(): PreferenceSnapshot['progressBarVisibility'] | undefined {
  return useContext(PreferencesContext)?.preferences.progressBarVisibility;
}

/** The archive card style, and a setter that persists it.
 *
 * The library and the three shelves render the same list and have to agree on
 * how a card is drawn, so the choice is a preference rather than either one's
 * component state — as state it also reset to the default on every navigation. */
export function useCardStyle(): { cardStyle: PreferenceSnapshot['cardStyle']; setCardStyle: (value: PreferenceSnapshot['cardStyle']) => void } {
  const { preferences, save } = usePreferences();
  return {
    cardStyle: preferences.cardStyle,
    setCardStyle: (value) => { void save({ ...preferences, cardStyle: value }); },
  };
}

/** Standalone detail previews use the same defaults as the app provider. */
export function useDetailActions() {
  return useContext(PreferencesContext)?.preferences.detailActions ?? DEFAULT_PREFERENCES.detailActions;
}

/** Which time fact the detail overview prints; same fallback as above. */
export function useDetailDateKind() {
  return useContext(PreferencesContext)?.preferences.detailDateKind ?? DEFAULT_PREFERENCES.detailDateKind;
}
