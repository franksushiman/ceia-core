const express = require('express');
const router = express.Router();
const multer = require('multer');
const { db } = require('../data/db');
const { ceiaEmitter } = require('../services/ceia-emitter');
const OpenAI = require('openai');

async function getOpenAIKey() {
  const fromDB = await get("SELECT value FROM config WHERE key = 'openai_key'").catch(() => null);
  if (fromDB?.value?.trim()) return fromDB.value.trim();
  return process.env.OPENAI_API_KEY || null;
}

function makeOpenAI(key) {
  return new OpenAI({ apiKey: key });
}

const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 20 * 1024 * 1024 } });

function run(sql, p = []) {
  return new Promise((res, rej) => db.run(sql, p, function(e) { e ? rej(e) : res(this); }));
}
function all(sql, p = []) {
  return new Promise((res, rej) => db.all(sql, p, (e, r) => e ? rej(e) : res(r)));
}
function get(sql, p = []) {
  return new Promise((res, rej) => db.get(sql, p, (e, r) => e ? rej(e) : res(r)));
}

function parseBRL(v) {
  if (typeof v === 'number') return v;
  if (!v) return 0;
  const s = String(v).replace(/R\$\s*/g, '').replace(/\s/g, '').replace(',', '.');
  const n = parseFloat(s);
  return isNaN(n) ? 0 : n;
}

const TOOL = {
  type: 'function',
  function: {
    name: 'estruturar_cardapio',
    description: 'Extrai categorias e produtos do cardápio fornecido e devolve estruturado.',
    parameters: {
      type: 'object',
      required: ['categorias'],
      properties: {
        categorias: {
          type: 'array',
          items: {
            type: 'object',
            required: ['nome', 'produtos'],
            properties: {
              nome: { type: 'string' },
              produtos: {
                type: 'array',
                items: {
                  type: 'object',
                  required: ['nome', 'preco'],
                  properties: {
                    nome: { type: 'string' },
                    descricao: { type: 'string' },
                    preco: { type: 'number', description: 'Preço base. Se houver variações, use o menor preço ou 0.' },
                    variacoes: {
                      type: 'array',
                      description: 'Variações de preço (tamanhos, porções, etc). Extraia se existirem.',
                      items: {
                        type: 'object',
                        required: ['nome', 'preco'],
                        properties: {
                          nome: { type: 'string', description: 'Ex: Pequeno, Médio, Grande, 500ml, Individual' },
                          preco: { type: 'number' },
                        },
                      },
                    },
                    adicionais_grupos: {
                      type: 'array',
                      description: 'Grupos de adicionais/complementos aplicáveis a este produto. Só inclua se estiver claramente no cardápio.',
                      items: {
                        type: 'object',
                        required: ['nome'],
                        properties: {
                          nome: { type: 'string', description: 'Nome do grupo (ex: "Molhos", "Acompanhamentos")' },
                          obrigatorio: { type: 'boolean', description: 'true se o cliente DEVE escolher' },
                          max_escolhas: { type: 'integer', description: 'Máximo de opções que o cliente pode escolher (padrão 1)' },
                          opcoes: {
                            type: 'array',
                            description: 'Itens/opções dentro do grupo',
                            items: {
                              type: 'object',
                              required: ['nome'],
                              properties: {
                                nome: { type: 'string' },
                                preco: { type: 'number', description: 'Custo adicional em reais. 0 se incluso.' },
                              },
                            },
                          },
                        },
                      },
                    },
                  },
                },
              },
            },
          },
        },
      },
    },
  },
};

const SYSTEM = `Você é um assistente que extrai cardápios de restaurantes de textos ou imagens.
Identifique categorias (ex: Pizzas, Bebidas, Sobremesas) e dentro de cada categoria liste os produtos com nome, descrição curta (1 linha) e preço em reais (number, sem R$).
Se não houver categorias explícitas, agrupe em "Cardápio".
Se um preço estiver ilegível ou ausente, use 0.

REGRA IMPORTANTE — VARIAÇÕES DE TAMANHO:
Quando um produto tem preços por tamanho, porção ou versão (ex: "Pequena R$ 32,00 | Média R$ 45,00 | Grande R$ 58,00 | Família R$ 75,00", ou "P R$32 / M R$45 / G R$58", ou "300ml / 500ml / 1L"), NÃO coloque um preço único. Em vez disso:
  1. Preencha o array variacoes com cada tamanho: [{nome:"Pequena", preco:32}, {nome:"Média", preco:45}, ...]
  2. Deixe o campo preco do produto como 0.
Reconheça tanto "Pequena/Média/Grande/Família" quanto "P/M/G/F" quanto "Individual/Família" quanto volumes como "300ml/500ml".

Se houver grupos de adicionais/complementos mencionados (ex: "Acompanhamentos", "Molhos à escolha", "Bordas recheadas"), inclua em adicionais_grupos com nome, obrigatorio, max_escolhas e as opções (itens) de cada grupo com nome e preço adicional (0 se incluso).
Não invente produtos que não aparecem. Não traduza, não modifique nomes.`;

router.post('/', upload.single('arquivo'), async (req, res) => {
  const texto = req.body?.texto?.trim();
  const arquivo = req.file;

  if (!texto && !arquivo) {
    return res.status(400).json({ error: 'Forneça texto ou arquivo' });
  }
  const openaiKey = await getOpenAIKey();
  if (!openaiKey) {
    return res.status(400).json({ error: 'Configure sua chave OpenAI em Configurações → Chaves de API' });
  }
  const openai = makeOpenAI(openaiKey);

  let userContent;

  if (arquivo) {
    const mime = arquivo.mimetype;
    if (mime === 'application/pdf') {
      // Extrai texto do PDF
      try {
        const pdfParse = require('pdf-parse');
        const data = await pdfParse(arquivo.buffer);
        const pdfText = data.text?.trim();
        if (!pdfText || pdfText.length < 20) {
          return res.status(400).json({ error: 'PDF sem texto extraível. Use a aba Foto ou cole o texto manualmente.' });
        }
        userContent = `Cardápio extraído de PDF:\n\n${pdfText}`;
      } catch(e) {
        return res.status(502).json({ error: 'Falha ao ler PDF: ' + e.message });
      }
    } else {
      // Imagem — envia como vision
      const b64 = arquivo.buffer.toString('base64');
      userContent = [
        { type: 'text', text: 'Extraia o cardápio desta imagem:' },
        { type: 'image_url', image_url: { url: `data:${mime};base64,${b64}`, detail: 'high' } },
      ];
    }
  } else {
    userContent = texto;
  }

  let completion;
  try {
    completion = await openai.chat.completions.create({
      model: 'gpt-4o',
      max_tokens: 4000,
      tool_choice: 'required',
      tools: [TOOL],
      messages: [
        { role: 'system', content: SYSTEM },
        { role: 'user', content: userContent },
      ],
    });
  } catch(e) {
    console.error('[IMPORT-IA] OpenAI error:', e.message);
    return res.status(502).json({ error: 'Falha ao processar com IA, tente novamente' });
  }

  const toolCall = completion.choices[0]?.message?.tool_calls?.[0];
  if (!toolCall) {
    return res.status(502).json({ error: 'IA não retornou estrutura válida' });
  }

  let parsed;
  try { parsed = JSON.parse(toolCall.function.arguments); }
  catch(e) { return res.status(502).json({ error: 'Resposta da IA inválida' }); }

  // Persiste em transação
  let catsCriadas = 0, catsReusadas = 0, prodsCriados = 0, varsCriadas = 0;

  try {
    const existentes = await all('SELECT id, LOWER(nome) as nome_lower FROM categorias');
    const mx = await get('SELECT MAX(ordem) as m FROM categorias');
    let proximaOrdem = (mx?.m || 0) + 1;

    // Pre-load adicionais existentes para reusar/criar por nome
    const adicionaisExistentes = await all('SELECT id, LOWER(nome) as nome_lower FROM adicionais');
    const adicionaisMap = {}; // nome_lower → id
    for (const a of adicionaisExistentes) adicionaisMap[a.nome_lower] = a.id;

    for (const catData of parsed.categorias || []) {
      const nomeLower = (catData.nome || '').toLowerCase().trim();
      const existente = existentes.find(e => e.nome_lower === nomeLower);
      let catId;

      if (existente) {
        catId = existente.id;
        catsReusadas++;
      } else {
        const r = await run('INSERT INTO categorias (nome, ordem) VALUES (?, ?)', [catData.nome.trim(), proximaOrdem++]);
        catId = r.lastID;
        catsCriadas++;
      }

      for (const prod of catData.produtos || []) {
        const vars = (prod.variacoes || []).filter(v => v?.nome?.trim());
        const temVars = vars.length > 0;
        const r = await run(
          'INSERT INTO produtos (categoria_id, nome, descricao, preco, tem_variacoes, ativo) VALUES (?, ?, ?, ?, ?, 1)',
          [catId, prod.nome?.trim() || 'Sem nome', prod.descricao?.trim() || null,
           temVars ? 0 : parseBRL(prod.preco), temVars ? 1 : 0]
        );
        const prodId = r.lastID;
        prodsCriados++;

        // Insert variações
        for (let vi = 0; vi < vars.length; vi++) {
          const v = vars[vi];
          await run(
            'INSERT INTO variacoes (produto_id, nome, preco, ordem) VALUES (?, ?, ?, ?)',
            [prodId, v.nome.trim(), parseBRL(v.preco), vi]
          );
          varsCriadas++;
        }

        // Resolve adicionais_grupos by name → id, creating new groups + opcoes if needed
        const grupoIds = [];
        for (const grupoData of (prod.adicionais_grupos || [])) {
          // Suporta tanto objeto {nome, opcoes, ...} quanto string legada
          const nomeGrupo = typeof grupoData === 'string' ? grupoData : grupoData?.nome;
          const nl = (nomeGrupo || '').toLowerCase().trim();
          if (!nl) continue;

          let grupoId;
          if (adicionaisMap[nl] !== undefined) {
            grupoId = adicionaisMap[nl];
          } else {
            const obrig  = grupoData?.obrigatorio ? 1 : 0;
            const maxEsc = parseInt(grupoData?.max_escolhas) || 1;
            const ar = await run(
              'INSERT INTO adicionais (nome, tipo, obrigatorio, min_escolhas, max_escolhas) VALUES (?, ?, ?, 0, ?)',
              [nomeGrupo.trim(), 'multiplo', obrig, maxEsc]
            );
            grupoId = ar.lastID;
            adicionaisMap[nl] = grupoId;

            // Insere as opções do grupo
            for (const op of (grupoData?.opcoes || [])) {
              const opNome = (op?.nome || '').trim();
              if (!opNome) continue;
              await run(
                'INSERT INTO adicionais_opcoes (adicional_id, nome, preco) VALUES (?, ?, ?)',
                [grupoId, opNome, parseBRL(op?.preco ?? 0)]
              );
            }
          }
          grupoIds.push(grupoId);
        }
        if (grupoIds.length > 0) {
          await run('UPDATE produtos SET adicionais_grupos = ? WHERE id = ?',
            [JSON.stringify(grupoIds), prodId]);
        }
      }
    }

    ceiaEmitter.emit('ceia:cardapio-changed');
    res.json({ ok: true, categorias_criadas: catsCriadas, produtos_criados: prodsCriados, categorias_reusadas: catsReusadas, variacoes_criadas: varsCriadas });
  } catch(e) {
    console.error('[IMPORT-IA] DB error:', e.message);
    res.status(500).json({ error: 'Falha ao salvar no banco: ' + e.message });
  }
});

module.exports = router;
