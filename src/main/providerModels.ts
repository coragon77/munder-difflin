/**
 * Per-provider DISCOVERED model lists (card agent-harness-provider-model-l-
 * 2026-08-17). Hardcoded lists lie for providers whose catalog is scoped by
 * the actual agent/auth — pi's list depends on the logged-in account (live
 * incident: a smoke intern got a hardcoded anthropic id its auth cannot
 * reach; pi showed "no activity", zero tokens).
 *
 * Mechanism: pi exposes `pi --list-models` — a fixed-column table already
 * scoped to what the CURRENT auth can reach (no JSON flag exists, checked).
 * The id is `provider/model` (pi's own --model value form). claude keeps the
 * curated static list as the adapter's static answer; every other provider
 * keeps its static list today — the adapter extends one provider at a time.
 *
 * Failure is GRACEFUL: discovery returning null means "nothing discovered",
 * and every caller falls back to its static list — a picker must never break.
 * Results are cached with a TTL (10min) so the CLI is not spawned per render;
 * a failed discovery is retried on the next window rather than cached.
 */
import { execFile } from 'node:child_process';
import type { ModelOption } from '../shared/modelOptions';

/** Discovery TTL — long enough for a settings session, short enough to pick
 *  up a changed auth scope without a restart. */
export const MODEL_LIST_TTL_MS = 10 * 60_000;

const PI_TIMEOUT_MS = 20_000;

/** Parse `pi --list-models` output. Rows are 2+-space separated columns:
 *  provider, model, context, max-out, thinking, images. Only well-shaped
 *  rows count; anything else (header, junk) is dropped. Model ids are slugs
 *  (never contain double spaces), so the split is safe. */
export function parsePiListModels(stdout: unknown): ModelOption[] {
  if (typeof stdout !== 'string') return [];
  const out: ModelOption[] = [];
  for (const line of stdout.split('\n')) {
    const cols = line.trim().split(/\s{2,}/);
    if (cols.length < 6) continue; // header + junk lines don't have the shape
    const [provider, model] = cols;
    if (!provider || !model || provider === 'provider') continue;
    out.push({ id: `${provider}/${model}`, label: model });
  }
  return out;
}

/** Run one discovery. Returns null when nothing was discovered (CLI missing,
 *  timeout, unparseable output) — callers fall back to their static list. */
async function discoverPi(): Promise<ModelOption[] | null> {
  return new Promise((resolve) => {
    execFile(
      'pi',
      ['--list-models'],
      { timeout: PI_TIMEOUT_MS, env: { ...process.env, PI_SKIP_VERSION_CHECK: '1' } },
      (err, stdout) => {
        if (err) return resolve(null);
        const models = parsePiListModels(stdout);
        resolve(models.length ? models : null);
      },
    );
  });
}

/** Central cache so every picker (hire dialog, edit dialog, intern defaults)
 *  shares one discovery per provider per TTL window. */
export class ProviderModelCache {
  private cache = new Map<string, { models: ModelOption[]; ts: number }>();

  constructor(
    private discover: (provider: string) => Promise<ModelOption[] | null> = (p) =>
      p === 'pi' ? discoverPi() : Promise.resolve(null),
    private now: () => number = Date.now,
  ) {}

  /** Discovered models for the provider, or null — TTL-cached; failures are
   *  never cached, so the next call after the window retries. */
  async list(provider: string): Promise<ModelOption[] | null> {
    const hit = this.cache.get(provider);
    if (hit && this.now() - hit.ts < MODEL_LIST_TTL_MS) return hit.models;
    const models = await this.discover(provider);
    if (models) this.cache.set(provider, { models, ts: this.now() });
    return models;
  }
}
