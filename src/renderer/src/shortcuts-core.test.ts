import { test } from 'node:test'
import assert from 'node:assert/strict'
import { shortcutFromEvent, type ShortcutKeyEvent } from './shortcuts-core.ts'

/** Собирает событие из «человеческого» описания: буквы по key, цифры по коду. */
function ev(key: string, mods: Partial<Omit<ShortcutKeyEvent, 'key' | 'code'>> & { code?: string } = {}): ShortcutKeyEvent {
  return {
    key,
    code: mods.code ?? (key.length === 1 ? `Key${key.toUpperCase()}` : key),
    ctrlKey: false,
    metaKey: false,
    shiftKey: false,
    altKey: false,
    ...mods,
  }
}

test('mod — это ctrl или meta', () => {
  assert.equal(shortcutFromEvent(ev('l', { ctrlKey: true })), 'focus-address')
  assert.equal(shortcutFromEvent(ev('l', { metaKey: true })), 'focus-address')
})

test('буквы читаются по event.code, а не по key', () => {
  // Раскладка не важна: key = 'ф', но code = KeyL.
  const cyrillic = ev('ф', { ctrlKey: true, code: 'KeyL' })
  assert.equal(shortcutFromEvent(cyrillic), 'focus-address')
})

test('вкладки: создание, закрытие, переключение', () => {
  assert.equal(shortcutFromEvent(ev('t', { ctrlKey: true })), 'new-tab')
  assert.equal(shortcutFromEvent(ev('w', { ctrlKey: true })), 'close-tab')
  assert.equal(shortcutFromEvent(ev('Tab', { ctrlKey: true })), 'next-tab')
  assert.equal(shortcutFromEvent(ev('Tab', { ctrlKey: true, shiftKey: true })), 'prev-tab')
})

test('Ctrl+1…9 дают tab-N по цифровому коду', () => {
  for (let n = 1; n <= 9; n += 1) {
    assert.equal(shortcutFromEvent(ev(String(n), { code: `Digit${n}`, ctrlKey: true })), `tab-${n}`)
  }
})

test('цифры без модификатора — не хоткей', () => {
  assert.equal(shortcutFromEvent(ev('1', { code: 'Digit1' })), null)
  // Shift или Alt исключают перехват цифр.
  assert.equal(shortcutFromEvent(ev('1', { code: 'Digit1', ctrlKey: true, shiftKey: true })), null)
  assert.equal(shortcutFromEvent(ev('1', { code: 'Digit1', ctrlKey: true, altKey: true })), null)
})

test('Ctrl+Shift+T остаётся шаблонами, а не новой вкладкой', () => {
  assert.equal(shortcutFromEvent(ev('T', { code: 'KeyT', ctrlKey: true, shiftKey: true })), 'templates')
  assert.equal(shortcutFromEvent(ev('T', { code: 'KeyT', ctrlKey: true })), 'new-tab')
})

test('Ctrl+Shift+P — окно ценников', () => {
  assert.equal(shortcutFromEvent(ev('P', { code: 'KeyP', ctrlKey: true, shiftKey: true })), 'pricetags')
})

test('Ctrl+Shift+L — учётные записи, Ctrl+L — адресная строка', () => {
  assert.equal(shortcutFromEvent(ev('l', { code: 'KeyL', ctrlKey: true, shiftKey: true })), 'accounts')
  assert.equal(shortcutFromEvent(ev('l', { code: 'KeyL', ctrlKey: true })), 'focus-address')
})

test('перезагрузка: F5, Ctrl+R и жёсткая Ctrl+F5', () => {
  assert.equal(shortcutFromEvent(ev('F5')), 'reload')
  assert.equal(shortcutFromEvent(ev('r', { ctrlKey: true })), 'reload')
  assert.equal(shortcutFromEvent(ev('F5', { ctrlKey: true })), 'hard-reload')
})

test('поиск, печать и снимок экрана', () => {
  assert.equal(shortcutFromEvent(ev('f', { ctrlKey: true })), 'find')
  assert.equal(shortcutFromEvent(ev('p', { ctrlKey: true })), 'print')
  assert.equal(shortcutFromEvent(ev('S', { code: 'KeyS', ctrlKey: true, shiftKey: true })), 'screenshot')
  // Без Shift тот же код — не снимок.
  assert.equal(shortcutFromEvent(ev('S', { code: 'KeyS', ctrlKey: true })), null)
})

test('зум: клавиши и numpad', () => {
  assert.equal(shortcutFromEvent(ev('=', { code: 'Equal', ctrlKey: true })), 'zoom-in')
  assert.equal(shortcutFromEvent(ev('+', { code: 'Equal', ctrlKey: true })), 'zoom-in')
  assert.equal(shortcutFromEvent(ev('+', { code: 'NumpadAdd', ctrlKey: true })), 'zoom-in')
  assert.equal(shortcutFromEvent(ev('-', { code: 'Minus', ctrlKey: true })), 'zoom-out')
  assert.equal(shortcutFromEvent(ev('-', { code: 'NumpadSubtract', ctrlKey: true })), 'zoom-out')
  assert.equal(shortcutFromEvent(ev('0', { code: 'Digit0', ctrlKey: true })), 'zoom-reset')
  assert.equal(shortcutFromEvent(ev('0', { code: 'Numpad0', ctrlKey: true })), 'zoom-reset')
})

test('настройки по Ctrl+запятая', () => {
  assert.equal(shortcutFromEvent(ev(',', { code: 'Comma', ctrlKey: true })), 'settings')
})

test('навигация по Alt+стрелки', () => {
  assert.equal(shortcutFromEvent(ev('ArrowLeft', { altKey: true })), 'back')
  assert.equal(shortcutFromEvent(ev('ArrowRight', { altKey: true })), 'forward')
  // Без Alt стрелки — не хоткей оболочки.
  assert.equal(shortcutFromEvent(ev('ArrowLeft')), null)
})

test('служебные клавиши: F11, F1, Escape', () => {
  assert.equal(shortcutFromEvent(ev('F11')), 'fullscreen')
  assert.equal(shortcutFromEvent(ev('F1')), 'help')
  assert.equal(shortcutFromEvent(ev('Escape')), 'escape')
  // Ctrl+F1 не перехватываем — отдаём системе.
  assert.equal(shortcutFromEvent(ev('F1', { ctrlKey: true })), null)
})

test('неизвестные комбинации игнорируются', () => {
  assert.equal(shortcutFromEvent(ev('q', { ctrlKey: true })), null)
  assert.equal(shortcutFromEvent(ev('a')), null)
  assert.equal(shortcutFromEvent(ev('F7')), null)
})
