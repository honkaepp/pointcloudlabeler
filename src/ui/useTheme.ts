import { useEffect, useState } from 'react';
import { onThemeChange, readTheme, viewportBackground, type Theme } from './theme';

/** The theme, re-rendering whatever reads it when it changes. */
export function useTheme(): Theme {
  const [theme, setTheme] = useState<Theme>(() => readTheme());
  useEffect(() => onThemeChange(setTheme), []);
  return theme;
}

/** The viewport's clear colour for the current theme. */
export function useViewportBackground(): string {
  return viewportBackground(useTheme());
}
