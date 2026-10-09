import { test } from 'node:test'
import assert from 'node:assert/strict'

import { isPermissionCheckAllowed, SAFE_CHECK_PERMISSIONS } from './permissions-core.ts'

test('check: разрешения, нужные гостю без диалога, проходят', () => {
  assert.equal(isPermissionCheckAllowed('notifications'), true)
  assert.equal(isPermissionCheckAllowed('fullscreen'), true)
  assert.equal(isPermissionCheckAllowed('automatic-fullscreen'), true)
  assert.equal(isPermissionCheckAllowed('pointerLock'), true)
  // sku-copy кладёт артикул в буфер через navigator.clipboard.writeText —
  // это check-only разрешение, запроса за ним не приходит вовсе.
  assert.equal(isPermissionCheckAllowed('clipboard-sanitized-write'), true)
})

test('check: опасные check-only разрешения без запроса — отказ', () => {
  for (const permission of [
    'openExternal',
    'window-management',
    'local-network',
    'local-network-access',
    'loopback-network',
    'persistent-storage',
    'midi',
    'midiSysex',
    'hid',
    'serial',
    'usb',
    'nfc',
    'smart-card',
    'sensors',
    'display-capture',
    'mediaKeySystem',
    'payment-handler',
    'speaker-selection',
    'fileSystem',
    'storage-access',
    'top-level-storage-access',
    'background-fetch',
    'background-sync',
    'idle-detection',
    'web-app-installation',
    'web-printing',
    'vr',
    'unknown',
  ]) {
    assert.equal(isPermissionCheckAllowed(permission), false, permission)
  }
})

test('check: разрешения с диалогом уходят в request-хендлер, а не разрешаются молча', () => {
  // check=false → Chromium делает permission request → наш request-хендлер
  // показывает диалог (camera/microphone/geolocation/clipboard-read) либо отказ.
  for (const permission of ['media', 'geolocation', 'geolocation-approximate', 'clipboard-read', 'audioCapture']) {
    assert.equal(isPermissionCheckAllowed(permission), false, permission)
  }
})

test('check: регистр не обходит список', () => {
  assert.equal(isPermissionCheckAllowed('Notifications'), true)
  assert.equal(isPermissionCheckAllowed('OPENEXTERNAL'), false)
})

test('check: мусор и пустое значение — отказ, а не исключение', () => {
  assert.equal(isPermissionCheckAllowed(''), false)
  assert.equal(isPermissionCheckAllowed('unknown-permission'), false)
  assert.equal(isPermissionCheckAllowed(undefined as unknown as string), false)
  assert.equal(isPermissionCheckAllowed(null as unknown as string), false)
  assert.equal(isPermissionCheckAllowed(42 as unknown as string), false)
})

test('check: список безопасных разрешений не пустой и не содержит лишнего', () => {
  assert.ok(SAFE_CHECK_PERMISSIONS.size >= 5)
  assert.equal(SAFE_CHECK_PERMISSIONS.has('camera'), false)
  assert.equal(SAFE_CHECK_PERMISSIONS.has('media'), false)
  assert.equal(SAFE_CHECK_PERMISSIONS.has('geolocation'), false)
})
