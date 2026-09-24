export interface TaskAlertElements {
  root: Pick<HTMLElement, 'hidden'>
  title: Pick<HTMLElement, 'textContent'>
  text: Pick<HTMLElement, 'textContent'>
  open: Pick<HTMLButtonElement, 'onclick'>
  all: Pick<HTMLButtonElement, 'hidden' | 'onclick'>
  close: Pick<HTMLButtonElement, 'onclick'>
}

export interface TaskAlertController {
  show: (text: string, onOpen: () => void, onAll?: () => void) => void
  close: () => void
}

export interface TaskAlertTask {
  kind?: string
  title: string
  body: string
  id?: number
  url?: string
}

export interface TaskAlertUrls {
  open: string
  all?: string
}

export function getTaskAlertUrls(task: TaskAlertTask): TaskAlertUrls {
  const open = task.url || '/v2/relocation/tasks'
  if (task.kind !== 'relocation' || typeof task.id !== 'number') return { open }
  const all = open.replace(/\/+$/, '')
  return { open: `${all}/${task.id}`, all }
}

export function formatTaskAlertText(task: TaskAlertTask): string {
  if (task.kind !== 'relocation') return task.title
  const match = /^#(\d+)\s*·\s*(.*?)\s*→\s*(.*)$/.exec(task.body)
  if (!match) return task.title
  return `Задание №${match[1]} · Источник: ${match[2]} · Приемник: ${match[3]}`
}

export function createTaskAlert(elements: TaskAlertElements): TaskAlertController {
  let onOpen: (() => void) | null = null
  let onAll: (() => void) | null = null

  const close = (): void => {
    elements.root.hidden = true
    elements.open.onclick = null
    elements.all.onclick = null
    elements.all.hidden = true
    elements.close.onclick = null
    onOpen = null
    onAll = null
  }

  const show = (text: string, callback: () => void, allCallback?: () => void): void => {
    onOpen = callback
    onAll = allCallback ?? null
    elements.title.textContent = 'Новое задание'
    elements.text.textContent = text
    elements.root.hidden = false
    elements.open.onclick = (): void => {
      const action = onOpen
      close()
      action?.()
    }
    elements.all.hidden = onAll === null
    elements.all.onclick = onAll === null
      ? null
      : (): void => {
          const action = onAll
          close()
          action?.()
        }
    elements.close.onclick = close
  }

  return { show, close }
}
