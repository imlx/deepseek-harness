/**
 * Electron preload: installs `window.dshIpc`, the bridge the renderer's
 * ElectronApiClient drives. Runs with contextIsolation on, so the page only ever
 * sees the narrow contextBridge surface — never ipcRenderer itself.
 *
 * Contract (mirrors DshIpcBridge in dsh-client-connection's electron-api-client):
 * unary calls go through a single invoke channel; each downlink stream gets a
 * per-stream send channel keyed by the id openStream returns.
 *
 * Client plugin bundles load as ordinary file:// classic scripts — the composed
 * graph rows carry absolute file:// URLs, so the module system's default
 * loadBundle works unchanged and no bundle-path bridge is needed here.
 */
const { contextBridge, ipcRenderer } = require('electron')

contextBridge.exposeInMainWorld('dshIpc', {
  fetch: (path, init) => ipcRenderer.invoke('dsh:fetch', path, init),
  openStream: (path) => ipcRenderer.invoke('dsh:openStream', path),
  onStream: (streamId, listener) => {
    const channel = `dsh:stream:${streamId}`
    const wrapped = (_event, data) => listener(data)
    ipcRenderer.on(channel, wrapped)
    // Tell the main process the listener is attached so it releases the stream
    // pump — frames sent before this would be silently dropped by IPC.
    ipcRenderer.send('dsh:streamReady', streamId)
    return () => { ipcRenderer.removeListener(channel, wrapped) }
  },
  closeStream: (streamId) => { ipcRenderer.send('dsh:closeStream', streamId) },
  // Binary fetch for the host download surfaces (session.export's ZIP): the unary
  // fetch channel returns text, which would corrupt a ZIP, so this carries bytes.
  fetchBinary: (path, init) => ipcRenderer.invoke('dsh:fetchBinary', path, init)
    .then(({ status, headers, bytes }) => ({
      status,
      ok: status >= 200 && status < 300,
      headers,
      bytes: Uint8Array.from(bytes ?? []),
    })),
  // Trigger a host download (session export): the main process writes the file to the
  // user's Downloads folder, matching the web surface's native-download behavior.
  download: (path, filename) => ipcRenderer.invoke('dsh:download', path, filename),
})
