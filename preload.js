const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('electronAPI', {
  setSyncSettings:  s  => ipcRenderer.send('set-sync-settings', s),
  getSyncSettings:  () => ipcRenderer.invoke('get-sync-settings'),
  pickToneFile:     () => ipcRenderer.invoke('pick-tone-file'),
  checkForUpdates:  () => ipcRenderer.invoke('check-for-updates'),
  installUpdate:    () => ipcRenderer.send('install-update'),
  onUpdateStatus:   cb => ipcRenderer.on('update-status', (_, data) => cb(data)),
});
