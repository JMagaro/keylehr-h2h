/**
 * Unit tests for `forDarkBackground` — several NFL primary colors are very dark
 * (Steelers/Raiders are literally #000000), which disappears against this app's
 * dark-mode card background. This raises lightness to a visible floor while
 * preserving hue/saturation, and leaves already-light colors untouched.
 */
import { describe, it, expect } from 'vitest';
import { forDarkBackground } from './color';

function hexToLightness(hex: string): number {
  const r = parseInt(hex.slice(1, 3), 16) / 255;
  const g = parseInt(hex.slice(3, 5), 16) / 255;
  const b = parseInt(hex.slice(5, 7), 16) / 255;
  return ((Math.max(r, g, b) + Math.min(r, g, b)) / 2) * 100;
}

describe('forDarkBackground', () => {
  it('lightens pure black to a visible mid-gray, preserving achromatic hue', () => {
    const result = forDarkBackground('#000000');
    expect(hexToLightness(result)).toBeCloseTo(48, 0);
    // Achromatic in, achromatic out (R=G=B).
    expect(result.slice(1, 3)).toBe(result.slice(3, 5));
    expect(result.slice(3, 5)).toBe(result.slice(5, 7));
  });

  it('lightens a very dark saturated color while preserving its hue', () => {
    // Steelers black is covered above; use Patriots navy (#002244) for a chromatic case.
    const result = forDarkBackground('#002244');
    expect(hexToLightness(result)).toBeGreaterThanOrEqual(48);
    // Still blue-ish: blue channel should remain the dominant channel.
    const r = parseInt(result.slice(1, 3), 16);
    const g = parseInt(result.slice(3, 5), 16);
    const b = parseInt(result.slice(5, 7), 16);
    expect(b).toBeGreaterThan(r);
    expect(b).toBeGreaterThan(g);
  });

  it('leaves an already-light color unchanged', () => {
    // Saints gold (#D3BC8D) is well above the default 48% lightness floor.
    expect(forDarkBackground('#D3BC8D')).toBe('#D3BC8D');
  });

  it('respects a custom minLightness floor', () => {
    const result = forDarkBackground('#000000', 30);
    expect(hexToLightness(result)).toBeCloseTo(30, 0);
  });
});
