const { contextBridge } = require('electron');

contextBridge.exposeInMainWorld('CEIA', {
  apiBase: 'http://127.0.0.1:' + (process.env.PORT || 3000),
});
