// Content script for SEW Templates Extension
// Handles Angular forms by dispatching input, change, blur events with bubbles: true

let fabElement = null;
let fabPanelOpen = false;

function handleStorageError(err) {
    if (err && /context\s*invalidated/i.test(err.message)) {
        showContextRestartToast();
    } else {
        // silent in production
    }
}

function showContextRestartToast() {
    const t = document.createElement('div');
    t.className = 'sew-context-toast';
    t.textContent = 'Расширение перезапущено — обновите страницу';
    t.style.cssText = 'position:fixed;bottom:24px;left:50%;transform:translateX(-50%);z-index:2147483647;background:#323232;color:#fff;padding:12px 16px;border-radius:8px;font:500 14px/1.4 Roboto,sans-serif;box-shadow:0 4px 12px rgba(0,0,0,.3)';
    document.body.appendChild(t);
    setTimeout(() => { if (t.parentNode) t.parentNode.removeChild(t); }, 3000);
}

document.addEventListener('DOMContentLoaded', () => {
    injectFAB();
    updateFABVisibility();
});

// Listen for messages from popup or other parts of the extension
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    if (message.action === 'applyTemplate') {
        applyTemplate(message.templateId);
        sendResponse({ success: true });
    }
    return true; // Indicates async response
});

// Function to fill form fields with template values
function fillFormFields(fields) {
    if (!fields || Object.keys(fields).length === 0) return;

    // Find all input fields, textareas, and selects in the document
    const formElements = document.querySelectorAll('input[type="text"], input[type="date"], textarea, select, [formControlName], [name]');

    formElements.forEach(element => {
        const fieldName = getFieldName(element);
        if (fields[fieldName] !== undefined) {
            setFieldValue(element, fields[fieldName]);
        }
    });
}

// Cache for label lookups by element id
const _labelCache = new Map();

// Get field name from element
function getFieldName(element) {
    // Angular sets formControlName in lowercase: 'formcontrolname'
    const fcName = element.getAttribute('formcontrolname') ||
                   element.getAttribute('formControlName') ||
                   element.formControlName;
    if (fcName) return fcName;

    if (element.name) {
        return element.name;
    }
    if (element.id) {
        return element.id;
    }
    // Try to find label associated with the input (cached)
    let label = _labelCache.get(element.id);
    if (!label && element.id) {
        label = document.querySelector(`label[for="${element.id}"]`);
        _labelCache.set(element.id, label);
    }
    if (label) {
        return label.textContent.trim().replace('*', '').trim();
    }
    return element.placeholder || '';
}

// Format YYYY-MM-DD → DD.MM.YYYY and back
function formatDateRU(dateStr) {
    if (!dateStr || typeof dateStr !== 'string') return dateStr;
    const m = dateStr.match(/^(\d{4})-(\d{2})-(\d{2})$/);
    if (m) return `${m[3]}.${m[2]}.${m[1]}`;
    const r = dateStr.match(/^(\d{2})\.(\d{2})\.(\d{4})$/);
    if (r) return `${r[3]}-${r[2]}-${r[1]}`;
    return dateStr;
}

// Detect whether this input should display dates in DD.MM.YYYY format
function isDateInput(element) {
    if (element.type === 'date') return true;
    const ph = element.placeholder || '';
    if (/дд\.мм|дд\/мм|мм\.гггг|год/i.test(ph)) return true;
    const label = element.closest('.mat-mdc-form-field, .form-control')?.querySelector('label');
    if (label && /дата|date|выдачи|дата выдачи/i.test(label.textContent)) return true;
    return false;
}

// Set field value and dispatch events for Angular reactive forms
function setFieldValue(element, value, force) {
    const strValue = String(value);
    // Format dates to Russian DD.MM.YYYY regardless of input type
    const formattedValue = isDateInput(element) ? formatDateRU(strValue) : strValue;
    if (!force && element.value === formattedValue) return;

    element.value = formattedValue;

    // Dispatch input and change with bubbles — enough for most Angular reactive forms
    const ev = new Event('input', { bubbles: true });
    element.dispatchEvent(ev);
    const ce = new Event('change', { bubbles: true });
    element.dispatchEvent(ce);

    // ngModelChange CustomEvent sends the user-facing format (DD.MM.YYYY for dates)
    const ncEv = new CustomEvent('ngModelChange', {
        bubbles: true,
        detail: formattedValue
    });
    element.dispatchEvent(ncEv);

    // Direct call to Angular's internal method if available
    try {
        const ngControl = element.ngControl || (element._ngRef && element._ngRef.parent);
        if (ngControl && typeof ngControl.viewToModelUpdate === 'function') {
            ngControl.viewToModelUpdate(formattedValue);
        }
    } catch (e) {
        // Ignore errors
    }
}

// Function to apply template fields to modal element
function applyTemplateFields(templateData, modalElement, force) {
    if (!templateData || !templateData.fields || Object.keys(templateData.fields).length === 0) return;

    // Find all input fields, textareas, and selects in the modal element
    // Angular sets formcontrolname (lowercase) but we also match camelCase for safety
    const formElements = modalElement.querySelectorAll('input[type="text"], input[type="date"], textarea, select, [formcontrolname], [formControlName], [name]');

    formElements.forEach(element => {
        const fieldName = getFieldName(element);
        if (templateData.fields[fieldName] !== undefined) {
            setFieldValue(element, templateData.fields[fieldName], force);
        }
    });
}

// Current active modal element
let currentModalElement = null;

// Track injected elements to avoid redundant injections
const _injectedElements = new WeakSet();

// Function to inject template selector into modal
function injectTemplateSelector(modalElement) {
    // Skip if selector already exists in this element or any parent up to body
    let el = modalElement;
    while (el && el !== document.body) {
        if (el.querySelector('.template-selector')) return;
        el = el.parentElement;
    }

    // Only inject into elements that contain our SEW form structure
    const hasNamedForm = !!modalElement.querySelector('shp-print-preparation-form, [class*="shp-"]');
    const hasSewFormClass = !!modalElement.querySelector('form.main, form[novalidate].main');
    const hasOurInputs = !!modalElement.querySelectorAll('[formcontrolname], [formControlName]').length;
    if (!hasNamedForm && !hasSewFormClass && !(modalElement.querySelector('.control-group') && hasOurInputs)) {
        return;
    }

    // Skip if already injected into this element or its descendants
    if (_injectedElements.has(modalElement)) return;
    _injectedElements.add(modalElement);

    const selectorHtml = `
        <div class="template-selector">
            <span class="template-selector-label">📄 Выбрать шаблон:</span>
            <select class="template-dropdown" id="sewTemplateDropdown">
                <option value="" disabled selected>-- Выбрать шаблон --</option>
            </select>
        </div>
    `;

    const selectorContainer = document.createElement('div');
    selectorContainer.innerHTML = selectorHtml.trim();
    const selectorElement = selectorContainer.firstElementChild || selectorContainer.firstChild;

    // Try to inject into header or before first form
    let insertTarget = null;

    const drawerHeader = modalElement.querySelector('.header, .mat-drawer-header, [class*="drawer-header"], [class*="panel-header"]');
    const modalHeader = modalElement.querySelector('.sew-modal-header, .modal-header, [class*="header"]');
    const modalFooter = modalElement.querySelector('.sew-modal-footer, .modal-footer, [class*="footer"]');
    const formElement = modalElement.querySelector('form.main, form[novalidate], form');

    if (drawerHeader) {
        insertTarget = drawerHeader;
    } else if (modalHeader) {
        insertTarget = modalHeader;
    } else if (modalFooter) {
        insertTarget = modalFooter;
    }

    if (insertTarget) {
        insertTarget.after(selectorElement);
    } else if (formElement) {
        // Insert before the form for drawers without a header
        modalElement.insertBefore(selectorElement, formElement);
    } else {
        modalElement.insertBefore(selectorElement, modalElement.firstChild);
    }

    // Load templates and populate dropdown (use selectorElement's own select to avoid ID collisions)
    const dropdown = selectorElement.querySelector('#sewTemplateDropdown');
    loadTemplatesIntoDropdown(dropdown);

    // Store current modal element
    currentModalElement = modalElement;

    // Store the last applied template ID on this dropdown to detect re-selection
    dropdown._lastApplied = null;

    dropdown.addEventListener('change', (e) => {
        const selectedTemplateId = e.target.value;
        if (!selectedTemplateId) return;
        const wasSame = selectedTemplateId === dropdown._lastApplied;
        applyTemplate(selectedTemplateId, true);
        dropdown._lastApplied = selectedTemplateId;
        // Reset to placeholder after Angular has processed the change so next selection always fires 'change'
        if (wasSame) {
            setTimeout(() => { dropdown.value = ''; }, 100);
        }
    });
}

// Load templates from storage and populate dropdown
function loadTemplatesIntoDropdown(dropdown) {
    try {
        chrome.storage.local.get(['sew_templates'], (result) => {
            if (chrome.runtime.lastError) { handleStorageError(chrome.runtime.lastError); return; }
            const templates = result.sew_templates || [];

            // Clear existing options except the first one
            while (dropdown.options.length > 1) {
                dropdown.remove(1);
            }

            templates.forEach(template => {
                const option = document.createElement('option');
                option.value = template.id;
                option.textContent = template.name || 'Без имени';
                dropdown.appendChild(option);
            });
        });
    } catch (e) {
        // Extension context invalidated — ignore
    }
}

// Apply template to form fields
function applyTemplate(templateId, force) {
    try {
        chrome.storage.local.get(['sew_templates'], (result) => {
            if (chrome.runtime.lastError) { handleStorageError(chrome.runtime.lastError); return; }
            const templates = result.sew_templates || [];
            const template = templates.find(t => t.id === templateId);

            if (template && template.fields) {
                let target = null;
                if (!currentModalElement) {
                    const activeEl = document.activeElement;
                    if (activeEl && (activeEl.matches('input, textarea, select') || activeEl.closest('.modal, [role="dialog"], .mat-drawer'))) {
                        target = activeEl.closest('.modal, [role="dialog"], .mat-drawer') || activeEl;
                    } else {
                        return;
                    }
                } else {
                    target = currentModalElement;
                }
                applyTemplateFields(template, target, force);
            }
        });
    } catch (e) {
        // Extension context invalidated — ignore
    }
}

// Clear form fields
function clearFormFields() {
    const selector = 'input[type="text"], input[type="date"], textarea, select, [formcontrolname], [formControlName], [name]';
    const formElements = currentModalElement ? currentModalElement.querySelectorAll(selector) : document.querySelectorAll(selector);
    formElements.forEach(element => {
        setFieldValue(element, '');
    });
}

// MutationObserver to detect modal appearance
let observer = null;

function startObserving() {
    if (observer) return;

    observer = new MutationObserver((mutations) => {
        mutations.forEach((mutation) => {
            // Check for removed nodes to clear modal tracking and show FAB
            mutation.removedNodes.forEach((node) => {
                if (currentModalElement && node === currentModalElement) {
                    currentModalElement = null;
                    updateFABVisibility();
                }
                _injectedElements.delete(node);
            });

            // Check for class attribute changes (Angular Material adds mat-drawer-opened to existing drawer)
            if (mutation.type === 'attributes' && mutation.attributeName === 'class') {
                const target = mutation.target;
                if (target.classList?.contains('mat-drawer') && target.classList?.contains('mat-drawer-opened')) {
                    // Check for SEW form structure
                    const hasSewInputs = target.querySelectorAll('[formcontrolname], [formControlName]').length > 0;
                    if (hasSewInputs || !!target.querySelector('[class*="shp-"]')) {
                        injectTemplateSelector(target);
                    }
                }
            }

            mutation.addedNodes.forEach((node) => {
                if (node.nodeType !== 1) return;

                // Clear stale modal reference if it's no longer in the document
                if (currentModalElement && !document.body.contains(currentModalElement)) {
                    currentModalElement = null;
                    updateFABVisibility();
                }

                // Check if this is a drawer/dialog/modal or contains one
                const sewDrawer = node.classList?.contains('mat-drawer') && node.classList?.contains('mat-drawer-opened') ? node : node.querySelector('.mat-drawer.mat-drawer-opened');
                const dialogContainer = node.querySelector('.mat-dialog-container');
                const overlayPane = node.querySelector('.cdk-overlay-pane');
                const hasSewInputs = (el) => el && !!el.querySelectorAll('[formcontrolname], [formControlName]').length;
                const modalElement = sewDrawer || (hasSewInputs(dialogContainer) ? dialogContainer : null) || (hasSewInputs(overlayPane) ? overlayPane : null);
                if (modalElement) {
                    injectTemplateSelector(modalElement);
                }
            });
        });
    });

    observer.observe(document.body, {
        childList: true,
        subtree: true,
        attributes: true,
        attributeFilter: ['class']
    });
}

function injectFAB() {
    if (fabElement) return;

    fabElement = document.createElement('button');
    fabElement.className = 'sew-fab';
    fabElement.textContent = 'Шаблоны';
    fabElement.setAttribute('title', 'Открыть шаблоны');

    // Inject outside Angular rendering zones
    document.body.appendChild(fabElement);

    fabElement.addEventListener('click', (e) => {
        e.stopPropagation();
        if (fabPanelOpen) {
            closeFABPanel();
        } else {
            openFABPanel();
        }
    });
}

function openFABPanel() {
    closeFABPanel(); // clear any existing panel first

    const overlay = document.createElement('div');
    overlay.className = 'sew-fab-panel-overlay';
    overlay.id = 'sewFabPanelOverlay';

    const panel = document.createElement('div');
    panel.className = 'sew-fab-panel';
    panel.id = 'sewFabPanel';

    const header = document.createElement('div');
    header.className = 'sew-fab-panel-header';
    header.textContent = 'Выберите шаблон';

    const list = document.createElement('div');
    list.className = 'sew-fab-panel-list';
    list.id = 'sewFabPanelList';

    panel.appendChild(header);
    panel.appendChild(list);
    overlay.appendChild(panel);
    document.body.appendChild(overlay);

    fabPanelOpen = true;

    try {
        chrome.storage.local.get(['sew_templates'], (result) => {
            if (chrome.runtime.lastError) { handleStorageError(chrome.runtime.lastError); return; }
            const templates = result.sew_templates || [];
            list.innerHTML = '';

            if (templates.length === 0) {
                const empty = document.createElement('div');
                empty.className = 'sew-fab-panel-empty';
                empty.textContent = 'Нет шаблонов. Откройте настройки для создания.';
                list.appendChild(empty);
                return;
            }

            templates.forEach(template => {
                const item = document.createElement('div');
                item.className = 'sew-fab-panel-item';
                item.textContent = template.name || 'Без имени';
                item.addEventListener('click', () => {
                    applyTemplate(template.id);
                    closeFABPanel();
                });
                list.appendChild(item);
            });
        });
    } catch (e) {
        // Extension context invalidated — ignore
    }

    overlay.addEventListener('click', (e) => {
        if (e.target === overlay) {
            closeFABPanel();
        }
    });
}

function closeFABPanel() {
    const overlay = document.getElementById('sewFabPanelOverlay');
    if (overlay) {
        overlay.remove();
    }
    fabPanelOpen = false;
}

function updateFABVisibility() {
    if (!fabElement) return;
    if (currentModalElement) {
        fabElement.style.display = 'none';
    } else {
        fabElement.style.display = 'flex';
    }
}

// Override injectTemplateSelector to also update FAB visibility
const originalInjectTemplateSelector = injectTemplateSelector;
injectTemplateSelector = function(modalElement) {
    currentModalElement = modalElement;
    updateFABVisibility();
    return originalInjectTemplateSelector.apply(this, arguments);
};

// Start observing when content script is loaded
startObserving();
