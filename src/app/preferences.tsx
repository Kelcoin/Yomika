import { createContext, useContext, useEffect, useMemo, useState, type ReactNode } from 'react';

import type { CommandResult } from '../domain/result';
import { getNativeImageCache } from '../lib/nativeImageCache';
import { setEhMyTagsPriorityEnabled } from '../lib/ehMyTags';
import { upgradeCssThemePreset } from '../lib/cssThemePresets';
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
}

const CUSTOM_CSS_ELEMENT_ID = 'yomika-custom-css';
/** Mirror of the last applied custom CSS. Preferences arrive through IPC, so
 * without this mirror the first frames of every launch painted the default
 * scheme and then flipped — the mirror applies synchronously at import time. */
const LAST_CUSTOM_CSS_KEY = 'yomika.last-custom-css';

// Runs when the module is imported, before React renders anything.
try {
  if (window.localStorage.getItem('yomika.last-sfw-mode') === 'true') document.documentElement.dataset.sfw = 'true';
  const cached = window.localStorage.getItem(LAST_CUSTOM_CSS_KEY);
  if (cached) applyCustomCss(cached);
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
  const [preferences, setPreferences] = useState(DEFAULT_PREFERENCES);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string>();

  useEffect(() => {
    let active = true;
    void repository.load().then((result) => {
      if (!active) return;
      if (result.ok) {
        const preferences = { ...result.value, customCss: upgradeCssThemePreset(result.value.customCss) };
        setPreferences(preferences);
        applyPreferences(preferences);
      } else {
        setError(result.error.message);
      }
      setLoading(false);
    });
    return () => { active = false; };
  }, []);

  async function save(input: PreferenceSnapshot): Promise<CommandResult<PreferenceSnapshot>> {
    const result = await repository.save(input);
    if (result.ok) {
      setPreferences(result.value);
      applyPreferences(result.value);
      setError(undefined);
    }
    return result;
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
