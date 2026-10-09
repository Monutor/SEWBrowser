import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { isAllowedFaviconUrl } from './favicon-core.ts'

const PAGE = 'https://sew.mvideoeldorado.ru/v2/'
const ALLOW = ['*.mvideoeldorado.ru', 'kc.tech.mvideo.ru']

describe('isAllowedFaviconUrl', () => {
  it('иконка с того же хоста, что и страница, — разрешена', () => {
    assert.equal(isAllowedFaviconUrl('https://sew.mvideoeldorado.ru/favicon.ico', PAGE, ALLOW, true), true)
  })
  it('тот же хост по http и без www — разрешён', () => {
    assert.equal(isAllowedFaviconUrl('http://SEW.mvideoeldorado.ru/i.png', PAGE, ALLOW, true), true)
  })
  it('иной путь на том же хосте — разрешён', () => {
    assert.equal(isAllowedFaviconUrl('https://sew.mvideoeldorado.ru/assets/i?v=2', PAGE, ALLOW, true), true)
  })

  it('чужой хост без allowlist — отказ', () => {
    assert.equal(isAllowedFaviconUrl('https://cdn.site.ru/favicon.png', PAGE, ALLOW, true), false)
  })
  it('localhost и внутренняя сеть — отказ', () => {
    assert.equal(isAllowedFaviconUrl('http://localhost:8080/actuator/env', PAGE, ALLOW, true), false)
    assert.equal(isAllowedFaviconUrl('http://10.0.0.5/logo.png', PAGE, ALLOW, true), false)
  })
  it('подмена хоста через userinfo — отказ (host = evil.ru, а не sew)', () => {
    assert.equal(isAllowedFaviconUrl('http://sew.mvideoeldorado.ru@evil.ru/i.png', PAGE, ALLOW, true), false)
  })
  it('подмена суффикса без точки-разделителя — отказ', () => {
    // evil-mvideoeldorado.ru не заканчивается на ".mvideoeldorado.ru"
    assert.equal(isAllowedFaviconUrl('https://evil-mvideoeldorado.ru/i.png', PAGE, ALLOW, true), false)
  })
  it('настоящий поддомен allowlist-домена через wildcard — разрешён', () => {
    assert.equal(isAllowedFaviconUrl('https://evil-sew.mvideoeldorado.ru/i.png', PAGE, ALLOW, true), true)
  })

  it('хост из allowlist точным шаблоном — разрешён', () => {
    assert.equal(isAllowedFaviconUrl('https://kc.tech.mvideo.ru/f.ico', PAGE, ALLOW, true), true)
  })
  it('поддомен из wildcard-шаблона allowlist — разрешён', () => {
    assert.equal(isAllowedFaviconUrl('https://cdn.mvideoeldorado.ru/f.ico', PAGE, ALLOW, true), true)
  })
  it('сам домен wildcard-шаблона — разрешён', () => {
    assert.equal(isAllowedFaviconUrl('https://mvideoeldorado.ru/f.ico', PAGE, ALLOW, true), true)
  })

  it('не-http схема — отказ', () => {
    assert.equal(isAllowedFaviconUrl('file:///C:/Windows/win.ini', PAGE, ALLOW, true), false)
    assert.equal(isAllowedFaviconUrl('javascript:alert(1)', PAGE, ALLOW, true), false)
    assert.equal(isAllowedFaviconUrl('data:image/png;base64,AAA', PAGE, ALLOW, true), false)
  })
  it('мусор и пустая строка — отказ', () => {
    assert.equal(isAllowedFaviconUrl('', PAGE, ALLOW, true), false)
    assert.equal(isAllowedFaviconUrl('не-url', PAGE, ALLOW, true), false)
  })
  it('битый URL страницы — иконка разрешена только если её хост в allowlist', () => {
    assert.equal(isAllowedFaviconUrl('https://cdn.mvideoeldorado.ru/f.ico', 'не-url', ALLOW, true), true)
    assert.equal(isAllowedFaviconUrl('https://evil.ru/f.ico', 'не-url', ALLOW, true), false)
  })
  it('пустой allowlist оставляет только хост страницы', () => {
    assert.equal(isAllowedFaviconUrl('https://sew.mvideoeldorado.ru/f.ico', PAGE, [], true), true)
    assert.equal(isAllowedFaviconUrl('https://kc.tech.mvideo.ru/f.ico', PAGE, [], true), false)
  })
  it('битый allowlist (не массив) не роняет проверку', () => {
    assert.equal(isAllowedFaviconUrl('https://sew.mvideoeldorado.ru/f.ico', PAGE, 'мусор' as never, true), true)
    assert.equal(isAllowedFaviconUrl('https://evil.ru/f.ico', PAGE, 'мусор' as never, true), false)
  })
  it('allowlist выключен — ограничений нет, как у isAllowedUrl', () => {
    assert.equal(isAllowedFaviconUrl('https://evil.ru/f.ico', PAGE, [], false), true)
  })
})
