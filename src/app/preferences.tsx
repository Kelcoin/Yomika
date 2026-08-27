import { createContext, useContext, useEffect, useMemo, useState, type ReactNode } from 'react';

import type { CommandResult } from '../domain/result';
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
        applyTheme(result.value.theme);
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
      applyTheme(result.value.theme);
      setError(undefined);
    }
    return result;
  }

  async function importLegacy(encoded: string): Promise<CommandResult<LegacyPreferenceImport>> {
    const result = await repository.importLegacy(encoded);
    if (result.ok) {
      setPreferences(result.value.preferences);
      applyTheme(result.value.preferences.theme);
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
