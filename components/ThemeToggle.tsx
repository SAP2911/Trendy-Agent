'use client';

import { useEffect, useSyncExternalStore } from 'react';
import styles from './ThemeToggle.module.css';
import { SunIcon, MoonIcon, MonitorIcon } from './icons';
import {
  applyTheme, getStoredTheme, setStoredTheme, subscribeStoredTheme, type ThemeMode,
} from './theme';

const OPTIONS: Array<{ mode: ThemeMode; label: string; Icon: typeof SunIcon }> = [
  { mode: 'light', label: 'Light', Icon: SunIcon },
  { mode: 'dark', label: 'Dark', Icon: MoonIcon },
  { mode: 'system', label: 'System', Icon: MonitorIcon },
];

/** Server and pre-hydration client render always agree: "system". */
function getServerSnapshot(): ThemeMode {
  return 'system';
}

/**
 * Light / Dark / System selector. The DOM's `data-theme` attribute is
 * already correct before this component ever mounts — set synchronously by
 * the inline script in <head> (see components/theme.ts). `mode` here is
 * read via useSyncExternalStore rather than useState+useEffect: React's own
 * prescribed way to read a browser-only external source (localStorage)
 * without a hydration mismatch — it renders "system" (matching the server
 * and the inline script's own default) until hydration completes, then
 * swaps to the real stored value in one client-only render, no manual
 * "mounted" flag required.
 */
export function ThemeToggle() {
  const mode = useSyncExternalStore(subscribeStoredTheme, getStoredTheme, getServerSnapshot);

  // Keeps <html data-theme> correct whenever `mode` changes for any reason
  // (this tab's own click, another tab's click, or first paint after
  // hydration resolves the real stored value) — a direct DOM write, not
  // React state, so it does not fight with the store subscription above.
  useEffect(() => {
    applyTheme(mode);
  }, [mode]);

  // While in "System" mode, keep <html data-theme> following the OS live —
  // `mode` itself never changes here, so this cannot loop with the effect
  // above; it only ever re-applies the same 'system' mode with a fresh
  // resolved light/dark value.
  useEffect(() => {
    if (mode !== 'system') return undefined;
    const media = window.matchMedia('(prefers-color-scheme: dark)');
    const onChange = () => applyTheme('system');
    media.addEventListener('change', onChange);
    return () => media.removeEventListener('change', onChange);
  }, [mode]);

  return (
    <div className={styles.group} role="radiogroup" aria-label="Colour theme">
      {OPTIONS.map(({ mode: optionMode, label, Icon }) => (
        <button
          key={optionMode}
          type="button"
          role="radio"
          aria-checked={mode === optionMode}
          className={styles.option}
          data-active={mode === optionMode ? 'true' : 'false'}
          onClick={() => setStoredTheme(optionMode)}
          title={label}
        >
          <Icon />
          <span className={styles.label}>{label}</span>
        </button>
      ))}
    </div>
  );
}
