// Таблица возможностей игры.
//
// PoE2 объявлен следующей очередью (ADR 0001), поэтому различия между версиями
// игры живут здесь, а не в `if (version === 2)` по всему коду: потребители
// читают `features.foo` и про версию игры не знают. Приём взят у scalpel
// идеей, не кодом — scalpel под AGPL-3.0, заимствовать оттуда нечего.
//
// Второй столбец сейчас намеренно пуст: у донора PoE1 второй игры нет вовсе
// (0 совпадений по `poe2` на 238 файлах), и заполнять таблицу под неё до
// стадии PoE2 значило бы выдумывать. Нужна форма, а не содержимое.

export type GameVersion = 'poe1' | 'poe2'

export interface GameFeatures {
  readonly version: GameVersion
  /**
   * Каталог пина донора. Парсер и справочники-база `.ndjson` берутся отсюда
   * одним коммитом — рассинхрон между ними и есть то, на чём падает `init()`.
   */
  readonly donorDir: string
  /**
   * Каталог нашей дельты к справочникам пина: `<язык>/*.delta.ndjson`
   * и `SOURCES.json`. Её пишет `tools/datagen/` из файлов игры, когда донор
   * ещё не выпустил данные под новую лигу. Собранный результат — `<dataDir>/.public/`.
   */
  readonly dataDir: string
  /**
   * Аккорд копирования предмета. Именно advanced item description: на обычном
   * `Ctrl+C` парсер вернёт предмет молча без модов (ADR 0001, И2).
   */
  readonly copyItemChord: string
  /**
   * AppId игры в Steam. Его gamescope кладёт в `GAMESCOPE_FOCUSED_APP` на корне,
   * и по нему демон отличает «игра на экране» от «интерфейс Steam» — то самое
   * автогашение, без которого он повиснет поверх QAM (спайк по оверлею, эксп. 6).
   */
  readonly steamAppId: number
}

const TABLE: { readonly [V in GameVersion]?: GameFeatures } = {
  poe1: {
    version: 'poe1',
    donorDir: 'vendor/awakened-poe-trade',
    dataDir: 'data/poe1',
    copyItemChord: 'Ctrl+Alt+C',
    // Снято с живого Deck: путь конфигурации Steam Input содержит `.../238960/`,
    // и тот же номер стоял в `GAMESCOPE_FOCUSED_APP` при запущенной PoE
    // (спайк по оверлею, эксп. 4).
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
