// Office identity (floor sprite + accent) for a spawn broadcast.
//
// The FIRST carding of an agent derives an identity: the hire modal lets the
// operator pick, a MAIN-initiated spawn (voice hire, intern, recall) falls back
// to a cast-name match, else the default character and an id-hash accent.
// Every LATER spawn of the same id — vacation recall, unarchive, a race with
// restore — must REUSE the prior row's identity instead: it is the persisted
// hire-time pick (the roster mirror keeps it on the archived/restorable shelf
// until addAgent consumes it). Re-deriving it fresh here is exactly how a
// recalled vacationer came back with a different sprite (Ada: angela → default
// jim, card vacation-recall-sprite-change-20260816).

import type { AccentColorName } from '@/design/tokens';
import { DEFAULT_CHARACTER, OFFICE_CAST, type OfficeCharacterName } from './cast';

/** Accent rotation for derived identities — same order as the token set. */
export const SPAWN_ACCENTS = ['coral', 'mint', 'sky', 'lemon', 'lilac', 'peach'] as const;

/** A previously-carded row for the same agent id (archived / restorable shelf). */
export interface PriorIdentity {
  character?: OfficeCharacterName;
  accent?: AccentColorName;
}

/**
 * The office identity for a spawn. `prior` (a same-id row from the archived or
 * restorable shelf) wins over any derivation — a re-spawn is the same agent,
 * not a new hire.
 */
export function spawnIdentity(
  id: string,
  name: string | undefined,
  prior?: PriorIdentity,
): { character: OfficeCharacterName; accent: AccentColorName } {
  const key = (name || id).toLowerCase();
  const character =
    prior?.character ??
    OFFICE_CAST.find((m) => m.name === key || m.displayName.toLowerCase() === key)?.name ??
    DEFAULT_CHARACTER;
  let h = 0;
  for (const ch of id) h = (h + ch.charCodeAt(0)) % SPAWN_ACCENTS.length;
  return { character, accent: prior?.accent ?? SPAWN_ACCENTS[h] };
}
