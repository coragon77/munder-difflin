/**
 * The hero card at the top of Settings → General (card
 * agent-settings-hero-card-port--2026-08-18).
 *
 * SHAPE ported from upstream 1b821b3 by intent: one prominent, deliberately
 * QUIET card that answers "what is this install" at a glance, sitting above
 * the settings it introduces — anything louder would be noise every time
 * someone opens this dialog to change a folder.
 *
 * The remote-fetch delivery mechanism is DROPPED (one operator, one box, no
 * publisher): no remote hero payload, no fetch helper, no payload validator.
 * The card is a pure PROPS-DRIVEN SLOT — no effects, no fetching, no internal
 * state — so
 * swapping its contents is cheap while the operator decides what the slot is
 * for. Today's rows (god engine, helper engine, floor occupancy, live
 * checkout sha) are a PLACEHOLDER assembled by the caller from local state
 * via shared/settingsHero.ts.
 *
 * Every value is a React text node (the one hardening rule worth keeping
 * from upstream even without a network path: data is never markup).
 */
import type { HeroRow } from '@shared/settingsHero';
import { PixelButton } from './PixelButton';

export interface SettingsHeroCardProps {
  /** App name shown in the identity line. */
  name: string;
  /** Running version, or null while unknown. */
  version: string | null;
  /** Small uppercase badge next to the name (e.g. 'HIVE'). */
  badge?: string;
  /** The placeholder rows — label/value/hint, built by shared/settingsHero. */
  rows: HeroRow[];
  /** Optional quiet action pinned to the identity row (the app-level "what's
   *  new" belongs here, not to any setting below). */
  action?: { label: string; onClick: () => void };
}

export function SettingsHeroCard({ name, version, badge, rows, action }: SettingsHeroCardProps) {
  return (
    <div
      data-testid="settings-hero-card"
      style={{
        display: 'flex',
        flexDirection: 'column',
        gap: 12,
        padding: 14,
        background: 'var(--cth-cream-100)',
        boxShadow: 'inset 0 0 0 1px var(--cth-ink-300)',
      }}
    >
      {/* Identity — the one place the display font gets to speak. */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
        <span
          style={{
            fontFamily: 'var(--cth-font-display)',
            fontSize: 12,
            lineHeight: '18px',
            color: 'var(--cth-ink-900)',
          }}
        >
          {name}
        </span>
        {version && (
          <span
            style={{
              fontFamily: 'var(--cth-font-mono)',
              fontSize: 11,
              color: 'var(--cth-ink-500)',
            }}
          >
            v{version}
          </span>
        )}
        {badge && (
          <span
            style={{
              fontFamily: 'var(--cth-font-display)',
              fontSize: 8,
              letterSpacing: 0.5,
              textTransform: 'uppercase',
              padding: '2px 6px',
              background: 'var(--cth-mint-light)',
              boxShadow: 'inset 0 0 0 1px var(--cth-mint)',
              color: 'var(--cth-ink-900)',
            }}
          >
            {badge}
          </span>
        )}
        <span style={{ flex: 1 }} />
        {action && (
          <PixelButton variant="secondary" size="sm" onClick={action.onClick}>
            {action.label}
          </PixelButton>
        )}
      </div>

      {/* The at-a-glance strip: label left, mono value right, quiet hint
       *  under the value. Coral is reserved for the one state that needs
       *  acting on (a full floor). */}
      <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
        {rows.map((r) => (
          <div
            key={r.label}
            style={{ display: 'flex', alignItems: 'baseline', gap: 10, flexWrap: 'wrap' }}
          >
            <span
              style={{
                fontFamily: 'var(--cth-font-display)',
                fontSize: 8,
                letterSpacing: 0.5,
                textTransform: 'uppercase',
                color: 'var(--cth-ink-500)',
                width: 110,
                flexShrink: 0,
              }}
            >
              {r.label}
            </span>
            <span
              style={{
                fontFamily: 'var(--cth-font-mono)',
                fontSize: 12,
                color:
                  /full/i.test(r.hint ?? '') && r.label === 'floor'
                    ? 'var(--cth-coral)'
                    : 'var(--cth-ink-900)',
              }}
            >
              {r.value}
            </span>
            {r.hint && <span style={{ fontSize: 11, color: 'var(--cth-ink-500)' }}>{r.hint}</span>}
          </div>
        ))}
      </div>
    </div>
  );
}
