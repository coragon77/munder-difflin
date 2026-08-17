// Office identity (floor sprite + accent) for a spawn broadcast.
//
// The FIRST carding of an agent derives an identity: the hire modal lets the
// operator pick, a MAIN-initiated spawn (voice hire, intern, recall) falls
// back to a cast-name match, then a female-coded name (Angela's sprite),
// else the default character and an id-hash accent.
// Every LATER spawn of the same id — vacation recall, unarchive, a race with
// restore — must REUSE the prior identity instead: the registry-saved pick
// first (agent-icon-persistence-20260817), else the persisted hire-time row
// (the roster mirror keeps it on the archived/restorable shelf until addAgent
// consumes it). Re-deriving it fresh here is exactly how a recalled vacationer
// came back with a different sprite (Ada: angela → default jim, card
// vacation-recall-sprite-change-20260816).

import type { AccentColorName } from '@/design/tokens';
import { DEFAULT_CHARACTER, OFFICE_CAST, type OfficeCharacterName } from './cast';

/** Accent rotation for derived identities — same order as the token set. */
export const SPAWN_ACCENTS = ['coral', 'mint', 'sky', 'lemon', 'lilac', 'peach'] as const;

/** Female-coded names for the derivation rung (card
 *  agent-harness-gendered-intern--2026-08-17): a main-initiated spawn (intern,
 *  voice hire, recall) wearing one of these names gets Angela's sprite; every
 *  other name keeps the default character (jim). God picks the name to match
 *  the sprite he wants (godLine INTERN SPRITES rule); the saved/prior rungs
 *  always outrank this map. Lowercase; matched against every letter token
 *  of the spawn key (name, else id — live patterns: 'holly (intern)',
 *  'intern-holly'). Cast members are deliberately absent — the cast-name
 *  rung handles them. */
export const FEMALE_CODED_NAMES: ReadonlySet<string> = new Set([
  'ada',
  'alice',
  'amelia',
  'amy',
  'ana',
  'anna',
  'barbara',
  'bella',
  'beth',
  'carol',
  'clara',
  'daisy',
  'diana',
  'edith',
  'elena',
  'eliza',
  'elsa',
  'emma',
  'erin',
  'eva',
  'freya',
  'grace',
  'gwen',
  'hannah',
  'hazel',
  'heidi',
  'holly',
  'iris',
  'ivy',
  'jade',
  'jane',
  'jessica',
  'julia',
  'kate',
  'laura',
  'leah',
  'lily',
  'lisa',
  'lucy',
  'luna',
  'mandy',
  'maria',
  'maya',
  'meg',
  'mia',
  'molly',
  'nina',
  'nora',
  'olive',
  'olivia',
  'pearl',
  'penny',
  'polly',
  'rachel',
  'rosa',
  'rose',
  'ruby',
  'ruth',
  'sally',
  'sara',
  'sarah',
  'sofia',
  'sophie',
  'stella',
  'susan',
  'tessa',
  'tina',
  'vera',
  'wanda',
  'willow',
  'zoe',
]);

/** A previously-carded row for the same agent id (archived / restorable shelf). */
export interface PriorIdentity {
  character?: OfficeCharacterName;
  accent?: AccentColorName;
}

/** A registry-saved identity (officeCharacter/officeAccent) riding a spawn
 *  broadcast — plain strings from main, validated here against the cast. */
export interface SavedIdentity {
  character?: string;
  accent?: string;
}

/**
 * The office identity for a spawn. Ladder, top rung first:
 *  1. `saved` — the registry-saved hire-time pick (durable across renderer
 *     data loss; the fix for recalled agents wearing a stranger's sprite,
 *     card agent-icon-persistence-20260817).
 *  2. `prior` — a same-id row from the archived/restorable shelf (the
 *     roster-mirror copy addAgent is about to consume).
 *  3. Derivation — cast-name match, else a female-coded name gets Angela
 *     (gendered intern sprites, card agent-harness-gendered-intern--
 *     2026-08-17), else the default character — with a stable id-hash
 *     accent.
 * Unknown `saved` names (a registry written by a different cast version) are
 * ignored per-field, never rendered.
 */
export function spawnIdentity(
  id: string,
  name: string | undefined,
  prior?: PriorIdentity,
  saved?: SavedIdentity,
): { character: OfficeCharacterName; accent: AccentColorName } {
  const key = (name || id).toLowerCase();
  const savedCharacter = saved?.character;
  const isKnownCharacter = (c: string): c is OfficeCharacterName =>
    OFFICE_CAST.some((m) => m.name === c);
  const savedAccent = saved?.accent;
  const isKnownAccent = (a: string): a is AccentColorName =>
    (SPAWN_ACCENTS as readonly string[]).includes(a);
  const castMatch = OFFICE_CAST.find(
    (m) => m.name === key || m.displayName.toLowerCase() === key,
  )?.name;
  const femaleCoded = key.split(/[^a-z]+/).some((t) => FEMALE_CODED_NAMES.has(t));
  const character =
    (savedCharacter && isKnownCharacter(savedCharacter) ? savedCharacter : undefined) ??
    prior?.character ??
    castMatch ??
    (femaleCoded ? 'angela' : DEFAULT_CHARACTER);
  const accent =
    (savedAccent && isKnownAccent(savedAccent) ? savedAccent : undefined) ?? prior?.accent;
  if (accent) return { character, accent };
  let h = 0;
  for (const ch of id) h = (h + ch.charCodeAt(0)) % SPAWN_ACCENTS.length;
  return { character, accent: SPAWN_ACCENTS[h] };
}
