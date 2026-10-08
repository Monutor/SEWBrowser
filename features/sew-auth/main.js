// features/sew-auth/main.js — перехватывает Bearer SEW и логин (x-username) из
// запросов самой SPA. Токен нужен main-процессу: кнопка «Скачать остатки» бьёт
// в API SEW из main (net.fetch), а сессионных кук гостя для этого недостаточно —
// API отдаёт 401.
// Логин нужен для диагностики ценников: подсистема /api/pricetags-* работает от
// x-username, и при входе в SEW под другим сотрудником SEW отвечает «Access
// Denied». Значение из этого перехвата — то, за кого SEW видит текущую сессию.
// Оба значения живут только в памяти страницы (window.__sewAuthBearer,
// window.__sewAuthUsername): никуда не пишутся, в консоль не выводятся, в
// plugin-data не попадают. Читает их main через executeJavaScript.
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

  /** Логин SEW из x-username: табельный номер, иногда с именем. Валидируем
   *  поверх: значение пойдёт в подсказку пользователю и в заголовок нашего
   *  запроса, поэтому мусор из заголовков чужого запроса туда не пускаем. */
  function rememberUsername(v) {
    if (typeof v === 'string' && /^[A-Za-z0-9._@-]{1,64}$/.test(v.trim())) {
      window.__sewAuthUsername = v.trim()
    }
  }

  /** Значение заголовка из того, чем SPA его передала: строка, пара, объект
   *  или Headers — форма зависит от вызова, а перехватываем все. */
  function headerValue(h, name) {
    try {
      if (!h) return ''
      if (typeof h === 'string') {
        const m = new RegExp('(?:^|[,\\n;])' + name + '\\s*[=:]\\s*"?([^",;\\n]+)', 'i').exec(h)
        return m ? m[1] : ''
      }
      if (typeof h.get === 'function') return String(h.get(name) || '')
      if (Array.isArray(h)) {
        const pair = h.find((p) => Array.isArray(p) && String(p[0]).toLowerCase() === name)
        return pair ? String(pair[1]) : ''
      }
      if (typeof h === 'object') {
        const key = Object.keys(h).find((k) => k.toLowerCase() === name)
        return key ? String(h[key]) : ''
      }
    } catch (e) {}
    return ''
  }

  function grab(h) {
    try {
      if (typeof h === 'string') {
        remember(h)
        rememberUsername(headerValue(h, 'x-username'))
      } else if (h && typeof h.get === 'function') {
        remember(h.get('authorization') || h.get('Authorization'))
        rememberUsername(h.get('x-username') || h.get('X-Username'))
      } else if (Array.isArray(h)) {
        const pair = h.find((p) => Array.isArray(p) && String(p[0]).toLowerCase() === 'authorization')
        if (pair) remember(String(pair[1]))
        const user = h.find((p) => Array.isArray(p) && String(p[0]).toLowerCase() === 'x-username')
        if (user) rememberUsername(String(user[1]))
      } else if (h && typeof h === 'object') {
        remember(h['authorization'] || h['Authorization'])
        rememberUsername(h['x-username'] || h['X-Username'] || h['X-username'])
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
        const name = String(k).toLowerCase()
        if (name === 'authorization' && isOurs(this.__sewAuthUrl)) {
          remember(String(v))
        } else if (name === 'x-username' && isOurs(this.__sewAuthUrl)) {
          rememberUsername(String(v))
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
