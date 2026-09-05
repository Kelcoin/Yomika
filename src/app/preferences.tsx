import { createContext, useContext, useEffect, useMemo, useState, type ReactNode } from 'react';

import type { CommandResult } from '../domain/result';
import { getNativeImageCache } from '../lib/nativeImageCache';
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
  applyCustomCss(preferences.customCss);
}

const CUSTOM_CSS_ELEMENT_ID = 'yomika-custom-css';

/** User CSS goes into one managed <style> at the end of head, so it overrides
 * the design tokens without the app having to know what it contains. It is also
 * the only theming surface: the accent-colour preference that used to sit beside
 * it said less than `--brand-vermilion: …` does here. */
function applyCustomCss(css: string) {
  if (typeof document === 'undefined') return;
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
        setPreferences(result.value);
        applyPreferences(result.value);
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
      setPreferences(result.value.preferences);
      applyPreferences(result.value.preferences);
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
