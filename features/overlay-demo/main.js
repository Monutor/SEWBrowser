(() => {
  if (window.__sewOverlayDemo) return
  window.__sewOverlayDemo = true

  const host = document.createElement('div')
  host.style.cssText = 'position: fixed; right: 12px; bottom: 12px; z-index: 999999;'
  const shadow = host.attachShadow({ mode: 'open' })
  shadow.innerHTML = `
    <style>
      .badge {
        background: rgba(30, 31, 34, 0.92);
        color: #fff;
        font: 12px/1.4 system-ui, sans-serif;
        padding: 8px 12px;
        border-radius: 8px;
        box-shadow: 0 4px 16px rgba(0, 0, 0, 0.4);
      }
    </style>
    <div class="badge">SEWBrowser · overlay-demo</div>`

  const ensure = () => {
    if (!document.body.contains(host)) {
      (document.body || document.documentElement).appendChild(host)
    }
  }

  document.body.appendChild(host)
  new MutationObserver(ensure).observe(document.body, { childList: true, subtree: true })
  setInterval(ensure, 5000)
})()
