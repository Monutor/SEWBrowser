// main.js — плагин «Автоподсчёт ЛП» (sew-inventory), этапы 1–4 плана
// docs/plan-sew-inventory.md: читаем состав ЛП из DOM, сводим его с остатками
// зоны из выгрузки SEW и вносим позиции в диалог ручного ввода ШК.
//
// Три неочевидных места, все описаны в docs/dom-sew-inventory.md:
//  1. В шапке ЛП каждое свойство — компонент `fck-property` с атрибутом `name`,
//     а значение разбито на `<span class="word">` по словам. Без склейки слов
//     «Торговый зал» превращается в «Торговыйзал» и не совпадёт с зоной файла.
//  2. Суффиксы Angular (`ng-tns-…-2`, `_ngcontent-…`) меняются при каждой
//     перезагрузке страницы, поэтому все селекторы строим на классах колонок
//     `cdk-column-*` и именах свойств, а не на этих суффиксах.
//  3. Кнопка ручного ввода и сам диалог ищутся по тем же признакам, что и в
//     sew-helper: `sew-stt-barcode-manually`, кнопка с `svg path[d^="M5 4C"]`.
//
// Остатки берём НЕ из API: файлом, который качает кнопка «Остатки» в тулбаре
// оболочки. У гостя нет window.shell, поэтому запрос идёт через мост оболочки:
// кладём {id, zone, skus} в window.__sewInventoryReq, ответ приходит объектом в
// window.__sewInventoryRes[id] (см. src/renderer/src/bridges.ts).

(function () {
  'use strict'

  var REQ = '__sewInventoryReq'
  var RES = '__sewInventoryRes'
  var STORE_KEY = 'lastRun'
  var ANSWER_POLL_MS = 250
  var ANSWER_TIMEOUT_MS = 120000
  var RESCAN_MS = 2000
  // Темп автовноса — как у sew-helper (пауза 900 мс + 300 мс на подтверждение),
  // около 1,2 с на единицу. Позже станет настраиваемым в панели.
  var STEP_BEFORE_OPEN_MS = 900
  var STEP_BEFORE_CONFIRM_MS = 300
  var DIALOG_WAIT_MS = 8000
  var UNIT_ATTEMPTS = 2
  var SHELF_WAIT_MS = 6000

  var state = {
    lp: null,
    rows: [],
    busy: false,
    lpKey: '',
    summary: null
  }

  /** Ключ ЛП: тот же номер в другой зоне — уже другой лист, пусть и с тем же номером. */
  function lpKeyOf(lp) {
    if (!lp) return ''
    return (lp.number || '') + '|' + (lp.zone || '')
  }

  // --- DOM листа подсчёта -------------------------------------------------

  /** Склеенное значение свойства по найденному элементу fck-property. */
  function propTextOf(prop) {
    var box = prop.querySelector('.value')
    if (!box) return ''
    var words = box.querySelectorAll('.word')
    if (words.length === 0) return box.textContent.replace(/\s+/g, ' ').trim()
    var parts = []
    for (var i = 0; i < words.length; i++) {
      var text = words[i].textContent.trim()
      if (text) parts.push(text)
    }
    return parts.join(' ').replace(/\s+/g, ' ').trim()
  }

  /** Значение свойства шапки: «Зона ЛП», «Номер ЛП» и т.п. */
  function propValue(name) {
    var prop = document.querySelector('fck-property[name="' + name + '"]')
    return prop ? propTextOf(prop) : ''
  }

  /**
   * Тот же поиск, но по вхождению подписи («Зона» вместо «Зона ЛП», «Номер
   * инвентаризации» вместо «Номер ЛП»). На разных экранах подсчёта SEW
   * называет поля по-разному, а нам нужна зона и номер — падать на этом нельзя,
   * иначе ЛП считается ненайденным при открытой шапке.
   */
  function propValueLoose(needle) {
    var want = normText(needle)
    var props = document.querySelectorAll('fck-property[name]')
    for (var i = 0; i < props.length; i++) {
      if (normText(props[i].getAttribute('name')).indexOf(want) === -1) continue
      var value = propTextOf(props[i])
      if (value) return value
    }
    return ''
  }

  /** Есть ли на экране аккордеон (в нём лежит шапка ЛП). */
  function hasExpansionPanels() {
    return document.querySelectorAll('.mat-expansion-panel').length > 0
  }

  // Панели не раскрываем: диагностикой подтверждено, что содержимое свёрнутого
  // mat-expansion-panel в разметке SEW присутствует, а клики по чужим панелям
  // только мешали бы на посторонних экранах.

  /** Число из текста ячейки: «0», « 12 », «—» */
  function cellNumber(text) {
    var cleaned = String(text || '').replace(/[^\d-]/g, '')
    var value = parseInt(cleaned, 10)
    return isFinite(value) ? value : 0
  }

  /** SKU строки: сперва наш артикул-кнопка, потом текст «SKU: …». */
  function rowSku(tr) {
    var copyBtn = tr.querySelector('button.sew-sku-copy[data-sku]')
    if (copyBtn) return copyBtn.getAttribute('data-sku') || ''
    var link = tr.querySelector('.sku-link')
    var fromLink = /SKU:\s*([0-9]+)/i.exec(link ? link.textContent : '')
    if (fromLink) return fromLink[1]
    var fromRow = /SKU:\s*([0-9]+)/i.exec(tr.textContent || '')
    return fromRow ? fromRow[1] : ''
  }

  /** Название позиции: блок `.item-name` без вложенного `.sku`, иначе первый
   *  текстовый td без фрагмента «SKU: …». */
  function rowName(tr) {
    var item = tr.querySelector('.item-name')
    if (item) {
      var parts = []
      for (var i = 0; i < item.children.length; i++) {
        var child = item.children[i]
        if (child.classList.contains('sku')) continue
        var text = child.textContent.trim()
        if (text) parts.push(text)
      }
      if (parts.length) return parts.join(' ')
    }
    var firstCell = tr.querySelector('td')
    var text = firstCell ? firstCell.textContent.replace(/\s+/g, ' ').trim() : ''
    return text.replace(/SKU:\s*[0-9]+/gi, '').replace(/\s+/g, ' ').trim()
  }

  /**
   * Уже посчитано в ЛП. На «слепом проходе» это отдельная колонка
   * `cdk-column-primaryQty`, а на экране результатов — свойство
   * «Отсканировано (1 этап)» внутри строки. Читаем оба варианта.
   */
  function rowCounted(tr) {
    var qty = tr.querySelector('td.cdk-column-primaryQty')
    if (qty) return cellNumber(qty.textContent)
    var props = tr.querySelectorAll('fck-property[name]')
    for (var i = 0; i < props.length; i++) {
      var name = normText(props[i].getAttribute('name'))
      var isCounted = name.indexOf('отсканировано') === 0 || name.indexOf('посчитано') === 0 || name === 'количество'
      if (isCounted) return cellNumber(propTextOf(props[i]))
    }
    return 0
  }

/**
 * Поднимаем найденный кусок строки до целой: пока в родителе ровно один
 * артикул, строка ещё не закончилась. Иначе «Отсканировано (1 этап)» и ШК
 * товара остались бы в соседних ячейках и «посчитано» читалось как 0.
 */
function growToFullRow(host) {
  var node = host
  for (var depth = 0; node && node.parentElement && depth < 6; depth++) {
    var parent = node.parentElement
    if (parent.querySelectorAll('.sku-link').length !== 1) break
    node = parent
  }
  return node
}

/**
 * Элементы строк позиций. Основной случай — обычная таблица (`tbody tr`).
 * На экране результатов подсчёта позиции размечены div'ами: `tr` в DOM нет
 * вовсе, но у каждой позиции есть блок `.sku` с артикулом (и наша кнопка
 * `sew-sku-copy`), поэтому строки собираем по этим маркерам и поднимаемся к
 * общему предку — строке. Маркеров на позицию два (`.sku-link` и кнопка), поэтому
 * дедуплицируем по SKU: иначе позиций вдвое больше, чем на самом деле.
 */
function findRowElements() {
  var rows = []
  var seen = {}
  var trs = document.querySelectorAll('tbody tr')
  for (var i = 0; i < trs.length; i++) rows.push(trs[i])
  if (rows.length > 0) return rows

  var marks = document.querySelectorAll('.sku-link, button.sew-sku-copy[data-sku]')
  for (var j = 0; j < marks.length; j++) {
    var host = marks[j].closest('[role="row"], .cdk-row, .mat-mdc-row')
    if (!host) host = rowLikeAncestor(marks[j])
    host = growToFullRow(host)
    var sku = rowSku(host)
    if (!sku || seen[sku]) continue
    seen[sku] = true
    rows.push(host)
  }
  return rows
}
  return rows
}

/** Ближайший предок, похожий на строку: класс с row/item/cell в имени. */
function rowLikeAncestor(node) {
  var current = node
  for (var depth = 0; current && depth < 8; depth++) {
    var cls = typeof current.className === 'string' ? current.className : ''
    if (/(^|\s|-)(row|item|position|goods|cell)/i.test(cls)) return current
    current = current.parentElement
  }
  return node.parentElement || node
}

/**
 * Позиции ЛП. Строки ищем по SKU, а не по классам колонок: на разных экранах
 * подсчёта таблица устроена по-разному («слепой проход» с `cdk-column-*` и
 * экран результатов со свойствами «Отсканировано»). Повторы по SKU убираем —
 * в разметке маркеров на позицию больше одного.
 */
function readRows() {
  var out = []
  var seen = {}
  var rows = findRowElements()
  for (var i = 0; i < rows.length; i++) {
    var sku = rowSku(rows[i])
    if (!sku || seen[sku]) continue
    seen[sku] = true
    out.push({ sku: sku, name: rowName(rows[i]), counted: rowCounted(rows[i]) })
  }
  return out
}

  /** ЛП на текущем экране или null. */
  function readLp() {
    var zone = propValue('Зона ЛП') || propValueLoose('зона')
    var number = propValue('Номер ЛП') || propValueLoose('номер лп')
    if (!zone && !number) return null
    return {
      zone: zone,
      number: number,
      title: propValue('Название ЛП') || propValueLoose('название'),
      kind: propValue('Тип ЛП') || propValueLoose('тип')
    }
  }

  // --- Мост остатков ------------------------------------------------------

  function requestStock(zone, skus) {
    return new Promise(function (resolve) {
      var id = 'inv' + Date.now() + '_' + Math.random().toString(36).slice(2, 8)
      var answers = window[RES] || (window[RES] = {})
      var queue = window[REQ] || (window[REQ] = [])
      answers[id] = ''
      queue.push({ id: id, zone: zone, skus: skus })
      var waited = 0
      var timer = setInterval(function () {
        waited += ANSWER_POLL_MS
        var box = window[RES] || {}
        if (box[id]) {
          clearInterval(timer)
          var raw = box[id]
          delete box[id]
          // Мост оболочки кладёт в ответ ОБЪЕКТ (JSON.stringify без кавычек в
          // коде гостя даёт литерал) — принимаем и объект, и строку, чтобы
          // не зависеть от того, как именно записан ответ.
          var parsed = null
          if (typeof raw === 'string') {
            try {
              parsed = JSON.parse(raw)
            } catch (e) {
              parsed = null
            }
          } else if (raw && typeof raw === 'object') {
            parsed = raw
          }
          if (!parsed || typeof parsed !== 'object') {
            console.warn('[sew-inventory] нечитаемый ответ моста:', Object.prototype.toString.call(raw), String(raw).slice(0, 200))
            resolve({ ok: false, error: 'мост вернул мусор вместо ответа: ' + String(raw).slice(0, 60) })
            return
          }
          resolve(parsed)
          return
        }
        if (waited >= ANSWER_TIMEOUT_MS) {
          clearInterval(timer)
          delete box[id]
          console.warn('[sew-inventory] мост не ответил за', ANSWER_TIMEOUT_MS / 1000, 'с; в очереди осталось:', (window[REQ] || []).length)
          resolve({ ok: false, error: 'оболочка не ответила — перезапусти приложение (main/preload меняются только при рестарте)' })
        }
      }, ANSWER_POLL_MS)
    })
  }

  // --- Сводка -------------------------------------------------------------

  /**
   * Сверка состава ЛП с остатками зоны. Считаем по SKU строк ЛП: «лишние» —
   * позиции остатков, которых в ЛП нет (плагин просит зону целиком, иначе
   * «лишние» посчитать нечем).
   */
  function summarize(lpRows, stockRows) {
    var stock = {}
    var stockUnits = 0
    for (var i = 0; i < stockRows.length; i++) {
      stock[stockRows[i].sku] = stockRows[i]
      stockUnits += stockRows[i].qty
    }

    var inLp = {}
    var matched = []
    var missing = []
    var zero = []
    var units = 0
    var alreadyCounted = 0
    for (var k = 0; k < lpRows.length; k++) {
      var row = lpRows[k]
      if (inLp[row.sku]) continue
      inLp[row.sku] = true
      alreadyCounted += row.counted
      var left = stock[row.sku]
      if (!left) {
        missing.push({ sku: row.sku, name: row.name })
        continue
      }
      matched.push({ sku: row.sku, name: row.name, qty: left.qty, barcode: left.barcode, cell: left.cell, counted: row.counted })
      units += left.qty
      if (left.qty <= 0) zero.push({ sku: row.sku, name: row.name })
    }

    var extraRows = []
    var extraUnits = 0
    for (var s = 0; s < stockRows.length; s++) {
      if (inLp[stockRows[s].sku]) continue
      extraRows.push(stockRows[s])
      extraUnits += stockRows[s].qty
    }

    return {
      total: lpRows.length,
      alreadyCounted: alreadyCounted,
      matched: matched,
      missing: missing,
      zero: zero,
      units: units,
      stockPositions: stockRows.length,
      stockUnits: stockUnits,
      extraCount: extraRows.length,
      extraUnits: extraUnits
    }
  }

  function plural(count, one, few, many) {
    var mod10 = count % 10
    var mod100 = count % 100
    if (mod10 === 1 && mod100 !== 11) return one
    if (mod10 >= 2 && mod10 <= 4 && (mod100 < 10 || mod100 >= 20)) return few
    return many
  }

  function listLine(items, limit) {
    if (items.length === 0) return ''
    var head = items.slice(0, limit || 5).map(function (item) {
      return item.sku + (item.name ? ' — ' + item.name : '')
    }).join('; ')
    var tail = items.length > (limit || 5) ? ' … и ещё ' + (items.length - (limit || 5)) : ''
    return head + tail
  }

  // --- Панель -------------------------------------------------------------

  var panel = null
  var els = {}

  function el(tag, className, text) {
    var node = document.createElement(tag)
    if (className) node.className = className
    if (text) node.textContent = text
    return node
  }

  function buildPanel() {
    panel = el('div', 'sew-inv-panel')
    panel.id = 'sew-inventory-panel'

    var head = el('div', 'sew-inv-head')
    head.appendChild(el('span', 'sew-inv-title', 'Автоподсчёт ЛП'))
    var collapse = el('button', 'sew-inv-btn sew-inv-collapse', '—')
    collapse.type = 'button'
    collapse.title = 'Свернуть'
    collapse.addEventListener('click', function () {
      panel.classList.toggle('sew-inv-collapsed')
      collapse.textContent = panel.classList.contains('sew-inv-collapsed') ? '+' : '—'
    })
    head.appendChild(collapse)
    panel.appendChild(head)

    var body = el('div', 'sew-inv-body')
    els.lp = el('div', 'sew-inv-lp', 'ЛП не найден')
    els.status = el('div', 'sew-inv-status', '')
    body.appendChild(els.lp)
    body.appendChild(els.status)

    var actions = el('div', 'sew-inv-actions')
    els.collect = el('button', 'sew-inv-btn sew-inv-primary', 'Собрать состав')
    els.collect.type = 'button'
    els.collect.addEventListener('click', function () {
      void collect()
    })
    actions.appendChild(els.collect)
    body.appendChild(actions)

    els.stats = el('div', 'sew-inv-stats')
    body.appendChild(els.stats)

    var start = el('button', 'sew-inv-btn', 'Старт подсчёта')
    start.type = 'button'
    start.disabled = true
    start.title = 'Внесёт остатки в диалог ручного ввода ШК'
    start.addEventListener('click', function () {
      void startRun()
    })
    els.start = start
    body.appendChild(start)

    var runRow = el('div', 'sew-inv-actions')
    var pause = el('button', 'sew-inv-btn', 'Пауза')
    pause.type = 'button'
    pause.hidden = true
    pause.addEventListener('click', function () {
      if (!state.run) return
      state.run.paused = !state.run.paused
      pause.textContent = state.run.paused ? 'Продолжить' : 'Пауза'
      updateProgress()
    })
    els.pause = pause
    var stop = el('button', 'sew-inv-btn', 'Стоп')
    stop.type = 'button'
    stop.hidden = true
    stop.addEventListener('click', function () {
      if (!state.run) return
      state.run.stopped = true
      state.run.paused = false
      setStatus('останавливаюсь…')
    })
    els.stop = stop
    runRow.appendChild(pause)
    runRow.appendChild(stop)
    body.appendChild(runRow)

    els.progress = el('div', 'sew-inv-progress', '')
    body.appendChild(els.progress)

    panel.appendChild(body)
    document.body.appendChild(panel)
  }

  function setStatus(text) {
    els.status.textContent = text || ''
  }

  function statRow(label, value, warn) {
    var row = el('div', 'sew-inv-stat' + (warn ? ' sew-inv-stat-warn' : ''))
    row.appendChild(el('span', 'sew-inv-stat-label', label))
    row.appendChild(el('span', 'sew-inv-stat-value', String(value)))
    return row
  }

  function renderSummary(summary, stockName) {
    els.stats.innerHTML = ''
    els.stats.appendChild(statRow('позиций в ЛП', summary.total))
    els.stats.appendChild(statRow('уже посчитано в ЛП', summary.alreadyCounted + ' шт'))
    els.stats.appendChild(statRow('совпало с остатками', summary.matched.length + ' из ' + summary.total, summary.matched.length === 0))
    els.stats.appendChild(statRow('единиц к вносу', summary.units))
    els.stats.appendChild(statRow('нет в остатках зоны', summary.missing.length, summary.missing.length > 0))
    els.stats.appendChild(statRow('найдено, но 0 шт', summary.zero.length, summary.zero.length > 0))
    els.stats.appendChild(statRow('лишних позиций в зоне', summary.extraCount + ' (' + summary.extraUnits + ' шт)'))
    if (stockName) els.stats.appendChild(el('div', 'sew-inv-note', 'файл: ' + stockName))

    var details = []
    if (summary.missing.length) details.push('нет в остатках: ' + listLine(summary.missing))
    if (summary.zero.length) details.push('нулевой остаток: ' + listLine(summary.zero))
    if (details.length) els.stats.appendChild(el('div', 'sew-inv-details', details.join('\n')))
  }

  // --- Сбор состава -------------------------------------------------------

  function refreshLp() {
    state.lp = readLp()
    state.rows = state.lp ? readRows() : []
    state.lpKey = lpKeyOf(state.lp)
    renderLpLine()
  }

  /** Строка шапки панели: номер, зона, позиции, посчитано. */
  function renderLpLine() {
    if (!state.lp) {
      els.lp.textContent = isInventoryScreen()
        ? 'это экран инвентаризации, а не лист подсчёта'
        : 'ЛП не найден — откройте лист подсчёта'
      return
    }
    var counted = 0
    for (var i = 0; i < state.rows.length; i++) counted += state.rows[i].counted
    els.lp.textContent =
      'ЛП № ' + (state.lp.number || '?') + ' · зона «' + (state.lp.zone || '?') + '» · позиций ' + state.rows.length +
      ' · посчитано ' + counted
  }

  async function collect() {
    if (state.busy) return
    // Таблица ЛП дорисовывается Angular'ом позже инжекта плагина, поэтому
    // состав читаем ЗДЕСЬ, а не берём снимок из init(): иначе в панели
    // «позиций 0» при полностью заполненной таблице.
    refreshLp()
    if (!state.lp) {
      setStatus(isInventoryScreen()
        ? 'это экран инвентаризации — открой лист подсчёта'
        : 'ЛП не найден — открой лист подсчёта')
      return
    }
    if (!state.lp.zone) {
      setStatus('в шапке ЛП нет «Зоны ЛП» — не знаю, чьи остатки брать')
      return
    }
    if (state.rows.length === 0) {
      setStatus('в таблице ЛП нет позиций — проверь, открыт ли лист подсчёта')
      return
    }
    state.busy = true
    els.collect.disabled = true
    setStatus('качаю остатки и разбираю ЛП…')
    try {
      var answer = await requestStock(state.lp.zone, [])
      if (!answer || !answer.ok) {
        setStatus('остатки не получились: ' + ((answer && answer.error) || 'нет ответа'))
        return
      }
      var stockRows = Array.isArray(answer.rows) ? answer.rows : []
      var summary = summarize(state.rows, stockRows)
      state.summary = summary
      renderSummary(summary, answer.name || '')
      els.start.disabled = false
      var queue = buildQueue(summary)
      setStatus('готово: к вносу ' + queue.total + ' шт' +
        (queue.skipped.length ? ', без ШК ' + queue.skipped.length : '') +
        '. Можно нажимать «Старт подсчёта».')
      saveLastRun(state.lp, summary)
    } catch (err) {
      setStatus('ошибка сбора: ' + ((err && err.message) || err))
    } finally {
      state.busy = false
      els.collect.disabled = false
    }
  }

  // В plugin-data кладём только сводку: состав на десятки тысяч строк ушёл бы
  // в plugin-data/sew-inventory.json, а тот целиком пушится в каждую вкладку
  // при каждой загрузке страницы (ловушка про 8 МБ в AGENTS.md).
  function saveLastRun(lp, summary) {
    try {
      chrome.storage.local.set({
        [STORE_KEY]: {
          zone: lp.zone,
          number: lp.number,
          title: lp.title,
          at: new Date().toISOString(),
          total: summary.total,
          units: summary.units,
          missing: summary.missing.length,
          extra: summary.extraCount
        }
      })
    } catch (e) {
      /* без сохранения не страшно */
    }
  }

  // --- Автовнос (этап 4) --------------------------------------------------

  function sleep(ms) {
    return new Promise(function (resolve) {
      setTimeout(resolve, ms)
    })
  }

  /** Ждём появления условия; false — не дождались. */
  async function waitFor(predicate, timeoutMs, stepMs) {
    var waited = 0
    var step = stepMs || 100
    while (waited < (timeoutMs || DIALOG_WAIT_MS)) {
      var value = predicate()
      if (value) return value
      await sleep(step)
      waited += step
    }
    return predicate() || false
  }

  /** Диалог ручного ввода ШК — тот же, что автоматизирован в sew-helper. */
  function findDialog() {
    var tagged = document.querySelector('sew-stt-barcode-manually')
    if (tagged && tagged.isConnected) return tagged
    var hosts = document.querySelectorAll('.cdk-overlay-container .mat-mdc-dialog-component-host, .cdk-overlay-container .mat-mdc-dialog-surface')
    for (var i = 0; i < hosts.length; i++) {
      if (!hosts[i].querySelector('.button-confirm')) continue
      if (!hosts[i].querySelector('input:not(.sew-helper-combo-input)')) continue
      return hosts[i]
    }
    return null
  }

  /**
   * Открыть диалог кнопкой ЛП. Ищем кнопку по иконке `M5 4C` (как в sew-helper),
   * с запасным вариантом по подписи — «штрих»/«ручн»/«barcode»/«manual».
   */
  function triggerDialog() {
    var buttons = document.querySelectorAll('shp-action-button button, rlc-action-button button, sew-iconed-action-button button')
    var fallback = null
    for (var i = 0; i < buttons.length; i++) {
      var paths = buttons[i].querySelectorAll('svg path')
      for (var j = 0; j < paths.length; j++) {
        var d = (paths[j].getAttribute('d') || '').trim()
        if (d.indexOf('M5 4C') === 0) {
          buttons[i].click()
          return true
        }
      }
      if (!fallback) {
        var hint = ((buttons[i].getAttribute('title') || '') + ' ' +
          (buttons[i].getAttribute('aria-label') || '') + ' ' +
          (buttons[i].textContent || '')).toLowerCase()
        if (hint.indexOf('штрих') !== -1 || hint.indexOf('ручн') !== -1 ||
          hint.indexOf('barcode') !== -1 || hint.indexOf('manual') !== -1) {
          fallback = buttons[i]
        }
      }
    }
    if (fallback) {
      fallback.click()
      return true
    }
    return false
  }

  /** Значение поля через сеттер прототипа — иначе Angular не увидит ввод. */
  function setNativeValue(input, value) {
    try {
      var setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set
      setter.call(input, value)
    } catch (e) {
      input.value = value
    }
    input.dispatchEvent(new Event('input', { bubbles: true }))
  }

  function normText(value) {
    return String(value || '').toLowerCase().replace(/ё/g, 'е').replace(/\s+/g, ' ').trim()
  }

  /**
   * Зона-источник в диалоге: комбобокс sew-helper перечисляет ПОЛКИ
   * («зона / ячейка»), а ЛП знает только зону, поэтому берём первую полку этой
   * зоны и показываем выбор в панели — человек успевает поправить. Выбор
   * подтверждается mousedown (так сделан pick() в sew-helper).
   *
   * Диалог создаётся заново на каждую единицу, но sew-helper восстанавливает
   * прошлый выбор сам, поэтому поле обычно уже заполнено — тогда мы ничего не
   * ждём и не тратим темп. Если поля нет (плагина полок нет / выбор сброшен) —
   * подставляем зону и ждём список полок.
   */
  async function applyZoneSource(dialog, zone) {
    var input = dialog.querySelector('.sew-helper-combo-input[data-slot="src"]')
    if (!input) return ''
    var want = normText(zone)
    if (want && normText(input.value).indexOf(want) === 0) return input.value.trim()
    setNativeValue(input, zone)
    var options = await waitFor(function () {
      var all = document.querySelectorAll('.sew-helper-combo-option')
      var visible = []
      for (var i = 0; i < all.length; i++) {
        if (all[i].offsetParent !== null) visible.push(all[i])
      }
      return visible.length ? visible : false
    }, SHELF_WAIT_MS, 250)
    if (!options) return ''
    for (var j = 0; j < options.length; j++) {
      var text = normText(options[j].textContent)
      if (text === want || text.indexOf(want + ' /') === 0 || text.indexOf(want + '/') === 0) {
        options[j].dispatchEvent(new MouseEvent('mousedown', { bubbles: true }))
        await sleep(200)
        return (options[j].textContent || '').trim()
      }
    }
    return ''
  }

  /**
   * Одна единица: открыть диалог, внести ШК, ОК. Возвращает {ok, shelf}:
   * ok=false — SEW ШК не принял, тогда очередь останавливается, а не долбит в
   * диалог (риск блокировки за частый ввод); shelf — какая полка попала в
   * зону-источник (для отчёта в панели).
   */
  async function enterUnit(zone, barcode) {
    var shelf = ''
    for (var attempt = 0; attempt < UNIT_ATTEMPTS; attempt++) {
      if (!findDialog()) {
        await sleep(STEP_BEFORE_OPEN_MS)
        if (!triggerDialog()) return { ok: false, shelf: shelf }
      }
      var target = await waitFor(findDialog, DIALOG_WAIT_MS, 100)
      if (!target) return { ok: false, shelf: shelf }
      var picked = await applyZoneSource(target, zone)
      if (picked) shelf = picked
      var input = target.querySelector('input:not(.sew-helper-combo-input)')
      var confirm = target.querySelector('.button-confirm')
      if (!input || !confirm) return { ok: false, shelf: shelf }
      setNativeValue(input, barcode)
      if (input.value !== barcode) return { ok: false, shelf: shelf }
      await sleep(STEP_BEFORE_CONFIRM_MS)
      confirm.click()
      // Успех = диалог закрылся (SEW закрывает его сам после ОК).
      var closed = await waitFor(function () {
        return !findDialog()
      }, 4000, 100)
      if (closed) return { ok: true, shelf: shelf }
      console.warn('[sew-inventory] ШК не принят (диалог не закрылся), попытка ' + (attempt + 2) + ' из ' + UNIT_ATTEMPTS)
    }
    return { ok: false, shelf: shelf }
  }

  /** Очередь: по каждой позиции остаток минус уже посчитанное в ЛП. */
  function buildQueue(summary) {
    var items = []
    var skipped = []
    var total = 0
    for (var i = 0; i < summary.matched.length; i++) {
      var item = summary.matched[i]
      var remaining = Math.max(0, item.qty - item.counted)
      if (remaining <= 0) continue
      if (!item.barcode) {
        skipped.push({ sku: item.sku, reason: 'нет ШК' })
        continue
      }
      items.push({ sku: item.sku, name: item.name, barcode: item.barcode, remaining: remaining, entered: 0 })
      total += remaining
    }
    return { items: items, skipped: skipped, total: total }
  }

  function formatEta(seconds) {
    if (!isFinite(seconds) || seconds <= 0) return '—'
    var minutes = Math.floor(seconds / 60)
    var rest = Math.round(seconds % 60)
    return minutes ? minutes + ' мин ' + rest + ' с' : rest + ' с'
  }

  function updateProgress() {
    var run = state.run
    var left = Math.max(0, run.total - run.entered)
    var perUnit = run.startedAt ? (Date.now() - run.startedAt) / Math.max(1, run.entered) : 0
    els.progress.textContent =
      'внесено ' + run.entered + ' из ' + run.total + ' шт' +
      (run.paused ? ' · пауза' : '') +
      (left ? ' · осталось ~' + formatEta(left * perUnit) : ' · готово')
  }

  async function runQueue(queue) {
    var run = state.run
    run.total = queue.total
    run.paused = false
    run.stopped = false
    run.failed = []
    run.startedAt = Date.now()
    var zoneDone = { shelf: '' }
    var zone = state.lp.zone

    for (var i = 0; i < queue.items.length; i++) {
      var item = queue.items[i]
      while (item.remaining > 0) {
        if (run.stopped) break
        if (run.paused) {
          await sleep(300)
          continue
        }
        var unit = await enterUnit(zone, item.barcode)
        if (unit.shelf) zoneDone.shelf = unit.shelf
        if (!unit.ok) {
          run.failed.push({ sku: item.sku, name: item.name, entered: item.entered })
          run.stopped = true
          setStatus('ШК не принят на ' + item.sku + ' — очередь остановлена')
          break
        }
        item.remaining--
        item.entered++
        run.entered++
        updateProgress()
        saveProgress(zone, run)
      }
      if (run.stopped) break
    }

    els.pause.hidden = true
    els.stop.hidden = true
    els.start.disabled = false
    var done = run.failed.length === 0
    setStatus(done
      ? 'подсчёт внесён полностью: ' + run.entered + ' шт за ' + formatEta((Date.now() - run.startedAt) / 1000) +
        (zoneDone.shelf ? ', зона-источник «' + zoneDone.shelf + '»' : '')
      : 'остановлено: внесено ' + run.entered + ' из ' + run.total)
    saveProgress(zone, run)
  }

  function saveProgress(zone, run) {
    // Только счётчики: очередь на десятки тысяч строк в plugin-data ушла бы
    // в снапшот, который пушится в каждую вкладку (ловушка про 8 МБ). Продолжение
    // после перезагрузки восстанавливается пересбором состава: сколько уже
    // внесено, ЛП показывает сам в cdk-column-primaryQty.
    try {
      chrome.storage.local.set({
        lastProgress: {
          zone: zone,
          number: state.lp ? state.lp.number : '',
          at: new Date().toISOString(),
          total: run.total,
          entered: run.entered,
          failed: run.failed.length
        }
      })
    } catch (e) {
      /* без сохранения не страшно */
    }
  }

  async function startRun() {
    if (state.busy || !state.summary) return
    var queue = buildQueue(state.summary)
    if (queue.total === 0) {
      setStatus('вносить нечего: всё уже посчитано или нет ШК')
      return
    }
    if (queue.skipped.length) {
      setStatus('без ШК: ' + queue.skipped.length + ' позиций — они не попадут в подсчёт')
    }
    state.busy = true
    els.collect.disabled = true
    els.start.disabled = true
    els.pause.hidden = false
    els.stop.hidden = false
    state.run = {
      total: queue.total,
      entered: 0,
      paused: false,
      stopped: false,
      failed: [],
      startedAt: Date.now()
    }
    updateProgress()
    setStatus('подсчёт идёт, ~' + formatEta(queue.total * 1.2) + '. Диалог откроет плагин.')
    try {
      await runQueue(queue)
    } catch (err) {
      setStatus('ошибка автовноса: ' + ((err && err.message) || err))
    } finally {
      state.busy = false
      els.collect.disabled = false
    }
  }

  /**
 * Полный срез того, что плагин видит на странице. Нужен, когда «ЛП не найден»
 * или «позиций 0»: сразу видно, где шапка, где таблица и что с панелями.
 * Вызывается из консоли гостя: copy(JSON.stringify(window.__sewInventory.diagnose(), null, 1))
 */
function diagnose() {
  var props = []
  var allProps = document.querySelectorAll('fck-property[name]')
  for (var i = 0; i < allProps.length; i++) {
    var panel = allProps[i].closest('.mat-expansion-panel')
    props.push({
      name: allProps[i].getAttribute('name'),
      value: propTextOf(allProps[i]),
      inPanel: !!panel,
      panelExpanded: panel ? panel.classList.contains('mat-expansion-panel-expanded') : null
    })
  }
  var panels = []
  var allPanels = document.querySelectorAll('.mat-expansion-panel')
  for (var j = 0; j < allPanels.length; j++) {
    var header = allPanels[j].querySelector('.mat-expansion-panel-header')
    panels.push({
      header: header ? header.textContent.replace(/\s+/g, ' ').trim().slice(0, 60) : '',
      expanded: allPanels[j].classList.contains('mat-expansion-panel-expanded'),
      rows: allPanels[j].querySelectorAll('tr').length
    })
  }
  var tables = []
  var allTables = document.querySelectorAll('table')
  for (var t = 0; t < allTables.length; t++) {
    tables.push({
      head: [].slice.call(allTables[t].querySelectorAll('thead th')).map(function (th) {
        return th.textContent.trim()
      }),
      rows: allTables[t].querySelectorAll('tr').length,
      cells: [].slice.call(allTables[t].querySelectorAll('tbody tr:first-child td')).map(function (td) {
        return td.className.replace(/\s*ng-tns[^\s]*/g, '').trim().slice(0, 60)
      })
    })
  }
  // Контекст реальной строки позиции: несколько уровней вверх от «Отсканировано»
  // или от нашей кнопки артикула. По нему видно, чем на самом деле является
  // строка, когда <tr> в DOM нет.
  var context = ''
  var anchor = document.querySelector('fck-property[name*="Отсканировано"], fck-property[name*="сканировано"]') ||
    document.querySelector('.sku-link, button.sew-sku-copy[data-sku]')
  if (anchor) {
    var chain = []
    var node = anchor
    for (var up = 0; node && up < 6; node = node.parentElement, up++) {
      var cls = typeof node.className === 'string' ? node.className : ''
      chain.push(node.tagName.toLowerCase() + (cls ? '.' + cls.replace(/\s*ng-tns[^\s]*/g, '').trim().split(/\s+/).slice(0, 4).join('.') : '') +
        '[' + node.children.length + ']')
    }
    context = chain.join(' < ')
  }

  return {
    url: location.pathname,
    looksLikeLpPage: looksLikeLpPage(),
    hasExpansionPanels: hasExpansionPanels(),
    trTotal: document.querySelectorAll('tr').length,
    materialNameCells: document.querySelectorAll('td.cdk-column-materialName').length,
    rowElements: findRowElements().length,
    context: context,
    props: props,
    panels: panels,
    tables: tables,
    readLp: readLp(),
    readRowsCount: readRows().length,
    readRows: readRows().slice(0, 3)
  }
}

// --- Запуск -------------------------------------------------------------

  /**
 * Экран инвентаризации (список подсчётов / результаты), а не лист подсчёта:
 * маршрут /v2/stocktaking/inventory/<номер>/results, в шапке нет «Зоны ЛП» и
 * таблицы позиций нет вовсе. На нём плагину нечего собирать — говорим прямо.
 */
function isInventoryScreen() {
  return /\/stocktaking\/inventory\/[^/]+\/results/.test(String(location.pathname || ''))
}

/** Похоже на экран подсчёта: есть таблица позиций ЛП. */
function looksLikeLpPage() {
  return document.querySelector('td.cdk-column-materialName') !== null || readRows().length > 0
}

function init() {
  if (document.getElementById('sew-inventory-panel')) return
  buildPanel()
  try {
    // Панели НЕ раскрываем: содержимое свёрнутого mat-expansion-panel в разметке
    // SEW тоже присутствует (проверено диагностикой), клики по чужим панелям
    // только мешали бы на посторонних экранах.
    refreshLp()
    if (!state.lp) setStatus(isInventoryScreen()
      ? 'это экран инвентаризации — открой лист подсчёта (кнопка ручного ввода ШК есть там же)'
      : 'открой лист подсчёта')
    else setStatus('нажмите «Собрать состав»')
  } catch (err) {
    console.warn('[sew-inventory] init failed:', err)
    setStatus('плагин не смог разобрать страницу: ' + ((err && err.message) || err))
  }
  // Страница SEW — SPA: тот же ЛП может дорисоваться после входа, а при
  // переходе на другой ЛП шапка меняется. Поэтому дешёвый опрос шапки, а не
  // одноразовое чтение. Перечитываем таблицу только когда ЛП реально сменился.
  setInterval(function () {
    if (state.busy) return
    try {
      var key = lpKeyOf(readLp())
      // Пока таблица пустая, продолжаем пробовать: плагин инжектится раньше,
      // чем SPA её нарисует. Дальше перечитываем только при смене ЛП.
      if (key === state.lpKey && state.rows.length > 0) return
      refreshLp()
      if (state.rows.length === 0) {
        if (state.lp) setStatus('ждём таблицу ЛП…')
        return
      }
      els.stats.innerHTML = ''
      setStatus('нажмите «Собрать состав»')
    } catch (err) {
      console.warn('[sew-inventory] rescan failed:', err)
    }
  }, RESCAN_MS)
}

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init)
  } else {
    init()
  }

  // Отладочный доступ (как у identity): панель и сводка доступны из консоли.
  window.__sewInventory = {
    readLp: readLp,
    readRows: readRows,
    collect: collect,
    startRun: startRun,
    diagnose: diagnose,
    state: state
  }
})()