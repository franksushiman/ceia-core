'use strict';

const path = require('path');

/**
 * Retorna o diretório base para dados graváveis (ceia.db, uploads/, baileys_auth/).
 *
 * - App empacotado (Electron):
 *     electron-main.js seta CEIA_DATA_DIR = app.getPath('userData') antes de
 *     subir o servidor, então este módulo retorna esse caminho gravável.
 *
 * - Dev (npm start sem app.isPackaged) ou node server.js:
 *     CEIA_DATA_DIR não está setado → retorna a raiz do projeto
 *     (2 níveis acima de src/lib/), comportamento idêntico ao original.
 */
function getDataDir() {
  if (process.env.CEIA_DATA_DIR) return process.env.CEIA_DATA_DIR;
  // src/lib/paths.js → src/lib → src → raiz do projeto
  return path.join(__dirname, '..', '..');
}

module.exports = { getDataDir };
