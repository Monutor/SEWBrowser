import { setStatus } from './status-ui'
import { guestJS } from './guest'
import { activeTab } from './tabs'
import { isGuestReady } from './tab-events'

// DOM-ссылки берём лениво: типы ненулевые (гарды в функциях остаются рабочими
// как защита на момент вызова), иначе повторные вызовы дают каскад TS2531.
const overlayEl = (): HTMLElement =>
  document.getElementById('accounts-overlay') as HTMLElement
const setAccountsEl = (): HTMLElement => document.getElementById('set-accounts') as HTMLElement
const accFormEl = (): HTMLElement => document.getElementById('acc-form') as HTMLElement
const accFioEl = (): HTMLInputElement => document.getElementById('acc-fio') as HTMLInputElement
const accTabNumEl = (): HTMLInputElement => document.getElementById('acc-tabnum') as HTMLInputElement
const accPasswordEl = (): HTMLInputElement =>
  document.getElementById('acc-password') as HTMLInputElement

let accountsOpen = false
let loginPrompted = false
let editingAccountId: string | null = null

/** Элемент оверлея для списка пар в wireOverlayDismiss. */
export function accountsOverlayEl(): HTMLElement {
  return overlayEl()
}

/** Предикат открытости для цепочки Esc. */
export function isAccountsOpen(): boolean {
  return accountsOpen
}

/** Состояние «уже предлагали вход» — нужно main.ts и tab-events. */
export function getLoginPrompted(): boolean {
  return loginPrompted
}

export function setLoginPrompted(value: boolean): void {
  loginPrompted = value
}

function accountLabel(a: AccountInfo): string {
  return a.fio ? `${a.fio} · ${a.tabNum}` : a.tabNum
}

/** Список аккаунтов в окне «Аккаунты SEW»: войти / изменить / удалить */
async function renderAccountsList(): Promise<AccountInfo[]> {
  const setAccounts = setAccountsEl()
  if (setAccounts) setAccounts.innerHTML = ''
  let accounts: AccountInfo[] = []
  try {
    accounts = await window.shell.listAccounts()
  } catch (err) {
    console.warn('[shell] list accounts failed:', err)
  }
  if (!setAccounts) return accounts
  if (accounts.length === 0) {
    const empty = document.createElement('span')
    empty.textContent = 'Нет сохранённых аккаунтов'
    setAccounts.append(empty)
    return accounts
  }
  for (const a of accounts) {
    const row = document.createElement('div')
    row.className = 'account-row'
    const info = document.createElement('span')
    info.textContent = accountLabel(a)
    const login = document.createElement('button')
    login.textContent = 'Войти'
    login.className = 'login-btn'
    login.title = 'Подставить логин и пароль, войти'
    login.addEventListener('click', () => void fillLogin(a.id))
    const edit = document.createElement('button')
    edit.textContent = '✎'
    edit.title = 'Изменить'
    edit.addEventListener('click', () => openAccountForm(a))
    const del = document.createElement('button')
    del.textContent = '✕'
    del.title = 'Удалить'
    del.addEventListener('click', () => void deleteAccount(a))
    row.append(info, login, edit, del)
    setAccounts.append(row)
  }
  return accounts
}

async function deleteAccount(a: AccountInfo): Promise<void> {
  if (!window.confirm(`Удалить аккаунт «${accountLabel(a)}»?`)) return
  try {
    await window.shell.removeAccount(a.id)
    if (editingAccountId === a.id) closeAccountForm()
    await renderAccountsList()
    setStatus('аккаунт удалён')
  } catch (err) {
    console.warn('[shell] remove account failed:', err)
  }
}

function openAccountForm(a?: AccountInfo): void {
  editingAccountId = a?.id ?? null
  const accFio = accFioEl()
  const accTabNum = accTabNumEl()
  const accPassword = accPasswordEl()
  if (accFio) accFio.value = a?.fio ?? ''
  if (accTabNum) accTabNum.value = a?.tabNum ?? ''
  if (accPassword) {
    accPassword.value = ''
    accPassword.placeholder = a ? 'Пусто — не менять' : 'Пароль'
    accPassword.type = 'password'
  }
  const eye = document.getElementById('acc-eye')
  if (eye) eye.innerHTML = '&#128065;'
  const accForm = accFormEl()
  if (accForm) accForm.hidden = false
  accTabNum?.focus()
}

function closeAccountForm(): void {
  editingAccountId = null
  const accForm = accFormEl()
  if (accForm) accForm.hidden = true
}

async function saveAccountForm(): Promise<void> {
  const accTabNum = accTabNumEl()
  const accPassword = accPasswordEl()
  const tabNum = accTabNum?.value.trim() ?? ''
  const password = accPassword?.value ?? ''
  if (!tabNum) {
    setStatus('укажите табельный номер')
    return
  }
  if (!editingAccountId && !password) {
    setStatus('укажите пароль')
    return
  }
  try {
    await window.shell.saveAccount({
      id: editingAccountId ?? undefined,
      fio: accFioEl()?.value ?? '',
      tabNum,
      password,
    })
    closeAccountForm()
    await renderAccountsList()
    setStatus('аккаунт сохранён')
  } catch (err) {
    console.warn('[shell] save account failed:', err)
    setStatus(`не удалось сохранить: ${err instanceof Error ? err.message : err}`)
  }
}

// ---------- Окно «Аккаунты SEW»: выбор для входа + управление ----------

export async function openAccounts(manual: boolean): Promise<void> {
  const accounts = await renderAccountsList()
  if (accounts.length === 0) {
    // Авто-обнаружение формы входа: предлагать нечего — молча выходим.
    // Ручное открытие: сразу показываем форму добавления.
    if (!manual) return
    openAccountForm()
    setStatus('добавьте аккаунт SEW для автовхода')
  }
  const accountsOverlay = overlayEl()
  if (!accountsOverlay) return
  accountsOverlay.hidden = false
  accountsOpen = true
}

export function closeAccounts(): void {
  accountsOpen = false
  closeAccountForm()
  const accountsOverlay = overlayEl()
  if (accountsOverlay) accountsOverlay.hidden = true
}

export function wireAccounts(): void {
  document.getElementById('acc-add')?.addEventListener('click', () => openAccountForm())
  document.getElementById('acc-save')?.addEventListener('click', () => void saveAccountForm())
  document.getElementById('acc-cancel')?.addEventListener('click', closeAccountForm)
  document.getElementById('acc-eye')?.addEventListener('click', (event) => {
    const accPassword = accPasswordEl()
    if (!accPassword) return
    const show = accPassword.type === 'password'
    accPassword.type = show ? 'text' : 'password'
    ;(event.target as HTMLElement).innerHTML = show ? '&#128064;' : '&#128065;'
  })
  document.getElementById('accounts-cancel')?.addEventListener('click', closeAccounts)
}

/** Есть ли на странице видимое поле пароля (форма входа)? */
async function hasLoginForm(): Promise<boolean> {
  const tab = activeTab()
  if (!tab) return false
  try {
    const found = await guestJS<unknown>(
      tab,
      'login-form',
      '!!document.querySelector(\'input[type="password"]:not([disabled])\')',
    )
    return found === true
  } catch {
    return false
  }
}

export async function checkLoginForm(manual: boolean): Promise<void> {
  const tab = activeTab()
  if (!tab) return
  // Гость может быть ещё не готов (вкладка только что открыта или переключились
  // на грузящуюся) — executeJavaScript бросит, а проверять форму там нечего.
  if (!isGuestReady(tab.view)) return
  if (accountsOpen) return
  if (!manual && loginPrompted) return
  if (!(await hasLoginForm())) return
  loginPrompted = true
  await openAccounts(false)
}

/**
 * Подставляет табельный номер + пароль и нажимает «Войти».
 * Значения задаём через нативный сеттер value + события input/change,
 * иначе React/Vue-формы не заметят программную подстановку.
 */
async function fillLogin(accountId: string): Promise<void> {
  closeAccounts()
  let secrets: { tabNum: string; password: string } | null = null
  try {
    secrets = await window.shell.getAccountSecrets(accountId)
  } catch (err) {
    console.warn('[shell] get secrets failed:', err)
  }
  if (!secrets) {
    setStatus('не удалось получить данные аккаунта')
    return
  }
  const payload = JSON.stringify({ tabNum: secrets.tabNum, password: secrets.password })
  secrets = null
  const script =
    '(function(creds){' +
    'var pass=document.querySelector(\'input[type="password"]:not([disabled])\');' +
    'if(!pass) return "no-password-field";' +
    'var inputs=Array.prototype.slice.call(document.querySelectorAll("input")).filter(function(el){' +
    'return el!==pass&&!el.disabled&&el.type!=="hidden"&&el.type!=="submit"&&el.type!=="checkbox"' +
    '&&el.type!=="radio"&&el.type!=="password"&&el.offsetParent!==null;});' +
    'var user=inputs.find(function(el){return /user|login|email|tabnum|account|name/i' +
    '.test(el.name+" "+el.id+" "+el.placeholder);})||inputs[0];' +
    'function setVal(el,v){var desc=Object.getOwnPropertyDescriptor(Object.getPrototypeOf(el),"value")' +
    '||Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,"value");' +
    'if(desc&&desc.set)desc.set.call(el,v);else el.value=v;' +
    'el.dispatchEvent(new Event("input",{bubbles:true}));el.dispatchEvent(new Event("change",{bubbles:true}));}' +
    'if(user)setVal(user,creds.tabNum);' +
    'setVal(pass,creds.password);' +
    'var form=pass.form||(user&&user.form);' +
    'var submit=form?form.querySelector(\'button[type="submit"],input[type="submit"]\')' +
    ':document.querySelector(\'button[type="submit"]\');' +
    'setTimeout(function(){if(submit)submit.click();else if(form)' +
    '{if(form.requestSubmit)form.requestSubmit();else form.submit();}},300);' +
    'return "ok";})(' +
    payload +
    ')'
  const tab = activeTab()
  if (!tab) return
  try {
    await guestJS<unknown>(tab, 'fill-login', script)
    setStatus('вход…')
  } catch (err) {
    console.warn('[shell] autofill failed:', err)
    setStatus('не удалось заполнить форму')
  }
}
