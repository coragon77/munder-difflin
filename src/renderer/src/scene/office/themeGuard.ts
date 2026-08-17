// Theme-switch safety (card agent-harness-custom-office-th-2026-08-17): the
// pure predicates behind the NON-DESTRUCTIVE theme switch and the broken-map
// guard. Asset-free so the .cjs test harness can load it (same extraction
// pattern as worktreeAdopt / vacationBusy).

/** The names a theme map must carry for the floor to run: the entrance
 *  (waiting rings + envelope target), every seat/stand the scene claims, and
 *  the two zones (boardroom overflow seating, cafeteria). A map the operator
 *  edited in Tiled may drop these — the guard refuses such a map. */
export function requiredAnchors(t: {
  primarySeatNames: string[];
  cafeSeatNames: string[];
  cafeStands: ReadonlyArray<readonly [string, string]>;
}): string[] {
  return [
    'entrance',
    'boardroom',
    'cafeteria',
    ...t.primarySeatNames,
    ...t.cafeSeatNames,
    ...t.cafeStands.map(([name]) => name),
  ];
}

/** Every named object across the map's object groups (spawn-points + zones). */
export function mapObjectNames(mapRaw: string): string[] {
  try {
    const m = JSON.parse(mapRaw) as {
      layers?: Array<{ type?: string; objects?: Array<{ name?: string }> }>;
    };
    const names: string[] = [];
    for (const layer of m.layers ?? [])
      if (layer.type === 'objectgroup')
        for (const o of layer.objects ?? []) if (o.name) names.push(o.name);
    return names;
  } catch {
    return [];
  }
}

/** Anchors a theme map is missing — a non-empty list REFUSES the switch; a
 *  broken custom map must never take the floor down. */
export function missingAnchors(mapRaw: string, required: string[]): string[] {
  const have = new Set(mapObjectNames(mapRaw));
  return required.filter((n) => !have.has(n));
}

/** May a theme switch keep the LIVE roster (no kill/archive teardown)?
 *  All three must hold: the target opts in (preservesAgents), every live
 *  character resolves in the target cast (else agents would silently
 *  re-skin), and the workers fit the target's seats (god takes seat 0). */
export function switchPreservesAgents(i: {
  preservesAgents: boolean;
  liveCharacters: string[];
  castByName: Record<string, unknown>;
  liveWorkers: number;
  workerSeats: number;
}): boolean {
  return (
    i.preservesAgents &&
    i.liveWorkers <= i.workerSeats &&
    i.liveCharacters.every((c) => c in i.castByName)
  );
}
