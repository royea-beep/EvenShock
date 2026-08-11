import { useCallback, useEffect, useState } from 'react';
import {
  DEFAULT_THEME,
  THEME_STORAGE_KEY,
  isThemeId,
  type ThemeId,
} from '../constants/themes';
import { local } from '../utils/safeStorage';

function readStoredTheme(): ThemeId {
  const stored = local.get(THEME_STORAGE_KEY);
  return isThemeId(stored) ? stored : DEFAULT_THEME;
}

/**
 * Owns the active theme. Applying it is a single attribute write on <html>:
 * the CSS custom properties cascade from there, so switching is instant and
 * costs no React re-render of the tree below.
 */
export function useTheme() {
  const [theme, setThemeState] = useState<ThemeId>(readStoredTheme);

  useEffect(() => {
    document.documentElement.setAttribute('data-theme', theme);
  }, [theme]);

  const setTheme = useCallback((next: ThemeId) => {
    setThemeState(next);
    // Non-fatal if storage refuses: the theme still applies for this session.
    local.set(THEME_STORAGE_KEY, next);
  }, []);

  return { theme, setTheme };
}
