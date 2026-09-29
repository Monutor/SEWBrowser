// features/sew-auth/main.js — перехватывает Bearer SEW из запросов самой SPA.
// Токен нужен main-процессу: кнопка «Скачать остатки» бьёт в API SEW из main
// (net.fetch), а сессионных кук гостя для этого недостаточно — API отдаёт 401.
// Токен живёт только в памяти страницы (window.__sewAuthBearer): никуда не
// пишется, в консоль не выводится, в plugin-data не попадает. Читает его
// main через executeJavaScript в момент клика по кнопке.
(() => {
  if (window.__sewAuthHooked) return
  window.__sewAuthHooked = true

  // SPA ходит и на свой хост, и на BFF — берём оба, но только свои.
  const OURS = /(^|\.)mvideoeldorado\.ru$/i

  function isOurs(u) {
    try {
      return OURS.test(new URL(String(u), location.href).hostname)
    } catch {
      return false
    }
  }

  function remember(v) {
    if (typeof v === 'string' && v.indexOf('Bearer ') === 0 && v.length > 7) {
      window.__sewAuthBearer = v
    }
  }

  function grab(h) {
    try {
      if (typeof h === 'string') {
        remember(h)
      } else if (h && typeof h.get === 'function') {
        remember(h.get('authorization') || h.get('Authorization'))
      } else if (h && typeof h === 'object') {
        remember(h['authorization'] || h['Authorization'])
      }
    } catch (e) {}
  }

  try {
    const origFetch = window.fetch.bind(window)
    window.fetch = function (url, opts) {
      try {
        if (isOurs(url && url.url ? url.url : url)) {
          grab(opts && opts.headers)
        }
      } catch (e) {}
      return origFetch(url, opts)
    }
  } catch (e) {}

  try {
    // Оборачиваем setRequestHeader на прототипе сразу: он всегда вызывается
    // до send, поэтому здесь Bearer ещё доступен (в обёртке send — уже нет).
    const origSetHeader = XMLHttpRequest.prototype.setRequestHeader
    XMLHttpRequest.prototype.setRequestHeader = function (k, v) {
      try {
        if (String(k).toLowerCase() === 'authorization' && isOurs(this.__sewAuthUrl)) {
          remember(String(v))
        }
      } catch (e) {}
      return origSetHeader.apply(this, arguments)
    }
    const origOpen = XMLHttpRequest.prototype.open
    XMLHttpRequest.prototype.open = function (m, u) {
      this.__sewAuthUrl = u
      return origOpen.apply(this, arguments)
    }
  } catch (e) {}
})()
