'use strict';

const path = require('path');

/**
 * Retorna o diretório base para dados graváveis (ceia.db, uploads/, baileys_auth/).
 *
 * Prioridades (da maior para a menor):
 *
 *  1. process.env.CEIA_DATA_DIR — override explícito (electron-main, testes)
 *
 *  2. Electron app.getPath('userData') — quando rodando dentro de um app Electron
 *     EMPACOTADO. Consultado diretamente via require('electron'), sem depender de
 *     que electron-main tenha setado a env var antes de server.js ser carregado.
 *     Isso elimina qualquer problema de timing entre os dois módulos.
 *
 *  3. Raiz do projeto — dev (npm start sem empacotamento) ou node server.js standalone.
 */
function getDataDir() {
  // 1. Override explícito
  if (process.env.CEIA_DATA_DIR) return process.env.CEIA_DATA_DIR;

  // 2. Dentro de um app Electron empacotado — usa userData diretamente
  try {
    // require('electron') funciona no processo main do Electron.
    // Lança exceção se rodando via "node server.js" puro (não-Electron).
    const { app } = require('electron');
    if (app && app.isPackaged) {
      return app.getPath('userData');
    }
  } catch (_) {
    // Não é contexto Electron — cai no fallback abaixo
  }

  // 3. Dev: raiz do projeto (src/lib → src → raiz)
  return path.join(__dirname, '..', '..');
}

module.exports = { getDataDir };
