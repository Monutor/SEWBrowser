// main.js — плагин «Автоподсчёт ЛП» (sew-inventory), этап 1–3 плана
// docs/plan-sew-inventory.md: читаем состав ЛП из DOM и сводим его с остатками
// зоны из выгрузки SEW. Автовнос (этап 4) сюда ещё НЕ входит.
//
// Два неочевидных места, оба описаны в docs/dom-sew-inventory.md:
//  1. В шапке ЛП каждое свойство — компонент `fck-property` с атрибутом `name`,
//     а значение разбито на `<span class="word">` по словам. Без склейки слов
//     «Торговый зал» превращается в «Торговыйзал» и не совпадёт с зоной файла.
//  2. Суффиксы Angular (`ng-tns-…-2`, `_ngcontent-…`) меняются при каждой
//     перезагрузке страницы, поэтому все селекторы строим на классах колонок
//     `cdk-column-*` и именах свойств, а не на этих суффиксах.
//
// Остатки берём НЕ из API: файлом, который качает кнопка «Остатки» в тулбаре
// оболочки. У гостя нет window.shell, поэтому запрос идёт через мост оболочки:
// кладём {id, zone, skus} в window.__sewInventoryReq, ответ приходит строкой в
// window.__sewInventoryRes[id] (см. src/renderer/src/bridges.ts).

(function () {
  'use strict'

  var REQ = '__sewInventoryReq'
  var RES = '__sewInventoryRes'
  var STORE_KEY = 'lastRun'
  var ANSWER_POLL_MS = 250
  var ANSWER_TIMEOUT_MS = 120000
  var RESCAN_MS = 2000

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

  /** Значение свойства шапки: «Зона ЛП», «Номер ЛП» и т.п. */
  function propValue(name) {
    var box = document.querySelector('fck-property[name="' + name + '"] .value')
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

  /** Есть ли на экране аккордеон ЛП (шапка лежит внутри его панели). */
  function hasExpansionPanels() {
    return document.querySelectorAll('.mat-expansion-panel').length > 0
  }

  /**
   * Angular Material рендерит содержимое панели только ПОСЛЕ первого
   * раскрытия, поэтому после перезагрузки страницы «Зона ЛП» в DOM отсутствует.
   * Раскрываем ТОЛЬКО свёрнутые панели (уже открытые кликом закрылись бы) и
   * останавливаемся, как только шапка появилась.
   *
   * Ищем по КЛАССУ `.mat-expansion-panel`, а не по тегу: SEW использует свои
   * компоненты с теми же классами Material (fck-property, fck-sku-link и т.п.),
   * и тег `mat-expansion-panel` в разметке может не встречаться вовсе.
   */
  function expandPanelsUntilHeader(attempt) {
    var tries = attempt || 0
    if (propValue('Зона ЛП')) return true
    if (tries >= 6) return false
    var panels = document.querySelectorAll('.mat-expansion-panel')
    var clicked = false
    for (var i = 0; i < panels.length; i++) {
      if (panels[i].classList.contains('mat-expansion-panel-expanded')) continue
      var header = panels[i].querySelector('.mat-expansion-panel-header')
      if (!header) continue
      header.click()
      clicked = true
      break
    }
    if (!clicked) return false
    setTimeout(function () {
      expandPanelsUntilHeader(tries + 1)
    }, 350)
    return false
  }

  /** Число из текста ячейки: «0», « 12 », «—» */
  function cellNumber(text) {
    var cleaned = String(text || '').replace(/[^\d-]/g, '')
    var value = parseInt(cleaned, 10)
    return isFinite(value) ? value : 0
  }

  /**
   * Позиции ЛП из таблицы. Слепой проход отдаёт SKU и название, а в
   * `cdk-column-primaryQty` — уже посчитанное количество.
   */
  function readRows() {
    var out = []
    var trs = document.querySelectorAll('tbody tr.mat-mdc-row')
    for (var i = 0; i < trs.length; i++) {
      var item = trs[i].querySelector('td.cdk-column-materialName .item-name')
      if (!item) continue
      var name = ''
      for (var j = 0; j < item.children.length; j++) {
        var child = item.children[j]
        if (child.classList.contains('sku')) continue
        var text = child.textContent.trim()
        if (text) name += (name ? ' ' : '') + text
      }
      var sku = ''
      var copyBtn = item.querySelector('button.sew-sku-copy[data-sku]')
      if (copyBtn) sku = copyBtn.getAttribute('data-sku') || ''
      if (!sku) {
        var link = item.querySelector('.sku-link')
        var match = /SKU:\s*(\d+)/i.exec(link ? link.textContent : '')
        if (match) sku = match[1]
      }
      if (!sku) continue
      var counted = cellNumber((trs[i].querySelector('td.cdk-column-primaryQty') || {}).textContent)
      out.push({ sku: sku, name: name, counted: counted })
    }
    return out
  }

  /** ЛП на текущем экране или null. */
  function readLp() {
    var zone = propValue('Зона ЛП')
    var number = propValue('Номер ЛП')
    if (!zone && !number) return null
    return {
      zone: zone,
      number: number,
      title: propValue('Название ЛП'),
      kind: propValue('Тип ЛП'),
      headerHidden: false
    }
  }

  /**
   * Шапка не найдена: то ли это не ЛП, то ли панель с общей информацией
   * свёрнута (её содержимое тогда вообще не в DOM). Различаем по наличию
   * аккордеона, чтобы не советовать «откройте ЛП» там, где он открыт.
   */
  function readLpOrExplain() {
    var lp = readLp()
    if (lp) return lp
    if (!hasExpansionPanels()) return null
    return { zone: '', number: '', title: '', kind: '', headerHidden: true }
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
    els.expand = el('button', 'sew-inv-btn', 'Развернуть шапку')
    els.expand.type = 'button'
    els.expand.hidden = true
    els.expand.title = 'Шапка ЛП лежит в свёрнутой панели — Material не отдаёт её содержимое'
    els.expand.addEventListener('click', function () {
      setStatus('раскрываю панель…')
      expandPanelsUntilHeader(0)
      setTimeout(function () {
        if (state.busy) return
        refreshLp()
        if (state.lp && !state.lp.headerHidden) setStatus('нажмите «Собрать состав»')
      }, 2400)
    })
    actions.appendChild(els.expand)
    body.appendChild(actions)

    els.stats = el('div', 'sew-inv-stats')
    body.appendChild(els.stats)

    var start = el('button', 'sew-inv-btn', 'Старт подсчёта')
    start.type = 'button'
    start.disabled = true
    start.title = 'Автовнос появится на следующем этапе плана'
    start.addEventListener('click', function () {
      setStatus('автовнос ещё не реализован')
    })
    body.appendChild(start)

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
    state.lp = readLpOrExplain()
    state.rows = state.lp && !state.lp.headerHidden ? readRows() : []
    state.lpKey = lpKeyOf(state.lp)
    renderLpLine()
  }

  /** Строка шапки панели: номер, зона, позиции, посчитано. */
  function renderLpLine() {
    if (!state.lp) {
      els.lp.textContent = 'ЛП не найден — откройте лист подсчёта'
      els.expand.hidden = true
      return
    }
    if (state.lp.headerHidden) {
      els.lp.textContent = 'Шапка ЛП свёрнута'
      els.expand.hidden = false
      setStatus('разверни панель с общей информацией или нажми кнопку')
      return
    }
    els.expand.hidden = true
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
    if (!state.lp || state.lp.headerHidden) {
      setStatus('сначала откройте лист подсчёта')
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
      setStatus('готово')
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

  // --- Запуск -------------------------------------------------------------

  function init() {
    if (document.getElementById('sew-inventory-panel')) return
    buildPanel()
    refreshLp()
    setStatus('нажмите «Собрать состав»')
    // Страница SEW — SPA: тот же ЛП может дорисоваться после входа, а при
    // переходе на другой ЛП шапка меняется. Поэтому дешёвый опрос шапки, а не
    // одноразовое чтение. Перечитываем таблицу только когда ЛП реально сменился.
    setInterval(function () {
      if (state.busy) return
      var key = lpKeyOf(readLpOrExplain())
      // Пока таблица пустая, продолжаем пробовать: плагин инжектится раньше,
      // чем SPA её нарисует. Дальше перечитываем только при смене ЛП.
      if (key === state.lpKey && state.rows.length > 0) return
      refreshLp()
      if (state.lp && state.lp.headerHidden) return
      if (state.rows.length === 0) {
        if (state.lp) setStatus('ждём таблицу ЛП…')
        return
      }
      els.stats.innerHTML = ''
      setStatus('нажмите «Собрать состав»')
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
    state: state
  }
})()