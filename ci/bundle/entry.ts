// Entry point of the daemon built as one executable file.
//
//   bun build --compile ci/bundle/entry.ts --root . \
//     --asset-naming '[dir]/[name].[ext]' --outfile dist/poe-deck/poe-deck
//
// The full recipe is ci/bundle/build-daemon.sh. Here is what the source does not have:
//
//  1. Donor modules are imported by a LITERAL path. `src/donor.ts` loads them by a
//     template path from the pin dir, and the bundler does not see such an
//     `import()`, so nothing would be embedded in the file.
//  2. Donor reference data is embedded as files (`with { type: 'file' }`). With
//     `--asset-naming '[dir]/[name].[ext]'` it sits in `/$bunfs/root/` in the same
//     tree as in the repository, so donor `fetch` and `import()` by
//     `BASE_URL` find it with no change in the donor code.
//  3. The reference data is not the pin as is, but the pin with our delta:
//     build-daemon.sh builds it and its binary indexes into `data/poe1/.public/`
//     before the build, with the same `assembleDonorData` that the source runs at first start.
//     The player has nothing to build and nowhere to write: rootfs is read-only, and
//     the daemon puts nothing into `$HOME`.
//
// The file is outside `src/` because the project tsc does not check donor code
// (tsconfig.json, exclude vendor), and a static import would pull it into the check.

import * as data from '../../vendor/awakened-poe-trade/renderer/src/assets/data/index.ts'
import * as parser from '../../vendor/awakened-poe-trade/renderer/src/parser/index.ts'

import items from '../../data/poe1/.public/data/en/items.ndjson' with { type: 'file' }
import '../../data/poe1/.public/data/en/stats.ndjson' with { type: 'file' }
import '../../data/poe1/.public/data/en/client_strings.js' with { type: 'file' }
import '../../data/poe1/.public/data/en/items-name.index.bin' with { type: 'file' }
import '../../data/poe1/.public/data/en/items-ref.index.bin' with { type: 'file' }
import '../../data/poe1/.public/data/en/stats-ref.index.bin' with { type: 'file' }
import '../../data/poe1/.public/data/en/stats-matcher.index.bin' with { type: 'file' }
import '../../data/poe1/.public/data/item-drop.json' with { type: 'file' }
import '../../data/poe1/.public/data/patrons.json' with { type: 'file' }

import { readFileSync } from 'node:fs'
import { effectiveSettings, loadConfig } from '../../src/config'
import { main } from '../../src/daemon'
import { doctor } from '../../src/doctor'
import { loadDonorParser, useBundledDonor } from '../../src/donor'
import { DEFAULT_PROFILE_SOURCE, formatMapCheck, loadProfile, mapCheckOf } from '../../src/map-check'
import { formatPriceCheck, priceOf } from '../../src/price-check'
import { formatItem } from '../../src/slice'

/** Build: poe-deck commit and donor pin. `--define` in build-daemon.sh sets it. */
declare const POE_DECK_BUILD: string

useBundledDonor({
  publicDir: items.slice(0, items.lastIndexOf('data/en/items.ndjson')),
  version: 'poe1',
  lang: 'en',
  data,
  parser
})

const argv = process.argv.slice(2)

if (argv[0] === '--version') {
  console.log(`poe-deck ${POE_DECK_BUILD}`)
  process.exit(0)
}

// Self-check for the player: link by link, ✓ or ✗ with a hint.
if (argv[0] === 'doctor') process.exit(await doctor(POE_DECK_BUILD))

// The default map check profile, for the player to copy and edit:
//   poe-deck map-profile > ~/.config/poe-deck/map-check.profile
if (argv[0] === 'map-profile') {
  process.stdout.write(DEFAULT_PROFILE_SOURCE)
  process.exit(0)
}

// Map check from a file, with the profile the daemon would use. Codes: 0 = marked,
// 1 = not a map with mods (the daemon prices it instead), 2 = no argument.
if (argv[0] === '--check-map') {
  const file = argv[1]
  if (!file) {
    console.log('usage: poe-deck --check-map <item.txt>')
    process.exit(2)
  }
  const { profile, errors } = loadProfile()
  for (const error of errors) console.log(`✗  map check profile: ${error}`)
  const check = mapCheckOf(readFileSync(file, 'utf8'), profile)
  if (!check) {
    console.log(`not a map with mods: ${file} — the daemon shows its price`)
    process.exit(1)
  }
  for (const line of formatMapCheck(check)) console.log(line)
  process.exit(0)
}

// Bundle check without a Deck and without a session: the parser from the embedded pin
// parses item text from a file. CI uses it to check the built file in a clean container,
// with no bun, no git and no network.
if (argv[0] === '--check-parser') {
  const file = argv[1]
  if (!file) {
    console.log('usage: poe-deck --check-parser <item.txt>')
    process.exit(2)
  }
  const donor = await loadDonorParser()
  const result = donor.parseClipboard(readFileSync(file, 'utf8'))
  if (result.isErr()) {
    console.log(`✗  parser rejected ${file}: ${String(result.error)}`)
    process.exit(1)
  }
  for (const line of formatItem(result.value)) console.log(line)
  process.exit(0)
}

// Price from the bundle without a session and without a gesture: the same priceOf path
// as the daemon after a press, only the item text comes from a file. It checks the bundle
// on the Deck before merge (ci/bundle/deck-verify.sh): price of both item forms on
// the stock rootfs, with no bun and no container. Codes: 0 = market answer received,
// 1 = parser rejected, 2 = no argument, 4 = trade did not answer.
if (argv[0] === '--check-price') {
  const file = argv[1]
  if (!file) {
    console.log('usage: poe-deck --check-price <item.txt>')
    process.exit(2)
  }
  const donor = await loadDonorParser()
  const result = donor.parseClipboard(readFileSync(file, 'utf8'))
  if (result.isErr()) {
    console.log(`✗  parser rejected ${file}: ${String(result.error)}`)
    process.exit(1)
  }
  const item = result.value
  for (const line of formatItem(item)) console.log(line)
  try {
    // League as in the daemon: the variable, else the player config, else /api/leagues.
    const league = effectiveSettings(loadConfig().settings).settings.league
    const check = await priceOf(item, league ? { league } : {})
    console.log(`price: ${formatPriceCheck(item, check)}`)
    process.exit(0)
  } catch (err) {
    console.log(`✗  trade did not answer: ${err instanceof Error ? err.message : String(err)}`)
    process.exit(4)
  }
}

console.log(`poe-deck ${POE_DECK_BUILD}`)
process.exit(await main())
