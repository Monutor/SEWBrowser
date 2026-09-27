export interface PromptFolder {
  id: string
  name: string
  passwordId?: string
}

export interface FolderPasswordPromptHooks {
  /** Папка по id; undefined, если папки нет. */
  findFolder(folderId: string): PromptFolder | undefined
}

export interface FolderPasswordPromptController {
  wire(): void
  cancel(): void
  prompt(folderId: string): Promise<string | null>
  require(folderId: string): Promise<boolean>
}

const promptEl = (): HTMLElement | null => document.getElementById('password-prompt')
const promptFolderNameEl = (): HTMLElement | null => document.getElementById('prompt-folder-name')
const promptPasswordEl = (): HTMLInputElement | null =>
  document.getElementById('prompt-password') as HTMLInputElement | null
const promptErrorEl = (): HTMLElement | null => document.getElementById('prompt-error')
const promptOkBtn = (): HTMLButtonElement | null =>
  document.getElementById('prompt-ok') as HTMLButtonElement | null
const promptCancelBtn = (): HTMLButtonElement | null =>
  document.getElementById('prompt-cancel') as HTMLButtonElement | null

/** Резолвер открытого диалога ввода пароля папки. */
let promptResolve: ((value: string | null) => void) | null = null
let currentPromptFolderId: string | null = null

/** Элемент диалога — нужен общей подписке на закрытие по клику по затемнению. */
export function passwordPromptEl(): HTMLElement | null {
  return promptEl()
}

export function createFolderPasswordPrompt(hooks: FolderPasswordPromptHooks): FolderPasswordPromptController {
  /** Скрыть диалог ввода пароля и разрешить промис как «отмена». */
  function cancel(): void {
    const el = promptEl()
    if (el && el.hidden) return
    if (el) el.hidden = true
    const resolve = promptResolve
    promptResolve = null
    resolve?.(null)
  }

  /** Показать диалог ввода пароля для защищённой папки.
   *  Возвращает введённый пароль (при верном) или null при отмене.
   *  Неверный пароль не закрывает диалог — показывает ошибку и ждёт повтора. */
  async function prompt(folderId: string): Promise<string | null> {
    const el = promptEl()
    const passwordEl = promptPasswordEl()
    const folderNameEl = promptFolderNameEl()
    // Без DOM диалог показать нельзя — трактуем как отмену (null), иначе пустая
    // строка прошла бы проверку как успешная аутентификация.
    if (!el || !passwordEl || !folderNameEl) return null
    const group = hooks.findFolder(folderId)
    currentPromptFolderId = group?.id ?? folderId
    folderNameEl.textContent = group ? `Папка «${group.name}»` : 'Введите пароль'
    passwordEl.value = ''
    const errorEl = promptErrorEl()
    if (errorEl) errorEl.hidden = true
    el.hidden = false
    passwordEl.focus()
    return await new Promise<string | null>((resolve) => {
      promptResolve = resolve
    })
  }

  function showPromptError(message: string): void {
    const errorEl = promptErrorEl()
    if (!errorEl) return
    errorEl.textContent = message
    errorEl.hidden = false
  }

  /** Проверить введённый пароль: неверный — показать ошибку и оставить диалог открытым. */
  async function submit(): Promise<void> {
    const passwordEl = promptPasswordEl()
    if (!passwordEl) return
    const value = passwordEl.value
    if (!value.trim()) {
      showPromptError('Введите пароль')
      return
    }
    if (!currentPromptFolderId) {
      cancel()
      return
    }
    const ok = await window.shell.verifyFolderPassword(currentPromptFolderId, value)
    if (!ok) {
      showPromptError('Неверный пароль')
      passwordEl.value = ''
      passwordEl.focus()
      return
    }
    const el = promptEl()
    if (el) el.hidden = true
    const resolve = promptResolve
    promptResolve = null
    resolve?.(value)
  }

  /** Подписать элементы диалога ввода пароля (один раз). */
  function wire(): void {
    promptOkBtn()?.addEventListener('click', () => void submit())
    promptCancelBtn()?.addEventListener('click', cancel)
    promptPasswordEl()?.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') void submit()
    })
  }

  /** Запросить текущий пароль защищённой па перед удалением или снятием/смены защиты.
   *  Возвращает true, если защита отсутствует или пароль введён верно; false — при отмене или ошибке. */
  async function require(folderId: string): Promise<boolean> {
    const group = hooks.findFolder(folderId)
    if (!group?.passwordId) return true // Без защиты — проверка не нужна.
    return (await prompt(folderId)) !== null
  }

  return { wire, cancel, prompt, require }
}
