/**
 * SKILLS — local inventory only: what the coding agents on this machine can
 * already do, walked from the directories each CLI reads. No catalog, no
 * install, no uninstall (card agent-skills-panel-local-inven-2026-08-18):
 * adding a skill is a decision, not a click, and a public skill store is a
 * supply-chain surface for no gain.
 */
import { useCallback, useEffect, useMemo, useState } from 'react';
import { PixelButton } from './PixelButton';
import type { LocalSkill } from '../../../preload';

const PROVIDER_LABEL: Record<LocalSkill['provider'], string> = {
  claude: 'Claude Code',
  opencode: 'OpenCode',
  codex: 'Codex',
};

function Chip({ text, tone = 'quiet' }: { text: string; tone?: 'quiet' | 'accent' }) {
  return (
    <span
      style={{
        fontSize: 10,
        fontFamily: 'var(--cth-font-display)',
        letterSpacing: 0.4,
        padding: '2px 6px',
        flexShrink: 0,
        textTransform: 'uppercase',
        color: 'var(--cth-ink-900)',
        background: tone === 'accent' ? 'var(--cth-mint-light)' : 'var(--cth-cream-200)',
        boxShadow: `inset 0 0 0 1px ${tone === 'accent' ? 'var(--cth-mint)' : 'var(--cth-ink-300)'}`,
      }}
    >
      {text}
    </span>
  );
}

const rowStyle: React.CSSProperties = {
  display: 'flex',
  flexDirection: 'column',
  gap: 5,
  padding: 10,
  background: 'var(--cth-paper-100)',
  boxShadow: 'inset 0 0 0 1px var(--cth-ink-300)',
  color: 'var(--cth-ink-900)',
};

export function SkillsTab() {
  const [query, setQuery] = useState('');
  const [local, setLocal] = useState<LocalSkill[] | null>(null);
  const [busy, setBusy] = useState(false);
  /** Per-row action state keyed by path — one row's reveal error must not read
   *  as the whole tab failing. */
  const [rowError, setRowError] = useState<Record<string, string>>({});

  const loadLocal = useCallback(async () => {
    setBusy(true);
    try {
      setLocal(await window.cth.skillsLocal());
    } catch {
      setLocal([]);
    } finally {
      setBusy(false);
    }
  }, []);

  useEffect(() => {
    void loadLocal();
  }, [loadLocal]);

  const reveal = async (s: LocalSkill) => {
    try {
      const res = await window.cth.skillsReveal(s.path);
      if (!res.ok) setRowError((e) => ({ ...e, [s.path]: res.error ?? 'could not open it' }));
    } catch (err) {
      setRowError((e) => ({
        ...e,
        [s.path]: err instanceof Error ? err.message : 'could not open it',
      }));
    }
  };

  const q = query.trim().toLowerCase();
  const shown = useMemo(() => {
    const list = local ?? [];
    if (!q) return list;
    return list.filter(
      (s) => s.name.toLowerCase().includes(q) || s.description.toLowerCase().includes(q),
    );
  }, [local, q]);

  return (
    <div style={{ display: 'flex', flexDirection: 'column', minHeight: 0, height: '100%' }}>
      <div
        style={{
          flexShrink: 0,
          display: 'flex',
          gap: 8,
          alignItems: 'center',
          flexWrap: 'wrap',
          padding: 10,
          borderBottom: '1px solid var(--cth-ink-300)',
        }}
      >
        <span
          style={{
            fontFamily: 'var(--cth-font-display)',
            fontSize: 12,
            color: 'var(--cth-ink-900)',
          }}
        >
          installed{local ? ` (${local.length})` : ''}
        </span>
        <input
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="Search installed skills…"
          style={{
            flex: 1,
            minWidth: 140,
            padding: '4px 8px',
            background: 'var(--cth-paper-100)',
            color: 'var(--cth-ink-900)',
            border: 'none',
            boxShadow: 'inset 0 0 0 1px var(--cth-ink-300)',
            fontFamily: 'var(--cth-font-ui)',
            fontSize: 12,
          }}
        />
        <PixelButton variant="ghost" size="sm" onClick={() => void loadLocal()} disabled={busy}>
          {busy ? 'scanning…' : 'refresh'}
        </PixelButton>
      </div>

      <div style={{ flex: 1, minHeight: 0, overflowY: 'auto', padding: 10 }}>
        {local === null ? (
          <Muted>Scanning…</Muted>
        ) : shown.length === 0 ? (
          <Muted>
            {local.length === 0
              ? 'No skills found yet. Skills live in ~/.claude/skills or .claude/skills inside a repo.'
              : 'Nothing matches that search.'}
          </Muted>
        ) : (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
            {shown.map((s) => (
              <div key={s.id + s.path} style={rowStyle}>
                <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
                  <span
                    style={{
                      fontFamily: 'var(--cth-font-display)',
                      fontSize: 11,
                      flex: 1,
                      minWidth: 0,
                    }}
                  >
                    {s.name.toUpperCase()}
                  </span>
                  <Chip text={PROVIDER_LABEL[s.provider]} />
                  <Chip text={s.scope} tone={s.scope === 'project' ? 'accent' : 'quiet'} />
                </div>
                {s.description && (
                  <div style={{ fontSize: 12, color: 'var(--cth-ink-700)', lineHeight: 1.45 }}>
                    {s.description.length > 220 ? `${s.description.slice(0, 220)}…` : s.description}
                  </div>
                )}
                <div
                  style={{
                    fontFamily: 'var(--cth-font-mono)',
                    fontSize: 10.5,
                    color: 'var(--cth-ink-500)',
                    wordBreak: 'break-all',
                  }}
                >
                  {s.path}
                </div>
                <div style={{ display: 'flex', gap: 6, alignItems: 'center', flexWrap: 'wrap' }}>
                  <button
                    onClick={() => void reveal(s)}
                    style={{
                      padding: '3px 9px 2px',
                      border: 'none',
                      cursor: 'pointer',
                      flexShrink: 0,
                      fontFamily: 'var(--cth-font-ui)',
                      fontSize: 11,
                      color: 'var(--cth-ink-900)',
                      background: 'var(--cth-cream-200)',
                      boxShadow: 'inset 0 0 0 1px var(--cth-ink-300)',
                    }}
                  >
                    open folder
                  </button>
                  {s.scope === 'bundled' && (
                    <span style={{ fontSize: 11, color: 'var(--cth-ink-500)' }}>
                      ships with the app
                    </span>
                  )}
                  {rowError[s.path] && (
                    <span style={{ fontSize: 11, color: 'var(--cth-coral)' }}>
                      {rowError[s.path]}
                    </span>
                  )}
                </div>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

function Muted({ children }: { children: React.ReactNode }) {
  return <div style={{ fontSize: 12, color: 'var(--cth-ink-500)', padding: 6 }}>{children}</div>;
}
