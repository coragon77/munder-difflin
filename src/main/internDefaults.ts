/**
 * Intern spawn defaults (card agent-harness-settings-section-2026-08-17).
 *
 * Settings-configurable DEFAULT provider/CLI + model for INTERN spawns
 * (persistent spawn-requests). One precedence, resolved HERE so the
 * spawn-request path stays a one-liner and the contract is unit-testable:
 *
 *   request engine identity (command/provider/model as a PAIR)  >  settings
 *   default pair (config.internDefaults, applied verbatim when the request
 *   names NO engine field)  >  current fallback (config.defaultCommand ??
 *   'claude'; model stays unset so spawnAgentCore's defaultModel/modelForRole
 *   path applies). Never a per-field mix across sources.
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
  const reqProvider = raw.provider || undefined;
  const reqModel = raw.model?.trim() || undefined;
  const reqCommand = raw.command?.trim() || undefined;
  // PAIR COHERENCE (card agent-build-hive-hire-the-miss-2026-08-18): a
  // request that names ANY engine field (command, provider OR model) is
  // authoritative for the WHOLE engine identity — settings defaults never
  // fill a missing half. The old per-field merge grafted the request's
  // provider onto the settings' model and launched
  // `claude --model openai-codex/gpt-5.6-sol` (a pi model id on the claude
  // binary, read from /proc/<pid>/cmdline, 2026-08-18). Either the pair comes
  // from the request, or the pair comes from settings — never a mix.
  const requestNamesEngine = !!(reqProvider || reqModel || reqCommand);
  const provider = requestNamesEngine ? reqProvider : (settings?.provider ?? undefined);
  const model = requestNamesEngine ? reqModel : settings?.model?.trim() || undefined;
  const command =
    reqCommand ||
    (provider ? providerPreset(provider).defaultCommand : undefined) ||
    cfg.defaultCommand ||
    'claude';
  return { command, provider, model };
}
