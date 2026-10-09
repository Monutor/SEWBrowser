import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { writeJsonAtomic } from './json-file.ts'

/**
 * Тесты идут по реальной ФС в отдельной временной папке на каждый кейс: писать
 * надо в настоящий файл, иначе «атомарность через temp+rename» нечего
 * проверять — мок fs доказывает лишь то, что мок сам же и делает.
 *
 * Ключевая проверка — `beforeCommit`: хук вызывается после записи во временный
 * файл и до rename, то есть попадает ровно в окно, где процесс может умереть.
 * In-place запись к этому моменту уже испортила цель, temp+rename — ещё нет.
 * Это единственный способ отличить атомарную запись от обычной, не убивая
 * процесс по-настоящему.
 */
function sandbox(): string {
  return mkdtempSync(join(tmpdir(), 'sew-json-'))
}

/** Всё, что лежит в папке, кроме ожидаемого целевого файла. */
function strays(dir: string, keep: string): string[] {
  return readdirSync(dir).filter((name) => name !== keep)
}

describe('writeJsonAtomic — запись JSON через temp+rename', () => {
  it('создаёт файл с разбираемым содержимым', () => {
    const dir = sandbox()
    const file = join(dir, 'config.json')
    writeJsonAtomic(file, { startUrl: 'https://sew.mvideoeldorado.ru/v2/', tabs: [1, 2] })
    assert.deepEqual(JSON.parse(readFileSync(file, 'utf-8')), { startUrl: 'https://sew.mvideoeldorado.ru/v2/', tabs: [1, 2] })
  })

  it('перезаписывает существующий файл целиком, а не дописывает', () => {
    const dir = sandbox()
    const file = join(dir, 'credentials.json')
    // Старое содержимое длиннее нового: если бы запись шла в начало файла,
    // хвост «лишнего» остался бы и JSON перестал бы разбираться.
    writeJsonAtomic(file, [{ id: 'a' }, { id: 'b' }, { id: 'c' }, { id: 'd' }, { id: 'e' }])
    writeJsonAtomic(file, [{ id: 'z' }])
    assert.deepEqual(JSON.parse(readFileSync(file, 'utf-8')), [{ id: 'z' }])
  })

  it('создаёт недостающие каталоги по пути файла', () => {
    const dir = sandbox()
    const file = join(dir, 'plugin-data', 'deep', 'tasks-notify.json')
    writeJsonAtomic(file, { seen: { '1': true } })
    assert.deepEqual(JSON.parse(readFileSync(file, 'utf-8')), { seen: { '1': true } })
  })

  it('после успеха в каталоге не остаётся временных файлов', () => {
    const dir = sandbox()
    writeJsonAtomic(join(dir, 'downloads.json'), [])
    assert.deepEqual(strays(dir, 'downloads.json'), [])
  })

  it('до rename в файле-цели лежит прежнее содержимое', () => {
    // Суть атомарности. Момент, когда новые данные уже записаны, но ещё не
    // видны читателю. In-place запись к этому моменту уже подставила бы в
    // config.json либо обрезок, либо полностью новое содержимое — то есть
    // читатель, поймавший файл в этом окне, увидел бы мусор.
    const dir = sandbox()
    const file = join(dir, 'config.json')
    const before = { good: true, tabs: ['a', 'b'] }
    writeJsonAtomic(file, before)
    let seenAtCommit: string | null = null
    writeJsonAtomic(file, { good: false, tabs: ['x', 'y', 'z'] }, () => {
      seenAtCommit = readFileSync(file, 'utf-8')
    })
    assert.notEqual(seenAtCommit, null, 'хук beforeCommit не был вызван')
    assert.deepEqual(JSON.parse(seenAtCommit as unknown as string), before)
  })

  it('обрыв между записью и rename не трогает файл на диске', () => {
    // Тот же момент, но процесс не просто смотрит, а умирает: исключение из
    // хука — это «питание выключили / OOM killer». Старый config.json обязан
    // уцелеть целиком, иначе после перезапуска приложение откроется с пустыми
    // вкладками, а следующий config:set запишет поверх дефолты навсегда.
    const dir = sandbox()
    const file = join(dir, 'config.json')
    const before = { good: true, tabs: ['a', 'b'], downloadDir: 'D:\\Downloads' }
    writeJsonAtomic(file, before)
    assert.throws(
      () => writeJsonAtomic(file, { good: false, tabs: [] }, () => { throw new Error('обрыв записи') }),
      /обрыв записи/,
    )
    assert.deepEqual(JSON.parse(readFileSync(file, 'utf-8')), before)
    assert.deepEqual(strays(dir, 'config.json'), [])
  })

  it('неудачная сериализация не трогает прежнее содержимое', () => {
    // Сериализация обязана идти ДО открытия файла: JSON.stringify бросает на
    // циклическом объекте, и если бы он шёл после открытия цели, файл
    // остался бы пустым/обрезанным.
    const dir = sandbox()
    const file = join(dir, 'config.json')
    writeJsonAtomic(file, { good: true, tabs: ['a', 'b'] })
    const cyclic: Record<string, unknown> = { good: true }
    cyclic.self = cyclic
    assert.throws(() => writeJsonAtomic(file, cyclic))
    assert.deepEqual(JSON.parse(readFileSync(file, 'utf-8')), { good: true, tabs: ['a', 'b'] })
    assert.deepEqual(strays(dir, 'config.json'), [])
  })

  it('неудачная сериализация не оставляет и нового файла', () => {
    const dir = sandbox()
    const file = join(dir, 'folder-passwords.json')
    const cyclic: Record<string, unknown> = {}
    cyclic.self = cyclic
    assert.throws(() => writeJsonAtomic(file, cyclic))
    assert.equal(existsSync(file), false)
    assert.deepEqual(strays(dir, 'folder-passwords.json'), [])
  })

  it('BigInt в данных тоже мимо файла', () => {
    // JSON.stringify бросает на BigInt — защита тут общая: любая непредставимая
    // в JSON величина не должна портить файл.
    const dir = sandbox()
    const file = join(dir, 'plugin-data.json')
    assert.throws(() => writeJsonAtomic(file, { big: 1n }))
    assert.equal(existsSync(file), false)
  })

  it('отказ записи на диск не оставляет временный файл', () => {
    // Цель — каталог: rename поверх него упадёт. Проверяем, что мусор в папке
    // не копится, иначе plugin-data зарос бы .tmp-хвостами после каждой ошибки.
    const dir = sandbox()
    const target = join(dir, 'config.json')
    mkdirSync(target)
    assert.throws(() => writeJsonAtomic(target, { a: 1 }))
    assert.deepEqual(strays(dir, 'config.json'), [])
  })

  it('два соседних вызова не путают временные файлы друг друга', () => {
    // Имя временного файла обязано быть уникальным: если бы оно было
    // производным только от целевого пути, соседние записи переименовывали бы
    // чужой файл и теряли данные.
    const dir = sandbox()
    const file = join(dir, 'config.json')
    for (let i = 0; i < 50; i++) writeJsonAtomic(file, { i })
    assert.deepEqual(JSON.parse(readFileSync(file, 'utf-8')), { i: 49 })
    assert.deepEqual(strays(dir, 'config.json'), [])
  })
})
