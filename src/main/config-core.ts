/**
 * Санитайз четырёх ключей фичи «Ценники» — вынесен из config.ts в чистый модуль,
 * потому что у них два тихих пути отказа (merge пользовательского config.json и
 * патч от config:set), и покрыть их тестами прямо в config.ts невозможно: тот
 * импортирует electron и под `node --test` физически не грузится. Здесь — ровно
 * та же логика, но без electron/node/DOM (конвенция: `*-core.ts`, см.
 * sounds/store-core, inventory/xlsx-core, shared/pricetags-core).
 *
 * Правила валидации здесь НЕ дублируются: `isValidObjectId` живёт в
 * ./downloads/stockReport (его и так видит main), остальные три — в
 * ../shared/pricetags-core, оттуда же их берёт renderer. Если бы проверка
 * конфига проверяла значения по своим правилам, в SEW ушло бы то, что
 * приложение само же считает негодным.
 */

import { isValidObjectId } from './downloads/stockReport.ts'
import { isValidCopies, isValidPaperColorId, isValidTemplateId } from '../shared/pricetags-core.ts'

/**
 * Четыре ключа фичи «Ценники» — те же по форме поля, что объявлены в
 * `SewConfig` (config.ts). Дублируем объявление, а не импортируем: `SewConfig`
 * живёт в модуле с electron, и его импорт утащил бы electron сюда. Структурно
 * поля совпадают, поэтому `SewConfig` и `Partial<SewConfig>` подставляются сюда
 * без приведений.
 */
export interface PricetagConfig {
  /** Код магазина для ценников (напр. S187). */
  pricetagObjectId: string
  /** id шаблона печати ценника (89 = А6 ПРОМО, 96 = ШТРИХ-КОД 24, …) */
  pricetagTemplateId: number
  /** 1 — белая, 2 — жёлтая, 3 — розовая */
  pricetagPaperColorId: number
  /** Сколько копий каждого ценника */
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
 * Тип `Record<PricetagKey, …>` исчерпывающий — забытый ключ ценников роняет
 * typecheck. Список ключей, написанный руками, такой защиты не давал: при
 * добавлении пятого ключа (задачи 6/9) компилятор промолчал бы, патч-путь
 * `config:set` молча потерял бы санитайз, и битое значение доехало бы до
 * config.json.
 */
export const VALIDATORS: Record<PricetagKey, (value: unknown) => boolean> = {
  pricetagObjectId: isValidObjectId,
  pricetagTemplateId: isValidTemplateId,
  pricetagPaperColorId: isValidPaperColorId,
  pricetagCopies: isValidCopies,
}

/**
 * Ключи, которые обходятся в патч-пути, — производная от VALIDATORS, а не
 * рукопись. Каст нужен потому, что Object.keys() типизирован как string[]:
 * ложью он быть не может, ведь литерал выше задаёт ровно четыре свойства, и
 * любое другое содержимое объекта уронил бы typecheck на месте.
 */
export const PRICETAG_KEYS: readonly PricetagKey[] = Object.keys(VALIDATORS) as PricetagKey[]

/**
 * Путь «прочитал config.json»: битое значение любого из четырёх ключей ->
 * дефолт из `defaults`. Отдельного `user[key] ?? defaults[key]` здесь
 * недостаточно: в файле лежит не мусор, а вполне разбираемый JSON — просто
 * значение не то (`89` строкой, цвет 4), и такой запрос SEW отвергнет.
 */
export function pickPricetagConfig(user: RawPricetags, defaults: PricetagConfig): PricetagConfig {
  return {
    pricetagObjectId: isValidObjectId(user.pricetagObjectId) ? user.pricetagObjectId : defaults.pricetagObjectId,
    pricetagTemplateId: isValidTemplateId(user.pricetagTemplateId) ? user.pricetagTemplateId : defaults.pricetagTemplateId,
    pricetagPaperColorId: isValidPaperColorId(user.pricetagPaperColorId) ? user.pricetagPaperColorId : defaults.pricetagPaperColorId,
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