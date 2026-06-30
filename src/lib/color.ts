'use client';

/**
 * Color helpers for charts that plot one line per NFL team's brand color. Several teams'
 * primary colors are very dark (Steelers/Raiders are literally #000000), which disappears
 * against this app's dark-mode card background (`--card: #111a2b`). `forDarkBackground`
 * keeps the hue/saturation but raises lightness to a visible floor, used only when
 * `useIsDarkMode` reports the OS/browser is in dark mode — light mode is untouched.
 */
import { useSyncExternalStore } from 'react';

function subscribe(onChange: () => void): () => void {
  const mq = window.matchMedia('(prefers-color-scheme: dark)');
  mq.addEventListener('change', onChange);
  return () => mq.removeEventListener('change', onChange);
}

function getSnapshot(): boolean {
  return window.matchMedia('(prefers-color-scheme: dark)').matches;
}

function getServerSnapshot(): boolean {
  return false;
}

/** True when the OS/browser prefers a dark color scheme; false during SSR/initial paint. */
export function useIsDarkMode(): boolean {
  return useSyncExternalStore(subscribe, getSnapshot, getServerSnapshot);
}

function hexToHsl(hex: string): [number, number, number] {
  const r = parseInt(hex.slice(1, 3), 16) / 255;
  const g = parseInt(hex.slice(3, 5), 16) / 255;
  const b = parseInt(hex.slice(5, 7), 16) / 255;
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  let h = 0;
  let s = 0;
  const l = (max + min) / 2;
  if (max !== min) {
    const d = max - min;
    s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
    switch (max) {
      case r:
        h = (g - b) / d + (g < b ? 6 : 0);
        break;
      case g:
        h = (b - r) / d + 2;
        break;
      default:
        h = (r - g) / d + 4;
    }
    h /= 6;
  }
  return [h * 360, s * 100, l * 100];
}

function hslToHex(h: number, s: number, l: number): string {
  const sf = s / 100;
  const lf = l / 100;
  const k = (n: number) => (n + h / 30) % 12;
  const a = sf * Math.min(lf, 1 - lf);
  const f = (n: number) => lf - a * Math.max(-1, Math.min(k(n) - 3, Math.min(9 - k(n), 1)));
  const toHex = (x: number) =>
    Math.round(x * 255)
      .toString(16)
      .padStart(2, '0');
  return `#${toHex(f(0))}${toHex(f(8))}${toHex(f(4))}`;
}

/**
 * Raise a hex color's lightness to a visible floor, preserving hue/saturation (so e.g. pure
 * black becomes mid-gray, not white). Pass through unchanged if already light enough.
 */
export function forDarkBackground(hex: string, minLightness = 48): string {
  const [h, s, l] = hexToHsl(hex);
  return l >= minLightness ? hex : hslToHex(h, s, minLightness);
}
