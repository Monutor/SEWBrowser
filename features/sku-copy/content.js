// content.js — плагин «Копировать артикул» (sku-copy).
// Выполняется в контексте ГОСТЕВОЙ страницы SEW: код оборачивается оболочкой
// в IIFE, где объявлен `chrome`. Свой API SEWBrowser здесь не нужен — копируем
// через буфер обмена самой страницы.
//
// Почему ищем по тексту, а не по CSS-классу: разметка SEW отличается от
// страницы к странице (у подтверждённого образца class="material-code", но это
// не гарантия — завтра будет material-code-v2), а вот подпись «SKU» есть везде.
// Якоримся на текстовый узел со словом «SKU» и берём его родителя.
//
// Значение артикула ищем в три приёма, потому что разметка тоже разная:
//   1. Собственный текст родителя:  <div>SKU: 4258850</div>
//   2. Следующий сосед:            <div>SKU:</div><div>4258850</div>
//   3. Первый элемент-ребёнок:     <div>SKU:<span>4258850</span></div>

(function () {
  'use strict'

  var BTN_CLASS = 'sew-sku-copy'
  // Подписи, по которым опознаём блок с артикулом. Список, а не одна строка:
  // если в SEW где-то подпишут «Артикул», достаточно дописать его сюда.
  var LABELS = ['SKU']
  // Ведущая подпись с разделителем: «SKU», «SKU:», «SKU -», «SKU –»
  var LABEL_RE = new RegExp('^\\s*(?:' + LABELS.join('|') + ')\\b[\\s:\\-\\u2013\\u2014]*', 'i')
  // Слово-подсказка в текстовом узле: по нему решаем, что узел нам интересен
  var HINT_RE = new RegExp('\\b(?:' + LABELS.join('|') + ')\\b', 'i')
  // Сколько живёт галочка/крестик после клика
  var FLASH_MS = 1400
  // Перерисовка не чаще: Angular мутирует DOM постоянно, а обход текстовых
  // узлов страницы на каждый чих — лишняя работа
  var RESCAN_MS = 250

  // Текст самого элемента без текста его потомков. Именно он различает
  // «SKU: 4258850» (значение тут же) от «SKU:» + отдельный узел с числом.
  function ownText(el) {
    var out = ''
    for (var i = 0; i < el.childNodes.length; i++) {
      var node = el.childNodes[i]
      if (node.nodeType === 3) out += node.nodeValue
    }
    return out.replace(/\s+/g, ' ').trim()
  }

  // Обрезаем мусор разметки по краям и отсекаем слишком длинное — это уже не
  // артикул, а кусок соседнего текста.
  function cleanValue(raw) {
    var v = String(raw || '').replace(/\s+/g, ' ').trim()
    v = v.replace(/[\s,;:.\u2013\u2014-]+$/, '')
    if (!v || v.length > 64) return ''
    return v
  }

  // Для значения, взятого из соседа/ребёнка, требуем цифру. Без этого подпись
  // «SKU» в шапке таблицы подхватила бы заголовок соседней колонки
  // («Наименование») и нарисовала кнопку копирования заголовка.
  function looksLikeSku(v) {
    return /\d/.test(v)
  }

  // Элемент-потомки без нашей кнопки. Сама кнопка — элемент тоже, и после
  // инъекции она ломала бы проверку «есть ли тут значение» (см. pickValue).
  function realChildren(host) {
    var out = []
    var kids = host.children || []
    for (var i = 0; i < kids.length; i++) {
      if (kids[i].classList && kids[i].classList.contains(BTN_CLASS)) continue
      out.push(kids[i])
    }
    return out
  }

  function pickValue(host) {
    var kids = realChildren(host)
    // Собственный текст берём только когда нет чужих элементов-потомков: иначе
    // в «SKU: <b>4258850</b> ед.» значением ошибочно стало бы «ед.».
    if (!kids.length) {
      var direct = cleanValue(ownText(host).replace(LABEL_RE, ''))
      if (direct) return direct
    }
    var sib = host.nextElementSibling
    if (sib) {
      var sv = cleanValue(ownText(sib))
      if (sv && looksLikeSku(sv)) return sv
    }
    if (kids.length) {
      var kv = cleanValue(ownText(kids[0]))
      if (kv && looksLikeSku(kv)) return kv
    }
    return ''
  }

  // --- буфер обмена ---------------------------------------------------------
  // Страница https, поэтому сначала современный API. Он требует фокуса
  // документа — клик по кнопке его даёт, но на всякий случай есть запасной
  // путь через execCommand, которому фокус не нужен.
  function copyText(text) {
    try {
      if (navigator.clipboard && typeof navigator.clipboard.writeText === 'function') {
        return navigator.clipboard
          .writeText(text)
          .then(function () { return true })
          .catch(function () { return legacyCopy(text) })
      }
    } catch (e) {
      /* ниже — запасной путь */
    }
    return Promise.resolve(legacyCopy(text))
  }

  function legacyCopy(text) {
    var ta = document.createElement('textarea')
    ta.value = text
    ta.setAttribute('readonly', '')
    ta.style.cssText = 'position:fixed;top:0;left:-9999px;opacity:0'
    document.body.appendChild(ta)
    var ok = false
    try {
      ta.select()
      ta.setSelectionRange(0, text.length)
      ok = document.execCommand('copy')
    } catch (e) {
      ok = false
    }
    if (ta.parentNode) ta.parentNode.removeChild(ta)
    return ok
  }

  // --- кнопка ---------------------------------------------------------------
  function stopEvent(e) {
    e.preventDefault()
    e.stopPropagation()
  }

  // Своих текстовых узлов у кнопки нет (значок рисует CSS): иначе собственный
  // текст host'а «SKU: 4258850» испортился бы, а на него могут смотреть другие
  // скрипты страницы.
  function makeButton(value) {
    var btn = document.createElement('button')
    btn.type = 'button'
    btn.className = BTN_CLASS
    btn.title = 'Скопировать артикул'
    btn.setAttribute('aria-label', 'Скопировать артикул ' + value)
    btn.setAttribute('data-sku', value)
    btn.addEventListener('click', function (e) {
      e.preventDefault()
      e.stopPropagation()
      copyValue(btn)
    })
    // Строка списка может начинать перетаскивание или выделение — гасим это,
    // иначе клик по кнопке таскает карточку товара.
    btn.addEventListener('mousedown', stopEvent)
    btn.addEventListener('pointerdown', stopEvent)
    return btn
  }

  function copyValue(btn) {
    var value = btn.getAttribute('data-sku') || ''
    if (!value) return
    copyText(value).then(function (ok) {
      flash(btn, ok ? 'is-done' : 'is-fail')
    })
  }

  function flash(btn, cls) {
    if (btn._skuTimer) clearTimeout(btn._skuTimer)
    btn.classList.remove('is-done')
    btn.classList.remove('is-fail')
    btn.classList.add(cls)
    btn._skuTimer = setTimeout(function () {
      btn.classList.remove(cls)
      btn._skuTimer = 0
    }, FLASH_MS)
  }

  // --- обход страницы -------------------------------------------------------
  function inject(host) {
    var value = pickValue(host)
    if (!value) return
    var existing = host.querySelector('.' + BTN_CLASS)
    if (existing) {
      // Наш узел пережил перерисовку Angular — просто освежаем значение
      existing.setAttribute('data-sku', value)
      return
    }
    host.appendChild(makeButton(value))
  }

  function scan() {
    var body = document.body
    if (!body || !body.isConnected) return
    // Идём по текстовым узлам, а не по querySelectorAll('*'): на странице с
    // таблицей это на порядки дешевле, и нужны нам именно текстовые узлы.
    var walker = document.createTreeWalker(body, NodeFilter.SHOW_TEXT, null)
    var hosts = []
    var node
    while ((node = walker.nextNode())) {
      var value = node.nodeValue
      if (!value || !HINT_RE.test(value)) continue
      var host = node.parentElement
      if (!host || host.classList.contains(BTN_CLASS)) continue
      if (hosts.indexOf(host) === -1) hosts.push(host)
    }
    for (var i = 0; i < hosts.length; i++) inject(hosts[i])
  }

  var rescanTimer = 0
  function scheduleScan() {
    if (rescanTimer) return
    rescanTimer = setTimeout(function () {
      rescanTimer = 0
      scan()
    }, RESCAN_MS)
  }

  // Наши собственные вставки — не повод перерисовывать страницу заново,
  // иначе observer будет будить сам себя.
  function hasForeignNodes(nodes) {
    for (var i = 0; i < nodes.length; i++) {
      var n = nodes[i]
      if (n.nodeType !== 1) continue
      if (n.classList && n.classList.contains(BTN_CLASS)) continue
      if (typeof n.querySelector === 'function' && n.querySelector('.' + BTN_CLASS)) continue
      return true
    }
    return false
  }

  function start() {
    if (!document.body) {
      // Страница ещё не разобрана — попробуем чуть позже
      setTimeout(start, 100)
      return
    }
    scan()
    var mo = new MutationObserver(function (mutations) {
      for (var i = 0; i < mutations.length; i++) {
        var m = mutations[i]
        // characterData — Angular обновил текст «SKU: ...» в том же узле
        if (m.type === 'characterData') { scheduleScan(); return }
        if (m.type === 'childList' && hasForeignNodes(m.addedNodes)) { scheduleScan(); return }
      }
    })
    mo.observe(document.body, { childList: true, subtree: true, characterData: true })
  }

  // Плагин стартует из did-finish-load, но на всякий случай оставляем ручную
  // точку входа — тем же приёмом, что у tasks-notify.
  if (typeof window !== 'undefined') window.__skuCopyInit = start
  start()
})()
