// block.js — в-page блок «Сканы». Выполняется в контексте ГОСТЕВОЙ страницы SEW
// (склеенный код плагина из loader.ts обёрнут в IIFE с `chrome`). У <webview> нет
// preload, поэтому window.shell недоступен — обмен с main через host-мост:
//   гость кладёт запросы в window.__sewScansReq[], оболочка (renderer) опросом
//   забирает их и отвечает в window.__sewScansRes[id]. Это тот же паттерн, что
//   sew-helper (__sewHelperBffReq/Res), но свой канал.
//
// Что умеет блок:
//   - список файлов из папки HP-софта (запуск софта, обновление);
//   - перенос документов в SEW drag-n-dropом;
//   - открыть файл / показать в проводнике / удалить (для файлов из папки);
//   - выбор файла с диска (нативный диалог main) как альтернатива сканеру.

(function () {
  'use strict'

  // --- host-мост: запрос -> ответ (как sew-helper, свой канал) ---------------
  var reqSeq = 0
  function bridgeSend(type, payload) {
    return new Promise(function (resolve) {
      var id = 's' + (++reqSeq) + '_' + Date.now()
      try {
        window.__sewScansReq = window.__sewScansReq || []
        window.__sewScansReq.push({ id: id, type: type, payload: payload || null })
      } catch (e) {
        resolve(null)
        return
      }
      var waited = 0
      var timer = setInterval(function () {
        var box = null
        try { box = window.__sewScansRes || null } catch (e) { box = null }
        if (box && Object.prototype.hasOwnProperty.call(box, id)) {
          var res = box[id]
          try { delete box[id] } catch (e) {}
          clearInterval(timer)
          resolve(res)
          return
        }
        if (waited >= 30000) {
          clearInterval(timer)
          resolve(null)
        }
        waited += 200
      }, 200)
    })
  }

  // --- состояние ------------------------------------------------------------
  var files = [] // ScanFile-записи (из папки) + «picked» (с диска)
  // Байты picked-файлов (с диска / из нативного дропа): id -> {base64, mime, name}.
  // Раньше base64 выбрасывался и picked-запись хранила только мету — файл терялся.
  var pickedCache = {}

  // --- утилиты --------------------------------------------------------------
  function fmtSize(b) {
    if (!b || b <= 0) return '0 Б'
    var u = ['Б', 'КБ', 'МБ', 'ГБ']
    var i = 0
    var v = b
    while (v >= 1024 && i < u.length - 1) { v /= 1024; i++ }
    return (i === 0 ? v : (v.toFixed(1).replace(/\.0$/, ''))) + ' ' + u[i]
  }

  function fmtDate(iso) {
    try {
      var d = new Date(iso)
      if (isNaN(d.getTime())) return ''
      var p = function (n) { return (n < 10 ? '0' + n : '' + n) }
      return d.getFullYear() + '-' + p(d.getMonth() + 1) + '-' + p(d.getDate()) + ' ' + p(d.getHours()) + ':' + p(d.getMinutes())
    } catch (e) {
      return ''
    }
  }

  function extOf(rec) {
    return (rec.ext || '').toLowerCase()
  }

  function isPicked(rec) {
    return !!rec && (rec._picked === true || (typeof rec.id === 'string' && rec.id.indexOf('picked::') === 0))
  }

  function base64ToBlob(base64, mime) {
    try {
      var bin = atob(base64 || '')
      var len = bin.length
      var arr = new Uint8Array(len)
      for (var i = 0; i < len; i++) arr[i] = bin.charCodeAt(i)
      return new Blob([arr], { type: mime || 'application/octet-stream' })
    } catch (e) {
      return null
    }
  }

  // Предпросмотр picked-файла в новой вкладке (байты из pickedCache, не с диска).
  function previewPicked(rec) {
    var cached = pickedCache[rec.id]
    if (!cached || !cached.base64) {
      setStatus('нет данных файла — выберите его заново')
      return
    }
    var blob = base64ToBlob(cached.base64, cached.mime)
    if (!blob) {
      setStatus('не удалось открыть файл')
      return
    }
    try {
      var url = URL.createObjectURL(blob)
      window.open(url, '_blank')
      setTimeout(function () { try { URL.revokeObjectURL(url) } catch (e) {} }, 60000)
    } catch (e) {
      setStatus('не удалось открыть файл')
    }
  }

  // Безопасное создание DOM-узла без innerHTML (имена файлов могут содержать <script>)
  function el(tag, cls) {
    var node = document.createElement(tag)
    if (cls) node.className = cls
    return node
  }

  var dragId = null // id перетаскиваемого файла ( для подсветки зоны)

  // --- отрисовка ------------------------------------------------------------
  var rootEl = null
  var panelEl = null
  var listEl = null
  var statusEl = null
  var toggleEl = null
  var collapsed = true

  function iconFor(rec) {
    var e = extOf(rec)
    if (e === 'pdf') return '📄'
    if (e === 'png' || e === 'jpg' || e === 'jpeg' || e === 'bmp' || e === 'tif' || e === 'tiff') return '🖼️'
    return '📎'
  }

  function renderItem(rec) {
    var row = el('div', 'scans-block-item')
    row.draggable = true
    row.title = rec.path || rec.name

    var icon = el('div', 'scans-block-icon')
    icon.textContent = iconFor(rec)
    row.appendChild(icon)

    var meta = el('div', 'scans-block-meta')
    var nameLine = el('div', 'scans-block-name')
    nameLine.textContent = rec.name
    meta.appendChild(nameLine)
    var sizeLine = el('div', 'scans-block-size')
    sizeLine.textContent = fmtSize(rec.bytes) + (rec.modifiedAt ? ' · ' + fmtDate(rec.modifiedAt) : '')
    meta.appendChild(sizeLine)
    row.appendChild(meta)

    var btns = el('div', 'scans-block-item-btns')

    // Перенос в SEW — для всех типов файлов
    var dragHint = el('button')
    dragHint.className = 'scans-block-item-btn'
    dragHint.title = 'Перенести в SEW (перетащите)'
    dragHint.textContent = '⇢'
    btns.appendChild(dragHint)

    // Открыть / Показать в папке — только у файлов с реальным путём на диске
    // ВАЖНО: в гостевой странице <webview> нет window.shell (нет preload),
    // поэтому все операции идут через host-мост bridgeSend (см. pumpScansBridge
    // в renderer). Прямые вызовы window.shell здесь — undefined и молча падают.
    if (isPicked(rec)) {
      // Picked-файл живёт только в pickedCache (байты уже есть) — даём
      // предпросмотр и удаление из списка (раньше кнопок не было вообще
      // и запись нельзя было убрать без перезагрузки страницы).
      var viewBtn = el('button')
      viewBtn.className = 'scans-block-item-btn'
      viewBtn.title = 'Предпросмотр'
      viewBtn.textContent = '👁'
      viewBtn.addEventListener('click', function (e) {
        e.stopPropagation()
        previewPicked(rec)
      })
      btns.appendChild(viewBtn)

      var rmBtn = el('button')
      rmBtn.className = 'scans-block-item-btn scans-block-del'
      rmBtn.title = 'Убрать из списка'
      rmBtn.textContent = '🗑'
      rmBtn.addEventListener('click', function (e) {
        e.stopPropagation()
        try { delete pickedCache[rec.id] } catch (err) {}
        render(files.filter(function (f) { return f.id !== rec.id }))
      })
      btns.appendChild(rmBtn)
    } else if (rec.path) {
      var openBtn = el('button')
      openBtn.className = 'scans-block-item-btn'
      openBtn.title = 'Открыть файл'
      openBtn.textContent = '↗'
      openBtn.addEventListener('click', function (e) {
        e.stopPropagation()
        bridgeSend('open', rec.path).then(function (ok) {
          if (ok !== true) setStatus('не удалось открыть файл')
        })
      })
      btns.appendChild(openBtn)

      var inFolderBtn = el('button')
      inFolderBtn.className = 'scans-block-item-btn'
      inFolderBtn.title = 'Показать в папике'
      inFolderBtn.textContent = '📁'
      inFolderBtn.addEventListener('click', function (e) {
        e.stopPropagation()
        bridgeSend('show', rec.path).then(function (ok) {
          if (ok !== true) setStatus('не удалось показать файл в папке')
        })
      })
      btns.appendChild(inFolderBtn)

      var delBtn = el('button')
      delBtn.className = 'scans-block-item-btn scans-block-del'
      delBtn.title = 'Удалить файл'
      delBtn.textContent = '🗑'
      delBtn.addEventListener('click', function (e) {
        e.stopPropagation()
        bridgeSend('delete', rec.id).then(function (list) {
          if (Array.isArray(list)) render(list)
          else doList()
        })
      })
      btns.appendChild(delBtn)
    }

    row.appendChild(btns)

    // Drag-n-drop: помечаем перетаскиваемый файл и подсвечиваем зону.
    row.addEventListener('dragstart', function (e) {
      dragId = rec.id
      try {
        e.dataTransfer.effectAllowed = 'copy'
        e.dataTransfer.setData('text/plain', rec.name)
      } catch (err) {}
      addDropzoneHighlight()
    })
    row.addEventListener('dragend', function () {
      dragId = null
      removeDropzoneHighlight()
    })

    return row
  }

  function render(list) {
    if (!listEl) return
    // Список от вотчера/main содержит только файлы папки — picked-записи
    // (только в памяти) сохраняем, иначе живое обновление стирало выбранное.
    var incoming = Array.isArray(list) ? list : []
    var picked = files.filter(function (f) { return isPicked(f) })
    var seen = {}
    incoming.forEach(function (r) { if (r && r.id) seen[r.id] = true })
    files = incoming.concat(picked.filter(function (f) { return !seen[f.id] }))
    listEl.innerHTML = ''
    if (files.length === 0) {
      var empty = el('div', 'scans-block-empty')
      empty.innerHTML =
        'Нет файлов.<br>' +
        '1. Запустите софт сканера (HP)<br>' +
        '2. Выберите файл с диска<br>' +
        '3. Перетащите документ в форму SEW'
      listEl.appendChild(empty)
      return
    }
    files.forEach(function (rec) {
      listEl.appendChild(renderItem(rec))
    })
  }

  function setStatus(text) {
    if (statusEl) statusEl.textContent = text || ''
  }

  // --- действия ------------------------------------------------------------
  function doList() {
    bridgeSend('list', null).then(function (res) {
      if (Array.isArray(res)) render(res)
    })
  }

  function doLaunch() {
    setStatus('запуск софта сканера…')
    bridgeSend('launch', null).then(function (ok) {
      if (ok === true) {
        setStatus('софт запущен; положите PDF в папку')
        setTimeout(doList, 1500)
      } else {
        setStatus('не удалось запустить софт (проверьте путь в настройках)')
      }
    })
  }

  function doPick() {
    // Выбор файла — тоже через мост (window.shell в госте нет).
    bridgeSend('pick', null).then(function (content) {
      if (!content) return
      // main возвращает id 'picked::<path>' — используем его как есть
      // (раньше лепили свой 'picked::<name>' и ломали связку с кэшем).
      var id = typeof content.id === 'string' && content.id ? content.id : ('picked::' + (content.name || 'файл'))
      if (content.base64) {
        pickedCache[id] = { base64: content.base64, mime: content.mime || 'application/octet-stream', name: content.name }
      }
      var rec = {
        id: id,
        name: content.name,
        path: null,
        bytes: content.bytes || 0,
        ext: content.ext,
        modifiedAt: new Date().toISOString(),
        _picked: true,
      }
      render(files.concat([rec]))
    })
  }

  // --- подсветка зоны дропа на странице SEW --------------------------------
  var zoneEl = null
  function addDropzoneHighlight() {
    if (zoneEl) return
    zoneEl = el('div', 'scans-block-dropzone')
    document.body.appendChild(zoneEl)
  }
  function moveDropzoneHighlight(x, y) {
    if (!zoneEl) return
    var target = document.elementFromPoint(x, y)
    if (!target) { removeDropzoneHighlight(); return }
    var r = target.getBoundingClientRect()
    zoneEl.style.left = r.left + 'px'
    zoneEl.style.top = r.top + 'px'
    zoneEl.style.width = r.width + 'px'
    zoneEl.style.height = r.height + 'px'
  }
  function removeDropzoneHighlight() {
    if (zoneEl && zoneEl.parentNode) zoneEl.parentNode.removeChild(zoneEl)
    zoneEl = null
  }

  // --- навигация «свернуть/развернуть» -------------------------------------
  // ВАЖНО: toggleEl — отдельный элемент (sibling rootEl в body), а не ребёнок
  // rootEl, поэтому его видимостью управляем явно через JS. Сам rootEl в
  // collapsed-состоянии полностью скрыт CSS (display:none), чтобы не оставалась
  // «линия» от пустого контейнера с border/background.
  function toggleCollapsed() {
    collapsed = !collapsed
    if (collapsed) {
      rootEl.classList.add('scans-block-collapsed')
      if (toggleEl) toggleEl.style.display = 'flex'
    } else {
      rootEl.classList.remove('scans-block-collapsed')
      if (toggleEl) toggleEl.style.display = 'none'
      doList()
    }
  }

  function buildUi() {
    if (rootEl) return
    rootEl = el('div', 'scans-block-root')
    if (collapsed) rootEl.classList.add('scans-block-collapsed')

    var panel = el('div', 'scans-block-panel')
    panelEl = panel

    var head = el('div', 'scans-block-head')
    var title = el('span', 'scans-block-title')
    title.textContent = 'Сканы'
    head.appendChild(title)

    var closeBtn = el('button', 'scans-block-head-btn')
    closeBtn.textContent = '✕'
    closeBtn.title = 'Свернуть'
    closeBtn.addEventListener('click', toggleCollapsed)
    head.appendChild(closeBtn)

    panel.appendChild(head)

    var actions = el('div', 'scans-block-actions')
    var launchBtn = el('button', 'scans-block-btn')
    launchBtn.textContent = 'Сканировать (HP)'
    launchBtn.addEventListener('click', doLaunch)
    actions.appendChild(launchBtn)

    var pickBtn = el('button', 'scans-block-btn')
    pickBtn.textContent = 'Выбрать файл'
    pickBtn.addEventListener('click', doPick)
    actions.appendChild(pickBtn)

    var refreshBtn = el('button', 'scans-block-btn scans-block-btn-ghost')
    refreshBtn.textContent = '↻'
    refreshBtn.title = 'Обновить список'
    refreshBtn.addEventListener('click', doList)
    actions.appendChild(refreshBtn)

    panel.appendChild(actions)

    statusEl = el('div', 'scans-block-status')
    panel.appendChild(statusEl)

    listEl = el('div', 'scans-block-list')
    panel.appendChild(listEl)

    rootEl.appendChild(panel)

    toggleEl = el('button', 'scans-block-toggle')
    toggleEl.textContent = '📚'
    toggleEl.title = 'Сканы'
    toggleEl.addEventListener('click', function () {
      if (collapsed) toggleCollapsed()
    })
    // Начальное состояние: блок свёрнут -> показываем только кнопку,
    // сам rootEl скрыт CSS-классом scans-block-collapsed (без «линии»).
    toggleEl.style.display = collapsed ? 'flex' : 'none'

    document.body.appendChild(rootEl)
    document.body.appendChild(toggleEl)

    // Нативный дроп из ОС в наш блок: перетаскиваемый файл с рабочего стола/
    // проводника — читаем через FileReader и добавляем как «picked».
    ;[panel, toggleEl].forEach(function (node) {
      if (!node) return
      node.addEventListener('dragover', function (e) {
        try { e.preventDefault(); e.dataTransfer.dropEffect = 'copy' } catch (err) {}
      })
      node.addEventListener('drop', function (e) {
        try { e.preventDefault() } catch (err) {}
        var fs = e.dataTransfer && e.dataTransfer.files ? e.dataTransfer.files : []
        for (var i = 0; i < fs.length; i++) {
          handleNativeDropFile(fs[i])
        }
      })
    })

    // Глобальные обработчики drag: подсветка зоны на странице и подсказка.
    // ВАЖНО: в Chromium/Electron нельзя программно положить synthetic File в
    // dataTransfer.files третьего drop-обработчика (ограничение безопасности —
    // защита от кражи локальных файлов). Поэтому «перенос в SEW» перетаскиванием
    // из нашего блока технически не доставляет файл в форму SEW. Реальные пути:
    //   - перетащить файл из проводника/рабочего стола ПРЯМО НАШ БЛОК (см. ниже)
    //     или нажать «Выбрать файл» (нативный диалog main);
    //   - форма SEW принимает файлы только через свой нативный дроп/диалог.
    document.addEventListener('dragover', function (e) {
      if (dragId === null) return
      e.preventDefault()
      try { e.dataTransfer.dropEffect = 'copy' } catch (err) {}
      moveDropzoneHighlight(e.clientX, e.clientY)
    })
    document.addEventListener('drop', function (e) {
      if (dragId === null) return
      dragId = null
      removeDropzoneHighlight()
      setStatus('перетащите файл из проводника в наш блок или «Выбрать файл»')
    }, true)
  }

  function handleNativeDropFile(file) {
    if (!file) return
    var reader = new FileReader()
    reader.onload = function () {
      var result = typeof reader.result === 'string' ? reader.result : ''
      var m = /^data:([^;,]*)?(;base64)?,([\s\S]*)$/.exec(result)
      if (!m) return
      var mime = (m[1] || file.type || '').toLowerCase()
      // readAsDataURL всегда отдаёт base64 — сохраняем байты в кэш,
      // раньше они выбрасывались и запись была пустой.
      var base64 = m[2] ? m[3].replace(/\s+/g, '') : ''
      if (!base64) return
      var id = 'picked::' + file.name + '::' + Date.now()
      pickedCache[id] = { base64: base64, mime: mime || 'application/octet-stream', name: file.name }
      var rec = {
        id: id,
        name: file.name,
        path: null,
        bytes: file.size || 0,
        ext: (file.type ? file.type.split('/')[1] : '') || extFromName(file.name),
        modifiedAt: new Date().toISOString(),
        _picked: true,
      }
      render(files.concat([rec]))
      setStatus('файл добавлен — откройте предпросмотр (👁)')
    }
    reader.onerror = function () {}
    reader.readAsDataURL(file)
  }

  function extFromName(name) {
    var i = name.lastIndexOf('.')
    return i >= 0 ? name.slice(i + 1).toLowerCase() : ''
  }

  // Открытие блока извне — кнопка «Сканы» в тулбаре оболочки шлёт это событие
  // через webview.executeJavaScript в гостевую страницу.
  window.addEventListener('scans-block:open', function () {
    if (collapsed) toggleCollapsed()
    else doList()
  })

  // Живые обновления от вотчера main (через renderer-форвард 'scans-push'):
  // свежий список файлов — перерисовываем без лишнего bridgeSend('list').
  window.addEventListener('scans-block:update', function (e) {
    try {
      var list = e && e.detail
      if (Array.isArray(list)) render(list)
    } catch (err) {}
  })

  // --- старт ---------------------------------------------------------------
  try {
    buildUi()
    doList()
  } catch (e) {
    // гость не готов — повторит следующий pump/перезагрузка страницы
  }
})()
