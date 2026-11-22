// Сырой ввод контроллера Deck: устройства и события evdev.
//
// Это путь 3 запасных каналов [ADR 0002](../../docs/decisions/0002-input-channel.md):
// «контроллер читается пользователем `deck` без root, ввод дублируется, а не
// отбирается у игры». Понадобился он не потому, что основной канал сломался, а
// потому, что дискретного аккорда мало: список модов кнопками не листается, а
// тачпад даёт непрерывную координату.
//
// ── Почему TypeScript, а не C ───────────────────────────────────────────────
//
// `gs-hotkey-probe` и `gs-panel` написаны на C потому, что им нужны Wayland и
// Xlib. Здесь ничего такого нет: evdev — это файл, из которого читаются записи
// по 24 байта. Значит правило проекта работает как обычно — TypeScript под bun,
// и тот же код потом живёт в демоне, а не переписывается.
//
// ── Две вещи, которые здесь намеренно не делаются ───────────────────────────
//
//  1. **`hidraw` не открываем никогда** (ADR 0002, Ф8: открытие роняет контроллер
//     в lizard mode). Только `/dev/input/event*`.
//  2. **Ничего не захватываем** (`EVIOCGRAB`). Мы читатель, а не потребитель:
//     ввод дублируется, и отбирать его у Steam Input нельзя — иначе сломается
//     сам геймпад. Отсюда же ограничение: если Steam уже захватил устройство,
//     мы не получим ничего, и это законный исход замера, а не поломка.
//
// Имя устройства спрашивается у `/proc/bus/input/devices`, а не ioctl'ом
// `EVIOCGNAME`: ioctl из bun не вызвать, а файл есть на любом ядре и говорит
// то же самое.

import { createReadStream } from 'node:fs'

/** Тип события ядра. Больше этих четырёх в контроллере не встречается. */
export const EV = { SYN: 0x00, KEY: 0x01, REL: 0x02, ABS: 0x03, MSC: 0x04 } as const

/** Одна запись `struct input_event`: на 64-битном ядре ровно 24 байта. */
export const EVENT_SIZE = 24

export interface InputEvent {
  /** Время ядра, мс. Нужно, чтобы отличить «палец ведёт» от «дрожит контакт». */
  timeMs: number
  type: number
  code: number
  value: number
}

export interface InputDevice {
  name: string
  /** `eventN` — то, что лежит в `/dev/input/`. */
  handlers: string[]
  path?: string
}

/**
 * Устройства из `/proc/bus/input/devices`. Блок на устройство, `N:` — имя,
 * `H:` — обработчики. Формат стабилен с 2.6 и одинаков на любом ядре.
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

/** Сырой контроллер Deck — его читаем мы. */
const RAW = /Valve Software Steam (Deck )?Controller/i
/** Виртуальный геймпад Steam Input — это видит игра. */
const VIRTUAL = /X-?Box|Steam Virtual Gamepad/i

export type DeviceRole = 'raw controller' | 'game gamepad'
export interface WatchedDevice extends InputDevice { role: DeviceRole, path: string }

/**
 * Устройства, которые нужно слушать, чтобы ответить на вопрос замера. Их два
 * рода, и оба обязательны: сырой контроллер показывает, что доступно НАМ, а
 * виртуальный геймпад Steam Input — что при том же жесте достаётся ИГРЕ.
 * Без второго «игра ничего не получила» остаётся словами.
 *
 * Одно физическое устройство часто даёт несколько `eventN` — кнопки и оси
 * порознь. Слушаются все: тачпад легко оказывается ровно в пропущенном.
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

// ── имена кодов ──────────────────────────────────────────────────────────────
//
// Только то, что реально приезжает с геймпада. Незнакомый код печатается числом,
// а не выдумывается: назвать ось неправильно хуже, чем не назвать — по неверному
// имени потом строится раскладка.

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

/** Человекочитаемое имя кода. Неизвестный — шестнадцатеричным числом. */
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
 * Байты → события. Возвращает разобранные записи и **хвост**: чтение из
 * символьного устройства режется по границе буфера, а не записи, и потерянные
 * четыре байта сдвинули бы все последующие события.
 */
export function decodeEvents (buf: Uint8Array): { events: InputEvent[], rest: Uint8Array } {
  const events: InputEvent[] = []
  const whole = Math.floor(buf.length / EVENT_SIZE)
  const view = new DataView(buf.buffer, buf.byteOffset, buf.byteLength)

  for (let i = 0; i < whole; i++) {
    const at = i * EVENT_SIZE
    // timeval: два поля по 8 байт (64-битное ядро), затем type, code, value.
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

/** Поток байтов → поток событий, с сшиванием записей на границах чанков. */
export async function * decodeStream (
  chunks: AsyncIterable<Uint8Array>
): AsyncGenerator<InputEvent> {
  let tail = new Uint8Array(0)

  for await (const chunk of chunks) {
    const buf = new Uint8Array(tail.length + chunk.length)
    buf.set(tail)
    buf.set(chunk, tail.length)
    const { events, rest } = decodeEvents(buf)
    tail = rest.slice() // копия: rest смотрит в буфер, который сейчас переиспользуют
    for (const event of events) yield event
  }
}

/**
 * События устройства. Открывается на чтение и НЕ захватывается: параллельно с
 * нами их читает Steam Input, и отобрать их у него значило бы сломать геймпад.
 */
export function openEvents (path: string): AsyncGenerator<InputEvent> {
  return decodeStream(createReadStream(path) as AsyncIterable<Uint8Array>)
}
