/** Вложенные модалки «Управления шаблонами» (#templateModal, #confirmModal)
 *  открываются классом `.open`, а не атрибутом hidden — поэтому скрытие
 *  самого оверлера их не закрывает, и кнопка удаления сохраняет замыкание
 *  на старый шаблон. Сброс вынесен в чистую функцию: принимает Document,
 *  чтобы тестироваться без DOM. */

interface Resettable {
  onclick: unknown
  classList: { remove(name: string): void }
}

export function resetNestedTemplateModals(doc: Document): void {
  const form = doc.getElementById('templateModal') as Resettable | null
  if (form) form.classList.remove('open')
  const confirm = doc.getElementById('confirmModal') as Resettable | null
  if (confirm) confirm.classList.remove('open')
  const del = doc.getElementById('confirmDeleteBtn') as Resettable | null
  if (del) del.onclick = null
}
