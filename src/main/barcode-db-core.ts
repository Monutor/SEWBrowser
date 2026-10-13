/** Чистая часть фичи «Штрихи локально»: распаковка db.json и построение
 *  компактного построчного индекса. Вынесена из main-сервиса, потому что
 *  `node --test` не поднимет модуль с electron, а проверять тут есть что:
 *  формат db.json — целиком в памяти, и любая ошибка молча ломает печать. */
import { gunzipSync } from 'node:zlib'

/** Поля db.json, которые нужны печати. Наименование берётся из «Наименование»
 *  (в базе оно одно; ключ «Наименование товара» в db-loader плагина sew-helper
 *  — опечатка старой версии, в живом файле такого поля нет). */
const SKU_FIELD = 'Код товара'
const BARCODE_FIELD = 'ШК товара'
const NAME_FIELD = 'Наименование'

/** db.json лежит в репозитории gzip'ом: GitHub отдаёт его как
 *  application/octet-stream БЕЗ заголовка Content-Encoding, поэтому браузер и
 *  сетевой стек его не распакуют. Детектим по магии 1F 8B (та же проверка, что
 *  в features/sew-helper/db-loader.js) и распаковываем сами. */
export function isGzip(bytes: Uint8Array): boolean {
  return bytes.length >= 2 && bytes[0] === 0x1f && bytes[1] === 0x8b
}

/** Байты db.json → текст JSON. gzip и обычный JSON одинаково допустимы: формат
 *  в репозитории пользователь может вернуть в любой из двух видов. */
export function unpackDbJson(bytes: Uint8Array): string {
  if (!isGzip(bytes)) return new TextDecoder('utf-8').decode(bytes)
  return gunzipSync(bytes).toString('utf8')
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function text(value: unknown): string {
  return typeof value === 'string' ? value.trim() : ''
}

/** Таб и переводы строк в строке индекса ломают разбор: наименование может
 *  содержать что угодно, и одна такая позиция сдвинет все следующие. */
function oneLine(value: string): string {
  return value.replace(/[\t\r\n]+/g, ' ').trim()
}

export interface DbIndexStats {
  text: string
  /** Сколько позиций попало в индекс. */
  items: number
  /** Сколько записей отброшено: без SKU или без штрих-кода. */
  skipped: number
}

/**
 * db.json (распарсенный) → компактный индекс `SKU⇥ШК⇥Наименование` по строкам.
 *
 * Зачем не хранить базу как есть: распакованный db.json — 179 МБ, и держать
 * его в памяти постоянно незачем. Индекс — 15 МБ, читается целиком за ~40 мс
 * и разбирается построчно, поэтому битая строка в нём (перенос, обрезка при
 * аварийном выключении) стоит одну позицию, а не весь файл.
 */
export function buildIndexText(data: unknown): DbIndexStats {
  if (!Array.isArray(data)) return { text: '', items: 0, skipped: 0 }
  const lines: string[] = []
  let skipped = 0
  for (const row of data) {
    const line = indexLine(row)
    if (!line) {
      skipped += 1
      continue
    }
    lines.push(line)
  }
  return { text: lines.join('\n'), items: lines.length, skipped }
}

/** Запись → строка индекса; `null`, если позицию печатать нельзя. */
function indexLine(row: unknown): string | null {
  if (!isRecord(row)) return null
  const sku = oneLine(text(row[SKU_FIELD]))
  const barcode = oneLine(text(row[BARCODE_FIELD]))
  if (!sku || !barcode) return null
  // Наименование может содержать табы — они не несут смысла, склеиваем.
  return `${sku}\t${barcode}\t${oneLine(text(row[NAME_FIELD]))}`
}

/**
 * Тот же индекс, но без `JSON.parse` всего массива.
 *
 * Зачем: db.json — одна строка на 179 МБ, и полный разбор поднимает RSS
 * process'а до 559 МБ (замерено на живом файле: 272 392 позиции), а кусковый
 * — до 491 МБ. Для main Electron, где уже крутятся гостевые процессы, каждая
 * сотня мегабайт важна. Основной едок памяти — сама строка (179 МБ в UTF-16 =
 * 358 МБ), а не объекты: снять это можно только разбором потоком с диска,
 * на что нужен отдельный шаг.
 *
 * Разделитель `},{` не может встретиться внутри значения строки, пока в
 * значении нет фигурных скобок; если встретится, JSON.parse куска упадёт, и
 * вызывающий откатится на полный разбор. Возвращает `null`, когда быстрый
 * путь неприменим, — молча печатать половину базы нельзя.
 */
export function parseDbJsonText(json: string): DbIndexStats | null {
  const text = String(json ?? '').trim()
  // Пустой массив — валидная база без единой позиции, а не «не тот формат».
  if (text === '[]') return { text: '', items: 0, skipped: 0 }
  if (!text.startsWith('[{') || !text.endsWith('}]')) return null
  // Срезаем внешние скобки массива: остаётся `{…},{…},{…}`.
  const chunks = text.slice(1, -1).split('},{')
  if (chunks.length === 0) return null

  const lines: string[] = []
  let skipped = 0
  const last = chunks.length - 1
  for (let i = 0; i <= last; i += 1) {
    const chunk = chunks[i]
    // Крайние куски сохранили свою скобку: первый начинается с «{», последний
    // кончается на «}» — дописываем только недостающую половину. При единственной
    // записи разделителя не было, и кусок уже целый объект — дописывать нечего.
    const piece =
      chunks.length === 1 ? chunk : i === 0 ? `${chunk}}` : i === last ? `{${chunk}` : `{${chunk}}`
    let row: unknown
    try {
      row = JSON.parse(piece)
    } catch {
      return null
    }
    const line = indexLine(row)
    if (!line) {
      skipped += 1
      continue
    }
    lines.push(line)
  }
  return { text: lines.join('\n'), items: lines.length, skipped }
}