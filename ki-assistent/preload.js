const { contextBridge, ipcRenderer } = require('electron');

const listeners = new Map();
ipcRenderer.on('llm:event', (_e, msg) => listeners.get(msg.id)?.(msg));

let commandHandler = () => {};
ipcRenderer.on('cmd', (_e, cmd) => commandHandler(cmd));

contextBridge.exposeInMainWorld('desktop', {
  edition: ipcRenderer.sendSync('app:edition'),
  loadData: () => ipcRenderer.invoke('data:load'),
  saveData: (data) => ipcRenderer.invoke('data:save', data),
  minimize: () => ipcRenderer.send('win:minimize'),
  close: () => ipcRenderer.send('win:close'),
  show: () => ipcRenderer.send('win:show'),
  quit: () => ipcRenderer.send('app:quit'),
  setAlwaysOnTop: (on) => ipcRenderer.send('win:alwaysOnTop', on),
  onCommand: (fn) => (commandHandler = fn),

  // freischwebende Figur
  avatarIgnoreMouse: (ignore) => ipcRenderer.send('avatar:ignoreMouse', ignore),
  avatarDragStart: () => ipcRenderer.send('avatar:dragStart'),
  avatarDragEnd: () => ipcRenderer.send('avatar:dragEnd'),
  avatarResize: (factor, aspect) => ipcRenderer.send('avatar:resize', { factor, aspect }),
  avatarMenu: (state) => ipcRenderer.send('avatar:menu', state),
  avatarResizeStart: (corner, aspect) => ipcRenderer.send('avatar:resizeStart', { corner, aspect }),
  avatarSetSize: (fraction, aspect) => ipcRenderer.send('avatar:setSize', { fraction, aspect }),

  // Dokumente speichern
  exportSave: (name, ext, label, bytes) => ipcRenderer.invoke('export:save', { name, ext, label, bytes }),
  exportPdf: (name, html) => ipcRenderer.invoke('export:pdf', { name, html }),
  exportShow: (file) => ipcRenderer.send('export:show', file),

  // Medien (Video-Posen)
  saveMedia: (bytes, ext) => ipcRenderer.invoke('media:save', { bytes, ext }),
  deleteMedia: (url) => ipcRenderer.invoke('media:delete', url),

  // Modelle / Netzwerk
  modelInfo: () => ipcRenderer.invoke('models:info'),
  openModelDir: () => ipcRenderer.send('models:open'),
  setOffline: (on) => ipcRenderer.send('net:offline', on),

  // Lokaler Sprach-Server (Chatterbox)
  ttsServerInfo: (base) => ipcRenderer.invoke('tts:server:info', base),
  ttsServerSpeak: (base, body) => ipcRenderer.invoke('tts:server:speak', { base, body }),
  ttsServerUpload: (base, name, bytes) => ipcRenderer.invoke('tts:server:upload', { base, name, bytes }),
  ttsServerMultilingual: (base) => ipcRenderer.invoke('tts:server:multilingual', base),
  openTtsScripts: () => ipcRenderer.send('tts:server:scripts'),

  // Cloud-Anbieter (Claude / ChatGPT) und Cloud-Stimme
  keyStatus: () => ipcRenderer.invoke('keys:status'),
  setKey: (provider, key) => ipcRenderer.invoke('keys:set', { provider, key }),
  openaiModels: () => ipcRenderer.invoke('openai:models'),
  ttsCloudSpeak: (opts) => ipcRenderer.invoke('tts:cloud:speak', opts),

  // LM Studio
  lmStudioPrompts: () => ipcRenderer.invoke('lmstudio:prompts'),
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
