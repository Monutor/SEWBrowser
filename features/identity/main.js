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
      window.__sewIdentity = { fio, department, source: 'dom', ts: new Date().toISOString() }
      return true
    } catch {
      return false
    }
  }

  // Angular рендерит шапку асинхронно — опрашиваем до первого успеха.
  // Скрипт инжектится заново при каждой загрузке страницы.
  if (!collect()) {
    const timer = setInterval(() => {
      if (collect()) clearInterval(timer)
    }, 2000)
    // Страховка от вечного таймера на чужой странице
    setTimeout(() => clearInterval(timer), 60000)
  }
})()
