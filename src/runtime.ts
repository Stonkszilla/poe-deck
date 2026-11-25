// Where the daemon gets its C binaries.
//
// There are two launch forms, and this is the only difference between them:
//
//   bun src/daemon.ts      sources; the binaries are built on the Deck in ~/poe-deck-tools
//                          (tools/dev-workspace.sh, the developer path)
//   ./poe-deck             one `bun build --compile` executable; the binaries
//                          are built in CI and sit in the same directory as it
//
// The variables POE_DECK_PROBE / _PANEL / _POINTER / _CLIP override both forms.

import { dirname } from 'node:path'

/**
 * Is the daemon built into one file. A compiled bun keeps its modules in the
 * virtual FS `/$bunfs/`; the sources keep them on disk.
 */
export const COMPILED = Bun.main.startsWith('/$bunfs/')

/** Default directory of the C binaries for this launch form. */
export function toolsDir (compiled = COMPILED, execPath = process.execPath, home = process.env.HOME): string {
  return compiled ? dirname(execPath) : `${home}/poe-deck-tools`
}

/** Path to a binary: the environment variable, else the default directory. */
export function toolPath (name: string, override?: string): string {
  return override || `${toolsDir()}/${name}`
}
