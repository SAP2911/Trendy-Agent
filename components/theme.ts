/**
 * Shared between app/layout.tsx (which inlines THEME_INIT_SCRIPT into
 * <head>, verbatim, so it runs before first paint) and ThemeToggle.tsx
 * (which does the exact same read/resolve logic after hydration). Keeping
 * both in one file means the "no flash of wrong theme" guarantee can't
 * silently drift out of sync between the two copies.
 */
export type ThemeMode = 'light' | 'dark' | 'system';

export const THEME_STORAGE_KEY = 'trendly-theme';

export function isThemeMode(value: unknown): value is ThemeMode {
  return value === 'light' || value === 'dark' || value === 'system';
}

export function resolveTheme(mode: ThemeMode): 'light' | 'dark' {
  if (mode !== 'system') return mode;
  if (typeof window === 'undefined') return 'light';
  return window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
}

/** Sets `data-theme`/`data-theme-mode` on <html> — the one place both ever get written. */
export function applyTheme(mode: ThemeMode): void {
  const root = document.documentElement;
  root.setAttribute('data-theme', resolveTheme(mode));
  root.setAttribute('data-theme-mode', mode);
}

const THEME_CHANGE_EVENT = 'trendly-theme-change';

/** Reads the persisted choice, defaulting to 'system'. Safe to call only on the client. */
export function getStoredTheme(): ThemeMode {
  const stored = window.localStorage.getItem(THEME_STORAGE_KEY);
  return isThemeMode(stored) ? stored : 'system';
}

/**
 * Persists the choice and notifies same-tab subscribers. The browser's
 * native `storage` event only fires in OTHER tabs/windows, never the one
 * that called setItem — this custom event is what lets this tab's own
 * ThemeToggle react immediately to its own click.
 */
export function setStoredTheme(mode: ThemeMode): void {
  window.localStorage.setItem(THEME_STORAGE_KEY, mode);
  window.dispatchEvent(new Event(THEME_CHANGE_EVENT));
}

/**
 * useSyncExternalStore subscription for the stored theme: fires on this
 * tab's own changes (the custom event above) and on changes made in other
 * tabs (the native `storage` event), so every open tab stays in sync.
 */
export function subscribeStoredTheme(callback: () => void): () => void {
  window.addEventListener('storage', callback);
  window.addEventListener(THEME_CHANGE_EVENT, callback);
  return () => {
    window.removeEventListener('storage', callback);
    window.removeEventListener(THEME_CHANGE_EVENT, callback);
  };
}

/**
 * Executed synchronously by a blocking <script> at the top of <head>,
 * before the body paints — this is what prevents a flash of the wrong
 * theme. Deliberately dependency-free and wrapped in try/catch: a blocked
 * or corrupted localStorage must never take the whole page down before
 * hydration even starts.
 */
export const THEME_INIT_SCRIPT = `(function(){try{
var k='${THEME_STORAGE_KEY}';
var stored=localStorage.getItem(k);
var mode=(stored==='light'||stored==='dark'||stored==='system')?stored:'system';
var resolved=mode==='system'
  ?(window.matchMedia('(prefers-color-scheme: dark)').matches?'dark':'light')
  :mode;
var root=document.documentElement;
root.setAttribute('data-theme',resolved);
root.setAttribute('data-theme-mode',mode);
}catch(e){}})();`;
