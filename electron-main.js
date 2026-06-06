if (!globalThis.crypto) {
  globalThis.crypto = require('node:crypto').webcrypto;
}

require('dotenv').config();
const { app, BrowserWindow, Menu } = require('electron');
const path = require('path');

const EXPRESS_PORT = process.env.PORT || 3000;
let mainWindow;

function startExpressServer() {
  // No app empacotado, direciona todos os dados graváveis para userData
  // (fora do asar read-only). Em dev (npm start) não seta nada → caminhos locais.
  if (app.isPackaged) {
    process.env.CEIA_DATA_DIR = app.getPath('userData');
  }
  const { app: expressApp, onListening } = require('./server.js');
  return new Promise((resolve, reject) => {
    const server = expressApp.listen(EXPRESS_PORT, '127.0.0.1', async () => {
      console.log('[electron] Express up on http://127.0.0.1:' + EXPRESS_PORT);
      await onListening();
      resolve(server);
    });
    server.on('error', reject);
  });
}

// DESATIVADO: index.js (legacy) iniciava uma segunda instância Baileys (auth_info/)
// em paralelo com src/whatsapp/index.js (baileys_auth/), causando loop 440
// (connection replaced) porque ambas conectavam ao mesmo número e se derrubavam.
// O WhatsApp é agora gerenciado exclusivamente por src/whatsapp/index.js via server.js.
// eslint-disable-next-line no-unused-vars
function startBot() {
  // require('./index.js'); // ← NÃO reativar sem remover a instância duplicada
}

function createWindow() {
  Menu.setApplicationMenu(null);
  mainWindow = new BrowserWindow({
    width: 1280,
    height: 800,
    minWidth: 1024,
    minHeight: 640,
    icon: path.join(__dirname, 'build', 'icon.png'),
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });
  mainWindow.loadFile(path.join(__dirname, 'ui', 'index.html'));
  // mainWindow.webContents.openDevTools({ mode: 'detach' });
  mainWindow.webContents.on('before-input-event', (_e, input) => {
    if (input.type === 'keyDown' && input.key === 'F12') {
      mainWindow.webContents.toggleDevTools();
    }
  });
  mainWindow.on('closed', () => { mainWindow = null; });
}

app.whenReady().then(async () => {
  try {
    await startExpressServer();
  } catch (e) {
    console.error('[electron] Express falhou:', e);
  }
  createWindow();
  startBot(); // não bloqueia a janela

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});
