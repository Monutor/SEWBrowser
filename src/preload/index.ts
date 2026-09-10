import { contextBridge, ipcRenderer } from 'electron'

const api = {
  getConfig: (): Promise<{ startUrl: string; debug: boolean; allowlistEnabled: boolean; allowlist: string[] }> =>
    ipcRenderer.invoke('config:get'),
  getPlugins: (): Promise<{ name: string; code: string }[]> => ipcRenderer.invoke('plugins:list'),
  windowMin: (): void => ipcRenderer.send('window:min'),
  windowMax: (): void => ipcRenderer.send('window:max'),
  windowClose: (): void => ipcRenderer.send('window:close'),
}

contextBridge.exposeInMainWorld('shell', api)
