/**
 * История кодов товара, введённых в генератор штрихов (оверлей «Штрихи»).
 *
 * Модуль чистый: без electron и файловой системы, всё тестируется в node:test.
 * Файл на диске — `%APPDATA%/SEWBrowser/barcode-history.json`, чтение и запись
 * держит `src/main/barcode-history.ts`.
 *
 * Храним ТОЛЬКО коды товара: штрих и наименование дозапрашиваются из локальной
 * базы по этим кодам (barcodesLookup), а хранить вторую копию — значит держать
 * в актуальном состоянии две правды об одном товаре.
 */

/** Сколько кодов держим. История — это «что я недавно вводил», а не архив:
 *  за несколькими сотнями список перестаёт быть полезным, но файл растёт. */
export const HISTORY_LIMIT = 200

/** Нормализация одного кода: без пробелов, только непустое. Всё, что не строка
 *  и не число, в историю не попадает — иначе битый аргумент из renderer засорит
 *  файл, который потом придётся чинить вручную. */
function normalize(value: unknown): string {
  if (typeof value === 'number' && Number.isFinite(value)) return String(value)
  if (typeof value !== 'string') return ''
  return value.trim()
}

/**
 * Разбор файла истории. Любой мусор (битый JSON, объект вместо массива,
 * не-строки внутри) даёт пустой список: битая история не должна ломать
 * открытие оверлея — это просто подсказка, что вводили раньше.
 */
export function parseHistory(text: string): string[] {
  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch {
    return []
  }
  if (!parsed || typeof parsed !== 'object') return []
  const list = (parsed as { skus?: unknown }).skus
  if (!Array.isArray(list)) return []
  const out: string[] = []
  for (const raw of list) {
    const sku = normalize(raw)
    if (sku) out.push(sku)
  }
  return mergeHistory([], out, HISTORY_LIMIT)
}

/**
 * Дописать новые коды в историю: без дублей, новые сверху (свежие — в глаза),
 * с обрезкой хвоста до лимита. Уже имеющийся код, введённый снова, лишь
 * поднимается наверх — так он оказывается в свежей части списка.
 */
export function mergeHistory(current: string[], incoming: string[], limit = HISTORY_LIMIT): string[] {
  const seen = new Set<string>()
  const out: string[] = []
  const push = (value: unknown): boolean => {
    const sku = normalize(value)
    if (!sku || seen.has(sku)) return false
    seen.add(sku)
    out.push(sku)
    return true
  }
  for (const value of incoming) {
    if (!push(value)) continue
    if (out.length >= limit) return out
  }
  for (const value of current) {
    if (out.length >= limit) break
    push(value)
  }
  return out
}