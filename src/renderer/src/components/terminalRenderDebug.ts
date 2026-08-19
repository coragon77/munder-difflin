/**
 * Pure validation for the renderer's terminal debug handle
 * (window.__cthTermDebug — installed from main.tsx, implemented in
 * terminalPool.ts).
 *
 * Split out of terminalPool so it stays loadable under node --test:
 * terminalPool's import graph ends in @xterm/xterm's stylesheet, which node
 * cannot require. The handle's input is whatever someone typed into the
 * DevTools console — hostile by default, so every value is validated and
 * clamped here before it ever reaches a Terminal.
 */

/** The xterm render options the debug handle may flip at runtime. A closed
 *  set on purpose: this is a diagnosis instrument for the pane flicker/blur
 *  report, not a settings API — anything the glyph-atlas / renderer hypotheses
 *  don't need stays off it. */
export interface TerminalRenderOptionPatch {
  /** Suspect #1 for the flicker/blur: with a ratio above 1, xterm computes a
   *  per-cell foreground, so one character becomes many glyph-atlas entries
   *  keyed by (glyph, fg, bg) and a full atlas gets cleared and re-rasterized.
   *  1 means "no adjustment" — the diagnosis value; 4.5 is the shipped
   *  default (WCAG AA). xterm accepts 1..21. */
  minimumContrastRatio?: number;
  fontFamily?: string;
  fontSize?: number;
  lineHeight?: number;
}

const MIN_CONTRAST = 1;
const MAX_CONTRAST = 21;
const MIN_FONT_SIZE = 6;
const MAX_FONT_SIZE = 72;
const MIN_LINE_HEIGHT = 0.8;
const MAX_LINE_HEIGHT = 2;

function clamp(n: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, n));
}

/** Validate + clamp one patch of console-provided render options. Unknown
 *  keys and values with the wrong type are DROPPED, not thrown on: a typo in
 *  a diagnosis session must never take down every open terminal. An empty
 *  result means "nothing applicable — leave everything as it was". */
export function sanitizeTerminalRenderOptionPatch(input: unknown): TerminalRenderOptionPatch {
  const patch: TerminalRenderOptionPatch = {};
  if (typeof input !== 'object' || input === null) return patch;
  const raw = input as Record<string, unknown>;

  if (typeof raw.minimumContrastRatio === 'number' && Number.isFinite(raw.minimumContrastRatio)) {
    patch.minimumContrastRatio = clamp(raw.minimumContrastRatio, MIN_CONTRAST, MAX_CONTRAST);
  }
  if (typeof raw.fontFamily === 'string' && raw.fontFamily.trim()) {
    patch.fontFamily = raw.fontFamily;
  }
  if (typeof raw.fontSize === 'number' && Number.isFinite(raw.fontSize)) {
    patch.fontSize = clamp(Math.round(raw.fontSize), MIN_FONT_SIZE, MAX_FONT_SIZE);
  }
  if (typeof raw.lineHeight === 'number' && Number.isFinite(raw.lineHeight)) {
    patch.lineHeight = clamp(raw.lineHeight, MIN_LINE_HEIGHT, MAX_LINE_HEIGHT);
  }
  return patch;
}
