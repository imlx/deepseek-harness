/**
 * Electron preload: installs `window.dshIpc`, the bridge the renderer's
 * ElectronApiClient drives. Runs with contextIsolation on, so the page only ever
 * sees the narrow contextBridge surface — never ipcRenderer itself.
 *
 * Contract (mirrors DshIpcBridge in dsh-client-connection's electron-api-client):
 * unary calls go through a single invoke channel; each downlink stream gets a
 * per-stream send channel keyed by the id openStream returns.
 */
const { contextBridge, ipcRenderer } = require('electron')

contextBridge.exposeInMainWorld('dshIpc', {
  fetch: (path, init) => ipcRenderer.invoke('dsh:fetch', path, init),
  openStream: (path) => ipcRenderer.invoke('dsh:openStream', path),
  onStream: (streamId, listener) => {
    const channel = `dsh:stream:${streamId}`
    const wrapped = (_event, data) => listener(data)
    ipcRenderer.on(channel, wrapped)
    return () => { ipcRenderer.removeListener(channel, wrapped) }
  },
  closeStream: (streamId) => { ipcRenderer.send('dsh:closeStream', streamId) },
})
