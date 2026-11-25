// Table of game features.
//
// PoE2 is the declared next stage (ADR 0001), so the differences between game
// versions live here, not in `if (version === 2)` across the code: consumers
// read `features.foo` and do not know the game version. The technique comes from
// scalpel as an idea, not as code: scalpel is AGPL-3.0, we borrow nothing from it.
//
// The second column is empty on purpose: the PoE1 donor has no second game at all
// (0 matches for `poe2` in 238 files), and to fill the table for it before the
// PoE2 stage would be invention. We need the shape, not the content.

export type GameVersion = 'poe1' | 'poe2'

export interface GameFeatures {
  readonly version: GameVersion
  /**
   * Directory of the donor pin. The parser and the base `.ndjson` reference data
   * come from here at one commit: a mismatch between them is what makes `init()` fail.
   */
  readonly donorDir: string
  /**
   * Directory of our delta to the pinned reference data: `<language>/*.delta.ndjson`
   * and `SOURCES.json`. `tools/datagen/` writes it from the game files when the donor
   * has not released data for a new league yet. The built result is `<dataDir>/.public/`.
   */
  readonly dataDir: string
  /**
   * Chord that copies an item. It must be the advanced item description: on a plain
   * `Ctrl+C` the parser silently returns the item without mods (ADR 0001, I2).
   */
  readonly copyItemChord: string
  /**
   * Steam AppId of the game. gamescope puts it in `GAMESCOPE_FOCUSED_APP` on the root,
   * and the daemon uses it to tell "game on screen" from "Steam UI": the auto-hide
   * without which it would hang over the QAM (overlay spike, exp. 6).
   */
  readonly steamAppId: number
}

const TABLE: { readonly [V in GameVersion]?: GameFeatures } = {
  poe1: {
    version: 'poe1',
    donorDir: 'vendor/awakened-poe-trade',
    dataDir: 'data/poe1',
    copyItemChord: 'Ctrl+Alt+C',
    // Taken from a live Deck: the Steam Input config path contains `.../238960/`,
    // and the same number was in `GAMESCOPE_FOCUSED_APP` while PoE was running
    // (overlay spike, exp. 4).
    steamAppId: 238960
  }
}

export function gameFeatures (version: GameVersion): GameFeatures {
  const features = TABLE[version]
  if (!features) {
    throw new Error(
      `GameFeatures: column ${version} is not filled in yet — see ADR 0001, § "PoE1 first, PoE2 next"`
    )
  }
  return features
}
