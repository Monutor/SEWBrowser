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
  var dragSent = null // что положено в dataTransfer в dragstart (имя/размер/сам File)
  var redispatching = false // guard от рекурсии при синтетическом redispatch drop

  // Кэш готовых File для drag-n-drop в форму SEW: id -> File.
  // Источник и цель лежат в одном документе гостевой страницы, поэтому
  // dataTransfer.items.add(file) в dragstart доставляет настоящий файл
  // в drop-обработчик SEW. Байты нужны СИНХРОННО в момент dragstart —
  // греем кэш фоном после render + по hover/mousedown на строке.
  var fileCache = {}
  var PRELOAD_MAX_BYTES = 30 * 1024 * 1024
  // MIME по расширению — страховка, если мост отдал пустой или generic тип
  // (иначе SEW не подбирает иконку превью и слот остаётся белым).
  function mimeFromExt(name) {
    var m = /\.([a-z0-9]+)$/i.exec(name || '')
    switch ((m && m[1] || '').toLowerCase()) {
      case 'pdf': return 'application/pdf'
      case 'png': return 'image/png'
      case 'jpg':
      case 'jpeg': return 'image/jpeg'
      case 'gif': return 'image/gif'
      case 'webp': return 'image/webp'
      case 'bmp': return 'image/bmp'
      case 'tif':
      case 'tiff': return 'image/tiff'
      default: return ''
    }
  }
  function storeFileInCache(id, name, mime, base64, modifiedAt) {
    if (!id || !base64 || fileCache[id]) return fileCache[id] || null
    if (!mime || mime === 'application/octet-stream') mime = mimeFromExt(name) || mime
    var blob = base64ToBlob(base64, mime)
    if (!blob) return null
    try {
      var opts = { type: mime || 'application/octet-stream' }
      var ts = Date.parse(modifiedAt || '')
      if (!isNaN(ts)) opts.lastModified = ts
      var f = new File([blob], name || 'файл', opts)
      fileCache[id] = f
      return f
    } catch (e) {
      return null
    }
  }
  function cachedFileFor(rec) {
    if (!rec || !rec.id) return null
    if (fileCache[rec.id]) return fileCache[rec.id]
    var pc = pickedCache[rec.id]
    if (pc && pc.base64) return storeFileInCache(rec.id, rec.name, pc.mime, pc.base64, rec.modifiedAt)
    return null
  }
  // Асинхронно подтягивает байты через мост и кладёт File в кэш.
  // Возвращает Promise<File|null>; вызывается фоном, не в dragstart.
  // Невидимый drag-образ: браузер по умолчанию таскает за курсором копию
  // строки, из-за чего кажется, что файл можно бросить куда угодно.
  var dragGhostEl = null
  function dragGhost () {
    if (!dragGhostEl) {
      dragGhostEl = document.createElement('div')
      dragGhostEl.style.cssText = 'position:fixed;left:-100px;top:-100px;width:1px;height:1px;opacity:0;pointer-events:none;'
      document.body.appendChild(dragGhostEl)
    }
    return dragGhostEl
  }
  function ensureFileCached(rec) {
    var hit = cachedFileFor(rec)
    if (hit) return Promise.resolve(hit)
    if (!rec || !rec.id || isPicked(rec)) return Promise.resolve(null)
    if (rec.bytes && rec.bytes > 100 * 1024 * 1024) return Promise.resolve(null)
    return bridgeSend('read', rec.id).then(function (content) {
      if (!content || !content.base64) return null
      return storeFileInCache(rec.id, content.name || rec.name, content.mime, content.base64, rec.modifiedAt)
    })
  }
  function preloadFiles(list) {
    if (!Array.isArray(list)) return
    list.forEach(function (rec) {
      if (!rec || !rec.id || fileCache[rec.id]) return
      if (rec.bytes && rec.bytes > PRELOAD_MAX_BYTES) return
      if (isPicked(rec)) { cachedFileFor(rec); return }
      ensureFileCached(rec)
    })
  }

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
    }

    row.appendChild(btns)

    // Drag-n-drop в форму SEW: кладём настоящий File (кэш прогрет фоном),
    // text/plain — только фолбэк. Байты в dragstart взять неоткуда
    // (мост асинхронный), поэтому без кэша просим потянуть ещё раз.
    row.addEventListener('mouseenter', function () { ensureFileCached(rec) })
    row.addEventListener('mousedown', function () { ensureFileCached(rec) })
    row.addEventListener('dragstart', function (e) {
      dragId = rec.id
      dragSent = null
      try {
        e.dataTransfer.effectAllowed = 'copy'
        try { e.dataTransfer.setDragImage(dragGhost(), 0, 0) } catch (ghostErr) {}
        var f = cachedFileFor(rec)
        if (f) {
          try { e.dataTransfer.items.add(f); dragSent = { name: f.name, size: f.size, file: f } } catch (addErr) {}
        } else {
          ensureFileCached(rec)
        }
        e.dataTransfer.setData('text/plain', rec.name)
      } catch (err) {}
      try { console.log('[scans-block] dragstart: ' + rec.name + ' — ' + (dragSent ? ('файл ' + dragSent.size + ' Б') : 'БЕЗ файла (кэш пуст)')) } catch (logErr) {}
      if (!cachedFileFor(rec)) {
        setStatus('файл готовится — потяните ещё раз через секунду')
      }
      addDropzoneHighlight()
    })
    row.addEventListener('dragend', function () {
      dragId = null
      dragSent = null
      removeDropzoneHighlight()
    })

    return row
  }

  var INDENT_PX = 16
  // Свёрнутость разделов папок (folderId -> true). В отличие от узлов дерева,
  // которые пересоздаются при каждом render, здесь состояние переживает
  // живые обновления списка от вотчера.
  var collapsedSections = {}
  // Собрать из плоского списка файлов дерева подпапок одной папки. Корневые
  // файлы (relPath '') — прямо в корне; подпапки — рекурсивно по '/'.
  function buildTree(files) {
    var root = { children: {}, files: [] }
    for (var i = 0; i < files.length; i++) {
      var rec = files[i]
      var rel = typeof rec.relPath === 'string' ? rec.relPath : ''
      if (!rel) { root.files.push(rec); continue }
      var parts = rel.split('/')
      var node = root
      for (var j = 0; j < parts.length - 1; j++) {
        var dn = parts[j]
        if (!node.children[dn]) node.children[dn] = { children: {}, files: [], name: dn }
        node = node.children[dn]
      }
      node.files.push(rec)
    }
    return root
  }
  function countFiles(node) {
    var n = node.files.length
    var keys = Object.keys(node.children)
    for (var k = 0; k < keys.length; k++) n += countFiles(node.children[keys[k]])
    return n
  }
  function countDirs(node) {
    var keys = Object.keys(node.children)
    var n = keys.length
    for (var m = 0; m < keys.length; m++) n += countDirs(node.children[keys[m]])
    return n
  }
  // Строка файла с отступом по глубине дерева. Переиспользует renderItem
  // (кнопки open/show/del/preview + drag-n-drop), только добавляем indent.
  function appendFileRow(rec, depth) {
    var row = renderItem(rec)
    if (depth > 0) row.style.paddingLeft = (depth * INDENT_PX) + 'px'
    return row
  }
  // Заголовок подпапки с раскрыванием + её содержимое (вложенные папки и файлы).
  function renderDir(node, depth) {
    var wrap = el('div', 'scans-block-dir')
    wrap.style.paddingLeft = ((depth + 1) * INDENT_PX) + 'px'
    node._expanded = node._expanded !== false
    var head = el('div', 'scans-block-dir-head')
    var toggle = el('span', 'scans-block-dir-toggle')
    head.appendChild(toggle)
    var label = el('span', 'scans-block-dir-name')
    label.textContent = node.name
    head.appendChild(label)
    var cnt = el('span', 'scans-block-dir-count')
    var body = el('div', 'scans-block-dir-body')
    wrap.appendChild(head)
    wrap.appendChild(body)
    function refresh() {
      toggle.textContent = node._expanded ? '▾' : '▸'
      cnt.textContent = countFiles(node) + ' · ' + countDirs(node) + ' подпапок'
      body.style.display = node._expanded ? '' : 'none'
      body.innerHTML = ''
      var dirNames = Object.keys(node.children).sort()
      for (var d = 0; d < dirNames.length; d++) {
        body.appendChild(renderDir(node.children[dirNames[d]], depth + 1))
      }
      for (var f = 0; f < node.files.length; f++) {
        body.appendChild(appendFileRow(node.files[f], depth + 1))
      }
    }
    refresh()
    head.addEventListener('click', function () {
      node._expanded = !node._expanded
      refresh()
    })
    return wrap
  }
  // Раздел одной папки: сворачиваемый заголовок (путь) + дерево по folderId/relPath.
  function renderFolderSection(container, folderId, files) {
    var section = el('div', 'scans-block-section')
    section.dataset.folderId = folderId
    var fp = (files[0] && files[0].folderPath) || folderId || ''
    var collapsed = collapsedSections[folderId] === true
    var title = el('div', 'scans-block-section-title scans-block-section-head')
    title.title = fp
    var toggle = el('span', 'scans-block-section-toggle')
    title.appendChild(toggle)
    var label = el('span', 'scans-block-section-label')
    label.textContent = fp
    title.appendChild(label)
    var cnt = el('span', 'scans-block-section-count')
    cnt.textContent = files.length + ' ' + plural(files.length, 'файл', 'файла', 'файлов')
    title.appendChild(cnt)
    section.appendChild(title)
    var body = el('div', 'scans-block-section-body')
    section.appendChild(body)
    var tree = buildTree(files)
    var names = Object.keys(tree.children).sort()
    for (var i = 0; i < names.length; i++) {
      body.appendChild(renderDir(tree.children[names[i]], 0))
    }
    for (var j = 0; j < tree.files.length; j++) {
      body.appendChild(appendFileRow(tree.files[j], 0))
    }
    function refresh() {
      toggle.textContent = collapsed ? '▸' : '▾'
      body.style.display = collapsed ? 'none' : ''
    }
    refresh()
    title.addEventListener('click', function () {
      collapsed = !collapsed
      collapsedSections[folderId] = collapsed
      refresh()
    })
    container.appendChild(section)
  }
  // Раздел выбранных файлов — плоско, отдельной секцией внизу (тоже сворачиваемый).
  function renderPickedSection(container, picked) {
    var section = el('div', 'scans-block-section')
    section.className = 'scans-block-section scans-block-picked-section'
    var key = '__picked__'
    var collapsed = collapsedSections[key] === true
    var title = el('div', 'scans-block-section-title scans-block-section-head')
    var toggle = el('span', 'scans-block-section-toggle')
    title.appendChild(toggle)
    var label = el('span', 'scans-block-section-label')
    label.textContent = '📎 Выбранные файлы'
    title.appendChild(label)
    var cnt = el('span', 'scans-block-section-count')
    cnt.textContent = picked.length + ' ' + plural(picked.length, 'файл', 'файла', 'файлов')
    title.appendChild(cnt)
    section.appendChild(title)
    var body = el('div', 'scans-block-section-body')
    section.appendChild(body)
    for (var i = 0; i < picked.length; i++) {
      body.appendChild(renderItem(picked[i]))
    }
    function refresh() {
      toggle.textContent = collapsed ? '▸' : '▾'
      body.style.display = collapsed ? 'none' : ''
    }
    refresh()
    title.addEventListener('click', function () {
      collapsed = !collapsed
      collapsedSections[key] = collapsed
      refresh()
    })
    container.appendChild(section)
  }
  function plural(n, one, few, many) {
    var m = Math.abs(n) % 100
    var d = m % 10
    if (m > 10 && m < 20) return many
    if (d > 1 && d < 5) return few
    if (d === 1) return one
    return many
  }
  function render(list) {
    if (!listEl) return
    // Список от вотчера/main содержит только файлы папки — picked-записи
    // (только в памяти) сохраняем, иначе живое обновление стирало выбранное.
    var incoming = Array.isArray(list) ? list : []
    var picked = files.filter(function (f) { return isPicked(f) })
    var seen = {}
    incoming.forEach(function (r) { if (r && r.id) seen[r.id] = true })
    // Группируем файлы по папкам — каждая папка свой раздел с деревом.
    var byFolder = {}
    var folderOrder = []
    incoming.forEach(function (r) {
      if (!r || !r.id) return
      var fid = typeof r.folderId === 'string' && r.folderId ? r.folderId : '__root__'
      if (!byFolder[fid]) { byFolder[fid] = []; folderOrder.push(fid) }
      byFolder[fid].push(r)
    })
    var flat = []
    folderOrder.forEach(function (fid) { byFolder[fid].forEach(function (r) { flat.push(r) }) })
    files = flat.concat(picked.filter(function (f) { return !seen[f.id] }))
    listEl.innerHTML = ''
    var hasMain = folderOrder.length > 0
    if (!hasMain && picked.length === 0) {
      var empty = el('div', 'scans-block-empty')
      empty.innerHTML =
        'Нет файлов.<br>' +
        '1. Запустите софт сканера (HP)<br>' +
        '2. Выберите файл с диска<br>' +
        '3. Перетащите документ в форму SEW'
      listEl.appendChild(empty)
      return
    }
    // Разделы по папкам — дерево по folderId/relPath.
    folderOrder.forEach(function (fid) {
      renderFolderSection(listEl, fid, byFolder[fid])
    })
    // Выбранные файлы — отдельный раздел внизу (плоско).
    if (picked.length > 0) {
      renderPickedSection(listEl, picked)
    }
    preloadFiles(flat.concat(picked))
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
  // Ищем input[type=file] рядом с точкой: сам элемент, label[for],
  // затем первый инпут внутри ближайших предков (слот «АКТ МХ-14» и т.п.).
  function findFileInputAtPoint(x, y) {
    var t = null
    try { t = document.elementFromPoint(x, y) } catch (err) { t = null }
    if (!t || t === document.documentElement) return null
    try {
      if (t.tagName === 'INPUT' && t.type === 'file') return t
      var node = t
      for (var depth = 0; depth < 6 && node && node !== document.body; depth++) {
        if (node.tagName === 'LABEL' && node.htmlFor) {
          var labelled = document.getElementById(node.htmlFor)
          if (labelled && labelled.tagName === 'INPUT' && labelled.type === 'file') return labelled
        }
        var q = null
        try { q = node.querySelector ? node.querySelector('input[type="file"]') : null } catch (qErr) { q = null }
        if (q) return q
        node = node.parentNode
      }
    } catch (err) {}
    return null
  }
  var zoneEl = null
  function addDropzoneHighlight() {
    if (zoneEl) return
    zoneEl = el('div', 'scans-block-dropzone')
    document.body.appendChild(zoneEl)
  }
  // Подсвечиваем ТОЛЬКО реальные слоты приёма файлов: если рядом с курсором
  // нет input[type=file] — подсветку прячем, чтобы не казалось, что бросить
  // можно куда угодно.
  function moveDropzoneHighlight(x, y) {
    if (!zoneEl) return
    var input = findFileInputAtPoint(x, y)
    if (!input) { removeDropzoneHighlight(); return }
    var r = null
    try { r = input.getBoundingClientRect() } catch (rectErr) { r = null }
    if (!r || (r.width < 4 && r.height < 4)) {
      // Инпут скрыт — обводим видимый слот под курсором.
      var target = null
      try { target = document.elementFromPoint(x, y) } catch (pointErr) { target = null }
      if (!target) { removeDropzoneHighlight(); return }
      try { r = target.getBoundingClientRect() } catch (rectErr2) { r = null }
    }
    if (!r || (r.width < 2 && r.height < 2)) { removeDropzoneHighlight(); return }
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

  // --- перемещение панели за шапку ------------------------------------------
  // Курсор move в CSS был, а логики не было. Таскаем за head (кроме кнопок),
  // позицию запоминаем в localStorage — переживает перезагрузку страницы.
  var panelPos = null
  try { panelPos = JSON.parse(localStorage.getItem('scans-block:pos') || 'null') } catch (posErr) { panelPos = null }
  function applyPanelPos() {
    if (!rootEl || !panelPos) return
    var left = parseInt(panelPos.left, 10), top = parseInt(panelPos.top, 10)
    if (isNaN(left) || isNaN(top)) return
    left = Math.min(Math.max(left, -300), Math.max(window.innerWidth - 60, 0))
    top = Math.min(Math.max(top, 0), Math.max(window.innerHeight - 40, 0))
    rootEl.style.left = left + 'px'
    rootEl.style.top = top + 'px'
    rootEl.style.right = 'auto'
    rootEl.style.bottom = 'auto'
  }
  function enablePanelDrag(head) {
    head.addEventListener('mousedown', function (e) {
      if (e.button !== 0) return
      try { if (e.target && e.target.closest && e.target.closest('button')) return } catch (closestErr) {}
      e.preventDefault()
      var r = rootEl.getBoundingClientRect()
      // Уходим с якоря right/bottom на явные left/top.
      rootEl.style.left = r.left + 'px'
      rootEl.style.top = r.top + 'px'
      rootEl.style.right = 'auto'
      rootEl.style.bottom = 'auto'
      var dx = e.clientX - r.left, dy = e.clientY - r.top
      var w = r.width
      function onMove(me) {
        var nx = Math.min(Math.max(me.clientX - dx, -w + 60), window.innerWidth - 60)
        var ny = Math.min(Math.max(me.clientY - dy, 0), window.innerHeight - 40)
        rootEl.style.left = nx + 'px'
        rootEl.style.top = ny + 'px'
      }
      function onUp() {
        document.removeEventListener('mousemove', onMove)
        document.removeEventListener('mouseup', onUp)
        try {
          localStorage.setItem('scans-block:pos', JSON.stringify({
            left: parseInt(rootEl.style.left, 10) || 0,
            top: parseInt(rootEl.style.top, 10) || 0,
          }))
        } catch (saveErr) {}
      }
      document.addEventListener('mousemove', onMove)
      document.addEventListener('mouseup', onUp)
    })
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
    enablePanelDrag(head)
    applyPanelPos()

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

    // Глобальные обработчики drag: подсветка зоны + прикрепление файла.
    // ВАЖНО: Chromium выкидывает File из dataTransfer при нативном drag
    // (проверено: dragstart items=1 types=[Files] -> drop types=[text/plain],
    // files=0) — долететь файл перетаскиванием НЕ может физически, даже в
    // пределах одного документа. Поэтому жест «отпустить над формой» ловим
    // здесь (capture drop) и прикрепляем файл программно: ищем input[type=file]
    // рядом с точкой дропа и кладём файл туда + dispatch change; если инпута
    // нет — шлём элементу под курсором синтетический drop уже С файлами
    // (синтетике файлы видны — нет нативного round-trip, который их режет).
    // Отдельно в наш блок можно дропнуть файл из проводника (см. ниже).
    // Поиск input[type=file] рядом с точкой дропа — см. findFileInputAtPoint выше.
    function fireChange(input) {
      try {
        var ev = null
        try { ev = new Event('change', { bubbles: true }) } catch (ctorErr) {
          ev = document.createEvent('Event'); ev.initEvent('change', true, true)
        }
        input.dispatchEvent(ev)
      } catch (err) {}
      try {
        var ev2 = null
        try { ev2 = new Event('input', { bubbles: true }) } catch (ctorErr2) {
          ev2 = document.createEvent('Event'); ev2.initEvent('input', true, true)
        }
        input.dispatchEvent(ev2)
      } catch (err2) {}
    }
    function attachFileToInputAtPoint(file, x, y) {
      var input = findFileInputAtPoint(x, y)
      if (!input) return false
      try {
        var dt = new DataTransfer()
        dt.items.add(file)
        input.files = dt.files
        fireChange(input)
        return true
      } catch (err) {
        return false
      }
    }
    function redispatchDropWithFiles(file, x, y) {
      var t = null
      try { t = document.elementFromPoint(x, y) } catch (err) { t = null }
      if (!t) return false
      try {
        var dt = new DataTransfer()
        dt.items.add(file)
        var ev = new DragEvent('drop', { bubbles: true, cancelable: true, clientX: x, clientY: y, dataTransfer: dt })
        redispatching = true
        t.dispatchEvent(ev)
        redispatching = false
        return true
      } catch (err) {
        redispatching = false
        return false
      }
    }
    document.addEventListener('dragover', function (e) {
      if (dragId === null) return
      e.preventDefault()
      try { e.dataTransfer.dropEffect = 'copy' } catch (err) {}
      moveDropzoneHighlight(e.clientX, e.clientY)
    })
    document.addEventListener('drop', function (e) {
      if (redispatching) return
      if (dragId === null) return
      var file = dragSent && dragSent.file ? dragSent.file : null
      var fileName = dragSent && dragSent.name ? dragSent.name : ''
      dragId = null
      dragSent = null
      removeDropzoneHighlight()
      if (!file) {
        setStatus('файл готовится — потяните ещё раз через секунду')
        return
      }
      // Нативный пакет всегда пуст (см. комментарий выше) — прикрепляем сами.
      var x = e.clientX, y = e.clientY
      if (attachFileToInputAtPoint(file, x, y)) {
        // preventDefault — чтобы браузер не навигировал на подсунутый
        // text/plain; stopPropagation НЕ зовём специально: собственный
        // drop-хендлер SEW должен тоже отработать (пустой пакет проигнорирует)
        // и спрятать свою синюю зону дропа, иначе она остаётся висеть.
        try { e.preventDefault() } catch (stopErr) {}
        try { console.log('[scans-block] прикреплено в SEW через input: ' + fileName) } catch (logErr) {}
        setStatus('прикреплено в SEW: ' + fileName)
        return
      }
      if (redispatchDropWithFiles(file, x, y)) {
        try { e.preventDefault() } catch (stopErr2) {}
        try { console.log('[scans-block] передан синтетический drop с файлом: ' + fileName) } catch (logErr2) {}
        setStatus('передано в зону SEW: ' + fileName)
        return
      }
      setStatus('не нашли зону SEW под курсором — отпустите файл точнее над слотом')
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
