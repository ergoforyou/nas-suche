const { contextBridge, ipcRenderer } = require('electron');

const listeners = new Map();
ipcRenderer.on('llm:event', (_e, msg) => listeners.get(msg.id)?.(msg));

contextBridge.exposeInMainWorld('desktop', {
  loadData: () => ipcRenderer.invoke('data:load'),
  saveData: (data) => ipcRenderer.invoke('data:save', data),
  minimize: () => ipcRenderer.send('win:minimize'),
  close: () => ipcRenderer.send('win:close'),
  setAlwaysOnTop: (on) => ipcRenderer.send('win:alwaysOnTop', on),
  listModels: (baseUrl) => ipcRenderer.invoke('llm:models', baseUrl),
  chat: (req, onEvent) => {
    listeners.set(req.id, (msg) => {
      onEvent(msg);
      if (msg.type !== 'delta') listeners.delete(req.id);
    });
    ipcRenderer.send('llm:chat', req);
  },
  abortChat: (id) => ipcRenderer.send('llm:abort', id),
});
