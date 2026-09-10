(() => {
  if (window.__sewDataDemo) return
  window.__sewDataDemo = true

  const log = []
  window.__sewDataLog = log

  const originalFetch = window.fetch.bind(window)
  window.fetch = async function fetchPatched(resource, options) {
    try {
      const url = typeof resource === 'string' ? resource : resource?.url ?? String(resource)
      log.push({ url, ts: new Date().toISOString() })
    } catch {
      // не критично — продолжаем оригинальный запрос
    }
    return originalFetch(resource, options)
  }
})()
