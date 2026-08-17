import { useEffect, useState } from 'react';
import { modelsForProvider, type ModelOption } from '@/store/config';
import type { AgentProvider } from '@shared/agentProvider';

/**
 * Per-provider model options with LIVE DISCOVERY (card
 * agent-harness-provider-model-l-2026-08-17): renders the static curated
 * list immediately (a picker must never be empty or broken), then swaps in
 * the DISCOVERED auth-scoped list when main's adapter returns one (pi:
 * `pi --list-models`, TTL-cached main-side). Discovery failure keeps the
 * static list — graceful by construction.
 */
export function useProviderModels(provider: AgentProvider): ModelOption[] {
  const [discovered, setDiscovered] = useState<ModelOption[] | null>(null);
  useEffect(() => {
    let alive = true;
    setDiscovered(null);
    window.cth
      .providerListModels?.(provider)
      .then((r) => {
        if (alive && r?.discovered && r.models?.length) setDiscovered(r.models);
      })
      .catch(() => {
        /* keep static */
      });
    return () => {
      alive = false;
    };
  }, [provider]);
  return discovered ?? modelsForProvider(provider);
}
