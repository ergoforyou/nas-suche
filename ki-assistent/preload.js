const { contextBridge, ipcRenderer } = require('electron');

const listeners = new Map();
ipcRenderer.on('llm:event', (_e, msg) => listeners.get(msg.id)?.(msg));

let commandHandler = () => {};
ipcRenderer.on('cmd', (_e, cmd, data) => commandHandler(cmd, data));
let syncHandler = null;
ipcRenderer.on('sync:req', async (_e, { rid, op, data }) => {
  try {
    if (!syncHandler) throw new Error('nicht bereit');
    ipcRenderer.send('sync:res', { rid, ok: true, result: await syncHandler(op, data) });
  } catch (e) {
    ipcRenderer.send('sync:res', { rid, ok: false, error: String(e?.message ?? e) });
  }
});
let cursorHandler = () => {};
ipcRenderer.on('avatar:cursor', (_e, p) => cursorHandler(p));

contextBridge.exposeInMainWorld('desktop', {
  edition: ipcRenderer.sendSync('app:edition'),
  area: ipcRenderer.sendSync('area:get'),
  areaSet: (name, patch) => ipcRenderer.invoke('area:set', name, patch),
  areaLoad: (name) => ipcRenderer.invoke('area:load', name),
  areaCopyKeys: () => ipcRenderer.invoke('area:copyKeys'),
  kbLoad: () => ipcRenderer.invoke('kb:load'),
  kbSave: (kb) => ipcRenderer.invoke('kb:save', kb),
  syncStart: () => ipcRenderer.invoke('sync:start'),
  syncStop: () => ipcRenderer.invoke('sync:stop'),
  syncServe: (token) => ipcRenderer.invoke('sync:serve', token),
  syncUnserve: () => ipcRenderer.invoke('sync:unserve'),
  nasReq: (req) => ipcRenderer.invoke('nas:req', req),
  nasSetPassword: (pw) => ipcRenderer.invoke('nas:setPassword', pw),
  nasHasPassword: () => ipcRenderer.invoke('nas:hasPassword'),
  onSyncRequest: (fn) => (syncHandler = fn),
  officePaste: (opts) => ipcRenderer.invoke('office:paste', opts),
  claudeHandoff: (opts) => ipcRenderer.invoke('claude:handoff', opts),
  weather: (opts) => ipcRenderer.invoke('weather:get', opts),
  news: (opts) => ipcRenderer.invoke('news:get', opts),
  traffic: (opts) => ipcRenderer.invoke('traffic:get', opts),
  officeCopy: (text) => ipcRenderer.invoke('office:copy', text),
  officeForeground: () => ipcRenderer.invoke('office:foreground'),
  officeState: () => ipcRenderer.invoke('office:state'),
  officeNotify: (n) => ipcRenderer.invoke('office:notify', n),
  avatarVisible: (on) => ipcRenderer.invoke('office:avatarVisible', on),
  googleUpcoming: (opts) => ipcRenderer.invoke('google:upcoming', opts),
  loadData: () => ipcRenderer.invoke('data:load'),
  saveData: (data) => ipcRenderer.invoke('data:save', data),
  minimize: () => ipcRenderer.send('win:minimize'),
  close: () => ipcRenderer.send('win:close'),
  show: () => ipcRenderer.send('win:show'),
  setFullScreen: (on) => ipcRenderer.send('win:fullscreen', on),
  quit: () => ipcRenderer.send('app:quit'),
  setCloseMode: (mode) => ipcRenderer.send('app:closeMode', mode),
  setAlwaysOnTop: (on) => ipcRenderer.send('win:alwaysOnTop', on),
  onCommand: (fn) => (commandHandler = fn),
  onAvatarCursor: (fn) => (cursorHandler = fn),

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
  backupSave: (name, value) => ipcRenderer.invoke('backup:save', name, value),
  backupList: () => ipcRenderer.invoke('backup:list'),
  backupRead: (name) => ipcRenderer.invoke('backup:read', name),
  backupDelete: (name) => ipcRenderer.invoke('backup:delete', name),
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
  openaiTtsModels: () => ipcRenderer.invoke('openai:ttsModels'),
  anthropicModels: () => ipcRenderer.invoke('anthropic:models'),
  ttsCloudSpeak: (opts) => ipcRenderer.invoke('tts:cloud:speak', opts),
  transcribeCloud: (audio, language, model, opts = {}) => ipcRenderer.invoke('stt:cloud', { audio, language, model, ...opts }),
  pickSaveTarget: (name) => ipcRenderer.invoke('file:pickTarget', { name }),
  writeSaveTarget: (target, bytes) => ipcRenderer.invoke('file:writeTarget', { target, bytes }),
  googleStatus: () => ipcRenderer.invoke('google:status'),
  googleConnect: (opts) => ipcRenderer.invoke('google:connect', opts),
  googleDisconnect: () => ipcRenderer.invoke('google:disconnect'),

  // LM Studio
  lmStudioPrompts: () => ipcRenderer.invoke('lmstudio:prompts'),
  listModels: (baseUrl) => ipcRenderer.invoke('llm:models', baseUrl),
  chat: (req, onEvent) => {
    listeners.set(req.id, (msg) => {
      onEvent(msg);
      if (msg.type === 'done' || msg.type === 'error') listeners.delete(req.id);
    });
    ipcRenderer.send('llm:chat', req);
  },
  abortChat: (id) => ipcRenderer.send('llm:abort', id),
  openFile: (file) => ipcRenderer.invoke('file:open', file),
});
