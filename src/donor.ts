// Seam to the donor pin.
//
// This file has no borrowed code, only glue: the donor loads its reference data
// with `fetch` relative to `import.meta.env.BASE_URL` (it is built for Vite),
// and we read the data from disk. The parser itself and `assets/data` come from
// the pin as is, without edits.
//
// Donor: SnosMe/awakened-poe-trade, MIT, see licenses/awakened-poe-trade.LICENSE.
// Pin: submodule `vendor/awakened-poe-trade`, the directory comes from GameFeatures.
// Reference data is the pin with our delta on top (`./donor-data.ts`): so a
// new league arrives without a new donor release. The delta is written against
// a specific pin, and `data/<game>/SOURCES.json` names that pin.
//
// Two launch forms:
//   - sources: modules load from the pin, reference data is assembled in
//     `data/<game>/.public/` on the first run and after a pin or delta change;
//   - one executable (`bun build --compile`, ci/bundle/entry.ts): modules
//     and the assembled reference data are embedded in it, and the entry point
//     hands them here with `useBundledDonor`. No git, no network to GitHub, no disk writes.

import { normalizeClipboard } from './clipboard-quirks'
import { assembleDonorData } from './donor-data'
import { gameFeatures, type GameVersion } from './game-features'

const REPO_ROOT = new URL('..', import.meta.url).pathname

/** Donor embedded in the executable: modules are already loaded, reference data is in `/$bunfs/`. */
export interface BundledDonor {
  /** Game version whose donor is embedded. The file has no other. */
  version: GameVersion
  /** The `public/` directory of the pin inside the executable, with a trailing slash. */
  publicDir: string
  /** Language whose reference data is embedded. The bundle has no others. */
  lang: string
  data: { init: (lang: string) => Promise<void> }
  parser: Record<string, unknown>
}

let bundled: BundledDonor | null = null

/** The entry point of the built daemon hands the embedded donor here, before the first `loadDonorParser`. */
export function useBundledDonor (donor: BundledDonor): void {
  bundled = donor
}

/** Intercepts the donor `fetch`: addresses inside `publicDir` are read as files. */
function serveFromDisk (publicDir: string): void {
  ;(process.env as Record<string, string>).BASE_URL = publicDir
  const realFetch = globalThis.fetch
  globalThis.fetch = ((
    input: Parameters<typeof fetch>[0],
    init?: Parameters<typeof fetch>[1]
  ) => {
    const url = String(input)
    return url.startsWith(publicDir)
      ? Promise.resolve(new Response(Bun.file(url)))
      : realFetch(input, init)
  }) as typeof fetch
}

/**
 * Starts the item parser from the donor pin and returns its module.
 * Reference data is read from the same pin, so the two cannot get out of sync.
 */
export async function loadDonorParser (version: GameVersion = 'poe1', lang = 'en') {
  if (bundled) {
    if (version !== bundled.version || lang !== bundled.lang) {
      throw new Error(`this poe-deck build carries the ${bundled.version} donor with "${bundled.lang}" data only, not ${version} "${lang}"`)
    }
    serveFromDisk(bundled.publicDir)
    await bundled.data.init(lang)
    // The same module that `import()` below gives to the sources, so the type is shared.
    return withQuirks(bundled.parser as Awaited<ReturnType<typeof loadFromPin>>)
  }
  return withQuirks(await loadFromPin(version, lang))
}

/**
 * The pinned parser with clipboard fixes (`./clipboard-quirks.ts`) before parsing:
 * all consumers (daemon, slice, bundle CLI) get them without knowing about them.
 */
function withQuirks<T extends { parseClipboard: (text: string) => unknown }> (parser: T): T {
  return { ...parser, parseClipboard: (text: string) => parser.parseClipboard(normalizeClipboard(text)) }
}

async function loadFromPin (version: GameVersion, lang: string) {
  const features = gameFeatures(version)
  const donorRoot = `${REPO_ROOT}${features.donorDir}/renderer/`
  // Reference data is the pin with our delta on top. The assembly is rebuilt
  // only when the pin or the delta changed; the indexes are built with it.
  const publicDir = `${REPO_ROOT}${features.dataDir}/.public/`
  assembleDonorData({
    pinPublicDir: `${donorRoot}public/`,
    deltaDir: `${REPO_ROOT}${features.dataDir}/${lang}/`,
    outPublicDir: publicDir,
    lang
  })

  // These few lines are all the glue to the environment.
  serveFromDisk(publicDir)

  const data = await import(`${donorRoot}src/assets/data/index.ts`)
  await data.init(lang)

  return await import(`${donorRoot}src/parser/index.ts`)
}
