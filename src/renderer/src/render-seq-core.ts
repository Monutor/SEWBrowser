/**
 * Счётчик поколений перерисовки: защита от задвоения строк при гонке.
 *
 * Список очищается синхронно ДО await, а строки добавляются после. Два
 * параллельных входа (двойной клик, хоткей + авто-предложение) оба успевают
 * очистить список, а потом оба дописывают полный набор — каждая строка
 * появляется дважды, с двумя наборами кнопок.
 *
 * Решение тот же, что в templates-overlay: пометить вызов номером и рисовать
 * только если пока никто более новый не начался. Возвращается значение
 * вызывающему в любом случае — «устаревший» не значит «пустой», иначе
 * openAccounts решил бы, что аккаунтов нет.
 */
export interface RenderSeq {
  call: number
}

export function createRenderSeq(): RenderSeq {
  return { call: 0 }
}

/** Метка вызывающего: инкремент счётчика (первый вызов — 1). */
export function beginRender(seq: RenderSeq): number {
  seq.call += 1
  return seq.call
}

/** Пока шли данные, начался более новый вызов — этот результат устарел. */
export function isStaleRender(seq: RenderSeq, myCall: number): boolean {
  return seq.call !== myCall
}

/**
 * Загрузить данные и отрисовать их, если к моменту ответа не начался более
 * новый вызов. Ошибка загрузки пробрасывается (рисования не будет).
 */
export async function runLatest<T>(
  seq: RenderSeq,
  load: () => Promise<T>,
  draw: (value: T) => void,
): Promise<T> {
  const myCall = beginRender(seq)
  const value = await load()
  if (isStaleRender(seq, myCall)) return value
  draw(value)
  return value
}
