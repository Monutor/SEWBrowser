/**
 * Локальная база полок склада: разбор `src/database/shelves.json` и сборка
 * компактной выдачи для гостевой страницы.
 *
 * Зачем это в main: у гостя нет ни файловой системы, ни ipcRenderer (у
 * `<webview>` нет preload), поэтому файл читает main, а плагин sew-helper
 * получает уже готовый список вместе с инжектом. Список полок — постоянная
 * часть поставки: тянуть его из сети нельзя, без сети приложение всё равно
 * должно знать полки.
 *
 * Формат выдачи: зоны словарём, полки — строками «индексЗоны TAB ячейка TAB
 * штрих» (одна строка на полку). На 7906 полок это ~230 КБ против ~600 КБ на
 * JSON-массив объектов, а инжект уходит в гостя на КАЖДУЮ загрузку вкладки.
 *
 * Модуль чистый (никакого electron/fs) — тестируется в node:test.
 */

/** Секция служебных зон: там полка сама является зоной («ТОРГОВЫЙ ЗАЛ») */
const SERVICE_SECTION = 'СЛУЖЕБНАЯ'
/** Секция зоны выдачи у витрины */
const PICKUP_SECTION = 'ПИКАП'

/**
 * Секции основного склада — буквы А…Р. Латинская `A` тоже: это тот же
 * раздел «А», просто набранный латиницей (в db.json полок с таким именем не
 * было, товара на них нет — группировка в основной склад ничего не ломает).
 */
const MAIN_SECTIONS = new Set([...'АБВГДЕЖЗИКЛМОПР', 'A'])

const MAIN_ZONE = 'Основной склад'
const PICKUP_ZONE = 'Пикап'

/** Сокращения в именах служебных зон: «КОМПОНЕНТНЫЙ ТЗ» -> «Компонентный ТЗ»,
 *  а не «Компонентный тз» — сокращение в названии зоны пишут прописными.
 *  Остальные слова приводим в нижний регистр: «ТОРГОВЫЙ ЗАЛ» -> «Торговый зал»
 *  (так эти зоны называются в SEW, см. Зона в db.json). */
const ZONE_ACRONYMS = new Set(['ТЗ'])

/** Разделители полей/строк выдачи — на них гость режет строки обратно */
export const SHELVES_FIELD_SEP = '\t'
export const SHELVES_ROW_SEP = '\n'

/** Выдача полок для гостя: зоны словарём, полки — построчно */
export interface ShelvesPayload {
  /** Версия/дата выгрузки из файла — только для лога, гостю не нужна */
  version: string
  /** Зоны по индексу, на который ссылаются строки полок */
  zones: string[]
  /** «индексЗоны TAB ячейка TAB штрих», по строке на полку */
  rows: string[]
}

export interface ParsedShelves {
  payload: ShelvesPayload
  /** Сколько полок ушло в выдачу (после отбрасывания дублей имён) */
  count: number
  /** Сколько имён полок повторилось — их оставили в одном экземпляре */
  duplicates: number
}

function zoneWordCase(word: string, first: boolean): string {
  if (ZONE_ACRONYMS.has(word)) return word
  const lower = word.toLowerCase()
  if (!first) return lower
  return lower.charAt(0).toUpperCase() + lower.slice(1)
}

/**
 * Человеческое имя зоны полки. `section` в shelves.json — код раздела
 * («А», «ПИКАП», «СЛУЖЕБНАЯ»), а плагину (и ЛП-автоматике sew-inventory,
 * которая ищет полку по префиксу «зона /») нужны названия зон SEW: «Основной
 * склад», «Пикап», «Торговый зал».
 *
 * Неизвестный раздел отдаём как есть. Придумывать ему зону нельзя: полка,
 * молча отнесённая к чужой зоне, подставила бы ЛП-автоматике не ту ячейку —
 * товар ушёл бы не туда. Своё имя раздела ищется в комбобоксе как есть.
 */
export function zoneOfShelf(section: string, name: string): string {
  const sec = section.trim()
  if (sec === SERVICE_SECTION) {
    // Имя полки служебной зоны и есть её название: «ТОРГОВЫЙ ЗАЛ» -> «Торговый зал»
    const words = name.split(/\s+/).filter(Boolean)
    return words.map((word, i) => zoneWordCase(word, i === 0)).join(' ')
  }
  if (sec === PICKUP_SECTION) return PICKUP_ZONE
  if (MAIN_SECTIONS.has(sec)) return MAIN_ZONE
  return sec
}

function field(value: unknown): string {
  if (typeof value === 'string') return value
  if (typeof value === 'number' && Number.isFinite(value)) return String(value)
  return ''
}

/**
 * Разбор shelves.json в выдачу для гостя. Бросает Error, если структуры нет:
 * молча отдать пустой список — значит показать пользователю пустые комбобоксы
 * полок и не сказать почему.
 */
export function parseShelvesFile(text: string): ParsedShelves {
  const parsed: unknown = JSON.parse(text)
  const list = Array.isArray(parsed)
    ? parsed
    : parsed && typeof parsed === 'object'
      ? (parsed as { shelves?: unknown }).shelves
      : undefined
  if (!Array.isArray(list)) throw new Error('в файле нет массива shelves')

  const zones: string[] = []
  const zoneIndex = new Map<string, number>()
  const seenCells = new Set<string>()
  const items: { zone: string; zoneIdx: number; cell: string; barcode: string }[] = []
  let duplicates = 0

  for (const raw of list) {
    if (!raw || typeof raw !== 'object') continue
    const record = raw as Record<string, unknown>
    // Табы/переводы строк внутри полей разорвали бы построчную выдачу
    const cell = field(record.name).replace(/[\t\r\n]/g, ' ').trim()
    const barcode = field(record.barcode).trim()
    if (!cell || !barcode) continue
    if (seenCells.has(cell)) {
      // Одинаковое имя с РАЗНЫМИ штрихами (в файле 63 таких места): в списке
      // это неразличимые дубли, а при выборе вернётся не тот штрих, что
      // напечатан на полке. Оставляем первый — как и делал прежний сборщик.
      duplicates++
      continue
    }
    seenCells.add(cell)

    const zone = zoneOfShelf(field(record.section), cell)
    let zoneIdx = zoneIndex.get(zone)
    if (zoneIdx === undefined) {
      zoneIdx = zones.length
      zones.push(zone)
      zoneIndex.set(zone, zoneIdx)
    }
    items.push({ zone, zoneIdx, cell, barcode })
  }

  items.sort((a, b) => a.zone.localeCompare(b.zone, 'ru') || a.cell.localeCompare(b.cell, 'ru'))

  return {
    payload: {
      version: parsed && typeof parsed === 'object' ? field((parsed as { version?: unknown }).version) : '',
      zones,
      rows: items.map((item) => `${item.zoneIdx}${SHELVES_FIELD_SEP}${item.cell}${SHELVES_FIELD_SEP}${item.barcode}`),
    },
    count: items.length,
    duplicates,
  }
}