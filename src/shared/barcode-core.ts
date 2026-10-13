/** Чистое ядро фичи «Штрихи локально»: определение symbology, генерация
 *  модулей EAN-13 и Code 128, сборка SVG. Видна и main, и renderer, и тестам —
 *  поэтому без DOM, без electron и без node (иначе `node --test` её не поднимет).
 *
 *  Источник кодов — db.json пользователя: там 272 392 позиции, причём форматы
 *  ШК неоднородны (130 068 валидных EAN-13 и ~142 тыс. прочих длиной 2…18).
 *  Рисовать всё одним EAN-13 нельзя — половина базы в него не вписывается,
 *  поэтому symbology выбирается по данным (см. `pickSymbology`). */

/** Таблица EAN-13: нечётная (L), чётная (G) и правая (R) группы цифр. */
const EAN_L = ['0001101', '0011001', '0010011', '0111101', '0100011', '0110001', '0101111', '0111011', '0110111', '0001011']
const EAN_G = ['0100111', '0110011', '0011011', '0100001', '0011101', '0111001', '0000101', '0010001', '0001001', '0010111']
const EAN_R = ['1110010', '1100110', '1101100', '1000010', '1011100', '1001110', '1010000', '1000100', '1001000', '1110100']

const EAN_START_GUARD = '101'
const EAN_MIDDLE_GUARD = '01010'
const EAN_END_GUARD = '101'

/** Таблица Code 128: 107 символов по 11 модулей (ISO/IEC 15417). */
const CODE128_PATTERNS = [
  '11011001100', '11001101100', '11001100110', '10010011000', '10010001100', '10001001100',
  '10011001000', '10011000100', '10001100100', '11001001000', '11001000100', '11000100100',
  '10110011100', '10011011100', '10011001110', '10111001100', '10011101100', '10011100110',
  '11001110010', '11001011100', '11001001110', '11011100100', '11001110100', '11101101110',
  '11101001100', '11100101100', '11100100110', '11101100100', '11100110100', '11100110010',
  '11011011000', '11011000110', '11000110110', '10100011000', '10001011000', '10001000110',
  '10110001000', '10001101000', '10001100010', '11010001000', '11000101000', '11000100010',
  '10110111000', '10110001110', '10001101110', '10111011000', '10111000110', '10001110110',
  '11101110110', '11010001110', '11000101110', '11011101000', '11011100010', '11011101110',
  '11101011000', '11101000110', '11100010110', '11101101000', '11101100010', '11100011010',
  '11101111010', '11001000010', '11110001010', '10100110000', '10100001100', '10010110000',
  '10010000110', '10000101100', '10000100110', '10110010000', '10110000100', '10011010000',
  '10011000010', '10000110100', '10000110010', '11000010010', '11001010000', '11110111010',
  '11000010100', '10001111010', '10100111100', '10010111100', '10010011110', '10111100100',
  '10011110100', '10011110010', '11110100100', '11110010100', '11110010010', '11011011110',
  '11011110110', '11110110110', '10101111000', '10100011110', '10001011110', '10111101000',
  '10111100010', '11110101000', '11110100010', '10111011110', '10111101110', '11101011110',
  '11110101110', '11010000100', '11010010000', '11010011100', '11000111010',
] as const

/** Значения Code 128, нужные для кодирования: старты, переключение на C,
 *  ASCII-цифры в наборе B и стоп. */
const C128_START_A = 103
const C128_START_B = 104
const C128_START_C = 105
const C128_STOP = 106
/** 99 — переключение в набор C из A/B (обратно — значение 100). */
const C128_CODE_C = 99

export type BarcodeSymbology = 'ean13' | 'code128'

/** Собранный штрих-код: модульная строка ('1' — полоса) и чем он нарисован. */
export interface BarcodeBars {
  symbology: BarcodeSymbology
  /** Модули слева направо: '1' — чёрный, '0' — белый. Без тихих зон. */
  modules: string
  /** Значение контрольного символа Code 128 (EAN-13 контрольную цифру
   *  вшивает в сам код) — показываем в подписи, чтобы руками проверить. */
  check: number
}

const DIGITS_RE = /^\d+$/

/** Только цифры — так кодируется весь ШК в db.json (проверено на живом файле:
 *  272 392 значения, ни одного нецифрового). */
function isDigits(code: string): boolean {
  return DIGITS_RE.test(code)
}

/**
 * Контрольная цифра EAN-13 по первым 12 цифрам. Возвращает `null`, если вход
 * не цифры нужной длины: контрольную у неверного кода считать нельзя, иначе
 * «годный» EAN-13 нарисуется из мусора.
 */
export function ean13CheckDigit(first12: string): number | null {
  const value = String(first12 ?? '')
  if (!/^\d{12}$/.test(value)) return null
  let sum = 0
  for (let i = 0; i < 12; i += 1) {
    sum += Number(value[i]) * (i % 2 === 0 ? 1 : 3)
  }
  return (10 - (sum % 10)) % 10
}

/** Настоящий EAN-13: 13 цифр, последняя сходится с контрольной. */
export function isValidEan13(code: string): boolean {
  const value = String(code ?? '')
  if (!/^\d{13}$/.test(value)) return false
  const expected = ean13CheckDigit(value.slice(0, 12))
  return expected !== null && Number(value[12]) === expected
}

/**
 * Чем печатать код: 13 цифр с верной контрольной — EAN-13 (его понимают
 * товарные POS-сканеры), всё остальное — Code 128 (единственная из двух, что
 * кодирует произвольную цифровую строку, поэтому 2…18-значные коды из db.json
 * печатаются осмысленно, а не «как получится»).
 *
 * `null` — кода нет или он пустой: рисовать нечего.
 */
export function pickSymbology(code: string): BarcodeSymbology | null {
  const value = String(code ?? '').trim()
  if (!value) return null
  return isValidEan13(value) ? 'ean13' : 'code128'
}

/** Модули EAN-13 (ровно 95): гарды + 6 левых + 6 правых цифр. */
export function ean13Modules(code: string): string | null {
  if (!isValidEan13(code)) return null
  const digits = [...code].map(Number)
  // Первая цифра в EAN-13 не кодируется символом — только выбором таблиц
  // левой половины: 0/1/2 → G (чётная), 3…9 → L (нечётная). Сама левой
  // половиной кодирует цифры d2…d7 (в 1-based это 1…6 в массиве), правая —
  // d8…d13 вместе с контрольной. Это классическая «двоичная» кодировка EAN и
  // главное место, где легко уехать на цифру: кодировать d1…d6 нельзя.
  const leftOdd = digits[0] >= 3
  const left: string[] = []
  for (let i = 1; i <= 6; i += 1) {
    left.push(leftOdd ? EAN_L[digits[i]] : EAN_G[digits[i]])
  }
  const right: string[] = []
  for (let i = 7; i < 13; i += 1) {
    right.push(EAN_R[digits[i]])
  }
  return EAN_START_GUARD + left.join('') + EAN_MIDDLE_GUARD + right.join('') + EAN_END_GUARD
}

/**
 * Символы Code 128 для строки: стартовый символ, значения данных и
 * контрольный символ. Возвращает `null` на символе, которого набор B не
 * знает (кириллица, служебные коды) — такой код честнее не нарисовать, чем
 * отдать сканеру мусор.
 *
 * Набор C для сплошных цифр: два знака на символ, вдвое компактнее B. При
 * нечётной длине первую цифру уводим в B, дальше пары в C — иначе на хвосте
 * остаётся одна цифра и лишнее переключение туда-обратно.
 */
export function code128Values(code: string): { values: number[]; check: number } | null {
  const value = String(code ?? '').trim()
  if (!value) return null

  const values: number[] = []
  // Контрольная сумма Code 128 — взвешенная по ПОЗИЦИЯМ сумма mod 103, где
  // стартовый символ весит 1, а данные нумеруются с 1 же (ISO/IEC 15417, пример
  // «PJJ123C» → 54). Старт не «съедает» позицию: если считать данные с 2, все
  // checksum'ы уедут и сканер код не примет.
  let checkSum = 0
  let position = 0
  const pushData = (symbol: number): void => {
    position += 1
    values.push(symbol)
    checkSum += symbol * position
  }
  const pushStart = (symbol: number): void => {
    values.push(symbol)
    checkSum += symbol
  }

  if (isDigits(value)) {
    const even = value.length % 2 === 0
    pushStart(even ? C128_START_C : C128_START_B)
    let i = 0
    if (!even) {
      // Одна цифра в B, чтобы дальше пары в C не разъехались по чётности.
      pushData(Number(value[0]) + 16)
      i = 1
    }
    if (i < value.length) {
      pushData(C128_CODE_C)
      for (; i < value.length; i += 2) {
        pushData(Number(value.slice(i, i + 2)))
      }
    }
  } else {
    pushStart(C128_START_B)
    for (let i = 0; i < value.length; i += 1) {
      const codePoint = value.charCodeAt(i)
      // Набор B покрывает ASCII 32…126; кириллица и управляющие — вне его.
      // Значения 98/99/100 из набора B (SHIFT / Code C / FNC4) соответствуют
      // ASCII 130…132, поэтому через charCode не достижимы и отдельно
      // обрабатывать их не нужно — код недостижим в принципе.
      if (codePoint < 32 || codePoint > 126) return null
      pushData(codePoint - 32)
    }
  }

  return { values, check: checkSum % 103 }
}

/** Модули Code 128: символы данных, контрольный символ и стоп-паттерн. */
export function code128Modules(code: string): string | null {
  const parsed = code128Values(code)
  if (!parsed) return null
  const symbols = [...parsed.values, parsed.check, C128_STOP]
  return symbols.map((symbol) => CODE128_PATTERNS[symbol] ?? '').join('') + '11'
}

/**
 * Штрих-код по строке кода: symbology по данным, модули и контрольный символ.
 * `null`, если код пустой или набор B не кодирует его символы.
 */
export function buildBarcode(code: string): BarcodeBars | null {
  const symbology = pickSymbology(code)
  if (symbology === 'ean13') {
    const modules = ean13Modules(code)
    return modules ? { symbology, modules, check: Number(code[12]) } : null
  }
  const values = code128Values(code)
  const modules = code128Modules(code)
  if (!modules || !values) return null
  return { symbology: 'code128', modules, check: values.check }
}

/** Человекочитаемое имя symbology — для подписи под штрихом. */
export function symbologyName(symbology: BarcodeSymbology): string {
  return symbology === 'ean13' ? 'EAN-13' : 'Code 128'
}

const SKU_RE = /^[\w-]*\d[\w-]*$/

/** SKU из буфера/строки ввода: переводы строк, табуляции, запятые, точки с
 *  запятой; мусор отбрасываем, дубли схлопываем с сохранением порядка.
 *  Переехал сюда из pricetags-core вместе со снятием ценников SEW: разбор
 *  списка артикулов нужен печати штрихов, а подсистеме ценников SEW больше нет. */
export function parseSkuInput(text: string): string[] {
  const out: string[] = []
  const seen = new Set<string>()
  for (const raw of String(text ?? '').split(/[\s,;]+/)) {
    const value = raw.trim()
    if (!value || !SKU_RE.test(value) || seen.has(value)) continue
    seen.add(value)
    out.push(value)
  }
  return out
}

export interface BarcodeSvgOptions {
  /** Ширина одного модуля в пикселях. */
  moduleWidth?: number
  /** Высота полос в пикселях (viewBox, определяет пропорцию). */
  height?: number
  /**
   * Высота полосы на этикетке в миллиметрах. Задаётся атрибутом `height` у
   * `<svg>`: без него браузер выводит высоту из пропорции viewBox, и при
   * `width:100%` полоса у EAN-13 (117 модулей в ширину против 64 в высоту)
   * занимает 49.8 мм — больше, чем есть в этикетке, и выдавливает подпись.
   */
  heightMm?: number
  /** Тихая зона слева/справа в модулях (минимум спецификации). */
  quietZone?: number
}

const SVG_ESCAPES: Record<string, string> = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }

function escapeXml(value: string): string {
  return String(value).replace(/[&<>"']/g, (char) => SVG_ESCAPES[char] ?? char)
}

/**
 * SVG штрих-кода: полосы одним `<path>`, все координаты целые модули — так
 * печать остаётся резкой на любом размере этикетки, а не «мыльным» растром.
 *
 * Высота по умолчанию 60 модулей (у EAN-13 норма 69…185, у Code 128 типично
 * 15…20% от длины штриха) — берём с запасом, чтобы полоса не сливалась.
 */
export function barcodeSvg(code: string, options: BarcodeSvgOptions = {}): string {
  const barcode = buildBarcode(code)
  if (!barcode) throw new Error('код не кодируется в EAN-13 или Code 128')
  const moduleWidth = Math.max(1, Math.floor(options.moduleWidth ?? 2))
  const height = Math.max(1, Math.floor(options.height ?? 60))
  // Тихая зона обязательна с обеих сторон: без неё часть сканеров не берёт
  // штрих, особенно на узкой этикетке. EAN-13 требует 11, Code 128 — 10.
  const quiet = Math.max(0, Math.floor(options.quietZone ?? (barcode.symbology === 'ean13' ? 11 : 10)))
  const totalModules = barcode.modules.length + quiet * 2

  // Соседние единицы склеиваем в один прямоугольник: на 18-значном коде это
  // ~40 rect вместо 100+, а на сотне этикеток разница в размере HTML заметна.
  const bars: string[] = []
  let runStart = -1
  for (let i = 0; i <= barcode.modules.length; i += 1) {
    const isBar = i < barcode.modules.length && barcode.modules[i] === '1'
    if (isBar && runStart < 0) runStart = i
    if (!isBar && runStart >= 0) {
      const x = (quiet + runStart) * moduleWidth
      bars.push(`M${x} 0h${(i - runStart) * moduleWidth}v${height}h-${(i - runStart) * moduleWidth}z`)
      runStart = -1
    }
  }

  const heightAttr = options.heightMm ?? height
  // По умолчанию SVG сохраняет пропорцию viewBox (xMidYMid meet). Вызывающий,
  // который задал физическую высоту, хочет полосу на всю ширину этикетки:
  // preserveAspectRatio=none растягивает её по вертикали, а по горизонтали
  // масштаб остаётся равномерным, поэтому ширина модулей одинаковая и сканер
  // код берёт. Без этой строки полоса уместилась бы по высоте и потеряла
  // большую часть ширины этикетки.
  const aspect = options.heightMm === undefined ? '' : ' preserveAspectRatio="none"'

  return (
    `<svg xmlns="http://www.w3.org/2000/svg" class="bc-svg" viewBox="0 0 ${totalModules} ${height}" ` +
    `width="${totalModules * moduleWidth}" height="${heightAttr}"${aspect} shape-rendering="crispEdges" ` +
    `role="img" aria-label="Штрих-код ${escapeXml(code)}">` +
    `<path fill="#000" d="${bars.join('')}"/></svg>`
  )
}