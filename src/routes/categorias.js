const express = require('express');
const router = express.Router();
const { db } = require('../data/db');
const { agendarSyncVitrine } = require('../services/ceia-vitrine');

function run(sql, p = []) {
  return new Promise((res, rej) => db.run(sql, p, function(e) { e ? rej(e) : res(this); }));
}
function all(sql, p = []) {
  return new Promise((res, rej) => db.all(sql, p, (e, r) => e ? rej(e) : res(r)));
}
function get(sql, p = []) {
  return new Promise((res, rej) => db.get(sql, p, (e, r) => e ? rej(e) : res(r)));
}
function emit(acao) { console.log(`[VITRINE] sync automático após ${acao}`); agendarSyncVitrine(acao); }

// GET /api/categorias
router.get('/', async (_req, res) => {
  try { res.json(await all('SELECT * FROM categorias WHERE ativo = 1 ORDER BY ordem, id')); }
  catch(e) { res.status(500).json({ error: e.message }); }
});

// GET /api/categorias/:id/contar
router.get('/:id/contar', async (req, res) => {
  try {
    const r = await get('SELECT COUNT(*) as count FROM produtos WHERE categoria_id = ? AND ativo = 1', [req.params.id]);
    res.json({ count: r ? r.count : 0 });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// POST /api/categorias
router.post('/', async (req, res) => {
  const nome = (req.body?.nome || '').trim();
  if (!nome) return res.status(400).json({ error: 'Nome obrigatório' });
  try {
    const mx = await get('SELECT MAX(ordem) as m FROM categorias');
    const ordem = (mx?.m || 0) + 1;
    const r = await run('INSERT INTO categorias (nome, ordem) VALUES (?, ?)', [nome, ordem]);
    const cat = await get('SELECT * FROM categorias WHERE id = ?', [r.lastID]);
    emit('criar-categoria');
    res.status(201).json(cat);
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// PATCH /api/categorias/:id
router.patch('/:id', async (req, res) => {
  const { id } = req.params;
  const body = req.body || {};
  try {
    const cat = await get('SELECT * FROM categorias WHERE id = ?', [id]);
    if (!cat) return res.status(404).json({ error: 'Não encontrada' });

    // Allowed patchable fields
    const allowed = ['nome','oculto','descricao','impressora_id','horarios_especificos','horarios'];
    const sets = [];
    const vals = [];

    for (const key of allowed) {
      if (!(key in body)) continue;
      if (key === 'nome') {
        sets.push('nome = ?'); vals.push(String(body.nome).trim());
      } else if (key === 'oculto') {
        sets.push('oculto = ?'); vals.push(body.oculto ? 1 : 0);
      } else if (key === 'horarios_especificos') {
        sets.push('horarios_especificos = ?'); vals.push(body.horarios_especificos ? 1 : 0);
      } else {
        sets.push(`${key} = ?`); vals.push(body[key] ?? null);
      }
    }

    if (sets.length === 0) return res.status(400).json({ error: 'Nenhum campo para atualizar' });
    vals.push(id);
    await run(`UPDATE categorias SET ${sets.join(', ')} WHERE id = ?`, vals);
    const updated = await get('SELECT * FROM categorias WHERE id = ?', [id]);
    emit('editar-categoria');
    res.json(updated);
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// DELETE /api/categorias/:id
router.delete('/:id', async (req, res) => {
  const { id } = req.params;
  try {
    const cat = await get('SELECT * FROM categorias WHERE id = ?', [id]);
    if (!cat) return res.status(404).json({ error: 'Não encontrada' });
    await run('DELETE FROM produtos WHERE categoria_id = ?', [id]);
    await run('DELETE FROM categorias WHERE id = ?', [id]);
    emit('excluir-categoria');
    res.json({ ok: true });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// POST /api/categorias/reorder
router.post('/reorder', async (req, res) => {
  const { ids } = req.body || {};
  if (!Array.isArray(ids)) return res.status(400).json({ error: 'ids deve ser array' });
  try {
    for (let i = 0; i < ids.length; i++) {
      await run('UPDATE categorias SET ordem = ? WHERE id = ?', [i, ids[i]]);
    }
    emit('reordenar-categoria');
    res.json({ ok: true });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// POST /api/categorias/:id/duplicar
router.post('/:id/duplicar', async (req, res) => {
  const { id } = req.params;
  try {
    const cat = await get('SELECT * FROM categorias WHERE id = ?', [id]);
    if (!cat) return res.status(404).json({ error: 'Não encontrada' });
    const mx = await get('SELECT MAX(ordem) as m FROM categorias');
    const r = await run(
      'INSERT INTO categorias (nome, ordem, oculto) VALUES (?, ?, ?)',
      [`${cat.nome} (cópia)`, (mx?.m || 0) + 1, cat.oculto || 0]
    );
    const novaId = r.lastID;
    const prods = await all('SELECT * FROM produtos WHERE categoria_id = ?', [id]);
    for (const p of prods) {
      await run(
        'INSERT INTO produtos (categoria_id, nome, descricao, preco, preco_promocional, foto_url, ordem, ativo) VALUES (?,?,?,?,?,?,?,?)',
        [novaId, p.nome, p.descricao, p.preco, p.preco_promocional, p.foto_url, p.ordem || 0, p.ativo ?? 1]
      );
    }
    const nova = await get('SELECT * FROM categorias WHERE id = ?', [novaId]);
    emit('duplicar-categoria');
    res.status(201).json(nova);
  } catch(e) { res.status(500).json({ error: e.message }); }
});

module.exports = router;
