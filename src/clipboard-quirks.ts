// Fixes to the clipboard text that the pinned parser does not know yet.
//
// We catch up the reference data with a generator (`tools/datagen/`), but the
// parser is donor code, and we do not edit it. When a league brings an item of a
// new shape, this module converts the clipboard text to a shape that the pinned
// parser can already read. A rule lives until the donor learns it; after a pin
// bump, check the rule and most likely remove it.
//
// There are no rules now. The last one, Viscera (Covens, 3.30: clipboard without
// `Rarity:`, name with `Lesser`/`Greater`), was removed with the pin bump to
// v3.30.102: the donor parses Viscera itself. The Viscera base for the trade
// query comes from `visceraBase` in `./trade/query.ts`.

export function normalizeClipboard (text: string): string {
  return text
}
