import assert from 'node:assert/strict'
import { test } from 'node:test'
import {
  beginRender,
  createRenderSeq,
  isStaleRender,
  runLatest,
} from './render-seq-core.ts'

function deferred<T>(): { promise: Promise<T>; resolve(value: T): void } {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((res) => {
    resolve = res
  })
  return { promise, resolve }
}

test('счётчик перерисовок начинается с нуля и растёт на каждый вызов', () => {
  const seq = createRenderSeq()
  assert.equal(seq.call, 0)
  assert.equal(beginRender(seq), 1)
  assert.equal(beginRender(seq), 2)
  assert.equal(seq.call, 2)
})

test('устаревшим считается вызов, пока шёл более новый', () => {
  const seq = createRenderSeq()
  const first = beginRender(seq)
  assert.equal(isStaleRender(seq, first), false)
  beginRender(seq)
  assert.equal(isStaleRender(seq, first), true)
  assert.equal(isStaleRender(seq, seq.call), false)
})

test('одиночный вызов рисует загруженное значение', async () => {
  const seq = createRenderSeq()
  const drawn: string[] = []
  const result = await runLatest(
    seq,
    async () => 'accounts',
    (value) => drawn.push(value),
  )
  assert.equal(result, 'accounts')
  assert.deepEqual(drawn, ['accounts'])
})

test('устаревший вызов не рисует — иначе строки задваиваются', async () => {
  const seq = createRenderSeq()
  const first = deferred<string>()
  const second = deferred<string>()
  const drawn: string[] = []

  const p1 = runLatest(seq, () => first.promise, (value) => drawn.push(value))
  const p2 = runLatest(seq, () => second.promise, (value) => drawn.push(value))

  // Более новый вызов успел раньше — рисует он.
  second.resolve('свежие')
  await p2
  // Старый ответ приходит последним: рисовать ему нельзя.
  first.resolve('устаревшие')
  await p1

  assert.deepEqual(drawn, ['свежие'])
})

test('устаревший вызов всё равно возвращает своё значение вызывающему', async () => {
  const seq = createRenderSeq()
  const first = deferred<string[]>()
  const second = deferred<string[]>()
  const drawn: string[][] = []

  const p1 = runLatest(seq, () => first.promise, (value) => drawn.push(value))
  const p2 = runLatest(seq, () => second.promise, (value) => drawn.push(value))

  second.resolve(['свежий'])
  await p2
  first.resolve(['устаревший'])
  const staleValue = await p1

  // Вызывающий (openAccounts) решает по возврату — «пусто» здесь означало бы
  // ложное «нет сохранённых аккаунтов».
  assert.deepEqual(staleValue, ['устаревший'])
  assert.deepEqual(drawn, [['свежий']])
})

test('последовательные вызовы рисуют каждый — устаревших нет', async () => {
  const seq = createRenderSeq()
  const drawn: number[] = []
  await runLatest(seq, async () => 1, (value) => drawn.push(value))
  await runLatest(seq, async () => 2, (value) => drawn.push(value))
  assert.deepEqual(drawn, [1, 2])
})

test('ошибка загрузки не рисует и пробрасывается вызывающему', async () => {
  const seq = createRenderSeq()
  const drawn: string[] = []
  await assert.rejects(
    runLatest(
      seq,
      async () => {
        throw new Error('list accounts failed')
      },
      (value) => drawn.push(value),
    ),
    /list accounts failed/,
  )
  assert.deepEqual(drawn, [])
})
