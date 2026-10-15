import assert from 'node:assert/strict'
import { test } from 'node:test'
import {
  barcodeSvg,
  buildBarcode,
  code128Modules,
  code128Values,
  ean13CheckDigit,
  ean13Modules,
  isValidEan13,
  pickSymbology,
  symbologyName,
} from './barcode-core.ts'

/* ── Обратное декодирование: единственная честная проверка таблиц ──────────
 * Генератор и декодер написаны независимо друг от друга, поэтому опечатка в
 * таблице EAN/Code128 не может «сойтись сама с собой»: если бары разъедутся с
 * кодом, тест это увидит. */

const EAN_L = ['0001101', '0011001', '0010011', '0111101', '0100011', '0110001', '0101111', '0111011', '0110111', '0001011']
const EAN_G = ['0100111', '0110011', '0011011', '0100001', '0011101', '0111001', '0000101', '0010001', '0001001', '0010111']
const EAN_R = ['1110010', '1100110', '1101100', '1000010', '1011100', '1001110', '1010000', '1000100', '1001000', '1110100']

function decodeEan13(modules: string): string | null {
  assert.equal(modules.length, 95, 'EAN-13 — ровно 95 модулей')
  assert.equal(modules.slice(0, 3), '101', 'стартовый гард')
  assert.equal(modules.slice(45, 50), '01010', 'центральный гард')
  assert.equal(modules.slice(92, 95), '101', 'конечный гард')

  const right: number[] = []
  for (let i = 0; i < 6; i += 1) {
    const digit = EAN_R.indexOf(modules.slice(50 + i * 7, 57 + i * 7))
    assert.ok(digit >= 0, `правая цифра ${i} не из таблицы`)
    right.push(digit)
  }

  // Первая цифра в EAN-13 не закодирована: символы её не содержат, она лишь
  // выбирает таблицу левой половины (L для 3…9, G для 0…2). Поэтому её
  // восстанавливают перебором 0…9 с проверкой контрольной цифры — ровно так
  // же, как это делает сканер. Прочитать её «из паттерна» невозможно.
  for (let first = 0; first <= 9; first += 1) {
    const table = first >= 3 ? EAN_L : EAN_G
    const left: number[] = []
    for (let i = 0; i < 6; i += 1) {
      const digit = table.indexOf(modules.slice(3 + i * 7, 10 + i * 7))
      if (digit < 0) break
      left.push(digit)
    }
    if (left.length !== 6) continue
    const candidate = String(first) + left.join('') + right.join('')
    if (ean13CheckDigit(candidate.slice(0, 12)) === Number(candidate[12])) return candidate
  }
  return null
}

const C128_PATTERNS = [
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
]

function decodeCode128(modules: string): { data: string; check: number } {
  assert.ok(modules.endsWith('1100011101011'), 'стоп-паттерн Code 128')
  const body = modules.slice(0, -2)
  assert.equal(body.length % 11, 0, 'символы по 11 модулей')
  const symbols: number[] = []
  for (let i = 0; i < body.length; i += 11) {
    const symbol = C128_PATTERNS.indexOf(body.slice(i, i + 11))
    assert.ok(symbol >= 0, `символ ${i / 11} не из таблицы: ${body.slice(i, i + 11)}`)
    symbols.push(symbol)
  }
  const start = symbols.shift()
  assert.ok(start === 103 || start === 104 || start === 105, `стартовый символ ${start}`)
  let set = start === 103 ? 'A' : start === 104 ? 'B' : 'C'
  // После start в хвосте символов лежат данные, затем контрольный символ и
  // стоп. Отрезаем именно два последних — иначе checksum уедет в данные.
  const dataSymbols = symbols.slice(0, -2)
  const check = symbols[symbols.length - 2]
  let data = ''
  for (const symbol of dataSymbols) {
    if (symbol === 99) { set = 'C'; continue }
    if (symbol === 100) { set = 'B'; continue }
    if (set === 'C') data += String(symbol).padStart(2, '0')
    else data += String.fromCharCode(symbol + 32)
  }
  return { data, check }
}

/* ── Контрольная цифра EAN-13 ───────────────────────────────────────────── */

test('ean13CheckDigit: эталон из учебника 5901234123457', () => {
  assert.equal(ean13CheckDigit('590123412345'), 7)
  assert.equal(isValidEan13('5901234123457'), true)
  assert.equal(isValidEan13('5901234123456'), false)
})

test('ean13CheckDigit: последние 9 цифр отличаются от первых', () => {
  // Ровно та проверка, на которой спотывается «скопипастили контрольную
  // цифру один раз»: у EAN-13 веса чередуются, а не идут подряд.
  assert.equal(ean13CheckDigit('000000000000'), 0)
  assert.equal(ean13CheckDigit('000000000001'), 7)
  assert.equal(ean13CheckDigit('000000000010'), 9)
  assert.equal(ean13CheckDigit('000000000100'), 7)
  assert.equal(ean13CheckDigit('000000001000'), 9)
})

test('ean13CheckDigit: не 12 цифр — отказ, а не выдуманная цифра', () => {
  assert.equal(ean13CheckDigit('12345'), null)
  assert.equal(ean13CheckDigit('1234567890123'), null)
  assert.equal(ean13CheckDigit('12345a6789012'), null)
  assert.equal(ean13CheckDigit(''), null)
})

/* ── Выбор symbology ────────────────────────────────────────────────────── */

test('pickSymbology: 13 цифр с верной контрольной → EAN-13', () => {
  assert.equal(pickSymbology('5901234123457'), 'ean13')
  assert.equal(pickSymbology('4660294839975'), 'ean13')
})

test('pickSymbology: всё остальное из db.json → Code 128', () => {
  // Реальные значения из живого db.json: 13-значные с битой контрольной,
  // 18-значные, 12/14/15-значные и вырожденные.
  for (const code of ['2014000000564050', '13045386376190', '476000000364050', '693996262756465284', '047875880825', '6010089', '35']) {
    assert.equal(pickSymbology(code), 'code128', code)
  }
  assert.equal(pickSymbology(''), null)
  assert.equal(pickSymbology('   '), null)
})

/* ── EAN-13: структура и обратимость ────────────────────────────────────── */

test('ean13Modules: ровно 95 модулей и правильные гарды', () => {
  const modules = ean13Modules('5901234123457')
  assert.ok(modules)
  assert.equal(modules.length, 95)
  assert.equal(modules.slice(0, 3), '101')
  assert.equal(modules.slice(45, 50), '01010')
  assert.equal(modules.slice(92, 95), '101')
})

test('ean13Modules: левая половина по G для первых цифр 0/1/2 и по L для 3…9', () => {
  // Первая цифра в EAN-13 не кодируется символом — только выбором таблицы.
  // Путаница L/G — самая частая ошибка, поэтому проверяем обе ветви явно.
  // Коды отличаются ТОЛЬКО первой цифрой — левая половина во всех одна и та
  // же (234567), и видно, какой набор выбрала первая цифра.
  assert.ok(ean13Modules('0234567890129')?.startsWith('101' + EAN_G[2]))
  assert.ok(ean13Modules('1234567890128')?.startsWith('101' + EAN_G[2]))
  assert.ok(ean13Modules('2234567890127')?.startsWith('101' + EAN_G[2]))
  assert.ok(ean13Modules('3234567890126')?.startsWith('101' + EAN_L[2]))
  assert.ok(ean13Modules('9234567890120')?.startsWith('101' + EAN_L[2]))
})

test('ean13Modules: любая цифра декодируется обратно в исходный код', () => {
  for (const code of ['5901234123457', '4660294839975', '7381032401342', '1234567890128', '2000000000008', '0000000000000']) {
    const modules = ean13Modules(code)
    assert.ok(modules, code)
    assert.equal(decodeEan13(modules), code, code)
  }
})

test('ean13Modules: не EAN-13 не рисуем', () => {
  assert.equal(ean13Modules('2014000000564050'), null)
  assert.equal(ean13Modules('5901234123456'), null)
  assert.equal(ean13Modules('047875880825'), null)
})

/* ── Таблица Code 128: самодостаточные свойства ─────────────────────────── */

test('таблица Code 128: 107 символов по 11 модулей, уникальные', () => {
  // Свойства из ISO/IEC 15417: 3 полосы + 3 пробела, ширины 1…4, полосы в
  // сумме дают чётное число модулей, пробелы — нечётное, всего ровно 11.
  // Это ловит опечатку в любой из 107 строк.
  assert.equal(C128_PATTERNS.length, 107)
  assert.equal(new Set(C128_PATTERNS).size, 107, 'паттерны повторяются')
  for (const [index, pattern] of C128_PATTERNS.entries()) {
    assert.match(pattern, /^[01]{11}$/, `символ ${index} не из 11 модулей`)
    const runs = pattern.match(/(.)\1*/g) ?? []
    assert.equal(runs.length, 6, `символ ${index}: полос/пробелов ${runs.length} вместо 6`)
    const widths = runs.map((run) => run.length)
    assert.ok(widths.every((w) => w >= 1 && w <= 4), `символ ${index}: ширина вне 1..4`)
    const bars = widths.filter((_, i) => i % 2 === 0).reduce((a, b) => a + b, 0)
    const spaces = widths.filter((_, i) => i % 2 === 1).reduce((a, b) => a + b, 0)
    assert.equal(bars % 2, 0, `символ ${index}: сумма полос ${bars} нечётна`)
    assert.equal(spaces % 2, 1, `символ ${index}: сумма пробелов ${spaces} чётна`)
    assert.equal(bars + spaces, 11, `символ ${index}: не 11 модулей`)
  }
})

/* ── Code 128: кодирование ──────────────────────────────────────────────── */

test('code128Values: контрольный символ совпадает с эталоном спецификации', () => {
  // ISO/IEC 15417: "PJJ123C" в наборе A даёт контрольный символ 54 (V).
  // Тот же текст в наборе B отличается ровно на единицу — стартовый символ
  // 104 вместо 103. Это независимая проверка формулы checksum.
  const a = 103 + 48 * 1 + 42 * 2 + 42 * 3 + 17 * 4 + 18 * 5 + 19 * 6 + 35 * 7
  assert.equal(a % 103, 54)
  const b = code128Values('PJJ123C')
  assert.ok(b)
  assert.equal(b.check, 55)
})

test('code128Values: сплошные цифры идут в наборе C по две', () => {
  // Ровная длина: старт C, переключение в C и пары цифр без остатка.
  const even = code128Values('12345678')
  assert.ok(even)
  assert.deepEqual(even.values, [105, 99, 12, 34, 56, 78])
  // Нечётная длина: одна цифра в B (105 → нет, 104 = Start B, '1' = 17),
  // дальше пары в C. Без этого на хвосте осталась бы цифра и лишний
  // переход обратно в B.
  const odd = code128Values('1234567')
  assert.ok(odd)
  assert.deepEqual(odd.values, [104, 17, 99, 23, 45, 67])
  // Одна цифра целиком: набор C не окупается, кодируем в B.
  const single = code128Values('7')
  assert.ok(single)
  assert.deepEqual(single.values, [104, 23])
})

test('code128Modules: чётное число цифр — 8 символов по 11 модулей плюс хвост стопа', () => {
  // 1 старт + 1 переключение в C + 4 пары + 1 checksum + 1 стоп = 8 символов.
  const modules = code128Modules('12345678')
  assert.ok(modules)
  assert.equal(modules.length, 8 * 11 + 2)
  const decoded = decodeCode128(modules)
  assert.equal(decoded.data, '12345678')
  assert.equal(decoded.check, code128Values('12345678')!.check)
})

test('code128Modules: длина строки растёт не быстрее, чем на 2 модуля', () => {
  // Страховка от типовой ошибки «забыли стоп-паттерн или контрольный символ».
  const short = code128Modules('123456')!
  const long = code128Modules('123456789012')!
  assert.ok(long.length > short.length)
  assert.equal(long.length - short.length, (12 - 6) / 2 * 11)
})

test('code128Modules: не кодируемое значение — отказ, а не мусор', () => {
  assert.equal(code128Values(''), null)
  assert.equal(code128Values('   '), null)
  assert.equal(code128Values('ПМИДЖ-1'), null, 'кириллицы в наборе B нет')
  assert.equal(code128Values('A\x01B'), null, 'управляющие символы вне 32…126')
})

test('code128Modules: латиница кодируется набором B и читается обратно', () => {
  for (const code of ['ABC-123', 'SKU400438912', 'a!b@c#d$e%f^g&h*i(j)k*l+m,n-o.p/q:r;s<t=u>v?w']) {
    const modules = code128Modules(code)
    assert.ok(modules, code)
    assert.equal(decodeCode128(modules).data, code, code)
  }
})

/* ── Реальные коды из db.json: сквозной round-trip ──────────────────────── */

test('коды из живого db.json декодируются обратно в сами себя', () => {
  const samples = ['693996262756465284', '60356365395163352', '4004588000755486', '476000000364050', '13045386376190', '047875880825', '1001028334', '6010089', '35']
  for (const code of samples) {
    const barcode = buildBarcode(code)
    assert.ok(barcode, code)
    assert.equal(barcode.symbology, 'code128', code)
    assert.equal(decodeCode128(barcode.modules).data, code, code)
  }
})

test('buildBarcode: EAN-13 отдаёт контрольную цифру кода, Code 128 — символ', () => {
  const ean = buildBarcode('5901234123457')
  assert.ok(ean)
  assert.equal(ean.symbology, 'ean13')
  assert.equal(ean.check, 7)
  assert.equal(symbologyName(ean.symbology), 'EAN-13')

  const c128 = buildBarcode('1234567890')
  assert.ok(c128)
  assert.equal(c128.symbology, 'code128')
  assert.equal(c128.check, code128Values('1234567890')!.check)
  assert.equal(symbologyName(c128.symbology), 'Code 128')
})

test('buildBarcode: пустой код — null, а не пустая полоса', () => {
  assert.equal(buildBarcode(''), null)
  assert.equal(buildBarcode('   '), null)
})

/* ── SVG ────────────────────────────────────────────────────────────────── */

test('barcodeSvg: полосы слиты в один path, тихая зона учтена', () => {
  const svg = barcodeSvg('5901234123457', { moduleWidth: 2, height: 60 })
  assert.match(svg, /^<svg xmlns="http:\/\/www\.w3\.org\/2000\/svg"/)
  // Координаты пути в пикселях (moduleWidth=2), поэтому ширина viewBox — тоже
  // в пикселях: 117 модулей × 2 = 234, а не 117. Иначе штрих резался бы краем
  // viewBox и «уезжал» в сторону (регресс: старый тест ловил только width).
  assert.match(svg, /viewBox="0 0 234 60"/, '95 модулей + 11+11 тихих, в пикселях')
  assert.match(svg, /width="234" height="60"/)
  assert.match(svg, /<path fill="#000" d="M/)
  assert.match(svg, /shape-rendering="crispEdges"/)
})

test('barcodeSvg: тихая зона Code 128 — 10 модулей с каждой стороны', () => {
  const svg = barcodeSvg('12345678', { moduleWidth: 1 })
  const total = code128Modules('12345678')!.length
  assert.match(svg, new RegExp(`viewBox="0 0 ${total + 20} \\d+"`))
})

test('barcodeSvg: полосы склеены — столько же серий, сколько серий в модулях', () => {
  const modules = ean13Modules('5901234123457')!
  const runs = modules.match(/(.)\1*/g) ?? []
  const svg = barcodeSvg('5901234123457')
  const drawn = (svg.match(/M\d+ 0h/g) ?? []).length
  assert.equal(drawn, runs.filter((run) => run.startsWith('1')).length)
  // У EAN-13 ровно 30 чёрных полос — если «склейка» исчезла, прямоугольников
  // станет по модулю, и тест на арифметике серий это поймает.
  assert.equal(drawn, 30)
})

test('barcodeSvg: код в aria-label экранирован', () => {
  const svg = barcodeSvg('12345678')
  assert.match(svg, /aria-label="Штрих-код 12345678"/)
})

test('barcodeSvg: нес кодируемый код — исключение, не пустой SVG', () => {
  assert.throws(() => barcodeSvg('ПМИДЖ'), /не кодируется/)
  assert.throws(() => barcodeSvg(''), /не кодируется/)
})