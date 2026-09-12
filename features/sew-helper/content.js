function closeModal(overlay) {
  document.removeEventListener('keydown', overlay._sewKeyHandler);
  if (overlay.parentNode) {
    overlay.parentNode.removeChild(overlay);
  }
}

function setupImg(img) {
  img.alt = '';
  img.loading = 'lazy';
  img.classList.add('sew-helper-loading');
  img.addEventListener('load', function () {
    this.classList.remove('sew-helper-loading', 'sew-helper-error');
  });
  img.addEventListener('error', function () {
    this.classList.remove('sew-helper-loading');
    this.classList.add('sew-helper-error');
    this.title = '\u041E\u0448\u0438\u0431\u043A\u0430 \u0437\u0430\u0433\u0440\u0443\u0437\u043A\u0438';
  });
  img.addEventListener('click', function (e) {
    if (!this.classList.contains('sew-helper-error')) return;
    e.stopPropagation();
    this.classList.remove('sew-helper-error');
    this.classList.add('sew-helper-loading');
    this.title = '';
    try {
      var url = new URL(this.src);
      url.searchParams.delete('retry');
      url.searchParams.set('retry', Date.now());
      this.src = url.toString();
    } catch (err) {
      var sep = this.src.indexOf('?') === -1 ? '?' : '&';
      this.src = this.src + sep + 'retry=' + Date.now();
    }
  });
}

function baseModal(onClose) {
  const overlay = document.createElement('div');
  overlay.className = 'sew-helper-modal';

  const content = document.createElement('div');
  content.className = 'sew-helper-modal-content';

  const close = document.createElement('button');
  close.className = 'sew-helper-modal-close';
  close.type = 'button';
  close.textContent = '\u00D7';
  close.setAttribute('aria-label', 'Close');
  close.addEventListener('click', onClose);

  overlay.addEventListener('mousedown', function (e) {
    overlay._sewBackdropDown = e.target === overlay;
  });

  overlay.addEventListener('click', function (e) {
    if (overlay._sewBackdropDown && e.target === overlay) onClose();
    overlay._sewBackdropDown = false;
  });

  const onKey = function (e) {
    if (e.key === 'Escape') onClose();
  };
  document.addEventListener('keydown', onKey);
  overlay._sewKeyHandler = onKey;

  overlay.appendChild(content);
  content.appendChild(close);
  document.body.appendChild(overlay);
  return { overlay: overlay, content: content };
}

function trapTab(overlay) {
  overlay.addEventListener('keydown', function (e) {
    if (e.key !== 'Tab') return;
    const focusable = overlay.querySelectorAll('button, [href], input, [tabindex]:not([tabindex="-1"])');
    if (!focusable.length) return;
    const first = focusable[0];
    const last = focusable[focusable.length - 1];
    if (e.shiftKey && document.activeElement === first) {
      e.preventDefault();
      last.focus();
    } else if (!e.shiftKey && document.activeElement === last) {
      e.preventDefault();
      first.focus();
    }
  });
}

const RECENT_SKUS_KEY = 'sewHelperRecentSkus';
const RECENT_SKUS_MAX = 8;

function getRecentSkus(cb) {
  try {
    chrome.storage.local.get(RECENT_SKUS_KEY, function (res) {
      const raw = (res && res[RECENT_SKUS_KEY]) || [];
      const list = (Array.isArray(raw) ? raw : [])
        .map(function (item) {
          if (typeof item === 'string') return { sku: item, name: null };
          if (item && typeof item.sku === 'string') {
            return { sku: item.sku, name: typeof item.name === 'string' ? item.name : null };
          }
          return null;
        })
        .filter(Boolean);
      cb(list);
    });
  } catch (e) {
    cb([]);
  }
}

function saveRecentSku(sku, name) {
  getRecentSkus(function (list) {
    const next = [{ sku: sku, name: name || null }]
      .concat(list.filter(function (e) { return e.sku !== sku; }))
      .slice(0, RECENT_SKUS_MAX);
    try {
      const obj = {};
      obj[RECENT_SKUS_KEY] = next;
      chrome.storage.local.set(obj);
    } catch (e) { /* noop */ }
  });
}

function clearRecentSkus() {
  try { chrome.storage.local.remove(RECENT_SKUS_KEY); } catch (e) { /* noop */ }
}

const SHSEL_KEY = 'sewHelperShelfSelection';

function sendMessageWithRetry(msg, callback, timeoutMs) {
  timeoutMs = timeoutMs || 15000;
  var responded = false;
  function onResponse(resp) {
    if (responded) return;
    responded = true;
    clearTimeout(timer);
    callback(resp);
  }
  var timer = setTimeout(function () {
    chrome.runtime.sendMessage(msg, onResponse);
  }, timeoutMs);
  chrome.runtime.sendMessage(msg, onResponse);
}

function saveShelfSelection() {
  try {
    const srcEl = document.querySelector('[data-slot="src"]');
    const dstEl = document.querySelector('[data-slot="dst"]');
    chrome.storage.local.set({ [SHSEL_KEY]: { src: (srcEl && srcEl.value) || '', dst: (dstEl && dstEl.value) || '' } });
  } catch (e) { /* noop */ }
}

function openInputModal() {
  const { overlay, content } = baseModal(function () { closeModal(overlay); });

  const form = document.createElement('form');
  form.className = 'sew-helper-form';

  const title = document.createElement('div');
  title.className = 'sew-helper-form-title';
  title.textContent = '\u0418\u043D\u0444\u043E\u0440\u043C\u0430\u0446\u0438\u044F \u043E \u0442\u043E\u0432\u0430\u0440\u0435';

  const input = document.createElement('input');
  input.className = 'sew-helper-input';
  input.type = 'text';
  input.inputMode = 'numeric';
  input.placeholder = '\u0412\u0432\u0435\u0434\u0438\u0442\u0435 \u0430\u0440\u0442\u0438\u043A\u0443\u043B (SKU)';
  input.autocomplete = 'off';

  const error = document.createElement('div');
  error.className = 'sew-helper-form-error';

  const actions = document.createElement('div');
  actions.className = 'sew-helper-form-actions';

  const cancel = document.createElement('button');
  cancel.type = 'button';
  cancel.className = 'sew-helper-btn';
  cancel.textContent = '\u041E\u0442\u043C\u0435\u043D\u0430';
  cancel.addEventListener('click', function () { closeModal(overlay); });

  const submit = document.createElement('button');
  submit.type = 'submit';
  submit.className = 'sew-helper-btn sew-helper-btn-primary';
  submit.textContent = '\u041F\u043E\u043A\u0430\u0437\u0430\u0442\u044C';

  actions.appendChild(cancel);
  actions.appendChild(submit);
  const recent = document.createElement('div');
  recent.className = 'sew-helper-recent';

  form.appendChild(title);
  form.appendChild(input);
  form.appendChild(recent);
  form.appendChild(error);
  form.appendChild(actions);
  content.appendChild(form);

  getRecentSkus(function (list) {
    if (!list.length) return;
    const label = document.createElement('div');
    label.className = 'sew-helper-recent-label';
    label.textContent = '\u041D\u0435\u0434\u0430\u0432\u043D\u0438\u0435:';
    const header = document.createElement('div');
    header.className = 'sew-helper-recent-header';
    header.appendChild(label);
    const clearBtn = document.createElement('button');
    clearBtn.type = 'button';
    clearBtn.className = 'sew-helper-recent-clear';
    clearBtn.textContent = '\u041E\u0447\u0438\u0441\u0442\u0438\u0442\u044C';
    clearBtn.addEventListener('click', function () {
      clearRecentSkus();
      while (recent.firstChild) recent.removeChild(recent.firstChild);
    });
    header.appendChild(clearBtn);
    recent.appendChild(header);
    const chips = document.createElement('div');
    chips.className = 'sew-helper-recent-chips';
    list.forEach(function (entry) {
      const chip = document.createElement('button');
      chip.type = 'button';
      chip.className = 'sew-helper-recent-chip';
      chip.textContent = entry.sku + (entry.name ? ' \u2014 ' + entry.name : '');
      if (entry.name) chip.title = entry.name;
      chip.addEventListener('click', function () {
        closeModal(overlay);
        openInfoModal(entry.sku);
      });
      chips.appendChild(chip);
    });
    recent.appendChild(chips);
  });

  form.addEventListener('submit', function (e) {
    e.preventDefault();
    const sku = input.value.trim();
    if (!/^\d+$/.test(sku)) {
      error.textContent = '\u0412\u0432\u0435\u0434\u0438\u0442\u0435 \u0447\u0438\u0441\u043B\u043E\u0432\u043E\u0439 \u0430\u0440\u0442\u0438\u043A\u0443\u043B';
      input.focus();
      return;
    }
    saveRecentSku(sku);
    closeModal(overlay);
    openInfoModal(sku);
  });

  trapTab(overlay);
  setTimeout(function () { input.focus(); }, 0);
}

function createShelfCombobox(labelText, onChange) {
  const wrap = document.createElement('div');
  wrap.className = 'sew-helper-shelf';

  const label = document.createElement('label');
  label.className = 'sew-helper-shelf-label';
  label.textContent = labelText;

  const input = document.createElement('input');
  input.className = 'sew-helper-select sew-helper-combo-input';
  input.type = 'text';
  input.placeholder = '\u041D\u0430\u0439\u0442\u0438 \u0437\u043E\u043D\u0443\u2026';
  input.autocomplete = 'off';

  const list = document.createElement('div');
  list.className = 'sew-helper-combo-list';

  const barcodeEl = document.createElement('div');
  barcodeEl.className = 'sew-helper-shelf-barcode';

  let shelves = [];
  let options = [];
  let currentBarcode = '';

  function positionList() {
    const rect = input.getBoundingClientRect();
    list.style.left = rect.left + 'px';
    list.style.top = rect.bottom + 2 + 'px';
    list.style.width = rect.width + 'px';
  }

  function openList() {
    positionList();
    list.classList.add('sew-helper-combo-open');
  }

  function closeList() {
    list.classList.remove('sew-helper-combo-open');
  }

  function cleanupIfDetached() {
    if (input.isConnected) return;
    window.removeEventListener('resize', onReposition);
    document.removeEventListener('scroll', onReposition, true);
    if (list.parentNode) list.parentNode.removeChild(list);
  }

  function onReposition() {
    if (!input.isConnected) {
      cleanupIfDetached();
      return;
    }
    if (list.classList.contains('sew-helper-combo-open')) positionList();
  }
  window.addEventListener('resize', onReposition);
  document.addEventListener('scroll', onReposition, true);

  function normalize(s) {
    return (s || '').toLowerCase().replace(/-/g, '');
  }

  function render(filter) {
    const f = normalize(filter);
    options.forEach(function (o) {
      o.el.style.display = (!f || o.search.indexOf(f) !== -1) ? '' : 'none';
    });
  }

  function pick(option) {
    input.value = option.textContent;
    currentBarcode = option.dataset.barcode || '';
    barcodeEl.textContent = '\u0428\u041A \u043F\u043E\u043B\u043A\u0438: ' + option.dataset.barcode;
    closeList();
    if (onChange) onChange(input.value);
  }

  input.addEventListener('focus', function () {
    render(input.value);
    openList();
  });

  input.addEventListener('input', function () {
    barcodeEl.textContent = '';
    currentBarcode = '';
    render(input.value);
    openList();
    if (onChange) onChange(input.value);
  });

  input.addEventListener('blur', function () {
    setTimeout(function () {
      cleanupIfDetached();
      closeList();
    }, 150);
  });

  list.addEventListener('mousedown', function (e) {
    e.stopPropagation();
    const option = e.target.closest('.sew-helper-combo-option');
    if (!option) return;
    e.preventDefault();
    pick(option);
  });

  list.addEventListener('click', function (e) {
    e.stopPropagation();
    if (e.target.closest('.sew-helper-combo-option')) {
      closeList();
    }
  });

  wrap.appendChild(label);
  wrap.appendChild(input);
  wrap.appendChild(barcodeEl);
  document.body.appendChild(list);

  return {
    wrap: wrap,
    setShelves: function (items) {
      shelves = items;
      list.innerHTML = '';
      options = [];
      items.forEach(function (s) {
        const opt = document.createElement('div');
        opt.className = 'sew-helper-combo-option';
        opt.textContent = s.zone + ' / ' + s.cell;
        opt.dataset.barcode = s.barcode;
        opt.dataset.search = normalize(s.zone + ' ' + s.cell);
        list.appendChild(opt);
        options.push({ el: opt, search: opt.dataset.search });
      });
    },
    restore: function (value) {
      if (!value) return;
      for (let i = 0; i < options.length; i++) {
        const el = options[i].el;
        if (el.textContent === value) {
          input.value = el.textContent;
          currentBarcode = el.dataset.barcode || '';
          barcodeEl.textContent = '\u0428\u041A \u043F\u043E\u043B\u043A\u0438: ' + el.dataset.barcode;
          if (onChange) onChange(input.value);
          break;
        }
      }
    },
    getBarcode: function () {
      return currentBarcode;
    }
  };
}

function fillShelfSelects(src, dst) {
  sendMessageWithRetry({ type: 'getShelves' }, function (resp) {
    const shelves = resp && Array.isArray(resp.shelves) ? resp.shelves : [];
    src.setShelves(shelves);
    dst.setShelves(shelves);
    try {
      chrome.storage.local.get(SHSEL_KEY, function (res) {
        const stored = res && res[SHSEL_KEY];
        if (!stored) return;
        if (stored.src) src.restore(stored.src);
        if (stored.dst) dst.restore(stored.dst);
      });
    } catch (e) { /* noop */ }
  });
}

function fillDialogBarcode(dialog, barcode) {
  if (!barcode) return;
  const scope = (dialog && dialog.isConnected) ? dialog : findManualBarcodeDialog();
  if (!scope) return;
  const input = scope.querySelector('input:not(.sew-helper-combo-input)');
  if (!input) return;
  try {
    const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
    setter.call(input, barcode);
  } catch (e) {
    input.value = barcode;
  }
  input.dispatchEvent(new Event('input', { bubbles: true }));
  try { input.focus(); } catch (e) { /* noop */ }
}

function injectShelfSection(dialog) {
  if (dialog.querySelector('.sew-helper-shelf-section')) return;
  const actions = dialog.querySelector('.mat-mdc-dialog-actions');
  if (!actions) return;
  const section = document.createElement('div');
  section.className = 'sew-helper-shelf-section sew-helper-shelf-in-dialog';

  const src = createShelfCombobox('\u0417\u043E\u043D\u0430-\u0438\u0441\u0442\u043E\u0447\u043D\u0438\u043A (\u0433\u0434\u0435 \u043D\u0430\u0445\u043E\u0434\u0438\u0442\u0441\u044F \u0442\u043E\u0432\u0430\u0440)', onShelfChange);
  const dst = createShelfCombobox('\u0417\u043E\u043D\u0430-\u043F\u0440\u0438\u0435\u043C\u043D\u0438\u043A (\u043A\u0443\u0434\u0430 \u043F\u043E\u043B\u043E\u0436\u0438\u0442\u044C \u0442\u043E\u0432\u0430\u0440)', onShelfChange);

  function onShelfChange() {
    saveShelfSelection();
    syncShelfFillButtons();
  }

  function syncShelfFillButtons() {
    srcBtn.disabled = !src.getBarcode();
    dstBtn.disabled = !dst.getBarcode();
  }

  src.wrap.querySelector('input').dataset.slot = 'src';
  dst.wrap.querySelector('input').dataset.slot = 'dst';
  section.appendChild(src.wrap);
  section.appendChild(dst.wrap);

  const srcBtn = document.createElement('button');
  srcBtn.type = 'button';
  srcBtn.className = 'sew-helper-btn sew-helper-shelf-fill-btn';
  srcBtn.textContent = '\u0428\u041A \u0438\u0441\u0442\u043E\u0447\u043D\u0438\u043A\u0430';
  srcBtn.title = '\u041F\u043E\u0434\u0441\u0442\u0430\u0432\u0438\u0442\u044C \u0428\u041A \u043F\u043E\u043B\u043A\u0438 \u0432 \u043F\u043E\u043B\u0435 \u0432\u0432\u043E\u0434\u0430';
  srcBtn.disabled = true;
  const dstBtn = document.createElement('button');
  dstBtn.type = 'button';
  dstBtn.className = 'sew-helper-btn sew-helper-shelf-fill-btn';
  dstBtn.textContent = '\u0428\u041A \u043F\u0440\u0438\u0451\u043C\u043D\u0438\u043A\u0430';
  dstBtn.title = '\u041F\u043E\u0434\u0441\u0442\u0430\u0432\u0438\u0442\u044C \u0428\u041A \u043F\u043E\u043B\u043A\u0438 \u0432 \u043F\u043E\u043B\u0435 \u0432\u0432\u043E\u0434\u0430';
  dstBtn.disabled = true;
  srcBtn.addEventListener('click', function () { fillDialogBarcode(dialog, src.getBarcode()); });
  dstBtn.addEventListener('click', function () { fillDialogBarcode(dialog, dst.getBarcode()); });
  section.appendChild(srcBtn);
  section.appendChild(dstBtn);
  fillShelfSelects(src, dst);
  syncShelfFillButtons();

  actions.parentNode.insertBefore(section, actions);
}

function openInfoModal(sku) {
  const { overlay, content } = baseModal(function () { closeModal(overlay); });

  const info = document.createElement('div');
  info.className = 'sew-helper-info';

  const header = document.createElement('div');
  header.className = 'sew-helper-info-header';
  const skuEl = document.createElement('span');
  skuEl.className = 'sew-helper-sku';
  skuEl.textContent = 'SKU: ' + sku;
  header.appendChild(skuEl);

  const barcodeEl = document.createElement('span');
  barcodeEl.className = 'sew-helper-barcode sew-helper-barcode-info';
  barcodeEl.textContent = '\u0428\u041A: \u0437\u0430\u0433\u0440\u0443\u0437\u043A\u0430\u2026';
  header.appendChild(barcodeEl);

  var refreshBtn = null;

  function makeRefresh() {
    var btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'sew-helper-btn sew-helper-refresh-btn';
    btn.textContent = '\u21BB \u041E\u0431\u043D\u043E\u0432\u0438\u0442\u044C \u0428\u041A';
    btn.addEventListener('click', function () {
      if (btn.disabled) return;
      sendMessageWithRetry({ type: 'reloadBarcodeDb' }, function () {
        setTimeout(loadBarcode, 1500);
      });
    });
    return btn;
  }

  function showRefresh() {
    if (refreshBtn || header.querySelector('.sew-helper-refresh-btn')) return;
    refreshBtn = makeRefresh();
    header.appendChild(refreshBtn);
  }

  function hideRefresh() {
    if (refreshBtn && refreshBtn.parentNode) {
      refreshBtn.parentNode.removeChild(refreshBtn);
    }
    refreshBtn = null;
  }

  const nameEl = document.createElement('div');
  nameEl.className = 'sew-helper-product-name';
  nameEl.hidden = true;

  const link = document.createElement('a');
  link.className = 'sew-helper-link';
  link.href = 'https://www.mvideo.ru/products/' + encodeURIComponent(sku);
  link.target = '_blank';
  link.rel = 'noopener noreferrer';
  link.textContent = '\u041E\u0442\u043A\u0440\u044B\u0442\u044C \u043D\u0430 mvideo.ru';
  header.appendChild(link);

  const grid = document.createElement('div');
  grid.className = 'sew-helper-modal-grid sew-helper-modal-grid-info';

  const status = document.createElement('div');
  status.className = 'sew-helper-status';
  status.textContent = '\u0417\u0430\u0433\u0440\u0443\u0437\u043A\u0430\u2026';

  info.appendChild(header);
  info.appendChild(nameEl);
  info.appendChild(grid);
  info.appendChild(status);
  content.appendChild(info);
  trapTab(overlay);

  sendMessageWithRetry({ type: 'getProductImages', sku: sku }, function (resp) {
    if (resp && typeof resp.name === 'string' && resp.name) {
      nameEl.textContent = resp.name;
      nameEl.hidden = false;
      saveRecentSku(sku, resp.name);
    }
    if (!(resp && resp.ok && (resp.thumb || (resp.all && resp.all.length)))) {
      status.textContent = '\u041D\u0435 \u0443\u0434\u0430\u043B\u043E\u0441\u044C \u043F\u043E\u043B\u0443\u0447\u0438\u0442\u044C \u0438\u0437\u043E\u0431\u0440\u0430\u0436\u0435\u043D\u0438\u044F \u0434\u043B\u044F SKU ' + sku;
      return;
    }
    if (status.parentNode) status.parentNode.removeChild(status);
    const sources = resp.all && resp.all.length ? resp.all : [resp.thumb];
    sources.forEach(function (src) {
      const wrap = document.createElement('div');
      wrap.className = 'sew-helper-thumb-wrap';
      const img = document.createElement('img');
      setupImg(img);
      img.src = src;
      wrap.appendChild(img);
      grid.appendChild(wrap);
      img.addEventListener('click', function () {
        if (this.classList.contains('sew-helper-error')) return;
        openLightbox(sources, this.src);
      });
    });
  });

  function loadBarcode() {
    barcodeEl.textContent = '\u0428\u041A: \u0437\u0430\u0433\u0440\u0443\u0437\u043A\u0430\u2026';
    hideToast();
    hideCachedNote();
    if (refreshBtn) {
      refreshBtn.disabled = true;
    }
    sendMessageWithRetry({ type: 'getBarcode', sku: sku }, function (resp) {
      if (resp && resp.barcode) {
        barcodeEl.textContent = '\u0428\u041A: ' + resp.barcode;
        hideCachedNote();
        hideRefresh();
        var oldWrap = header.querySelector('.sew-helper-fill-wrap');
        if (oldWrap && oldWrap.parentNode) oldWrap.parentNode.removeChild(oldWrap);
        var oldFill = header.querySelector('.sew-helper-fill-btn');
        if (oldFill && oldFill.parentNode) oldFill.parentNode.removeChild(oldFill);
        var fillWrap = document.createElement('span');
        fillWrap.className = 'sew-helper-fill-wrap';
        var qtyInput = document.createElement('input');
        qtyInput.type = 'number';
        qtyInput.min = '1';
        qtyInput.max = String(REPEAT_QTY_MAX);
        qtyInput.value = '1';
        qtyInput.className = 'sew-helper-qty';
        qtyInput.title = '\u041A\u043E\u043B\u0438\u0447\u0435\u0441\u0442\u0432\u043E \u043F\u043E\u0432\u0442\u043E\u0440\u0435\u043D\u0438\u0439';
        qtyInput.setAttribute('aria-label', '\u041A\u043E\u043B\u0438\u0447\u0435\u0441\u0442\u0432\u043E \u043F\u043E\u0432\u0442\u043E\u0440\u0435\u043D\u0438\u0439');
        var fillBtn = document.createElement('button');
        fillBtn.type = 'button';
        fillBtn.className = 'sew-helper-btn sew-helper-btn-primary sew-helper-fill-btn';
        fillBtn.textContent = '\u0414\u043E\u0431\u0430\u0432\u0438\u0442\u044C \u0448\u0442\u0440\u0438\u0445-\u043A\u043E\u0434';
        fillBtn.addEventListener('click', function () {
          var times = parseInt(qtyInput.value, 10);
          if (!(times >= 1)) times = 1;
          if (times > REPEAT_QTY_MAX) times = REPEAT_QTY_MAX;
          qtyInput.value = String(times);
          cancelBarcodeRepeats();
          if (!triggerManualBarcodeDialog()) {
            showToast('\u041D\u0435 \u0443\u0434\u0430\u043B\u043E\u0441\u044C \u043E\u0442\u043A\u0440\u044B\u0442\u044C \u0434\u0438\u0430\u043B\u043E\u0433 \u0440\u0443\u0447\u043D\u043E\u0433\u043E \u0432\u0432\u043E\u0434\u0430');
            return;
          }
          pendingBarcode = resp.barcode;
          pendingBarcodeTotal = times;
          pendingBarcodeDone = 0;
          pendingBarcodeArmedAt = Date.now();
          armBarcodeExpiry();
          updateRepeatChip();
          closeModal(overlay);
        });
        fillWrap.appendChild(qtyInput);
        fillWrap.appendChild(fillBtn);
        header.appendChild(fillWrap);
      } else {
        sendMessageWithRetry({ type: 'getDbStatus' }, function (dbResp) {
          if (dbResp && !dbResp.loaded) {
            showToast(dbResp.error || '\u0411\u0414 \u0448\u0442\u0440\u0438\u0445\u043A\u043E\u0434\u043E\u0432 \u043D\u0435 \u0437\u0430\u0433\u0440\u0443\u0437\u0438\u043B\u0430\u0441\u044C', function () {
              sendMessageWithRetry({ type: 'reloadBarcodeDb' }, function () {
                setTimeout(loadBarcode, 1500);
              });
            });
          } else {
            barcodeEl.textContent = '\u0428\u041A: \u041D\u0435 \u043D\u0430\u0439\u0434\u0435\u043D';
            if (dbResp && dbResp.cached) {
              showCachedNote();
            }
            showRefresh();
          }
        });
      }
    });
  }

  function showCachedNote() {
    if (cachedNoteEl && cachedNoteEl.parentNode) return;
    if (!cachedNoteEl) {
      cachedNoteEl = document.createElement('span');
      cachedNoteEl.className = 'sew-helper-barcode-cached';
      cachedNoteEl.textContent = '\u0418\u0437 \u043A\u044D\u0448-\u0430';
    }
    barcodeEl.appendChild(cachedNoteEl);
  }

  function hideCachedNote() {
    if (cachedNoteEl && cachedNoteEl.parentNode) {
      cachedNoteEl.parentNode.removeChild(cachedNoteEl);
    }
    cachedNoteEl = null;
  }

  loadBarcode();
}

function createToolbarButton() {
  const btn = document.createElement('button');
  btn.type = 'button';
  btn.className = 'sew-helper-toolbar-btn';

  const icon = document.createElement('span');
  icon.className = 'sew-helper-toolbar-icon';
  icon.textContent = 'info';
  btn.appendChild(icon);

  const label = document.createElement('span');
  label.className = 'sew-helper-toolbar-label';
  label.textContent = '\u0418\u043D\u0444\u043E \u043E \u0442\u043E\u0432\u0430\u0440\u0435';
  btn.appendChild(label);

  btn.title = '\u0418\u043D\u0444\u043E\u0440\u043C\u0430\u0446\u0438\u044F \u043E \u0442\u043E\u0432\u0430\u0440\u0435';
  btn.setAttribute('aria-label', '\u0418\u043D\u0444\u043E\u0440\u043C\u0430\u0446\u0438\u044F \u043E \u0442\u043E\u0432\u0430\u0440\u0435');
  btn.addEventListener('click', openInputModal);
  return btn;
}

function injectToolbarButton() {
  const toolbar = document.querySelector('sew-toolbar mat-toolbar.toolbar');
  if (!toolbar) return false;
  if (toolbar.querySelector('.sew-helper-toolbar-btn')) return true;
  const btn = createToolbarButton();

  const rlcToolbar = toolbar.querySelector('rlc-toolbar');
  if (rlcToolbar) {
    const spacer = rlcToolbar.querySelector('.spacer');
    if (spacer && spacer.nextSibling) {
      rlcToolbar.insertBefore(btn, spacer.nextSibling);
    } else {
      rlcToolbar.appendChild(btn);
    }
    return true;
  }

  const actions = toolbar.querySelector('.actions fck-actions') || toolbar.querySelector('.actions');
  if (actions) {
    actions.insertBefore(btn, actions.firstChild);
    return true;
  }

  toolbar.appendChild(btn);
  return true;
}

function isClickableActionButton(btn) {
  if (!btn || !btn.isConnected) return false;
  if (btn.disabled) return false;
  if (btn.getAttribute('aria-disabled') === 'true') return false;
  try {
    const rect = btn.getBoundingClientRect();
    if (rect.width === 0 && rect.height === 0) return false;
  } catch (e) { /* noop */ }
  return true;
}

function triggerManualBarcodeDialog() {
  const buttons = document.querySelectorAll('shp-action-button button, rlc-action-button button');
  let fallback = null;
  for (let i = 0; i < buttons.length; i++) {
    if (!isClickableActionButton(buttons[i])) continue;
    const paths = buttons[i].querySelectorAll('svg path');
    for (let j = 0; j < paths.length; j++) {
      const d = (paths[j].getAttribute('d') || '').trim();
      if (d.indexOf('M5 4C') === 0) {
        buttons[i].click();
        return true;
      }
    }
    if (!fallback) {
      const hint = ((buttons[i].getAttribute('title') || '') + ' ' +
        (buttons[i].getAttribute('aria-label') || '') + ' ' +
        (buttons[i].textContent || '')).toLowerCase();
      if (hint.indexOf('\u0448\u0442\u0440\u0438\u0445') !== -1 || hint.indexOf('\u0440\u0443\u0447\u043D') !== -1 ||
        hint.indexOf('barcode') !== -1 || hint.indexOf('manual') !== -1) {
        fallback = buttons[i];
      }
    }
  }
  if (fallback) {
    fallback.click();
    return true;
  }
  try {
    const dump = [];
    for (let k = 0; k < buttons.length && dump.length < 10; k++) {
      const b = buttons[k];
      const ds = [];
      const ps = b.querySelectorAll('svg path');
      for (let m = 0; m < ps.length && m < 3; m++) {
        ds.push((ps[m].getAttribute('d') || '').trim().slice(0, 12));
      }
      dump.push({
        host: b.parentNode && b.parentNode.tagName,
        cls: typeof b.className === 'string' ? b.className.slice(0, 80) : String(b.className).slice(0, 80),
        title: b.getAttribute('title'),
        aria: b.getAttribute('aria-label'),
        text: (b.textContent || '').trim().slice(0, 40),
        paths: ds
      });
    }
    console.warn('[sew-helper] triggerManualBarcodeDialog: \u043A\u043D\u043E\u043F\u043A\u0430 \u043D\u0435 \u043D\u0430\u0439\u0434\u0435\u043D\u0430, \u0432\u0441\u0435\u0433\u043E \u043A\u043D\u043E\u043F\u043E\u043A:', buttons.length, dump);
  } catch (e) { /* noop */ }
  return false;
}

let pendingBarcode = null;
let pendingBarcodeTotal = 0;
let pendingBarcodeDone = 0;
let pendingBarcodeArmedAt = 0;
const PENDING_BARCODE_TTL_MS = 10000;
const REPEAT_QTY_MAX = 99;
let _repeatChipEl = null;
let _toastEl = null;
let cachedNoteEl = null;

function showToast(text, onRetry) {
  hideToast();
  var toast = document.createElement('div');
  toast.className = 'sew-helper-toast';
  toast.textContent = text;
  if (onRetry) {
    var btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'sew-helper-toast__action';
    btn.textContent = '\u21BB \u041E\u0431\u043D\u043E\u0432\u0438\u0442\u044C';
    btn.addEventListener('click', function () {
      hideToast();
      onRetry();
    });
    toast.appendChild(btn);
  }
  var info = document.querySelector('.sew-helper-info');
  if (info) {
    info.appendChild(toast);
  }
  _toastEl = toast;
}

function hideToast() {
  if (_toastEl && _toastEl.parentNode) {
    _toastEl.parentNode.removeChild(_toastEl);
  }
  _toastEl = null;
}

function ensureRepeatChip() {
  if (!_repeatChipEl || !_repeatChipEl.isConnected) {
    _repeatChipEl = null;
    var chip = document.createElement('div');
    chip.className = 'sew-helper-repeat-chip';
    var label = document.createElement('span');
    label.className = 'sew-helper-repeat-chip__label';
    chip.appendChild(label);
    chip._sewLabel = label;
    chip._sewCancel = null;
    document.body.appendChild(chip);
    _repeatChipEl = chip;
  }
  var el = _repeatChipEl;
  if (!el._sewCancel || !el._sewCancel.isConnected) {
    var btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'sew-helper-repeat-chip__cancel';
    btn.textContent = '\u041E\u0442\u043C\u0435\u043D\u0430';
    btn.addEventListener('click', cancelBarcodeRepeats);
    el.appendChild(btn);
    el._sewCancel = btn;
  }
  return el;
}

function hideRepeatChip() {
  if (_repeatChipEl && _repeatChipEl.parentNode) {
    _repeatChipEl.parentNode.removeChild(_repeatChipEl);
  }
  _repeatChipEl = null;
}

function updateRepeatChip() {
  if (!(pendingBarcodeTotal > 1)) {
    hideRepeatChip();
    return;
  }
  var chip = ensureRepeatChip();
  chip._sewLabel.textContent = '\u0428\u041A: ' + pendingBarcodeDone + '/' + pendingBarcodeTotal;
}

function finishRepeatChip(aborted) {
  var total = pendingBarcodeTotal;
  var done = pendingBarcodeDone;
  pendingBarcode = null;
  pendingBarcodeTotal = 0;
  pendingBarcodeDone = 0;
  if (total > 1) {
    var chip = ensureRepeatChip();
    if (chip._sewCancel && chip._sewCancel.parentNode) {
      chip._sewCancel.parentNode.removeChild(chip._sewCancel);
    }
    chip._sewCancel = null;
    chip._sewLabel.textContent = aborted
      ? '\u041E\u0441\u0442\u0430\u043D\u043E\u0432\u043B\u0435\u043D\u043E: ' + done + '/' + total
      : '\u0413\u043E\u0442\u043E\u0432\u043E: ' + done + '/' + total;
    setTimeout(hideRepeatChip, aborted ? 4000 : 2500);
  } else {
    hideRepeatChip();
  }
}

function cancelBarcodeRepeats() {
  pendingBarcode = null;
  pendingBarcodeTotal = 0;
  pendingBarcodeDone = 0;
  hideRepeatChip();
}

function armBarcodeExpiry() {
  setTimeout(function () {
    if (pendingBarcode && Date.now() - pendingBarcodeArmedAt >= PENDING_BARCODE_TTL_MS) {
      pendingBarcode = null;
      pendingBarcodeTotal = 0;
      pendingBarcodeDone = 0;
      hideRepeatChip();
    }
  }, PENDING_BARCODE_TTL_MS + 500);
}

function scheduleBarcodeRepeat(barcode, attempt) {
  setTimeout(function () {
    if (!(pendingBarcodeTotal > 0 && pendingBarcodeDone < pendingBarcodeTotal)) return;
    if (findManualBarcodeDialog()) {
      if (attempt < 6) {
        scheduleBarcodeRepeat(barcode, attempt + 1);
        return;
      }
      try {
        console.warn('[sew-helper] \u043F\u043E\u0432\u0442\u043E\u0440 \u0428\u041A \u043E\u0441\u0442\u0430\u043D\u043E\u0432\u043B\u0435\u043D: \u0434\u0438\u0430\u043B\u043E\u0433 \u043D\u0435 \u0437\u0430\u043A\u0440\u044B\u043B\u0441\u044F');
      } catch (e) { /* noop */ }
      finishRepeatChip(true);
      return;
    }
    pendingBarcode = barcode;
    pendingBarcodeArmedAt = Date.now();
    armBarcodeExpiry();
    if (!triggerManualBarcodeDialog()) {
      try {
        console.warn('[sew-helper] \u043F\u043E\u0432\u0442\u043E\u0440 \u0428\u041A \u043E\u0441\u0442\u0430\u043D\u043E\u0432\u043B\u0435\u043D: \u0434\u0438\u0430\u043B\u043E\u0433 \u043D\u0435 \u043E\u0442\u043A\u0440\u044B\u0442');
      } catch (e) { /* noop */ }
      finishRepeatChip(true);
    }
  }, attempt === 0 ? 900 : 700);
}

function findManualBarcodeDialog() {
  var surfaces = document.querySelectorAll('.cdk-overlay-container .mat-mdc-dialog-surface');
  for (var i = 0; i < surfaces.length; i++) {
    var surface = surfaces[i];
    if (!surface.querySelector('.button-confirm')) continue;
    if (!surface.querySelector('input:not(.sew-helper-combo-input)')) continue;
    return surface;
  }
  return null;
}

let _manualBarcodeDialogObserver = null;
let _toolbarObserver = null;

function watchManualBarcodeDialog() {
  if (_manualBarcodeDialogObserver) { _manualBarcodeDialogObserver.disconnect(); }
  _manualBarcodeDialogObserver = new MutationObserver(function () {
    const dialog = findManualBarcodeDialog();
    if (!dialog) return;
    injectShelfSection(dialog);
    if (dialog._sewHelperFilled || !pendingBarcode) return;
    if (Date.now() - pendingBarcodeArmedAt > PENDING_BARCODE_TTL_MS) {
      pendingBarcode = null;
      pendingBarcodeTotal = 0;
      pendingBarcodeDone = 0;
      hideRepeatChip();
      return;
    }
    const input = dialog.querySelector('input:not(.sew-helper-combo-input)');
    const confirm = dialog.querySelector('.button-confirm');
    if (!input || !confirm) return;
    dialog._sewHelperFilled = true;
    const barcode = pendingBarcode;
    pendingBarcode = null;
    const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
    setter.call(input, barcode);
    input.dispatchEvent(new Event('input', { bubbles: true }));
    if (input.value !== barcode) {
      try {
        console.warn('[sew-helper] \u0428\u041A \u043D\u0435 \u043F\u043E\u0434\u0441\u0442\u0430\u0432\u0438\u043B\u0441\u044F \u0432 \u0434\u0438\u0430\u043B\u043E\u0433 \u0440\u0443\u0447\u043D\u043E\u0433\u043E \u0432\u0432\u043E\u0434\u0430, \u0430\u0432\u0442\u043E\u043A\u043B\u0438\u043A \u043E\u0442\u043C\u0435\u043D\u0435\u043D');
      } catch (e) { /* noop */ }
      return;
    }
    pendingBarcodeDone += 1;
    updateRepeatChip();
    setTimeout(function () {
      confirm.click();
      if (pendingBarcodeTotal > 0 && pendingBarcodeDone < pendingBarcodeTotal) {
        scheduleBarcodeRepeat(barcode, 0);
      } else if (pendingBarcodeTotal > 0) {
        finishRepeatChip(false);
      }
    }, 300);
  });
  _manualBarcodeDialogObserver.observe(document.body, { childList: true, subtree: true });
}

function setupToolbarObserver() {
  if (_toolbarObserver) { _toolbarObserver.disconnect(); }
  _toolbarObserver = new MutationObserver(function () {
    clearTimeout(_toolbarObserver._t);
    _toolbarObserver._t = setTimeout(injectToolbarButton, 300);
  });
  _toolbarObserver.observe(document.documentElement, { childList: true, subtree: true });
}

setupToolbarObserver();
injectToolbarButton();
watchManualBarcodeDialog();

function modIndex(current, delta, len) {
  return ((current + delta) % len + len) % len;
}

function preloadImage(src) {
  return new Promise(function (resolve) {
    var probe = new Image();
    probe.onload = function () { resolve(true); };
    probe.onerror = function () { resolve(false); };
    probe.src = src;
  });
}

function collectWorkingUrls(sources) {
  return Promise.all(
    sources.map(function (src) {
      return preloadImage(src).then(function (ok) { return ok ? src : null; });
    })
  ).then(function (arr) { return arr.filter(function (v) { return v !== null; }); });
}

function stripQuery(u) {
  var q = u.indexOf('?');
  return q === -1 ? u : u.slice(0, q);
}

var lbState = { el: null, urls: [], index: 0 };

function closeLightbox() {
  if (!lbState.el) return;
  var el = lbState.el;
  document.removeEventListener('keydown', lightboxKeyHandler);
  lbState.el = null;
  lbState.urls = [];
  lbState.index = 0;
  if (el.parentNode) {
    el.parentNode.removeChild(el);
  }
}

function lightboxKeyHandler(e) {
  if (!lbState.el) return;
  if (e.key === 'Escape') {
    closeLightbox();
  } else if (e.key === 'ArrowLeft') {
    navigateLightbox(-1);
  } else if (e.key === 'ArrowRight') {
    navigateLightbox(1);
  }
}

function buildLightboxDOM() {
  var el = document.createElement('div');
  el.className = 'sew-helper-lightbox';

  var backdrop = document.createElement('div');
  backdrop.className = 'sew-helper-lightbox-backdrop';

  var stage = document.createElement('div');
  stage.className = 'sew-helper-lightbox-stage';

  var prevBtn = document.createElement('button');
  prevBtn.type = 'button';
  prevBtn.className = 'sew-helper-lightbox-nav sew-helper-lightbox-prev';
  prevBtn.textContent = '\u2039';

  var nextBtn = document.createElement('button');
  nextBtn.type = 'button';
  nextBtn.className = 'sew-helper-lightbox-nav sew-helper-lightbox-next';
  nextBtn.textContent = '\u203A';

  var img = document.createElement('img');
  img.className = 'sew-helper-lightbox-img';
  img.alt = '';

  var counter = document.createElement('div');
  counter.className = 'sew-helper-lightbox-counter';

  var closeBtn = document.createElement('button');
  closeBtn.type = 'button';
  closeBtn.className = 'sew-helper-lightbox-close';
  closeBtn.textContent = '\u00D7';

  stage.appendChild(prevBtn);
  stage.appendChild(img);
  stage.appendChild(nextBtn);
  stage.appendChild(counter);

  el.appendChild(backdrop);
  el.appendChild(stage);
  el.appendChild(closeBtn);

  lbState.el = el;
  return el;
}

function renderLightboxImage() {
  if (!lbState.el || lbState.urls.length === 0) return;
  var img = lbState.el.querySelector('.sew-helper-lightbox-img');
  var counter = lbState.el.querySelector('.sew-helper-lightbox-counter');
  img.src = lbState.urls[lbState.index];
  if (counter) {
    counter.textContent = (lbState.index + 1) + ' / ' + lbState.urls.length;
  }
  var prevIdx = modIndex(lbState.index, -1, lbState.urls.length);
  var nextIdx = modIndex(lbState.index, 1, lbState.urls.length);
  preloadImage(lbState.urls[prevIdx]);
  preloadImage(lbState.urls[nextIdx]);
}

function navigateLightbox(delta) {
  if (!lbState.el || lbState.urls.length === 0) return;
  lbState.index = modIndex(lbState.index, delta, lbState.urls.length);
  renderLightboxImage();
}

function openLightbox(sources, clickedSrc) {
  collectWorkingUrls(sources).then(function (working) {
    if (working.length === 0) return;
    var startIdx = 0;
    for (var i = 0; i < working.length; i++) {
      if (stripQuery(working[i]) === stripQuery(clickedSrc)) { startIdx = i; break; }
    }
    lbState.urls = working;
    lbState.index = startIdx;
    var el = buildLightboxDOM();
    document.body.appendChild(el);
    bindLightboxHandlers();
    renderLightboxImage();
  });
}

function bindLightboxHandlers() {
  var el = lbState.el;
  if (!el) return;
  var backdrop = el.querySelector('.sew-helper-lightbox-backdrop');
  var closeBtn = el.querySelector('.sew-helper-lightbox-close');
  var nextBtn = el.querySelector('.sew-helper-lightbox-next');
  var prevBtn = el.querySelector('.sew-helper-lightbox-prev');
  if (backdrop) backdrop.addEventListener('click', closeLightbox);
  if (closeBtn) closeBtn.addEventListener('click', closeLightbox);
  if (nextBtn) nextBtn.addEventListener('click', function () { navigateLightbox(1); });
  if (prevBtn) prevBtn.addEventListener('click', function (e) { e.stopPropagation(); navigateLightbox(-1); });
  document.addEventListener('keydown', lightboxKeyHandler);
}
