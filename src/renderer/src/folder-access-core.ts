/**
 * Чистая логика доступа к секции папки в оверлее вкладок. Вынесена отдельно от
 * DOM, чтобы покрыть тестами: раньше состояние секции считалось прямо в разметке,
 * и защищённая папка рисовалась раскрытой — по её вкладкам можно было перейти без
 * пароля.
 */

export interface FolderSectionInput {
  /** Папка защищена паролем (у NavFolder задан passwordId). */
  hasPassword: boolean
  /** Пароль введён (или «запомнен») и оверлей держит секцию раскрытой. */
  revealed: boolean
  /** Секция свёрнута пользователем — учитывается только у незащищённых папок. */
  collapsed: boolean
}

export interface FolderSectionState {
  /** Содержимое показывать нельзя: имя папки есть, вкладок — нет. */
  locked: boolean
  /** Секция раскрыта (тело с вкладками видно). */
  expanded: boolean
}

/**
 * Защищённая папка раскрыта только после ввода пароля: свёртка на неё не влияет,
 * пока пароль не введён. Незащищённая — как обычно, по состоянию свёртки.
 */
export function folderSectionState(input: FolderSectionInput): FolderSectionState {
  if (input.hasPassword) {
    return { locked: !input.revealed, expanded: input.revealed }
  }
  return { locked: false, expanded: !input.collapsed }
}

export interface ExportableInput {
  folders: NavFolder[]
  tabs: NavTab[]
}

export interface ExportableResult {
  folders: NavFolder[]
  tabs: NavTab[]
}

/**
 * Что уходит в экспорт .json: всё, кроме защищённых папок и вкладок внутри них.
 * Иначе пароль обходится файлом — выгруженную ссылку можно открыть, не зная его.
 */
export function exportableTabs(input: ExportableInput): ExportableResult {
  const protectedIds = new Set(input.folders.filter((f) => f.passwordId).map((f) => f.id))
  return {
    folders: input.folders.filter((f) => !protectedIds.has(f.id)),
    tabs: input.tabs.filter((t) => !(t.folderId && protectedIds.has(t.folderId))),
  }
}
