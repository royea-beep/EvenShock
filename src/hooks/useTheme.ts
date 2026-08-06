import { useCallback, useEffect, useState } from 'react';
import {
  DEFAULT_THEME,
  THEME_STORAGE_KEY,
  isThemeId,
  type ThemeId,
} from '../constants/themes';

function readStoredTheme(): ThemeId {
  try {
    const stored = localStorage.getItem(THEME_STORAGE_KEY);
    if (isThemeId(stored)) return stored;
  } catch {
    // Storage unavailable — fall through to the default.
  }
  return DEFAULT_THEME;
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
    try {
      localStorage.setItem(THEME_STORAGE_KEY, next);
    } catch {
      // Non-fatal: the theme still applies for this session.
    }
  }, []);

  return { theme, setTheme };
}
