/**
 * Санитайз ключа фичи печати — вынесен из config.ts в чистый модуль, потому что
 * у него два тихих пути отказа (merge пользовательского config.json и патч от
 * config:set), и покрыть их тестами прямо в config.ts невозможно: тот
 * импортирует electron и под `node --test` физически не грузится. Здесь — ровно
 * та же логика, но без electron/node/DOM (конвенция: `*-core.ts`, см.
 * sounds/store-core, inventory/xlsx-core).
 *
 * После снятия печати ценников через SEW от фичи остался один ключ —
 * `pricetagCopies` (число копий в листе штрихов). Имя ключа сохранено прежним:
 * оно лежит в config.json пользователя, переименование обнулило бы настройку.
 */

/** Число копий каждой позиции на листе штрихов. Правило переехало из
 *  shared/pricetags-core вместе с удалением того модуля: других
 *  потребителей у него не было, а тянуть ради одного правила файл с
 *  разбором ответов SEW незачем. */
function isValidCopies(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value >= 1 && value <= 999
}

/**
 * Ключ фичи — тот же по форме, что объявлен в `SewConfig` (config.ts).
 * Дублируем объявление, а не импортируем: `SewConfig` живёт в модуле с
 * electron, и его импорт утащил бы electron сюда.
 */
export interface PricetagConfig {
  /** Сколько копий каждой позиции печатать на листе штрихов */
  pricetagCopies: number
}

type PricetagKey = keyof PricetagConfig

/**
 * Значения ключей «как они лежат в config.json»: объявленный тип здесь ничего
 * не значит — в файле (и в патче из renderer) может быть строка вместо числа,
 * объект вместо строки, null. Поэтому на вход идут `unknown`, иначе проверка
 * негодности была бы недостижима уже на этапе типов.
 */
type RawPricetags = Partial<Record<PricetagKey, unknown>>

/**
 * Ключ конфига → валидатор его значения. Единственный источник и правил, и
 * списка ключей: PRICETAG_KEYS выводится отсюда.
 *
 * Тип `Record<PricetagKey, …>` исчерпывающий — забытый ключ роняет typecheck.
 * Список ключей, написанный руками, такой защиты не давал.
 */
export const VALIDATORS: Record<PricetagKey, (value: unknown) => boolean> = {
  pricetagCopies: isValidCopies,
}

/**
 * Ключи, которые обходятся в патч-пути, — производная от VALIDATORS, а не
 * рукопись. Каст нужен потому, что Object.keys() типизирован как string[]:
 * ложью он быть не может, ведь литерал выше задаёт ровно одно свойство, и
 * любое другое содержимое объекта уронил бы typecheck на месте.
 */
export const PRICETAG_KEYS: readonly PricetagKey[] = Object.keys(VALIDATORS) as PricetagKey[]

/**
 * Путь «прочитал config.json»: битое значение ключа -> дефолт из `defaults`.
 * Отдельного `user[key] ?? defaults[key]` здесь недостаточно: в файле лежит не
 * мусор, а вполне разбираемый JSON — просто значение не то (копии 2.5 или 0).
 */
export function pickPricetagConfig(user: RawPricetags, defaults: PricetagConfig): PricetagConfig {
  return {
    pricetagCopies: isValidCopies(user.pricetagCopies) ? user.pricetagCopies : defaults.pricetagCopies,
  }
}

/**
 * Путь «config:set»: невалидный ключ ВЫБРАСЫВАЕТСЯ из патча, а не заменяется
 * дефолтом — иначе битый патч из renderer (например, шаблон приехал строкой из
 * `<input>`) затёр бы хорошее значение в config.json. Ключа в патче нет —
 * значит поле не меняли, и патч остаётся как есть. Остальные ключи, включая
 * неизвестные, не трогаем: их санитайзит сам config.ts.
 *
 * Аргумент не мутируется (копия поверх), чтобы вызывающий код мог строить патч
 * в несколько шагов, как это делает saveConfig.
 */
export function dropInvalidPricetags<T extends object>(patch: T): T {
  const out: T = { ...patch }
  const check = out as RawPricetags
  for (const key of PRICETAG_KEYS) {
    if (key in check && !VALIDATORS[key](check[key])) delete check[key]
  }
  return out
}