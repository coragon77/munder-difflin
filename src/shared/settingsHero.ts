/**
 * The Settings hero card's field logic (card agent-settings-hero-card-port--
 * 2026-08-18). The card SHAPE is ported from upstream 1b821b3 by intent; the
 * remote-fetch delivery mechanism (hero.json over the wire, fetchText, the
 * payload validator) is deliberately DROPPED — we are one operator on one
 * box, so there is no publisher and no stranger's payload to harden against.
 * The card takes its fields as PROPS; this module turns local state into
 * rows. Contents are a PLACEHOLDER until the operator decides what the slot
 * is for — keep swapping them cheap.
 *
 * Pure by design: no React, no IPC — loadable from node:test. The engine and
 * floor resolution chains MIRROR the real ones and are pinned against the
 * REAL functions by test/settings-hero-card.test.cjs:
 *   - helper engine: helperDefaults.provider > godProvider > 'claude'
 *     (SettingsModal's chain, src/main/config.ts:325);
 *   - floor: floorCensus (src/main/hive.ts:307) + normalizeFloorMaxAgents
 *     (src/main/config.ts:716) semantics.
 */

import { providerPreset } from './agentProvider';

/** One rendered row of the card: label, value, optional quiet hint. */
export interface HeroRow {
  label: string;
  value: string;
  hint?: string;
}

interface HeroConfigSlice {
  godProvider?: string;
  godModel?: string;
  helperDefaults?: { provider?: string; model?: string };
  floorMaxAgents?: number;
}

interface HeroAgentSlice {
  isGod?: boolean;
  archived?: boolean;
  vacation?: boolean;
  retired?: boolean;
}

/** 7-char short sha, or null for missing/junk — a settings card shows facts,
 *  never a wrong guess at one. */
export function shortSha(sha: unknown): string | null {
  if (typeof sha !== 'string' || !/^[0-9a-f]{7,40}$/.test(sha)) return null;
  return sha.slice(0, 7);
}

function floorMaxOf(n: unknown): number {
  // Mirrors normalizeFloorMaxAgents (src/main/config.ts) — clamped 1..16, 16
  // when unset/nonsense. Equality pinned by test against the real function.
  return typeof n === 'number' && Number.isFinite(n)
    ? Math.min(16, Math.max(1, Math.floor(n)))
    : 16;
}

/** Mirrors floorCensus (src/main/hive.ts): everyone on the registry except
 *  god (own desk), archived (closed tab), vacation (parked), retired (fired).
 *  Equality pinned by test against the real function. */
function onFloorOf(registry: unknown): number | null {
  const reg = registry as { godId?: unknown; agents?: unknown } | null | undefined;
  const agents = reg?.agents;
  if (!agents || typeof agents !== 'object') return null;
  let n = 0;
  for (const [id, a] of Object.entries(agents as Record<string, HeroAgentSlice>)) {
    if (id === reg?.godId || a?.isGod) continue;
    if (a?.archived || a?.vacation || a?.retired) continue;
    n++;
  }
  return n;
}

/** Engine display name: the provider preset's label (same names the AI
 *  Engines tab shows), lowercased — a settings row, not a headline. */
function engineLabel(provider: unknown): string {
  const p = typeof provider === 'string' && provider ? provider : 'claude';
  try {
    return providerPreset(p as never).label.toLowerCase();
  } catch {
    return p;
  }
}

/** Build the card's rows from local state. Every unknown degrades to '—'
 *  (the card is never empty and never crashes on a surprise). */
export function heroRows(input: {
  config: HeroConfigSlice | null | undefined;
  registry: unknown;
  version: string | null | undefined;
  headSha: string | null | undefined;
}): HeroRow[] {
  const cfg = (input.config ?? {}) as HeroConfigSlice;

  const god = engineLabel(cfg.godProvider);
  const godModel =
    typeof cfg.godModel === 'string' && cfg.godModel.trim() ? cfg.godModel.trim() : null;
  const helperProvider = (cfg.helperDefaults?.provider ?? '').trim() || cfg.godProvider || 'claude';
  const helper = engineLabel(helperProvider);
  const helperModel =
    typeof cfg.helperDefaults?.model === 'string' && cfg.helperDefaults.model.trim()
      ? cfg.helperDefaults.model.trim()
      : null;

  const onFloor = onFloorOf(input.registry);
  const max = floorMaxOf(cfg.floorMaxAgents);
  const floor =
    onFloor === null
      ? { value: '—' as const, hint: undefined as string | undefined }
      : {
          value: `${onFloor}/${max} seats` as const,
          hint:
            onFloor >= max ? 'full — spawns refused until a seat frees' : `${max - onFloor} free`,
        };

  const sha = shortSha(input.headSha);

  return [
    {
      label: 'version',
      value: typeof input.version === 'string' && input.version ? input.version : '—',
    },
    { label: 'god engine', value: godModel ? `${god} · ${godModel}` : god },
    {
      label: 'helper engine',
      value: helperModel ? `${helper} · ${helperModel}` : helper,
    },
    { label: 'floor', value: floor.value, hint: floor.hint },
    { label: 'live checkout', value: sha ?? '—', hint: sha ? undefined : 'no git head' },
  ];
}
