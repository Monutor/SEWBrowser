(() => {
  if (window.__sewIdentityScript) return
  window.__sewIdentityScript = true

  // Селекторы БЕЗ _ngcontent-атрибутов Angular — они меняются при каждой сборке SEW.
  // sew-bottom-bar-header .current-user .user — ФИО («Цыганков Роман»);
  // #logout_btn (title) — код подразделения («S187»), это НЕ табельный номер.
  function collect() {
    try {
      const userEl = document.querySelector('sew-bottom-bar-header .current-user .user')
      const fio = userEl ? (userEl.textContent || '').trim() : ''
      if (!fio) return false
      const logoutBtn = document.querySelector('sew-bottom-bar-header #logout_btn')
      const department = logoutBtn
        ? ((logoutBtn.getAttribute('title') || logoutBtn.textContent) || '').trim()
        : ''
      const prev = window.__sewIdentity
      // Обновляем только при смене пользователя (поздний логин/перелогин
      // без перезагрузки), иначе ts дергался бы каждые пару секунд.
      if (!prev || prev.fio !== fio || prev.department !== department) {
        window.__sewIdentity = { fio, department, source: 'dom', ts: new Date().toISOString() }
      }
      return true
    } catch {
      return false
    }
  }

  // Angular рендерит шапку асинхронно, а логин может случиться сильно позже
  // загрузки (SSO, перелогин без перезагрузки) — поэтому два механизма:
  // 1) MutationObserver: мгновенно подхватывает появление/смену шапки;
  // 2) редкий опрос как fallback (на случай немых перерендеров).
  // Жёсткого 60с-стопа больше нет (раньше поздний логин терялся навсегда).
  let debounce = null
  function scheduleCollect() {
    if (debounce) return
    debounce = setTimeout(() => {
      debounce = null
      try { collect() } catch {}
    }, 500)
  }

  try {
    if (typeof MutationObserver !== 'undefined' && document.documentElement) {
      const obs = new MutationObserver(scheduleCollect)
      obs.observe(document.documentElement, { childList: true, subtree: true, characterData: true })
      window.addEventListener('pagehide', () => { try { obs.disconnect() } catch {} }, { once: true })
    }
  } catch {}

  if (!collect()) scheduleCollect()
  const timer = setInterval(() => {
    try { collect() } catch {}
  }, 5000)
  window.addEventListener('pagehide', () => clearInterval(timer), { once: true })
})()
