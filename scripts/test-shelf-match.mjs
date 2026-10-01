// Стенд фичи: features/sew-helper/shelf-match.js — распознавание полок,
// в т.ч. ввод с английской раскладки (ЙЦУКЕН) и транслитом.
// Запуск: node scripts/test-shelf-match.mjs
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createRequire } from 'node:module'

const require = createRequire(import.meta.url)
const { shelfNormalize, shelfSearchKeys, shelfMatches } = require('../features/sew-helper/shelf-match.js')

const SHELF = shelfSearchKeys('Торговый Зал', '1-14')

test('русский ввод по-прежнему находит полку', () => {
  assert.equal(shelfMatches(SHELF, 'торговый'), true)
  assert.equal(shelfMatches(SHELF, 'Торговый Зал'), true)
  assert.equal(shelfMatches(SHELF, 'зал 1-14'), true)
})

test('ввод с английской раскладки (забыли переключить) находит ту же полку', () => {
  assert.equal(shelfMatches(SHELF, 'Njhujdsq Pfk'), true)
  assert.equal(shelfMatches(SHELF, 'njhujdsq'), true)
  assert.equal(shelfMatches(SHELF, 'Nfhby'), false)
})

test('транслит латиницей находит полку', () => {
  assert.equal(shelfMatches(SHELF, 'Torgovyj'), true)
  assert.equal(shelfMatches(SHELF, 'torgovyj zal'), true)
  assert.equal(shelfMatches(SHELF, 'Torg'), true)
})

test('пустой ввод показывает всё, чужое слово — ничего', () => {
  assert.equal(shelfMatches(SHELF, ''), true)
  assert.equal(shelfMatches(SHELF, '   '), true)
  assert.equal(shelfMatches(SHELF, 'Алмаз'), false)
})

test('нормализация игнорирует регистр, пробелы, дефисы и «ё»', () => {
  assert.equal(shelfNormalize('Ёлка-2'), 'елка2')
  assert.equal(shelfNormalize('  Торговый   Зал '), 'торговыйзал')
})

test('ключи полки содержат кириллицу, ЙЦУКЕН и транслит', () => {
  assert.deepEqual(SHELF, ['торговыйзал114', 'njhujdsqpfk114', 'torgovyjzal114'])
})
