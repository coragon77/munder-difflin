/**
 * Intern spawn defaults (card agent-harness-settings-section-2026-08-17).
 *
 * Settings-configurable DEFAULT provider/CLI + model for INTERN spawns
 * (persistent spawn-requests). One precedence, resolved HERE so the
 * spawn-request path stays a one-liner and the contract is unit-testable:
 *
 *   request field  >  settings default (config.internDefaults)  >  current
 *   fallback (config.defaultCommand ?? 'claude'; model stays unset so
 *   spawnAgentCore's defaultModel/modelForRole path applies).
 *
 * Settings defaults apply to interns only — the ephemeral-worker path keeps
 * today's behavior (workers ship disabled anyway). A provider named by EITHER
 * source with no explicit command derives the command from that provider's
 * preset (providerPreset().defaultCommand), which also fixes the old mismatch
 * where a raw.provider without a command spawned the 'claude' binary while
 * claiming a different provider.
 */
import { providerPreset, type AgentProvider } from '../shared/agentProvider';

/** The config slice the resolver needs — keeps the function test-pure. */
export interface InternDefaultsConfig {
  defaultCommand?: string;
  internDefaults?: { provider?: AgentProvider; model?: string };
}

/** The spawn-request fields it resolves (see SpawnRequest in index.ts). */
export interface InternSpawnRequestFields {
  command?: string;
  provider?: AgentProvider;
  model?: string;
}

export function resolveInternSpawn(
  cfg: InternDefaultsConfig,
  raw: InternSpawnRequestFields,
  intern: boolean,
): { command: string; provider?: AgentProvider; model?: string } {
  const settings = intern ? cfg.internDefaults : undefined;
  const provider = raw.provider ?? settings?.provider;
  const command =
    raw.command?.trim() ||
    (provider ? providerPreset(provider).defaultCommand : undefined) ||
    cfg.defaultCommand ||
    'claude';
  const model = raw.model?.trim() || settings?.model?.trim() || undefined;
  return { command, provider, model };
}
