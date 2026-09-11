document.addEventListener('DOMContentLoaded', () => {
    const templateList = document.getElementById('template-list');
    const createTemplateBtn = document.getElementById('createTemplateBtn');
    const modalTitle = document.getElementById('modalTitle');
    const templateForm = document.getElementById('templateForm');
    const templateIdInput = document.getElementById('templateId');
    const templateNameInput = document.getElementById('templateName');
    const cancelBtn = document.getElementById('cancelBtn');
    const closeModalBtn = document.getElementById('closeModalBtn');
    const modalOverlay = document.getElementById('templateModal');

    let templates = [];
    let currentPreset = 'trn';

    // Character counter for template name (maxlength=50)
    const nameCounterEl = document.getElementById('nameCounter');
    if (templateNameInput && nameCounterEl) {
        templateNameInput.addEventListener('input', updateCounter);
    }

    function loadTemplates() {
        try {
            chrome.storage.local.get(['sew_templates'], (result) => {
                if (chrome.runtime.lastError) { showToast('Ошибка загрузки: ' + chrome.runtime.lastError.message); return; }
                templates = result.sew_templates || [];
                renderTemplateList();
            });
        } catch(e) {}
    }

    function escapeHtml(text) {
        const div = document.createElement('div');
        div.textContent = text;
        return div.innerHTML;
    }

    function getFieldsFromForm() {
        const fields = {};
        templateForm.querySelectorAll('input[data-field]').forEach(field => {
            const val = field.value.trim();
            if (val) {
                fields[field.dataset.field] = val;
            }
        });
        return fields;
    }

    function setFormValues(fields) {
        templateForm.querySelectorAll('input[data-field]').forEach(field => {
            const key = field.dataset.field;
            field.value = fields[key] || '';
        });
    }

    function renderTemplateList() {
        if (templates.length === 0) {
            templateList.innerHTML = `
                <div class="empty-state">
                    <svg viewBox="0 0 24 24"><path d="M14.86 3H9c-.55 0-1 .45-1 1v12H5V4c0-.55-.45-1-1-1S2 3.45 2 4v16c0 .55.45 1 1 1h14c.55 0 1-.45 1-1v-9.14L16.86 3z"/><path d="M17 3l-4 4h4z"/></svg>
                    <p>Создайте первый шаблон,<br>чтобы начать автоматизацию заполнения документов</p>
                </div>
            `;
            return;
        }

        templateList.innerHTML = '';
        templateList.insertAdjacentHTML('beforeend', '<div class="drag-hint">Перетащите карточку, чтобы изменить порядок</div>');
        templates.forEach((template, i) => {
            const fieldCount = template.fields ? Object.keys(template.fields).length : 0;
            const presetName = template.preset === 'trn' ? 'ТрН' : (template.preset || 'ТрН');

            const card = document.createElement('div');
            card.className = 'template-card';
            card.dataset.templateId = template.id;
            card.innerHTML = `
                <div class="card-row">
                    <div class="card-icon-wrap">
                        <svg viewBox="0 0 24 24"><path d="M14.86 3H9c-.55 0-1 .45-1 1v12H5V4c0-.55-.45-1-1-1S2 3.45 2 4v16c0 .55.45 1 1 1h14c.55 0 1-.45 1-1v-9.14L16.86 3z"/><path d="M17 3l-4 4h4z"/></svg>
                    </div>
                    <div class="card-text">
                        <div class="card-name">${escapeHtml(template.name || 'Без имени')}</div>
                        <div class="card-meta">${presetName} · ${fieldCount} полей</div>
                    </div>
                    <div class="card-actions">
                        <button class="icon-btn duplicate" data-action="duplicate" title="Копировать" aria-label="Дублировать шаблон">
                            <svg viewBox="0 0 24 24"><path d="M16 1H4a2 2 0 0 0-2 2v14h2V3h12V1zm3 4H8a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h11a2 2 0 0 0 2-2V7a2 2 0 0 0-2-2zm0 16H8V7h11v14z"/></svg>
                        </button>
                        <button class="icon-btn edit" data-action="edit" title="Редактировать" aria-label="Редактировать шаблон">
                            <svg viewBox="0 0 24 24"><path d="M3 17.25V21h3.75L17.81 9.94l-3.75-3.75L3 17.25zM20.71 7.04a.996.996 0 000-1.41l-2.34-2.34a.996.996 0 00-1.41 0l-1.83 1.83 3.75 3.75 1.83-1.83z"/></svg>
                        </button>
                        <button class="icon-btn delete" data-action="delete" title="Удалить" aria-label="Удалить шаблон">
                            <svg viewBox="0 0 24 24"><path d="M6 19c0 1.1.9 2 2 2h8c1.1 0 2-.9 2-2V7H6v12zM19 4h-3.5l-1-1h-5l-1 1H5v2h14V4z"/></svg>
                        </button>
                    </div>
                </div>
            `;
            const idx = i;
            card.draggable = true;
            card.addEventListener('dragstart', (e) => {
                card.classList.add('dragging');
                e.dataTransfer.effectAllowed = 'move';
                e.dataTransfer.setData('text/plain', String(idx));
            });
            card.addEventListener('dragend', () => card.classList.remove('dragging'));
            card.addEventListener('dragover', (e) => { e.preventDefault(); card.classList.add('drag-over'); });
            card.addEventListener('dragleave', () => card.classList.remove('drag-over'));
            card.addEventListener('drop', (e) => {
                e.preventDefault();
                card.classList.remove('drag-over');
                const from = Number(e.dataTransfer.getData('text/plain'));
                if (!Number.isInteger(from) || from === idx) return;
                const moved = templates.splice(from, 1)[0];
                templates.splice(idx, 0, moved);
                try {
                    chrome.storage.local.set({ sew_templates: templates }, () => {
                        if (chrome.runtime.lastError) { showToast('Ошибка сохранения порядка'); return; }
                        renderTemplateList();
                    });
                } catch (err) { showToast('Ошибка сохранения порядка'); }
            });
            templateList.appendChild(card);
        });

    }

    function openCreateModal() {
        templateIdInput.value = '';
        templateNameInput.value = '';
        setFormValues({});
        modalTitle.textContent = 'Создать шаблон';
        if (nameCounterEl) nameCounterEl.textContent = '0/50';
        modalOverlay.classList.add('open');
    }

    function openEditModal(id) {
        const template = templates.find(t => t.id === id);
        if (!template) return;

        templateIdInput.value = template.id;
        templateNameInput.value = template.name || '';
        setFormValues(template.fields || {});
        modalTitle.textContent = 'Редактировать шаблон';
        if (nameCounterEl) updateCounter();
        modalOverlay.classList.add('open');
    }

    function updateCounter() {
        const len = templateNameInput.value.length;
        nameCounterEl.textContent = len + '/50';
    }

    function closeModals() {
        modalOverlay.classList.remove('open');
    }

    function saveTemplate(e) {
        e.preventDefault();

        const id = templateIdInput.value || Date.now().toString();
        const name = templateNameInput.value.trim();
        const fields = getFieldsFromForm();

        if (!name) {
            showToast('Введите название шаблона');
            return;
        }

        if (Object.keys(fields).length === 0) {
            showToast('Заполните хотя бы одно поле');
            return;
        }

        const templateData = { id, name, preset: currentPreset, fields };
        const existingIndex = templates.findIndex(t => t.id === id);

        if (existingIndex >= 0) {
            templates[existingIndex] = templateData;
        } else {
            templates.push(templateData);
        }

        try {
            chrome.storage.local.set({ sew_templates: templates }, () => {
                if (chrome.runtime.lastError) { showToast('Ошибка сохранения'); return; }
                closeModals();
                loadTemplates();
                showToast('Шаблон сохранён');
            });
        } catch(e) {}
    }

    var confirmModal = document.getElementById('confirmModal');
    var confirmText = document.getElementById('confirmText');
    var confirmDeleteBtn = document.getElementById('confirmDeleteBtn');
    var confirmCancelBtn = document.getElementById('confirmCancelBtn');
    var confirmCloseBtn = document.getElementById('confirmCloseBtn');

    function openConfirmDialog(message, onConfirm) {
        confirmText.textContent = message;
        confirmModal.classList.add('open');
        confirmDeleteBtn.onclick = () => {
            confirmModal.classList.remove('open');
            onConfirm();
        };
    }

    function deleteTemplate(id) {
        templates = templates.filter(t => t.id !== id);
        try {
            chrome.storage.local.set({ sew_templates: templates }, () => {
                if (chrome.runtime.lastError) { showToast('Ошибка сохранения'); return; }
                loadTemplates();
            });
        } catch(e) {}
    }

    function duplicateTemplate(id) {
        const src = templates.find(t => t.id === id);
        if (!src) return;
        const copy = {
            id: Date.now().toString(),
            name: (src.name || 'Без имени') + ' (копия)',
            preset: src.preset || 'trn',
            fields: Object.assign({}, src.fields || {})
        };
        templates.push(copy);
        chrome.storage.local.set({ sew_templates: templates }, () => {
            if (chrome.runtime.lastError) { showToast('Ошибка сохранения'); return; }
            loadTemplates();
            showToast('Шаблон скопирован');
        });
    }

    confirmModal.addEventListener('click', (e) => {
        if (e.target === confirmModal) {
            confirmModal.classList.remove('open');
        }
    });
    confirmCancelBtn.addEventListener('click', () => confirmModal.classList.remove('open'));
    confirmCloseBtn.addEventListener('click', () => confirmModal.classList.remove('open'));

    function requestDeleteTemplate(id) {
        openConfirmDialog('Вы уверены, что хотите удалить этот шаблон?', () => deleteTemplate(id));
    }

    let toastTimer = null;
    const _toastSelector = '.toast';

    function showToast(message) {
        const existing = document.querySelector(_toastSelector);
        if (existing) existing.remove();
        if (toastTimer) clearTimeout(toastTimer);

        const toast = document.createElement('div');
        toast.className = 'toast';
        toast.textContent = message;
        document.body.appendChild(toast);

        requestAnimationFrame(() => toast.classList.add('show'));

        toast.addEventListener('click', () => {
            toast.remove();
            if (toastTimer) clearTimeout(toastTimer);
        });

        toastTimer = setTimeout(() => {
            toast.classList.remove('show');
            setTimeout(() => toast.remove(), 250);
        }, 2000);
    }

    // Preset selector
    document.querySelectorAll('.preset-option').forEach(opt => {
        opt.addEventListener('click', () => {
            document.querySelectorAll('.preset-option').forEach(o => o.classList.remove('active'));
            opt.classList.add('active');
            currentPreset = opt.dataset.preset;
        });
    });

    createTemplateBtn.addEventListener('click', openCreateModal);
    cancelBtn.addEventListener('click', closeModals);
    closeModalBtn.addEventListener('click', closeModals);
    templateForm.addEventListener('submit', saveTemplate);

    modalOverlay.addEventListener('click', (e) => {
        if (e.target === modalOverlay) {
            closeModals();
        }
    });

    chrome.storage.onChanged.addListener((changes) => {
        if (changes.sew_templates) { loadTemplates(); }
    });

    function isValidTpl(t) {
        return !!t && typeof t === 'object' && typeof t.id === 'string' && t.id &&
               typeof t.name === 'string' && t.fields && typeof t.fields === 'object';
    }

    function exportTemplates() {
        const blob = new Blob([JSON.stringify(templates, null, 2)], { type: 'application/json' });
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        const d = new Date();
        const stamp = `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}`;
        a.href = url;
        a.download = `sew-templates-${stamp}.json`;
        document.body.appendChild(a);
        a.click();
        a.remove();
        setTimeout(() => URL.revokeObjectURL(url), 2000);
    }

    function handleImportFile(file) {
        const reader = new FileReader();
        reader.onload = () => {
            let parsed;
            try {
                parsed = JSON.parse(reader.result);
            } catch (e) {
                showToast('Ошибка: неверный файл JSON');
                return;
            }
            if (!Array.isArray(parsed)) { showToast('Ошибка: в файле нет списка шаблонов'); return; }
            const existingIds = new Set(templates.map(t => t.id));
            let added = 0;
            parsed.forEach(t => {
                if (isValidTpl(t) && !existingIds.has(t.id)) {
                    templates.push(t);
                    existingIds.add(t.id);
                    added++;
                }
            });
            const skipped = parsed.length - added;
            chrome.storage.local.set({ sew_templates: templates }, () => {
                if (chrome.runtime.lastError) { showToast('Ошибка сохранения'); return; }
                loadTemplates();
                showToast(added > 0 ? `Импортировано: +${added}, пропущено: ${skipped}` : 'Не найдено новых шаблонов');
            });
        };
        reader.readAsText(file);
    }

    document.getElementById('exportBtn').addEventListener('click', exportTemplates);
    document.getElementById('importBtn').addEventListener('click', () => document.getElementById('importFileInput').click());
    document.getElementById('importFileInput').addEventListener('change', (e) => {
        const f = e.target.files && e.target.files[0];
        if (f) handleImportFile(f);
        e.target.value = '';
    });

    templateList.addEventListener('click', (e) => {
        const iconBtn = e.target.closest('.icon-btn');
        if (iconBtn) {
            e.stopPropagation();
            const id = iconBtn.closest('.template-card').dataset.templateId;
            if (iconBtn.dataset.action === 'edit') {
                openEditModal(id);
            } else if (iconBtn.dataset.action === 'delete') {
                requestDeleteTemplate(id);
            } else if (iconBtn.dataset.action === 'duplicate') {
                duplicateTemplate(id);
            }
            return;
        }
        const card = e.target.closest('.template-card');
        if (card) {
            openEditModal(card.dataset.templateId);
        }
    });

    loadTemplates();
});
