/** Где лежат базы данных, которые едут с приложением.
 *
 *  Файла из репозитория в установленном SEWBrowser нет, и править их из
 *  приложения нельзя — обновляются они новой версией. Копии в %APPDATA%
 *  поэтому не делаем: пользователь их всё равно не правит, а лишний файл в
 *  профиле только путает. */
import { app } from 'electron'
import { join } from 'node:path'

/**
 * Путь к файлу базы: dev — src/database рядом с проектом, prod —
 * resources/database (electron-builder: extraResources src/database -> database).
 */
export function getDatabaseFile(name: string): string {
  if (app.isPackaged) return join(process.resourcesPath, 'database', name)
  // dev: __dirname = <proj>/out/main → два уровня вверх = корень проекта
  return join(__dirname, '..', '..', 'src', 'database', name)
}