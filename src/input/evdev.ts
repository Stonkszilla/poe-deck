// Raw input of the Deck controller: evdev devices and events.
//
// This is path 3 of the fallback channels in [ADR 0002](../../docs/decisions/0002-input-channel.md):
// "the user `deck` reads the controller without root, input is duplicated, not
// taken from the game". It is needed not because the main channel broke, but
// because a discrete chord is not enough: buttons cannot scroll the mod list, and
// the trackpad gives a continuous coordinate.
//
// ── Why TypeScript and not C ──────────────────────────────────────────────────
//
// `gs-hotkey-probe` and `gs-panel` are written in C because they need Wayland and
// Xlib. Nothing like that is here: evdev is a file that gives records
// of 24 bytes. So the project rule applies as usual: TypeScript under bun,
// and the same code later lives in the daemon instead of a rewrite.
//
// ── Two things this code does not do on purpose ──────────────────────────────
//
//  1. **Never open `hidraw`** (ADR 0002, F8: opening it drops the controller
//     into lizard mode). Only `/dev/input/event*`.
//  2. **Grab nothing** (`EVIOCGRAB`). We are a reader, not a consumer:
//     input is duplicated, and we must not take it from Steam Input, or the
//     gamepad itself breaks. Hence a limit: if Steam already grabbed the device,
//     we get nothing, and that is a valid result of the measurement, not a breakage.
//
// The device name comes from `/proc/bus/input/devices`, not from the ioctl
// `EVIOCGNAME`: bun cannot call an ioctl, and the file exists on any kernel and says
// the same thing.

import { createReadStream } from 'node:fs'

/** Kernel event type. The controller sends no types beyond these. */
export const EV = { SYN: 0x00, KEY: 0x01, REL: 0x02, ABS: 0x03, MSC: 0x04 } as const

/** One `struct input_event` record: exactly 24 bytes on a 64-bit kernel. */
export const EVENT_SIZE = 24

export interface InputEvent {
  /** Kernel time, ms. It tells "the finger moves" from "the contact jitters". */
  timeMs: number
  type: number
  code: number
  value: number
}

export interface InputDevice {
  name: string
  /** `eventN`: the name under `/dev/input/`. */
  handlers: string[]
  path?: string
}

/**
 * Devices from `/proc/bus/input/devices`. One block per device, `N:` is the name,
 * `H:` is the handlers. The format is stable since 2.6 and the same on any kernel.
 */
export function parseProcDevices (text: string): InputDevice[] {
  const out: InputDevice[] = []

  for (const block of text.split(/\n\s*\n/)) {
    const name = block.match(/^N: Name="(.*)"$/m)?.[1]
    if (!name) continue
    const handlers = (block.match(/^H: Handlers=(.*)$/m)?.[1] ?? '')
      .trim().split(/\s+/).filter(h => /^event\d+$/.test(h))
    const device: InputDevice = { name, handlers }
    if (handlers[0]) device.path = `/dev/input/${handlers[0]}`
    out.push(device)
  }

  return out
}

/** The raw Deck controller: we read it. */
const RAW = /Valve Software Steam (Deck )?Controller/i
/** The Steam Input virtual gamepad: the game sees it. */
const VIRTUAL = /X-?Box|Steam Virtual Gamepad/i

export type DeviceRole = 'raw controller' | 'game gamepad'
export interface WatchedDevice extends InputDevice { role: DeviceRole, path: string }

/**
 * The devices to listen to in order to answer the measurement question. There are two
 * kinds, and both are required: the raw controller shows what is available to US, and
 * the Steam Input virtual gamepad shows what the GAME gets from the same gesture.
 * Without the second one, "the game got nothing" stays an unproven claim.
 *
 * One physical device often gives several `eventN`: buttons and axes
 * separately. We listen to all of them: the trackpad easily ends up in the one we skip.
 */
export function watchedDevices (devices: InputDevice[]): WatchedDevice[] {
  const out: WatchedDevice[] = []

  for (const device of devices) {
    const role: DeviceRole | undefined = RAW.test(device.name)
      ? 'raw controller'
      : VIRTUAL.test(device.name) ? 'game gamepad' : undefined
    if (!role) continue

    for (const handler of device.handlers) {
      out.push({ name: device.name, role, handlers: [handler], path: `/dev/input/${handler}` })
    }
  }

  return out
}

// ── code names ────────────────────────────────────────────────────────────────
//
// Only what the gamepad really sends. An unknown code prints as a number
// and is not invented: a wrong axis name is worse than no name, because a layout
// is later built on the wrong name.

const ABS_NAMES: Record<number, string> = {
  0x00: 'ABS_X', 0x01: 'ABS_Y', 0x02: 'ABS_Z',
  0x03: 'ABS_RX', 0x04: 'ABS_RY', 0x05: 'ABS_RZ',
  0x10: 'ABS_HAT0X', 0x11: 'ABS_HAT0Y',
  0x12: 'ABS_HAT1X', 0x13: 'ABS_HAT1Y',
  0x14: 'ABS_HAT2X', 0x15: 'ABS_HAT2Y',
  0x16: 'ABS_HAT3X', 0x17: 'ABS_HAT3Y',
  0x18: 'ABS_PRESSURE', 0x19: 'ABS_DISTANCE',
  0x2f: 'ABS_MT_SLOT', 0x30: 'ABS_MT_TOUCH_MAJOR',
  0x35: 'ABS_MT_POSITION_X', 0x36: 'ABS_MT_POSITION_Y',
  0x39: 'ABS_MT_TRACKING_ID', 0x3a: 'ABS_MT_PRESSURE'
}

const KEY_NAMES: Record<number, string> = {
  0x110: 'BTN_LEFT', 0x111: 'BTN_RIGHT', 0x112: 'BTN_MIDDLE',
  0x130: 'BTN_SOUTH/A', 0x131: 'BTN_EAST/B', 0x133: 'BTN_NORTH/X', 0x134: 'BTN_WEST/Y',
  0x136: 'BTN_TL', 0x137: 'BTN_TR', 0x138: 'BTN_TL2', 0x139: 'BTN_TR2',
  0x13a: 'BTN_SELECT', 0x13b: 'BTN_START', 0x13c: 'BTN_MODE',
  0x13d: 'BTN_THUMBL', 0x13e: 'BTN_THUMBR',
  0x145: 'BTN_TOOL_FINGER', 0x14a: 'BTN_TOUCH',
  0x220: 'BTN_DPAD_UP', 0x221: 'BTN_DPAD_DOWN', 0x222: 'BTN_DPAD_LEFT', 0x223: 'BTN_DPAD_RIGHT',
  0x2c0: 'BTN_TRIGGER_HAPPY1', 0x2c1: 'BTN_TRIGGER_HAPPY2',
  0x2c2: 'BTN_TRIGGER_HAPPY3', 0x2c3: 'BTN_TRIGGER_HAPPY4'
}

/** Human-readable code name. An unknown code is a hex number. */
export function codeName (type: number, code: number): string {
  const hex = `0x${code.toString(16)}`
  if (type === EV.ABS) return ABS_NAMES[code] ?? `ABS(${hex})`
  if (type === EV.KEY) return KEY_NAMES[code] ?? `KEY(${hex})`
  if (type === EV.REL) return code === 0 ? 'REL_X' : code === 1 ? 'REL_Y' : `REL(${hex})`
  if (type === EV.SYN) return 'SYN'
  if (type === EV.MSC) return 'MSC'
  return `TYPE${type}(${hex})`
}

/**
 * Bytes → events. Returns the parsed records and the **tail**: a read from
 * a character device is cut at the buffer boundary, not the record boundary, and four
 * lost bytes would shift all later events.
 */
export function decodeEvents (buf: Uint8Array): { events: InputEvent[], rest: Uint8Array } {
  const events: InputEvent[] = []
  const whole = Math.floor(buf.length / EVENT_SIZE)
  const view = new DataView(buf.buffer, buf.byteOffset, buf.byteLength)

  for (let i = 0; i < whole; i++) {
    const at = i * EVENT_SIZE
    // timeval: two 8-byte fields (64-bit kernel), then type, code, value.
    const sec = view.getBigUint64(at, true)
    const usec = view.getBigUint64(at + 8, true)
    events.push({
      timeMs: Number(sec) * 1000 + Number(usec) / 1000,
      type: view.getUint16(at + 16, true),
      code: view.getUint16(at + 18, true),
      value: view.getInt32(at + 20, true)
    })
  }

  return { events, rest: buf.subarray(whole * EVENT_SIZE) }
}

/** Byte stream → event stream, joining records across chunk boundaries. */
export async function * decodeStream (
  chunks: AsyncIterable<Uint8Array>
): AsyncGenerator<InputEvent> {
  let tail = new Uint8Array(0)

  for await (const chunk of chunks) {
    const buf = new Uint8Array(tail.length + chunk.length)
    buf.set(tail)
    buf.set(chunk, tail.length)
    const { events, rest } = decodeEvents(buf)
    tail = rest.slice() // copy: rest points into a buffer that is about to be reused
    for (const event of events) yield event
  }
}

/**
 * Device events. The device opens for reading and is NOT grabbed: Steam Input
 * reads them in parallel with us, and taking them from it would break the gamepad.
 */
export function openEvents (path: string): AsyncGenerator<InputEvent> {
  return decodeStream(createReadStream(path) as AsyncIterable<Uint8Array>)
}
