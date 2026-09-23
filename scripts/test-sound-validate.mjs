// RED: тестирует src/main/sounds/validate.ts (скомпилированный в temp через tsc).
// Запуск: npx tsc src/main/sounds/validate.ts --outDir <tmp> --module commonjs --target es2020 --strict
//         node scripts/test-sound-validate.mjs <tmp>
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { pathToFileURL } from 'node:url'

const outDir = process.argv[2] ?? ''
const { pickSoundExt, isSoundSizeOk, isSoundSlot } = await import(pathToFileURL(outDir + '/validate.js').href)

test('разрешает mp3/wav/ogg независимо от регистра', () => {
  assert.equal(pickSoundExt('alarm.MP3'), 'mp3')
  assert.equal(pickSoundExt('ding.wav'), 'wav')
  assert.equal(pickSoundExt('notify.Ogg'), 'ogg')
})

test('отклоняет чужие расширения и отсутствие расширения', () => {
  assert.equal(pickSoundExt('virus.exe'), null)
  assert.equal(pickSoundExt('notes.txt'), null)
  assert.equal(pickSoundExt('track.m4a'), null)
  assert.equal(pickSoundExt('noext'), null)
})

test('размер: 0 байт и больше 2 МБ — нельзя, граница 2 МБ — можно', () => {
  assert.equal(isSoundSizeOk(0), false)
  assert.equal(isSoundSizeOk(1), true)
  assert.equal(isSoundSizeOk(2 * 1024 * 1024), true)
  assert.equal(isSoundSizeOk(2 * 1024 * 1024 + 1), false)
})

test('слоты звука: только rel и ho', () => {
  assert.equal(isSoundSlot('rel'), true)
  assert.equal(isSoundSlot('ho'), true)
  assert.equal(isSoundSlot('custom'), false)
  assert.equal(isSoundSlot(''), false)
  assert.equal(isSoundSlot('../rel'), false)
})
