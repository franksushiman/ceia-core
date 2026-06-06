/**
 * CEIA OS — Agente de IA WhatsApp (WA-2a: Motor de texto)
 *
 * PRINCÍPIOS (NÃO REMOVER):
 * 1. O sistema só RESPONDE. Nunca inicia conversa com quem não falou primeiro.
 * 2. Mensagens do próprio número (fromMe) são IGNORADAS — evita loop de IA.
 * 3. A IA NUNCA inventa preço ou item. Tudo vem das tools, calculado pelo código.
 * 4. Killswitch: se ia_ativa='0', o agente fica completamente mudo.
 * 5. Modo manual por conversa: se modo_manual=1 na tabela conversas_wa, IA não responde.
 */

'use strict';

const { OpenAI }           = require('openai');
const db                   = require('../data/db');
const { ceiaEmitter }      = require('../services/ceia-emitter');
const { enviarMensagemWhatsApp, onMensagemRecebida } = require('./index');
const { getClienteWA, upsertClienteWA } = require('../data/db');

// ── Lazy loader de downloadMediaMessage (Baileys ESM) ────────────────────────
let _downloadMediaMessage = null;
async function _getDownloadMedia() {
  if (_downloadMediaMessage) return _downloadMediaMessage;
  const m = await import('@whiskeysockets/baileys');
  _downloadMediaMessage = m.downloadMediaMessage;
  return _downloadMediaMessage;
}

// ── Cache de cardápio (TTL 5 min) ────────────────────────────────────────────
let _cardapioCache    = null;
let _cardapioCacheAt  = 0;
const CACHE_TTL_MS    = 90 * 1000; // 90 s — zonas excluídas propagam rápido

// ── Resolve URL pública da vitrine ────────────────────────────────────────────
// Fonte da verdade: campo `url` retornado pelo Hub no sync → salvo em `vitrine_url`.
// Override manual: `cardapio_url` (Configurações → IA) tem prioridade se preenchido.
function _resolverVitrineUrl(cfg) {
  return cfg.cardapio_url || cfg.vitrine_url || null;
}

async function _getCardapio() {
  if (_cardapioCache && Date.now() - _cardapioCacheAt < CACHE_TTL_MS) return _cardapioCache;
  const [produtos, categorias, bairros, zonas] = await Promise.all([
    db.getProdutosParaAgente(),
    db.getCategorias(),
    db.getBairros(),
    db.getZonas(),
  ]);
  _cardapioCache   = { produtos, categorias, bairros, zonas };
  _cardapioCacheAt = Date.now();
  return _cardapioCache;
}

// ── Carrinhos em memória ──────────────────────────────────────────────────────
// carrinho: [{ idx, produto_id, nome, categoria, variacao, quantidade, preco_unit, adicionais_str, subtotal_item }]
const _carrinhos      = new Map(); // numero → []
// ── Estado de promoções por sessão ───────────────────────────────────────────
const _promoOferecida = new Map(); // numero → true (promo já apresentada nesta sessão)
const _cupomAceitoMap = new Map(); // numero → promoObj (cupom validado pronto para fechar_pedido)
// ── Estado de cobrança Asaas por sessão ──────────────────────────────────────
// Evita duplicação: quando gerar_cobranca_asaas já foi chamado nesta sessão,
// reutiliza a cobrança existente em vez de criar uma nova.
// { id, link, valor, forma, qr_code, status: 'pendente'|'fechado' }
const _asaasCobrancaMap = new Map(); // numero → cobrancaObj
// ── Cache de resultado de definir_entrega por sessão ─────────────────────────
// fechar_pedido usa este cache em vez de recalcular geocoding independentemente.
// { taxa, bairroStr, lat, lng }
const _entregaMap = new Map(); // numero → { taxa, bairroStr, lat, lng }
const _avaliacoesPendentes = new Map(); // numero → { pedido_id, at } — TTL 24 h
let _lojaUFCache = null; // UF do estado da loja — derivado 1 vez por reverse geocode, persistido em config

function _getCarrinho(numero) {
  if (!_carrinhos.has(numero)) _carrinhos.set(numero, []);
  return _carrinhos.get(numero);
}

/**
 * Consolida linhas duplicadas num carrinho: itens com mesmo produto_id + variacao + adicionais
 * são somados em uma única linha. Usado como rede de segurança em ver_carrinho e fechar_pedido.
 */
function _consolidarCarrinho(carrinho) {
  const mapa = new Map();
  for (const it of carrinho) {
    const key = `${it.produto_id}||${it.variacao || ''}||${it.adicionais_str || ''}`;
    if (mapa.has(key)) {
      const ex   = mapa.get(key);
      const novaQtd = ex.quantidade + it.quantidade;
      mapa.set(key, { ...ex, quantidade: novaQtd, subtotal_item: ex.preco_unit * novaQtd });
    } else {
      mapa.set(key, { ...it });
    }
  }
  return Array.from(mapa.values());
}

// ── Checagens de janela/zona para promoções (Fase 3) ─────────────────────────
/** Retorna true se a promoção está válida no dia/horário atual. */
function _promoNaJanela(promo) {
  if (Array.isArray(promo.dias_semana) && promo.dias_semana.length > 0) {
    const diasMap = ['dom', 'seg', 'ter', 'qua', 'qui', 'sex', 'sab'];
    const diaHoje = diasMap[new Date().getDay()];
    if (!promo.dias_semana.includes(diaHoje)) return false;
  }
  if (promo.hora_inicio || promo.hora_fim) {
    const now = new Date();
    const hm  = `${String(now.getHours()).padStart(2,'0')}:${String(now.getMinutes()).padStart(2,'0')}`;
    if (promo.hora_inicio && hm < promo.hora_inicio) return false;
    if (promo.hora_fim   && hm > promo.hora_fim)   return false;
  }
  return true;
}

/** Retorna true se a zona NÃO está na lista de exclusão da promoção. */
function _promoPermiteZona(promo, zona) {
  if (!Array.isArray(promo.zonas_excluidas) || promo.zonas_excluidas.length === 0) return true;
  if (!zona) return true;
  return !promo.zonas_excluidas.includes(zona);
}

// ── Texto de benefício formatado ──────────────────────────────────────────────
function _beneficioTexto(promo) {
  if (promo.beneficio_tipo === 'frete_gratis')        return 'frete grátis';
  if (promo.beneficio_tipo === 'desconto_percentual') return `${promo.beneficio_valor}% de desconto`;
  if (promo.beneficio_tipo === 'desconto_valor')      return `${_fmtBRL(promo.beneficio_valor)} de desconto`;
  return promo.beneficio_tipo;
}

// ── Variações de mensagens fixas (anti-ban: evita texto idêntico repetido) ───
const MSGS_AUDIO_ERRO = [
  'Não consegui entender o áudio, pode mandar por escrito ou tentar de novo? 😊',
  'Opa, não entendi o áudio direito. Pode repetir por escrito ou reenviar?',
  'Tive dificuldade com esse áudio. Pode tentar novamente ou mandar por texto?',
];
const MSGS_MIDIA_INVALIDA = [
  'No momento consigo atender por texto ou áudio. Pode me mandar sua mensagem assim? 😊',
  'Por enquanto só trabalho com texto ou mensagem de voz. Pode me escrever? 😊',
  'Ainda não consigo ler arquivos ou imagens. Me manda por texto ou áudio, tá? 😊',
];
const MSGS_CHAMADO_ABERTO = [
  'Vou te transferir para um de nossos atendentes, um momento 😊',
  'Claro! Vou chamar um atendente para você agora. Um segundo 😊',
  'Entendido! Estou te conectando com um atendente. Já já chega alguém 😊',
];
function _pick(arr) { return arr[Math.floor(Math.random() * arr.length)]; }

// ── Comportamento humano: presença + delay + leitura (anti-ban) ───────────────
async function _enviarComPresenca(numero, jid, texto, sock, msgKey) {
  // Marca mensagem como lida — comportamento humano natural
  if (sock && msgKey) {
    try { await sock.readMessages([msgKey]); } catch (_) {}
  }
  // Delay proporcional: base 1 s + 30 ms/char, teto 4 s
  const delay = Math.min(1000 + Math.round(texto.length * 30), 4000);
  // Envia "digitando..." para o chat
  if (sock && jid) {
    try { await sock.sendPresenceUpdate('composing', jid); } catch (_) {}
  }
  await new Promise(r => setTimeout(r, delay));
  if (sock && jid) {
    try { await sock.sendPresenceUpdate('paused', jid); } catch (_) {}
  }
  await enviarMensagemWhatsApp(numero, texto);
}

// ── Transcrição de áudio via Whisper ─────────────────────────────────────────
async function _transcreverAudio(msg, sock, openai) {
  const downloadMediaMessage = await _getDownloadMedia();
  const buffer = await downloadMediaMessage(
    msg,
    'buffer',
    {},
    {
      logger:          { level:'silent', fatal:()=>{}, error:()=>{}, warn:()=>{}, info:()=>{}, debug:()=>{}, trace:()=>{}, child:function(){return this} },
      reuploadRequest: sock.updateMediaMessage,
    }
  );
  const os      = require('os');
  const fs      = require('fs');
  const path    = require('path');
  const tmpPath = path.join(os.tmpdir(), `wa_audio_${Date.now()}_${Math.random().toString(36).slice(2,8)}.ogg`);
  fs.writeFileSync(tmpPath, buffer);
  try {
    const tr = await openai.audio.transcriptions.create({
      file:     fs.createReadStream(tmpPath),
      model:    'whisper-1',
      language: 'pt',
    });
    return (tr.text || '').trim();
  } finally {
    try { fs.unlinkSync(tmpPath); } catch (_) {}
  }
}

// ── Utilitários ───────────────────────────────────────────────────────────────
function _normalizar(str) {
  return String(str || '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase().trim();
}

function _fmtBRL(v) {
  return 'R$ ' + Number(v || 0).toFixed(2).replace('.', ',');
}

// ── Busca fuzzy ───────────────────────────────────────────────────────────────

/** Levenshtein iterativo O(m*n) — bom para strings curtas (tokens de busca) */
function _levenshtein(a, b) {
  if (a === b) return 0;
  if (!a.length) return b.length;
  if (!b.length) return a.length;
  let prev = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 0; i < a.length; i++) {
    const curr = [i + 1];
    for (let j = 0; j < b.length; j++) {
      curr[j + 1] = a[i] === b[j] ? prev[j] : 1 + Math.min(prev[j], prev[j + 1], curr[j]);
    }
    prev = curr;
  }
  return prev[b.length];
}

/**
 * Mapa de sinônimos normalizados (sem acento, minúsculas).
 * Chave → valor: o valor é o token "canônico" que também entra na busca.
 * Extensível: adicione linhas conforme o cardápio do cliente.
 */
const _SINONIMOS_BUSCA = new Map([
  // Refrigerantes / bebidas
  ['coca',      'refrigerante'], ['cocacola',   'refrigerante'],
  ['coca-cola', 'refrigerante'], ['pepsi',       'refrigerante'],
  ['refri',     'refrigerante'], ['guarana',     'refrigerante'],
  ['soda',      'refrigerante'], ['lata',        'refrigerante'],
  ['energetico','energetico'],
  // Grafias aproximadas comuns
  ['spice',     'spicy'],        ['espicy',      'spicy'],
  ['salmon',    'salmao'],       ['tuna',        'atum'],
  ['shrimp',    'camarao'],      ['camarao',     'camarao'],
  // Diminutivos / abreviações de tamanho
  ['porcao',    'porcao'],       ['porcaozinha', 'pequena'],
  ['pequeno',   'pequena'],      ['grande',      'grande'],
  ['p',         'pequena'],      ['g',           'grande'],
]);

/**
 * Tokeniza e expande sinônimos o termo de busca.
 * "refrigerante lata" → ['refrigerante', 'lata', 'refrigerante'] → dedupado → ['refrigerante', 'lata']
 * "edamame spice"     → ['edamame', 'spice', 'spicy']
 */
function _tokensBusca(termo) {
  const base = _normalizar(termo).split(/\s+/).filter(t => t.length >= 2);
  const expandido = base.flatMap(t => {
    const syn = _SINONIMOS_BUSCA.get(t);
    return syn && syn !== t ? [t, syn] : [t];
  });
  return [...new Set(expandido)];
}

/**
 * Retorna score 0–100 de quanto os tokens batem no texto alvo.
 * Usa: substring, token-exact, Levenshtein ≤ 1 (tokens ≥ 4 chars), Levenshtein ≤ 2 (tokens ≥ 6 chars).
 */
function _scoreFuzzy(tokens, alvo) {
  if (!tokens.length || !alvo) return 0;
  const alvoNorm   = _normalizar(alvo);
  const alvoTokens = alvoNorm.split(/\s+/).filter(Boolean);
  let pontos = 0;
  for (const t of tokens) {
    if (alvoNorm.includes(t)) { pontos += 1; continue; }                             // substring exato
    if (alvoTokens.some(at => at === t)) { pontos += 1; continue; }                 // token exato
    if (t.length >= 4 && alvoTokens.some(at => at.length >= 3 && _levenshtein(t, at) <= 1)) {
      pontos += 0.8; continue;                                                        // 1 edição (spice→spicy)
    }
    if (t.length >= 6 && alvoTokens.some(at => at.length >= 4 && _levenshtein(t, at) <= 2)) {
      pontos += 0.5; continue;                                                        // 2 edições (typo maior)
    }
  }
  return (pontos / tokens.length) * 100;
}

/** Score composto de um produto: nome (peso 1.0) + descrição (0.6) + categoria (0.5). */
function _scoreProduto(tokens, produto) {
  return Math.max(
    _scoreFuzzy(tokens, produto.nome)       * 1.0,
    _scoreFuzzy(tokens, produto.descricao)  * 0.6,
    _scoreFuzzy(tokens, produto.categoria)  * 0.5,
  );
}

// ── Lookup de zona (portado de server.js) ────────────────────────────────────
function _pointInPolygon(lat, lng, pontos) {
  let inside = false;
  const n = pontos.length;
  for (let i = 0, j = n - 1; i < n; j = i++) {
    const xi = pontos[i].lng, yi = pontos[i].lat;
    const xj = pontos[j].lng, yj = pontos[j].lat;
    if (((yi > lat) !== (yj > lat)) && (lng < (xj - xi) * (lat - yi) / (yj - yi) + xi)) inside = !inside;
  }
  return inside;
}
function _haversine(lat1, lng1, lat2, lng2) {
  const R = 6371000;
  const dPhi = (lat2 - lat1) * Math.PI / 180, dLam = (lng2 - lng1) * Math.PI / 180;
  const a = Math.sin(dPhi / 2) ** 2 + Math.cos(lat1 * Math.PI / 180) * Math.cos(lat2 * Math.PI / 180) * Math.sin(dLam / 2) ** 2;
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}
function _pontoNaZona(lat, lng, zona) {
  try {
    const geo = typeof zona.geometria === 'string' ? JSON.parse(zona.geometria) : zona.geometria;
    if (zona.tipo === 'poligono') return _pointInPolygon(lat, lng, geo);
    if (zona.tipo === 'circulo')  return _haversine(lat, lng, geo.center.lat, geo.center.lng) <= geo.radius;
  } catch (_) {}
  return false;
}

// ── Store open check ──────────────────────────────────────────────────────────
function _isLojaAberta(cfg) {
  const dias = ['dom', 'seg', 'ter', 'qua', 'qui', 'sex', 'sab'];
  const d    = dias[new Date().getDay()];
  if (cfg[`horario_${d}_ativo`] !== '1') return false;
  const ab   = cfg[`horario_${d}_ab`] || '00:00';
  const fe   = cfg[`horario_${d}_fe`] || '23:59';
  const now  = new Date();
  const hm   = `${String(now.getHours()).padStart(2,'0')}:${String(now.getMinutes()).padStart(2,'0')}`;
  return hm >= ab && hm <= fe;
}

// ── System Prompt ─────────────────────────────────────────────────────────────
async function _buildSystemPrompt(cfg, cardapio, cliente) {
  const lojaAberta   = _isLojaAberta(cfg);
  const nomeLoja     = cfg.loja_nome || 'nossa loja';
  const saudacao     = cfg.ia_saudacao || '';
  const tom          = cfg.ia_tom || 'amigavel';

  const tonMap = {
    amigavel:     'descontraído e caloroso, como um atendente simpático — não formal demais, não forçado',
    formal:       'educado e profissional, linguagem mais cuidada mas ainda humana',
    informal:     'bem informal e leve, como um amigo do bairro',
    profissional: 'direto e eficiente, sem enrolação',
  };
  const instrucaoTom = tonMap[tom] || tonMap.amigavel;

  const categorias = cardapio.categorias.map(c => c.nome).join(', ');

  const pagamentos = [
    cfg.pag_dinheiro      === '1' ? 'Dinheiro' : null,
    cfg.pag_cartao        === '1' ? 'Cartão na entrega' : null,
    cfg.pag_pix_direto    === '1' ? 'PIX' : null,
    cfg.pag_cartao_online === '1' ? 'Cartão online (link de pagamento)' : null,
  ].filter(Boolean).join(', ') || 'consulte o atendente';

  const statusLoja = lojaAberta
    ? '🟢 A loja está ABERTA agora.'
    : '🔴 A loja está FECHADA no momento. Mesmo assim, registre o pedido se o cliente quiser — ele será processado quando abrirmos.';

  // Contexto do cliente recorrente (injetado só quando existe)
  const ctxCliente = cliente
    ? `\nCLIENTE RECORRENTE — Nome: ${cliente.nome || '(não informado)'}, já fez ${cliente.total_pedidos || 0} pedido(s). Não pergunte o nome, você já sabe.`
    : '';

  // Instrução de entrega: cliente com endereço salvo → pergunta se confirma o mesmo
  const instrucaoEntrega = (cliente?.ultimo_endereco)
    ? `Se o cliente confirmar que é no mesmo endereço ("sim", "mesmo", "igual"), chame definir_entrega com o endereço EXATO: "${cliente.ultimo_endereco}". Se quiser outro lugar, peça o novo endereço ou nome do lugar.`
    : `Peça o endereço de entrega — pode ser rua+número, nome de estabelecimento ("bar do banana", "supermercado koch") ou pin de localização 📍. QUALQUER referência de destino deve ser passada para definir_entrega.`;

  // Vitrine web (link com fotos do cardápio)
  const vitrineUrl = _resolverVitrineUrl(cfg);
  if (vitrineUrl) {
    console.log('[AGENTE] cardápio: vitrine_url=' + vitrineUrl + ' → enviando link');
  } else {
    console.log('[AGENTE] cardápio: sem vitrine configurada → listando categorias');
  }
  const instrucaoVitrine = vitrineUrl
    ? `Temos cardápio online com fotos em: ${vitrineUrl}`
    : '';

  return `Você é o atendente de "${nomeLoja}" no WhatsApp.
${statusLoja}
${saudacao ? `\nSaudação padrão: "${saudacao}"\n` : ''}
Tom: ${instrucaoTom}.
Formas de pagamento: ${pagamentos}.
${ctxCliente}

COMO VOCÊ SE COMUNICA:
Você é um atendente humano de delivery — simpático, ágil e prestativo. Não um menu automático.
- Frases curtas e naturais. Varie as aberturas, não comece toda resposta igual.
- Emojis com moderação: no máximo 1 por mensagem, às vezes nenhum.
- Não numere listas como catálogo a toda hora. Para poucos itens, use vírgulas ou travessão.
- Quando descrever um prato, use o campo "descricao" que a ferramenta retorna e fale de forma apetitosa. Se a descrição estiver vazia, descreva naturalmente pelo nome (ex: temaki de salmão → mencione o salmão fresco). NUNCA diga "não consigo descrever" ou "não tenho essa informação" — contorne com naturalidade.
- Pode comentar com entusiasmo genuíno: "esse é um dos mais pedidos", "fica muito bom", "recomendo".
- NUNCA diga "Desculpe, não consigo..." — se não sabe algo, contorne. Ex: "Não tenho detalhes sobre isso, mas posso te ajudar com o pedido".
- Varie os fechamentos: às vezes pergunta se quer mais alguma coisa, às vezes vai direto ao próximo passo, às vezes só confirma.

VALORES DO PEDIDO — REGRA ABSOLUTA:
Você NUNCA calcula, soma ou estima preços. O valor que você mostra ao cliente DEVE ser exatamente o que as ferramentas retornam.
- adicionar_item retorna carrinho_completo e subtotal_real após cada adição. Use estes valores.
- Para mostrar resumo ao cliente, chame ver_carrinho e use subtotal_real — nunca faça conta na cabeça.
- O valor no resumo e o valor no fechamento são a MESMA fonte (carrinho real). Divergência = erro grave.
- Se adicionar_item retornar precisa_variacao=true: o item NÃO foi adicionado. Apresente as variações ao cliente, peça escolha, e DEPOIS chame adicionar_item de novo com a variação. Não tente adicionar de novo antes da escolha do cliente.

FECHAMENTO — PROIBIÇÕES ABSOLUTAS (violação = bug crítico):
- NUNCA escreva "pedido confirmado", "pedido registrado", "Código do Pedido", "seu pedido foi feito" ou qualquer variação sem ter chamado fechar_pedido NESTE turno e recebido o código real.
- O código do pedido (ex: "HNNGX") SÓ existe como retorno da ferramenta fechar_pedido. Se você não chamou fechar_pedido, o código NÃO existe — escrever "Código do Pedido:" com campo vazio é ERRO GRAVE.
- A taxa de entrega SÓ existe se definir_entrega retornou ok=true com taxa real. Nunca invente R$15, R$5 ou qualquer valor de frete sem ter chamado a ferramenta.
- Se o cliente confirmar o pedido e você ainda não chamou fechar_pedido, CHAME AGORA antes de redigir qualquer resposta. Não existe "confirmar sem fechar".

PAGAMENTO ONLINE (Asaas) — REGRAS CRÍTICAS:
- Para cartão online e PIX via Asaas: SEMPRE passe asaas_payment_id (retornado por gerar_cobranca_asaas) ao chamar fechar_pedido. Sem isso o pedido não fica vinculado à cobrança.
- Após fechar_pedido com pagamento online, o pedido fica com status "aguardando_pagamento". NUNCA diga "seu pedido está sendo preparado" — diga "Pedido registrado! Assim que o pagamento for confirmado (em alguns segundos), ele vai automaticamente para a cozinha. 🎉"
- Se o cliente disser "já paguei", "paguei agora", "efetuei o pagamento" etc. ANTES do sistema confirmar: NÃO chame fechar_pedido de novo. Responda: "Perfeito! Assim que o pagamento for confirmado pelo sistema (geralmente em alguns segundos), seu pedido vai automaticamente para a cozinha. Pode aguardar!" Confie no sistema automático.
- Se o cliente perguntar "meu pedido saiu?", "cadê meu pedido?" ou qualquer variação APÓS fechar_pedido: NÃO responda com base no que aconteceu nesta conversa — chame rastrear_pedido para obter o status real e atual.
- NUNCA gere uma segunda cobrança Asaas para o mesmo pedido. Se gerar_cobranca_asaas já foi chamado nesta conversa, o sistema reutiliza a mesma cobrança automaticamente.

PAGAMENTO OFFLINE — DINHEIRO E MAQUININHA:
- DINHEIRO: pergunte "Vai precisar de troco? Se sim, para quanto?" ANTES de mostrar o resumo.
  • Se precisar de troco: passe forma_pagamento="dinheiro" e troco_para=<valor da nota> (ex: 50, 100).
  • Se não precisar de troco: passe forma_pagamento="dinheiro" e omita troco_para.
- MAQUININHA (cartão na entrega): pergunte "Qual a bandeira do cartão? (Visa, Master, Elo...)" ANTES de fechar.
  • Passe forma_pagamento="cartao_offline" e bandeira_cartao=<bandeira em minúsculas, ex: "visa", "master", "elo">.
  • Se o cliente não souber a bandeira, omita bandeira_cartao — não bloqueie o fechamento por isso.
- Valores canônicos para fechar_pedido: use EXATAMENTE "dinheiro", "cartao_offline", "pix", "cartao_online". Nunca "Dinheiro", "Cartão", etc.

FERRAMENTAS — REGRA DE USO IMEDIATO (crítico):
NUNCA anuncie que vai buscar algo e encerre a mensagem. Frases como "vou buscar", "um instante", "deixa eu verificar", "já te trago", "vou confirmar" são PROIBIDAS como resposta final.
- Você não tem um "depois" — cada mensagem sua é final para o cliente.
- Se precisa de dados do cardápio: CHAME a ferramenta no mesmo turno e responda COM o resultado.
- Se o cliente pediu vários itens numa mensagem só: busque e adicione TODOS no mesmo fluxo (múltiplas chamadas de ferramenta em sequência), depois responda com o carrinho completo.
- Exemplo ERRADO: "Vou buscar os nigiri de atum agora!" ← cliente nunca recebe o dado.
- Exemplo CORRETO: chama buscar_produto → chama adicionar_item → responde "Adicionado! Carrinho: 2x Dupla Nigiri Atum R$28,00. Mais alguma coisa?"

CARRINHO — REGRA DE NÃO-DUPLICAÇÃO (crítico):
O carrinho PERSISTE entre turnos. Itens adicionados ficam lá até serem removidos.
- NUNCA re-adicione itens que já estão no carrinho. Cada item deve ser adicionado UMA ÚNICA VEZ.
- Se adicionar_item retornar ja_no_carrinho=true: o item já está lá — NÃO chame adicionar_item de novo para esse item.
- Quando o cliente ESCLARECE uma variação pendente (ex: responde "o pequeno" para um sashimi que pediu variação): adicione SOMENTE aquele item com a variação escolhida — NÃO re-adicione o restante do carrinho.
- Quando o cliente confirma o pedido, responde uma pergunta, ou faz qualquer coisa que não seja pedir um item novo: NÃO chame adicionar_item para nada. O carrinho já está correto.
- Se tiver dúvida do que já está no carrinho, chame ver_carrinho — não assuma e não re-adicione por precaução.

CARDÁPIO — REGRA CRÍTICA (nunca viole):
Você NÃO conhece o cardápio de memória. Só cite produto, tamanho, variação ou preço que veio de uma ferramenta NESTA conversa.
- Chame listar_categorias, listar_produtos_categoria ou buscar_produto ANTES de citar qualquer item.
- Liste APENAS o que a ferramenta retornou. O que não está lá, não existe — não ofereça.
- NUNCA diga "não temos" se buscar_produto retornar candidatos (campo candidatos). Apresente como sugestão: "Temos X (R$Y) — é isso que você quer?" O cliente pode ter falado por áudio/nome aproximado (ex: "coca" = Refrigerante, "spice" = Edamame Spicy).
- Só diga que não temos se realmente não houver nenhum produto (encontrados=0 e sem candidatos).
- NUNCA invente tamanhos (350ml, P/M/G etc.) sem que vieram da ferramenta.
- Para adicionar_item: use o campo "id" EXATO do produto retornado pela ferramenta de busca. NUNCA use ids sequenciais (1, 2, 3...) ou adivinhe. Se não tiver o id, informe o campo "nome" como fallback.
- Para remover_item: prefira sempre informar o campo "nome" do item. Não dependa do índice.
- Pedido com múltiplos itens numa frase ("quero X, Y e Z"): busque e adicione cada item individualmente no MESMO turno, com as quantidades certas. Responda só depois que todos estiverem no carrinho.

PEDIDO POR CARACTERÍSTICA GENÉRICA (regra crítica):
Quando o cliente pede algo por categoria ou característica — ex: "algo sem álcool", "uma bebida", "algo doce", "tem suco?", "quero uma entrada", "tem algo gelado?" — você DEVE:
1. Chamar listar_produtos_categoria na categoria relevante (ex: "Bebidas") OU buscar_produto com o termo genérico.
2. Listar SOMENTE o que a ferramenta retornou, com o nome EXATO e o preço EXATO do cardápio.
3. NUNCA inventar nomes comerciais (Coca-Cola, Guaraná, Sprite, Heineken, etc.) — o cardápio tem nomes próprios. Se o item se chama "Refrigerante", ofereça "Refrigerante", não "Coca-Cola" ou "Coca-Cola 300ml".
4. NUNCA citar preço de memória — o preço do cardápio é o único válido.
Se o cliente pede "Coca-Cola Zero", busque com buscar_produto("coca cola zero"). Se não encontrar, informe que não temos e ofereça o que existe (ex: "Não temos Coca-Cola Zero; temos Refrigerante (lata) por R$X").

FLUXO DO ATENDIMENTO:

1. SAUDAÇÃO — Cumprimente. Não peça nome nem endereço agora.

2. PEDIDO — Ajude a montar o pedido:
   • Cliente pede cardápio / "o que têm": chame listar_categorias(), apresente SÓ as categorias, pergunte qual quer ver.${instrucaoVitrine ? ` (Se o cliente quiser ver fotos ou mais detalhes, o sistema já enviou o link automaticamente.)` : ''}
   • Cliente escolhe categoria: chame listar_produtos_categoria() e liste com preços.
   • Cliente pede item específico: chame buscar_produto() para confirmar existência e preço.
   • Use adicionar_item para cada item confirmado.
   • Após adicionar item(s), pergunte se o cliente quer mais alguma coisa.
   • Quando o cliente sinalizar fim de seleção ("é só isso", "não", "não quero mais", "pode fechar", "só isso", "por enquanto é só", "fechou", "tá bom", etc.) com itens no carrinho → AVANCE IMEDIATAMENTE para o passo 3 (ENTREGA). NUNCA encerre a conversa neste momento.

3. ENTREGA — Só após confirmar o pedido:
   ${cliente?.ultimo_endereco
     ? `Pergunte se entrega no mesmo endereço: "${cliente.ultimo_endereco}". ${instrucaoEntrega}`
     : instrucaoEntrega}
   • QUALQUER referência de destino — endereço estruturado (rua, número) OU nome de lugar ("bar do banana", "padaria central", "em frente ao posto") — deve ser passada para definir_entrega. NUNCA responda "não encontrei" ou "não conheço esse lugar" sem ter chamado definir_entrega primeiro.
   • Pin de localização 📍 recebido → chame definir_entrega com lat e lng direto.
   • NUNCA afirme que a entrega será feita em um endereço sem que definir_entrega tenha retornado ok:true para ELE neste turno. Use SEMPRE o endereço/zona exatos retornados pela tool — nunca o que o cliente digitou, nunca um endereço de turno anterior.
   • motivo='nao_localizado' → peça mais detalhes ao cliente (rua e número), NÃO diga "fora da área". Ofereça o PIN como alternativa: "Pode me mandar sua localização pelo 📎 do WhatsApp?"
   • motivo='nao_confere' → informe que o endereço não foi reconhecido com precisão e ofereça o PIN: "Não consegui identificar esse endereço corretamente. Pode confirmar a rua ou me mandar sua localização pelo 📎 do WhatsApp?" NÃO feche o pedido.
   • motivo='fora_zona' → informe que está fora da área de entrega e NÃO feche o pedido com esse endereço. Peça outro endereço dentro da área ou encerre a tentativa. JAMAIS chame fechar_pedido com endereço que retornou fora_zona.

4. OBSERVAÇÕES — Após definir entrega e antes de mostrar o resumo, pergunte ao cliente:
   "Tem alguma observação para o preparo? (ex: sem cebola, ponto da carne bem passado)"
   Se o cliente disser que não tem, tudo bem — siga para a confirmação.

5. CONFIRMAÇÃO — Chame ver_carrinho para ter o subtotal real. Apresente o resumo completo:
   itens, subtotal (de ver_carrinho), taxa de entrega (de definir_entrega), total, forma de pagamento${''/* não interpolar nada aqui */}, observações (se houver).
   Pergunte "Confirma?" — aguarde o cliente responder.

6. FECHAMENTO — Quando o cliente confirmar:
   CHAME fechar_pedido imediatamente (não redija texto antes) passando: endereco, forma_pagamento e observacoes (se houver).
   Só após receber o retorno da ferramenta com o código real, informe o cliente de forma simpática.
   Exemplo CORRETO: fechar_pedido retorna {codigo:"HNNGX"} → você escreve "Pedido feito! Código HNNGX 🎉"
   Exemplo ERRADO: escrever "Código do Pedido: HNNGX" sem ter chamado fechar_pedido.

REGRAS GERAIS:
- Não peça nome/endereço antes de terminar o pedido.
- Não pule etapas.
- Produto esgotado: avise e ofereça alternativa.
- ENCERRAMENTO PROIBIDO COM CARRINHO CHEIO: Com itens no carrinho e fechar_pedido ainda não chamado, a IA NUNCA encerra, NUNCA se despede ("Se precisar, estou por aqui" e similares são PROIBIDOS). Conduza o cliente até o fechamento — pergunte endereço, confirme o pedido, feche. "Não quero mais itens" = avance para ENTREGA (passo 3), não encerre.
- A IA só pode se despedir ou encerrar a conversa em dois casos: (a) o carrinho está VAZIO e o cliente não quer pedir nada; ou (b) fechar_pedido já retornou OK com o código do pedido.

limpar_carrinho: use APENAS quando o cliente pedir EXPLICITAMENTE para cancelar, recomeçar, apagar o pedido, começar de novo ou quando reclamar de itens errados e querer refazer tudo. Palavras-gatilho: "cancela", "cancelar", "esquece", "esquece tudo", "remove tudo", "limpa o carrinho", "desisto", "apaga tudo", "começa de novo", "quero refazer".
- Após limpar, confirme ao cliente e pergunte o que ele gostaria de pedir.
- Se o cliente reclamar de valor muito alto ou de itens que não pediu, ofereça: "Quer que eu limpe o carrinho e a gente refaça?"
- CRÍTICO — "Não" NUNCA limpa o carrinho: "Não" é resposta a uma pergunta, não um cancelamento. Exemplos:
  • "Não" como resposta a confirmação de endereço = o endereço está errado → peça o endereço correto, NÃO limpe o carrinho.
  • "Não" como resposta a "quer mais alguma coisa?" = avance para entrega, NÃO limpe o carrinho.
  • "Não quero" / "não" / "nao" sozinhos = negação genérica, NUNCA cancelamento.
  Só chame limpar_carrinho se o cliente usar uma das palavras-gatilho acima.

CICLO DE VIDA DO PEDIDO:
- Pedido em "preparacao": cliente pode acrescentar itens ao pedido já fechado. Use acrescentar_item_pedido — NÃO crie pedido novo, NÃO peça endereço/pagamento novamente. Fluxo: buscar_produto → acrescentar_item_pedido → confirmar ao cliente. Gatilhos: "acrescenta X", "esqueci de pedir X", "pode colocar Y também", "adiciona mais uma X ao pedido".
- Pedido em "aguardando_coleta", "em_rota" ou "entregue": pedido INTOCÁVEL — já saiu ou vai sair. Se o cliente quiser mais itens, é um pedido NOVO (fluxo normal). NUNCA diga "você já tem X no carrinho" referindo ao pedido anterior.

rastrear_pedido: chame SEMPRE que o cliente perguntar sobre andamento do pedido ("meu pedido saiu?", "cadê meu pedido?", "já tá pronto?", "quanto falta?", "foi despachado?", "saiu pra entrega?", "tá na cozinha?"). NUNCA responda sobre status de pedido de memória — a resposta DEVE vir do retorno da ferramenta. Regras de uso dos campos:
- Use os campos literalmente — NUNCA invente, reformate ou calcule valores que não vieram da tool.
- NUNCA exponha lat/lng ao cliente. Use apenas ref_local e os campos de texto pré-prontos.
- Seja CURTO e NATURAL. Uma frase resolve.

Interpretação do retorno:
- sem_pedido=true → "Não encontrei pedido ativo nas últimas 24h para este número. Posso ajudar a fazer um novo pedido?"
- status "aguardando_pagamento" → "Seu pedido #X está aguardando a confirmação do pagamento."
- status "preparacao" → "Seu pedido #X está sendo preparado na cozinha 👨‍🍳."
- status "aguardando_coleta" → "Seu pedido #X está pronto e aguardando o motoboy 📦."
- status "em_rota" + loc_fresca=true + ref_local não nulo → OBRIGATÓRIO incluir ref_local na resposta exatamente como veio da tool, sem parafrasear. Ex: ref_local="perto de Mercado Extra" → escreva "perto de Mercado Extra". Modelo: "Saiu às {saiu_em} com o {motoboy} 🛵 — está {ref_local}. Código: {codigo_entrega}."
- status "em_rota" + loc_fresca=true + ref_local=null → "Saiu às {saiu_em} com o {motoboy} 🛵, está a caminho. Código: {codigo_entrega}."
- status "em_rota" + loc_fresca=false → não afirme posição: "Saiu às {saiu_em} com o {motoboy} 🛵, está a caminho. Código: {codigo_entrega}."
- status "em_rota" + rastreio_indisponivel=true → "Já saiu com o {motoboy} 🛵. Não consegui a posição agora. Código: {codigo_entrega}."
- status "entregue" → "Seu pedido #X consta como entregue. Se não recebeu, me avise!"

abrir_chamado: use SOMENTE se o cliente pedir explicitamente falar com pessoa/atendente humano.

PROMOÇÕES E CUPONS (Fase 3):
verificar_promocoes_cliente: chame logo após a saudação (primeira mensagem do cliente). Se retornar promoções, ofereça UMA de forma breve e natural — como uma dica, não como anúncio. Ex: "Ah, vi que você tem direito a frete grátis hoje! 😊 Aplico quando fecharmos, é só pedir."
- Ofereça a promoção UMA ÚNICA VEZ por conversa. Não repita nem mencione de novo se o cliente não quis.
- Se o cliente aceitar a promoção, confirme e ao fechar o pedido passe o promocao_id para fechar_pedido.

validar_cupom: chame quando o cliente mencionar um código de cupom. Retorna se é válido e o benefício.
- Se válido: confirme o benefício ao cliente e passe cupom_codigo para fechar_pedido.
- Se inválido: informe o cliente com empatia (ex: "Esse cupom não encontrei aqui 😕 Pode confirmar o código?").

fechar_pedido com desconto: se houver promoção ou cupom aceito, sempre passe o respectivo campo (promocao_id ou cupom_codigo).
- Se retornar erro_promo (valor mínimo não atingido): informe o cliente do valor mínimo e pergunte se quer adicionar mais itens. NÃO feche o pedido.
- O campo total no retorno já inclui o desconto — use-o para informar o cliente.
- NUNCA invente descontos ou promoções. Apenas os retornados pelas ferramentas são reais.`.trim();
}

// ── Definição das tools ───────────────────────────────────────────────────────
const TOOL_DEFINITIONS = [
  {
    type: 'function',
    function: {
      name: 'listar_categorias',
      description: 'Lista todas as categorias do cardápio com a quantidade de itens disponíveis em cada uma. Use quando o cliente pede o cardápio, "o que vocês têm", "quais as opções", "tem X?" sem saber se existe. Apresente as categorias ao cliente e pergunte qual ele quer ver.',
      parameters: { type: 'object', properties: {} },
    },
  },
  {
    type: 'function',
    function: {
      name: 'listar_produtos_categoria',
      description: 'Lista todos os produtos disponíveis de uma categoria específica, com preços e variações reais cadastradas. Use quando o cliente escolhe uma categoria (ex: "me mostra as bebidas", "quero ver os temakis").',
      parameters: {
        type: 'object',
        properties: {
          categoria: { type: 'string', description: 'Nome da categoria (exato ou parcial, ex: "Bebidas", "Temakis", "Combinados")' },
        },
        required: ['categoria'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'buscar_produto',
      description: 'Busca produtos por nome ou categoria (parcial, ignora acentos). Use quando o cliente pede algo específico (ex: "quero um temaki de salmão"). Retorna id, nome, preço, variações REAIS e adicionais. As variações retornadas são as ÚNICAS que existem — não ofereça outras.',
      parameters: {
        type: 'object',
        properties: {
          termo: { type: 'string', description: 'Termo de busca — parte do nome do produto ou da categoria' },
        },
        required: ['termo'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'adicionar_item',
      description: 'Adiciona um produto ao carrinho. Use o id EXATO retornado por buscar_produto ou listar_produtos_categoria — NUNCA invente ou use ids sequenciais (1, 2, 3). Se não souber o id, informe o nome do produto no campo nome como fallback.',
      parameters: {
        type: 'object',
        properties: {
          produto_id:  { type: 'integer', description: 'ID EXATO do produto, obtido de buscar_produto ou listar_produtos_categoria. Nunca invente.' },
          nome:        { type: 'string',  description: 'Nome do produto — fallback usado se produto_id for desconhecido ou errado' },
          quantidade:  { type: 'integer', description: 'Quantidade desejada', minimum: 1 },
          variacao:    { type: 'string',  description: 'Nome exato da variação (se o produto tiver variações)' },
          adicionais:  { type: 'array',   items: { type: 'string' }, description: 'Nomes das opções de adicionais escolhidas' },
        },
        required: ['quantidade'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'ver_carrinho',
      description: 'Retorna os itens atuais do carrinho com posições numeradas e o subtotal real. Chame sempre antes de apresentar resumo ao cliente.',
      parameters: { type: 'object', properties: {} },
    },
  },
  {
    type: 'function',
    function: {
      name: 'remover_item',
      description: 'Remove um item do carrinho. Prefira informar o nome do item (ex: nome:"edamame spicy"). Se usar índice, use a posição exata retornada por ver_carrinho. Retorna o carrinho atualizado.',
      parameters: {
        type: 'object',
        properties: {
          nome:   { type: 'string',  description: 'Nome (ou parte do nome) do item a remover — preferir este campo' },
          indice: { type: 'integer', description: 'Posição no carrinho (1-based), alternativa ao nome', minimum: 1 },
        },
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'acrescentar_item_pedido',
      description: 'Acrescenta um item a um pedido que já foi fechado e está em PREPARAÇÃO. Use EXCLUSIVAMENTE quando o cliente pedir para adicionar algo a um pedido existente que ainda não saiu para entrega (ex: "esqueci de pedir X", "pode colocar uma Coca também", "acrescenta uma sobremesa"). NÃO cria pedido novo. NÃO pede endereço nem forma de pagamento — reutiliza os do pedido existente. Se o pedido estiver em um pacote, ele volta automaticamente para a coluna de preparação.',
      parameters: {
        type: 'object',
        properties: {
          produto_id: { type: 'integer', description: 'ID EXATO do produto, obtido de buscar_produto. Nunca invente.' },
          nome:       { type: 'string',  description: 'Nome do produto — fallback se produto_id for desconhecido' },
          quantidade: { type: 'integer', description: 'Quantidade a acrescentar', minimum: 1 },
          variacao:   { type: 'string',  description: 'Nome exato da variação (se o produto tiver variações)' },
        },
        required: ['quantidade'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'definir_entrega',
      description: 'OBRIGATÓRIO sempre que o cliente indicar PARA ONDE entregar — seja endereço estruturado (rua, número, bairro) OU nome de estabelecimento/ponto de referência ("bar do banana", "supermercado koch", "em frente à praça X", "posto shell da entrada"). A tool resolve qualquer referência de destino via Google Maps e retorna a taxa e o tempo. Retorna {ok:true,...} se dentro da área de entrega, {ok:false, motivo:"fora_zona"} se fora, ou {ok:false, motivo:"nao_localizado"} se não encontrou (aí peça mais detalhes ao cliente). Aceita texto livre OU lat/lng (pin do WhatsApp).',
      parameters: {
        type: 'object',
        properties: {
          endereco: { type: 'string',  description: 'Qualquer referência de destino: endereço (rua, número, bairro), nome de estabelecimento ("bar do banana", "supermercado koch"), ponto de referência ("praça central"), ou qualquer combinação. Omitir apenas se usar lat/lng.' },
          lat:      { type: 'number', description: 'Latitude (quando cliente enviou pin de localização do WhatsApp)' },
          lng:      { type: 'number', description: 'Longitude (quando cliente enviou pin de localização do WhatsApp)' },
        },
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'fechar_pedido',
      description: 'Cria o pedido real no sistema após confirmação do cliente. Retorna o código do pedido. NUNCA chame sem endereço e forma de pagamento confirmados pelo cliente. Se houver promoção ou cupom aceito pelo cliente, passe promocao_id ou cupom_codigo. Se pagamento for online (Asaas), passe asaas_payment_id obtido de gerar_cobranca_asaas. Para dinheiro com troco, passe troco_para. Para maquininha, passe bandeira_cartao.',
      parameters: {
        type: 'object',
        properties: {
          nome_cliente:      { type: 'string',  description: 'Nome do cliente (opcional se já conhecido do cadastro)' },
          endereco:          { type: 'string',  description: 'Endereço completo para entrega — OBRIGATÓRIO, confirmado pelo cliente' },
          forma_pagamento:   { type: 'string',  description: 'Forma de pagamento — OBRIGATÓRIO. Use exatamente: "dinheiro", "cartao_offline", "pix" ou "cartao_online".' },
          observacoes:       { type: 'string',  description: 'Observações do cliente sobre o preparo (ex: "sem cebola", "ponto bem passado"). Pergunte antes de fechar.' },
          troco_para:        { type: 'number',  description: 'Valor da nota que o cliente vai pagar (ex: 100). Preencha SOMENTE quando forma_pagamento="dinheiro" E o cliente precisar de troco. Omitir se não precisar de troco.' },
          bandeira_cartao:   { type: 'string',  description: 'Bandeira do cartão (ex: "visa", "master", "elo", "hipercard"). Preencha SOMENTE quando forma_pagamento="cartao_offline".' },
          promocao_id:       { type: 'integer', description: 'ID da promoção segmentada aceita pelo cliente (obtido de verificar_promocoes_cliente)' },
          cupom_codigo:      { type: 'string',  description: 'Código do cupom validado (obtido de validar_cupom que retornou valido:true)' },
          asaas_payment_id:  { type: 'string',  description: 'ID da cobrança Asaas (obtido de gerar_cobranca_asaas). Quando informado, o pedido fica com status "aguardando_pagamento" até confirmação do webhook.' },
        },
        required: ['endereco', 'forma_pagamento'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'abrir_chamado',
      description: 'Abre chamado de atendimento humano. Use SOMENTE quando o cliente pedir EXPLICITAMENTE falar com uma pessoa, atendente ou humano.',
      parameters: {
        type: 'object',
        properties: {
          motivo:       { type: 'string', description: 'Motivo do chamado conforme descrito pelo cliente' },
          nome_cliente: { type: 'string', description: 'Nome do cliente se já conhecido na conversa' },
        },
        required: ['motivo'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'limpar_carrinho',
      description: 'Zera o carrinho do cliente. Use quando o cliente pedir para cancelar, recomeçar, apagar o pedido ou começar de novo. Também use se o cliente reclamar de itens errados e quiser refazer tudo.',
      parameters: { type: 'object', properties: {} },
    },
  },
  {
    type: 'function',
    function: {
      name: 'verificar_promocoes_cliente',
      description: 'Verifica se o cliente tem promoções segmentadas disponíveis (ex: frete grátis, desconto por fidelidade). Chame UMA VEZ no início da conversa, logo após a saudação inicial. Se houver promoção elegível, ofereça naturalmente — nunca como lista de ofertas. Não chame mais de uma vez por conversa.',
      parameters: { type: 'object', properties: {} },
    },
  },
  {
    type: 'function',
    function: {
      name: 'validar_cupom',
      description: 'Valida um código de cupom informado pelo cliente. Retorna se o cupom é válido, o benefício e o mínimo de pedido (se houver). Chame quando o cliente mencionar um código de cupom.',
      parameters: {
        type: 'object',
        properties: {
          codigo: { type: 'string', description: 'Código do cupom exatamente como o cliente informou' },
        },
        required: ['codigo'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'rastrear_pedido',
      description: 'Consulta o status REAL e rastreamento em tempo real dos pedidos do cliente (últimas 24h), incluindo posição atual do motoboy e ETA estimado. CHAME SEMPRE que o cliente perguntar sobre andamento: "meu pedido saiu?", "cadê meu pedido?", "já tá pronto?", "quanto falta?", "já saiu?", "foi despachado?", "tá na cozinha?". NUNCA responda de memória sobre status de pedido.',
      parameters: { type: 'object', properties: {} },
    },
  },
  {
    type: 'function',
    function: {
      name: 'gerar_cobranca_asaas',
      description: 'Gera cobrança via Asaas (cartão online ou PIX). OBRIGATÓRIO antes de fechar_pedido quando forma_pagamento for cartão online ou PIX Asaas. Retorna id_cobranca, link e (se PIX) qr_code. Passe id_cobranca como asaas_payment_id no fechar_pedido.',
      parameters: {
        type: 'object',
        required: ['valor', 'descricao', 'forma'],
        properties: {
          valor:            { type: 'number', description: 'Valor total com frete em reais (número, sem R$)' },
          descricao:        { type: 'string', description: 'Descrição da cobrança, ex: "Pedido delivery 3 itens"' },
          forma:            { type: 'string', enum: ['PIX', 'CREDIT_CARD'], description: 'PIX ou CREDIT_CARD' },
          nome_cliente:     { type: 'string', description: 'Nome do cliente para criar o customer Asaas' },
          cliente_telefone: { type: 'string', description: 'Número WhatsApp do cliente (referência única do customer)' },
        },
      },
    },
  },
];


// ── Execução das tools ────────────────────────────────────────────────────────
async function _executarTool(nomeTool, args, numero) {
  const cardapio = await _getCardapio();
  const carrinho = _getCarrinho(numero);

  // ── listar_categorias ──
  if (nomeTool === 'listar_categorias') {
    const categoriasMap = {};
    for (const p of cardapio.produtos) {
      const cat = p.categoria || 'Sem categoria';
      if (!categoriasMap[cat]) categoriasMap[cat] = { disponivel: 0, esgotado: 0 };
      if (p.esgotado) categoriasMap[cat].esgotado++;
      else            categoriasMap[cat].disponivel++;
    }
    const categorias = Object.entries(categoriasMap)
      .filter(([, c]) => c.disponivel > 0)
      .map(([nome, c]) => ({ nome, itens_disponiveis: c.disponivel }));

    if (!categorias.length) return { categorias: [], mensagem: 'Nenhuma categoria com itens disponíveis no momento.' };
    return { categorias, total_categorias: categorias.length };
  }

  // ── listar_produtos_categoria ──
  if (nomeTool === 'listar_produtos_categoria') {
    const catNorm   = _normalizar(args.categoria || '');
    const produtos  = cardapio.produtos.filter(p => _normalizar(p.categoria).includes(catNorm));
    const disponiveis = produtos.filter(p => !p.esgotado);
    const esgotados   = produtos.filter(p =>  p.esgotado).map(p => p.nome);

    if (!produtos.length) {
      return { encontrados: 0, mensagem: `Nenhum produto encontrado na categoria "${args.categoria}". Categorias disponíveis: ${[...new Set(cardapio.produtos.map(p => p.categoria))].join(', ')}` };
    }

    const mapearProduto = (p) => {
      const temVar = p.tem_variacoes && p.variacoes.length > 0;
      return {
        id:           p.id,
        nome:         p.nome,
        descricao:    p.descricao || null,
        preco:        temVar ? null : p.preco_promo || p.preco,
        preco_texto:  temVar
          ? `a partir de ${_fmtBRL(Math.min(...p.variacoes.map(v => v.preco)))}`
          : _fmtBRL(p.preco_promo || p.preco),
        variacoes:    temVar ? p.variacoes.map(v => ({ nome: v.nome, preco: v.preco, preco_texto: _fmtBRL(v.preco) })) : [],
        sem_variacoes: !temVar,
        adicionais:   p.adicionais.map(g => ({
          grupo: g.nome,
          opcoes: g.opcoes.map(o => ({ nome: o.nome, preco_texto: o.preco ? _fmtBRL(o.preco) : 'grátis' })),
        })),
      };
    };

    const result = {
      categoria:   args.categoria,
      encontrados: disponiveis.length,
      produtos:    disponiveis.map(mapearProduto),
      aviso:       'Liste SOMENTE estes produtos e variações, com preços exatos. Use o campo descricao ao falar sobre cada item.',
    };
    if (esgotados.length) result.esgotados = esgotados;
    return result;
  }

  if (nomeTool === 'buscar_produto') {
    const tokens = _tokensBusca(args.termo || '');
    if (!tokens.length) return { encontrados: 0, mensagem: 'Termo de busca inválido.' };

    console.log(`[TOOL] buscar_produto: termo="${args.termo}" → tokens=[${tokens.join(', ')}]`);

    // Score todos os produtos (disponíveis e esgotados separados)
    const withScore = cardapio.produtos.map(p => ({ p, score: _scoreProduto(tokens, p) }));

    // Limiares: ≥ 50 = match direto, ≥ 20 = candidato (match parcial/aproximado)
    const LIMIAR_DIRETO     = 50;
    const LIMIAR_CANDIDATO  = 20;

    const diretos    = withScore.filter(({ p, score }) => !p.esgotado && score >= LIMIAR_DIRETO)
                                .sort((a, b) => b.score - a.score);
    const candidatos = withScore.filter(({ p, score }) => !p.esgotado && score >= LIMIAR_CANDIDATO && score < LIMIAR_DIRETO)
                                .sort((a, b) => b.score - a.score);
    const esgotados  = withScore.filter(({ p, score }) =>  p.esgotado && score >= LIMIAR_DIRETO)
                                .map(({ p }) => p.nome);

    console.log(`[TOOL] buscar_produto: diretos=${diretos.length} candidatos=${candidatos.length} esgotados=${esgotados.length}`);
    if (diretos.length || candidatos.length) {
      console.log(`[TOOL] buscar_produto scores: ${[...diretos, ...candidatos].slice(0,5).map(({p,score})=>`"${p.nome}"=${score.toFixed(0)}`).join(', ')}`);
    }

    const mapearProduto = (p) => {
      const temVar = p.tem_variacoes && p.variacoes.length > 0;
      return {
        id:           p.id,
        nome:         p.nome,
        categoria:    p.categoria,
        descricao:    p.descricao || null,
        disponivel:   !p.esgotado,
        preco:        temVar ? null : p.preco_promo || p.preco,
        preco_texto:  temVar
          ? `variações a partir de ${_fmtBRL(Math.min(...p.variacoes.map(v => v.preco)))}`
          : _fmtBRL(p.preco_promo || p.preco),
        variacoes:    temVar ? p.variacoes.map(v => ({ nome: v.nome, preco: v.preco, preco_texto: _fmtBRL(v.preco) })) : [],
        sem_variacoes: !temVar,
        adicionais:   p.adicionais.map(g => ({
          grupo:  g.nome,
          opcoes: g.opcoes.map(o => ({ nome: o.nome, preco: o.preco, preco_texto: o.preco ? _fmtBRL(o.preco) : 'grátis' })),
        })),
      };
    };

    if (!diretos.length && !candidatos.length) {
      return {
        encontrados: 0,
        mensagem: `Nenhum produto encontrado para "${args.termo}". Verifique o cardápio com listar_categorias — NÃO diga que não temos sem antes verificar as categorias.`,
      };
    }

    const result = {};
    if (diretos.length) {
      result.encontrados = diretos.length;
      result.produtos    = diretos.map(({ p }) => mapearProduto(p));
      result.aviso       = 'Liste SOMENTE estes produtos e variações, com preços exatos. Use o campo descricao ao descrever o item.';
    } else {
      result.encontrados = 0;
    }
    if (candidatos.length) {
      result.candidatos = candidatos.slice(0, 4).map(({ p }) => mapearProduto(p));
      result.instrucao_candidatos = `Busca aproximada para "${args.termo}": não há match exato, mas estes produtos são próximos. Apresente ao cliente como sugestão ("Temos X (R$Y) — é isso?") em vez de dizer que não temos. Só diga que não temos se o cliente confirmar que não é nenhum destes.`;
    }
    if (esgotados.length) result.esgotados = esgotados;
    return result;
  }

  // ── adicionar_item ──
  if (nomeTool === 'adicionar_item') {
    // ── BUG FIX: coerce para Number — OpenAI às vezes manda produto_id como string ──
    let prodId  = args.produto_id != null ? Number(args.produto_id) : NaN;
    let produto = isNaN(prodId) ? null : cardapio.produtos.find(p => Number(p.id) === prodId);

    console.log(`[TOOL] adicionar_item INPUT: produto_id=${prodId} (raw=${JSON.stringify(args.produto_id)}), nome=${JSON.stringify(args.nome||null)}, qtd=${args.quantidade}, variacao=${JSON.stringify(args.variacao || null)}`);

    // ── Fallback por nome: usa busca fuzzy idêntica ao buscar_produto ──────────
    if (!produto && args.nome) {
      const tokens = _tokensBusca(args.nome);
      const melhor = cardapio.produtos
        .filter(p => !p.esgotado)
        .map(p => ({ p, score: _scoreProduto(tokens, p) }))
        .sort((a, b) => b.score - a.score)[0];
      if (melhor && melhor.score >= 50) {
        produto = melhor.p;
        prodId  = produto.id;
        console.log(`[TOOL] adicionar_item: fallback fuzzy "${args.nome}" (score=${melhor.score.toFixed(0)}) → "${produto.nome}" (id=${produto.id})`);
      }
    }

    if (!produto) {
      const exemplos = cardapio.produtos.slice(0, 8).map(p => `id=${p.id} "${p.nome}"`).join(', ');
      console.warn(`[TOOL] adicionar_item: id ${prodId} não encontrado. Exemplos reais: ${exemplos}`);
      return { erro: `Produto id=${prodId} não existe. Use o id EXATO retornado por listar_produtos_categoria ou buscar_produto — NUNCA invente ids. Exemplos de ids reais: ${exemplos}` };
    }
    if (produto.esgotado) return { erro: `"${produto.nome}" está esgotado no momento.` };

    // ── BUG FIX: preco_promo=0 é falsy — usa null-check em vez de || ──
    let preco = (produto.preco_promo != null && produto.preco_promo > 0)
      ? produto.preco_promo
      : produto.preco;
    let variacao_nome = null;

    // Resolve variação
    if (produto.tem_variacoes && produto.variacoes.length) {
      if (!args.variacao) {
        // ── BUG FIX: NÃO é erro fatal — retorna estrutura para IA perguntar ao cliente ──
        return {
          precisa_variacao: true,
          produto:          produto.nome,
          mensagem:         `"${produto.nome}" tem variações — qual o cliente quer?`,
          variacoes:        produto.variacoes.map(v => ({ nome: v.nome, preco: v.preco, preco_texto: _fmtBRL(v.preco) })),
          instrucao:        'Apresente as variações ao cliente e pergunte qual ele quer. Então chame adicionar_item novamente com o campo variacao preenchido.',
        };
      }
      const varNorm  = _normalizar(args.variacao);
      // Aceita match nos dois sentidos (ex: "G" inclui "grande"? não, mas "grande" includes "g" sim)
      const varMatch = produto.variacoes.find(v =>
        _normalizar(v.nome).includes(varNorm) || varNorm.includes(_normalizar(v.nome))
      );
      if (!varMatch) {
        return {
          precisa_variacao: true,
          produto:          produto.nome,
          mensagem:         `Variação "${args.variacao}" não existe em "${produto.nome}".`,
          variacoes:        produto.variacoes.map(v => ({ nome: v.nome, preco: v.preco, preco_texto: _fmtBRL(v.preco) })),
          instrucao:        'Apresente as variações corretas ao cliente e peça para escolher uma.',
        };
      }
      preco         = varMatch.preco;
      variacao_nome = varMatch.nome;
    }

    // Resolve adicionais
    const adicSelecionados = [];
    let adicPrecoExtra = 0;
    for (const opcNome of (args.adicionais || [])) {
      const normOpc = _normalizar(opcNome);
      let found = null;
      for (const grupo of produto.adicionais) {
        found = grupo.opcoes.find(o => _normalizar(o.nome).includes(normOpc));
        if (found) break;
      }
      if (found) {
        adicSelecionados.push(found.nome);
        adicPrecoExtra += found.preco || 0;
      }
    }

    const qtd          = Math.max(1, args.quantidade || 1);
    const precoUnit    = preco + adicPrecoExtra;
    const subtotalItem = precoUnit * qtd;
    const adicionaisStr = adicSelecionados.join(', ');

    // ── Idempotência: bloqueia duplicata (mesmo produto + variação + adicionais) ──
    // Re-chamar adicionar_item com o mesmo item NÃO empilha — retorna estado atual.
    // Isso previne o bug de a IA re-adicionar o carrinho inteiro ao resolver uma variação.
    const jaExiste = carrinho.find(it =>
      Number(it.produto_id) === Number(produto.id) &&
      it.variacao === variacao_nome &&
      (it.adicionais_str || '') === adicionaisStr
    );
    if (jaExiste) {
      console.warn(`[CARRINHO] ${numero} ⚠ DUPLICATA BLOQUEADA: ${produto.nome}${variacao_nome ? ` (${variacao_nome})` : ''} já no carrinho (qty=${jaExiste.quantidade}). Retornando estado sem empilhar.`);
      const subtotalCarrinho = carrinho.reduce((s, i) => s + i.subtotal_item, 0);
      return {
        adicionado:        false,
        ja_no_carrinho:    true,
        mensagem:          `"${produto.nome}${variacao_nome ? ` (${variacao_nome})` : ''}" já está no carrinho (${jaExiste.quantidade}x). NÃO re-adicione. Se o cliente quer mais unidades, pergunte explicitamente e use remover_item + adicionar_item com a nova quantidade.`,
        carrinho_completo: carrinho.map((it, idx) => ({
          posicao:    idx + 1,
          nome:       it.variacao ? `${it.nome} (${it.variacao})` : it.nome,
          adicionais: it.adicionais_str || null,
          quantidade: it.quantidade,
          preco_unit: _fmtBRL(it.preco_unit),
          subtotal:   _fmtBRL(it.subtotal_item),
        })),
        subtotal_real: _fmtBRL(subtotalCarrinho),
        instrucao:     'Item já existia — carrinho inalterado. Continue a conversa sem re-adicionar.',
      };
    }

    carrinho.push({
      produto_id:     produto.id,
      nome:           produto.nome,
      categoria:      produto.categoria,
      variacao:       variacao_nome,
      quantidade:     qtd,
      preco_unit:     precoUnit,
      adicionais_str: adicionaisStr,
      subtotal_item:  subtotalItem,
    });

    // Persiste carrinho no DB (operação atômica: se falhar aqui, não chegou ao push — mas push já aconteceu em memória)
    await db.upsertConversaWA(numero, { carrinho: JSON.stringify(carrinho) });

    const subtotalCarrinho = carrinho.reduce((s, i) => s + i.subtotal_item, 0);

    // Log completo do estado atual para diagnóstico
    const estadoLog = carrinho.map(it => `${it.nome}${it.variacao ? ` (${it.variacao})` : ''} x${it.quantidade} = ${_fmtBRL(it.subtotal_item)}`).join(' | ');
    console.log(`[CARRINHO] ${numero} após adicionar_item (${carrinho.length} itens): ${estadoLog} → subtotal REAL: ${_fmtBRL(subtotalCarrinho)}`);

    // Retorna o carrinho COMPLETO para a IA ter o estado real e não precisar calcular
    return {
      adicionado:       true,
      item_adicionado: {
        nome:       produto.nome,
        variacao:   variacao_nome,
        quantidade: qtd,
        preco_unit: _fmtBRL(precoUnit),
        adicionais: adicionaisStr || null,
        subtotal:   _fmtBRL(subtotalItem),
      },
      // Estado real do carrinho após esta adição — USE ESTES VALORES, não calcule
      carrinho_completo: carrinho.map((it, idx) => ({
        posicao:   idx + 1,
        nome:      it.variacao ? `${it.nome} (${it.variacao})` : it.nome,
        adicionais: it.adicionais_str || null,
        quantidade: it.quantidade,
        preco_unit: _fmtBRL(it.preco_unit),
        subtotal:   _fmtBRL(it.subtotal_item),
      })),
      subtotal_real: _fmtBRL(subtotalCarrinho),  // subtotal correto — nunca some preços manualmente
      total_itens:   carrinho.length,
      instrucao:     'Use subtotal_real e carrinho_completo no resumo. NUNCA calcule ou some preços você mesma.',
    };
  }

  // ── ver_carrinho ──
  if (nomeTool === 'ver_carrinho') {
    if (!carrinho.length) return { vazio: true, mensagem: 'O carrinho está vazio.' };

    // Rede de segurança: consolida duplicatas que possam ter escapado (não deveria acontecer)
    const consolidado = _consolidarCarrinho(carrinho);
    if (consolidado.length !== carrinho.length) {
      console.warn(`[CARRINHO] ${numero} ver_carrinho: consolidou ${carrinho.length} → ${consolidado.length} linhas (havia duplicatas)`);
      _carrinhos.set(numero, consolidado);
      // TODO(causa-2): considerar propagar/alertar — falha aqui deixa carrinho dessincronizado entre mem e DB
      await db.upsertConversaWA(numero, { carrinho: JSON.stringify(consolidado) }).catch(e => console.error('[AGENTE] falha em upsertConversaWA (consolidar carrinho):', e.message));
    }

    const subtotal = consolidado.reduce((s, i) => s + i.subtotal_item, 0);
    const estadoLog = consolidado.map(it => `${it.nome}${it.variacao ? ` (${it.variacao})` : ''} x${it.quantidade} = ${_fmtBRL(it.subtotal_item)}`).join(' | ');
    console.log(`[CARRINHO] ${numero} ver_carrinho (${consolidado.length} itens): ${estadoLog} → subtotal REAL: ${_fmtBRL(subtotal)}`);
    return {
      itens: consolidado.map((it, idx) => ({
        numero:     idx + 1,
        nome:       it.variacao ? `${it.nome} (${it.variacao})` : it.nome,
        adicionais: it.adicionais_str || null,
        quantidade: it.quantidade,
        preco_unit: _fmtBRL(it.preco_unit),
        subtotal:   _fmtBRL(it.subtotal_item),
      })),
      subtotal_real: _fmtBRL(subtotal),
      instrucao: 'Este é o estado real do carrinho. Use subtotal_real no resumo, nunca calcule.',
    };
  }

  // ── remover_item ──
  if (nomeTool === 'remover_item') {
    const _carrinhoSnapshot = () => carrinho.map((it, i) => ({
      posicao: i + 1,
      nome:    it.variacao ? `${it.nome} (${it.variacao})` : it.nome,
      subtotal: _fmtBRL(it.subtotal_item),
    }));

    let idx = -1;

    if (args.nome) {
      // Busca por nome (fuzzy) — preferido por ser mais robusto que índice
      const nomeNorm = _normalizar(args.nome);
      idx = carrinho.findIndex(it => {
        const fullName = _normalizar(`${it.nome} ${it.variacao || ''}`);
        return fullName.includes(nomeNorm) || _normalizar(it.nome).includes(nomeNorm) || nomeNorm.includes(_normalizar(it.nome));
      });
      if (idx === -1) {
        return {
          erro:          `"${args.nome}" não encontrado no carrinho.`,
          carrinho_atual: _carrinhoSnapshot(),
          instrucao:     'Use um dos nomes acima para remover.',
        };
      }
    } else {
      // Busca por índice (1-based)
      idx = (args.indice || 1) - 1;
      if (idx < 0 || idx >= carrinho.length) {
        return {
          erro:          `Posição ${args.indice} não existe (carrinho tem ${carrinho.length} item(ns)).`,
          carrinho_atual: _carrinhoSnapshot(),
          instrucao:     'Use a posição exata (1-based) ou prefira informar o nome do item.',
        };
      }
    }

    const [removido] = carrinho.splice(idx, 1);
    await db.upsertConversaWA(numero, { carrinho: JSON.stringify(carrinho) });
    const subtotal = carrinho.reduce((s, i) => s + i.subtotal_item, 0);
    return {
      removido:      removido.nome + (removido.variacao ? ` (${removido.variacao})` : ''),
      subtotal_real: _fmtBRL(subtotal),
      total_itens:   carrinho.length,
      carrinho_atual: _carrinhoSnapshot(),
    };
  }

  // ── definir_entrega ──
  if (nomeTool === 'definir_entrega') {
    // ── Helper: lookup de zona por lat/lng ───────────────────────────────────
    const _zonaParaLatLng = (lat, lng) => {
      const z = cardapio.zonas.find(z => z.ativa && _pontoNaZona(lat, lng, z));
      if (z) return { ok: true, zona: z.nome, taxa: z.taxa, taxa_texto: z.taxa > 0 ? _fmtBRL(z.taxa) : 'Grátis', tempo_min: z.tempo_min, tempo_max: z.tempo_max, tempo_texto: `${z.tempo_min}–${z.tempo_max} min`, lat, lng };
      return null;
    };
    // Salva resultado ok=true no cache de sessão para fechar_pedido reusar
    const _cacheEntrega = (result) => {
      if (result?.ok) {
        _entregaMap.set(numero, {
          taxa:               result.taxa ?? 0,
          bairroStr:          result.zona || result.bairro || null,
          lat:                result.lat  ?? null,
          lng:                result.lng  ?? null,
          endereco_formatado: result.endereco_formatado || null,
        });
      }
      return result;
    };

    // ── Caso A: lat/lng direto (pin de localização do WhatsApp) ──────────────
    if (args.lat != null && args.lng != null) {
      const lat = Number(args.lat), lng = Number(args.lng);
      console.log(`[TOOL] definir_entrega: lat/lng direto (${lat},${lng})`);
      const r = _zonaParaLatLng(lat, lng);
      if (!r) return { ok: false, motivo: 'fora_zona' };

      // Reverse geocode para obter logradouro próximo ao PIN
      let endFormatado = null;
      try {
        const mk = await db.getConfig('google_maps_key').catch(() => null);
        if (mk) {
          const rgUrl = `https://maps.googleapis.com/maps/api/geocode/json?latlng=${lat},${lng}&language=pt-BR&key=${mk}`;
          const rgResp = await fetch(rgUrl, { signal: AbortSignal.timeout(5000) });
          const rgData = await rgResp.json();
          if (rgData.status === 'OK' && rgData.results?.length > 0) {
            // Prefere resultado de rua (street_address/route), cai no primeiro se não achar
            const hit = rgData.results.find(res =>
              res.types?.some(t => ['street_address', 'route'].includes(t))
            ) || rgData.results[0];
            // Pega só rua + número (as 2 primeiras partes do formatted_address)
            const partes = hit.formatted_address.split(',');
            const rua = partes.slice(0, Math.min(2, partes.length)).join(',').trim();
            endFormatado = `${rua} (aproximado)`;
            console.log(`[ENDERECO] PIN reverse geocode: "${endFormatado}" para (${lat},${lng})`);
          }
        }
      } catch (e) {
        console.warn('[ENDERECO] PIN reverse geocode falhou:', e.message);
      }
      if (!endFormatado) {
        endFormatado = `${r.zona || r.bairro || 'Localização'} (aproximado)`;
      }

      return _cacheEntrega({ ...r, endereco_formatado: endFormatado });
    }

    const endereco = (args.endereco || '').trim();
    if (!endereco) return { ok: false, motivo: 'nao_localizado', mensagem: 'Endereço não informado.' };

    const endNorm = _normalizar(endereco);

    // Helpers para detecção e validação de endereço estruturado (rua + número).
    // Endereço estruturado: começa com keyword de logradouro (Rua, Av., Avenida, etc.)
    const _ehEstruturado = (end) =>
      /^(rua|av\.?\s|avenida|praça|alameda|travessa|estrada|rod\.?\s|rodovia|r\.\s)/i.test(end.trim());
    // Extrai o nome distintivo da rua, sem prefixo e sem número (ex: "Avenida Amazonas, 30" → "amazonas")
    const _nomeRua = (end) => _normalizar(
      end.trim()
        .replace(/^(rua|avenida|av\.?\s*|praça|alameda|travessa|estrada|rodovia|rod\.?\s*|r\.\s*)/i, '')
        .replace(/[,\-\d].*$/, '')
        .trim()
    );

    // ── Atalho: endereço idêntico ao salvo → usa coords em cache ─────────────
    if (_loop_cliente?.ultimo_lat && _loop_cliente?.ultimo_lng && _loop_cliente?.ultimo_endereco &&
        _normalizar(_loop_cliente.ultimo_endereco) === endNorm) {
      // Endereço estruturado: ignora cache do DB para forçar re-geocoding com validação
      // (evita perpetuar matches ruins gravados antes do fix de validação de rua).
      if (_ehEstruturado(endereco)) {
        console.log(`[ENDERECO] Cache atalho: endereço estruturado "${endereco}" → ignorado, re-geocodificando`);
        // cai em bairro e depois Places/Geocoding
      } else {
        const lat = _loop_cliente.ultimo_lat, lng = _loop_cliente.ultimo_lng;
        const r = _zonaParaLatLng(lat, lng);
        if (r) return _cacheEntrega({ ...r, cache: true });
        // Coords salvas não cobrem nenhuma zona ativa → endereço fora da área atual.
        // NÃO cai em fallback por nome: um bairro chamado "Betim" poderia existir sem
        // ter qualquer relação geográfica com a localização do cliente.
        console.log(`[ENDERECO] Cache atalho: coords salvas (${lat},${lng}) não cobrem zona ativa → fora_zona`);
        return { ok: false, motivo: 'fora_zona', endereco_formatado: _loop_cliente.ultimo_endereco };
      }
    }

    // ── Tenta bairro por nome (sem API) ──────────────────────────────────────
    const bairroMatch = cardapio.bairros.find(b => endNorm.includes(_normalizar(b.nome)));
    if (bairroMatch) {
      return _cacheEntrega({ ok: true, bairro: bairroMatch.nome, taxa: bairroMatch.taxa, taxa_texto: bairroMatch.taxa > 0 ? _fmtBRL(bairroMatch.taxa) : 'Grátis', tempo_min: bairroMatch.tempo_min, tempo_max: bairroMatch.tempo_max, tempo_texto: `${bairroMatch.tempo_min}–${bairroMatch.tempo_max} min` });
    }

    // ── Resolução via Google Maps (Places Text Search + Geocoding fallback) ──
    const mapsKey = await db.getConfig('google_maps_key').catch(() => null);
    if (mapsKey) {
      // Extrai cidade-base do config.
      // Suporta endereços com ". " como separador (ex: "Rua X, 25. São Francisco do Sul")
      // além do separador por "," (ex: "Rua X, 123, Bairro Y, Cidade").
      const lojaEnd    = (await db.getConfig('loja_endereco').catch(() => null) || '');
      const cidadeBase = (await db.getConfig('loja_cidade').catch(() => null))
        || (() => {
          // Tenta separador ". " primeiro (número + ponto + espaço + cidade)
          const partesPonto  = lojaEnd.split(/\.\s+/);
          if (partesPonto.length > 1) {
            const ult = partesPonto[partesPonto.length - 1].trim();
            if (ult.length > 2 && /^[A-Za-zÀ-ÿ\s]+$/.test(ult)) return ult;
          }
          // Tenta separador "," (último token)
          const partesVirgula = lojaEnd.split(',');
          if (partesVirgula.length > 1) {
            const ult = partesVirgula[partesVirgula.length - 1].trim();
            if (ult.length > 2 && /^[A-Za-zÀ-ÿ\s]+$/.test(ult)) return ult;
          }
          return '';
        })()
        || '';

      const temCidadeNoEndereco = cidadeBase && endNorm.includes(_normalizar(cidadeBase));
      const queryComCidade      = (cidadeBase && !temCidadeNoEndereco)
        ? `${endereco}, ${cidadeBase}`
        : endereco;

      // ── Coordenadas e UF da loja (para locationbias e desambiguação) ─────────
      const lojaLat = parseFloat(await db.getConfig('loja_lat').catch(() => null)) || null;
      const lojaLng = parseFloat(await db.getConfig('loja_lng').catch(() => null)) || null;

      // Extrai sigla da UF do endereço da loja (ex: "- SC," ou "SC 89240")
      const _ufRegex = /\b(AC|AL|AP|AM|BA|CE|DF|ES|GO|MA|MT|MS|MG|PA|PB|PR|PE|PI|RJ|RN|RS|RO|RR|SC|SP|SE|TO)\b/i;

      // Extrai UF de um formatted_address via regex (fallback)
      const _extrairUF = (addr) => (_ufRegex.exec(addr || ''))?.[1]?.toUpperCase() || null;

      // Extrai UF de address_components (mais confiável que regex no formatted_address)
      const _extrairUFComp = (comps) => {
        if (!Array.isArray(comps)) return null;
        const state = comps.find(c => c.types?.includes('administrative_area_level_1'));
        return state?.short_name?.toUpperCase() || null;
      };

      // lojaUF: tenta cache de sessão → config → regex → reverse geocode (1 vez)
      let lojaUF = _lojaUFCache
        || (await db.getConfig('loja_uf').catch(() => null))?.toUpperCase()
        || (_ufRegex.exec(lojaEnd) || _ufRegex.exec(cidadeBase))?.[1]?.toUpperCase()
        || null;

      if (!lojaUF && lojaLat && lojaLng) {
        // Reverse geocode da loja para determinar o estado (1 vez por processo)
        try {
          const rgUrl = `https://maps.googleapis.com/maps/api/geocode/json?latlng=${lojaLat},${lojaLng}&result_type=administrative_area_level_1&language=pt-BR&key=${mapsKey}`;
          const rgResp = await fetch(rgUrl, { signal: AbortSignal.timeout(5000) });
          const rgData = await rgResp.json();
          if (rgData.status === 'OK' && rgData.results[0]) {
            lojaUF = _extrairUFComp(rgData.results[0].address_components) || _extrairUF(rgData.results[0].formatted_address);
            if (lojaUF) {
              _lojaUFCache = lojaUF; // cache em memória (dura até reiniciar o processo)
              db.setConfig('loja_uf', lojaUF).catch(e => console.error('[AGENTE] falha em setConfig(loja_uf):', e.message)); // persiste para próximas reinicializações
              console.log(`[ENDERECO] lojaUF detectado via reverse geocode: ${lojaUF} (salvo em config)`);
            }
          }
        } catch (e) {
          console.warn('[ENDERECO] Reverse geocode loja falhou:', e.message);
        }
      } else if (lojaUF && !_lojaUFCache) {
        _lojaUFCache = lojaUF; // popula cache em memória se veio de config/regex
      }

      // Normaliza tipo de logradouro para comparação (Av./Avenida → "avenida", Tv. → "travessa", etc.)
      const _normTipo = (s) => {
        if (!s) return null;
        const t = _normalizar(s).replace(/\.\s*$/, '').trim();
        if (t === 'av' || t === 'av.') return 'avenida';
        if (t === 'tv' || t === 'tv.') return 'travessa';
        if (t === 'r.' || t === 'r') return 'rua';
        if (t === 'est.' || t === 'est') return 'estrada';
        if (t === 'rod.' || t === 'rod') return 'rodovia';
        return t;
      };
      // Extrai tipo de logradouro do início de um endereço (ex: "Av. Amazonas, 30" → "avenida")
      const _extrairTipo = (end) => {
        const m = /^(rua|av(?:enida)?\.?\s*|praça|alameda|travessa|tv\.?\s*|estrada|est\.?\s*|rodovia|rod\.?\s*|r\.\s*)/i.exec(end.trim());
        return m ? _normTipo(m[1].trim()) : null;
      };

      // ── ENDEREÇO ESTRUTURADO (rua/av/travessa + nome): Geocoding com component filter ─
      // Places Text Search retorna estabelecimentos para nomes de rua (escola "Antenor
      // Sprotte", CEI "Antenor Sprotte") causando rejeições falsas de ruas reais.
      // Geocoding com components=locality filtra para a cidade da loja e devolve
      // route/street_address confiáveis. Para nomes de lugar → Places abaixo.
      if (_ehEstruturado(endereco)) {
        try {
          const comps = [
            cidadeBase ? `locality:${cidadeBase}` : null,
            lojaUF     ? `administrative_area:${lojaUF}` : null,
            'country:BR',
          ].filter(Boolean).join('|');
          const geoUrl = `https://maps.googleapis.com/maps/api/geocode/json?address=${encodeURIComponent(queryComCidade)}&components=${encodeURIComponent(comps)}&region=br&language=pt-BR&key=${mapsKey}`;
          console.log(`[ENDERECO] Geocoding logradouro: "${queryComCidade}" components="${comps}"`);
          const gResp = await fetch(geoUrl, { signal: AbortSignal.timeout(6000) });
          const gData = await gResp.json();

          if (gData.status === 'OK' && gData.results.length > 0) {
            const res   = gData.results[0];
            const tipos = res.types || [];
            // Aceita route, street_address, premise, subpremise (localizações físicas na via).
            // Rejeita establishment, school, point_of_interest — estabelecimentos que
            // levam o nome da rua mas não são a rua em si.
            const ehLogradouro = tipos.some(t =>
              ['route', 'street_address', 'premise', 'subpremise'].includes(t)
            );
            const locType = res.geometry?.location_type;
            const parcial = res.partial_match === true;

            if (ehLogradouro) {
              // Quando partial_match=true o Google adaptou o endereço. Verifica se os
              // nomes próprios do logradouro PEDIDO aparecem no RETORNADO para evitar
              // aceitar rua completamente diferente (ex: "Cristiano Machado" ≠ "Fernando Machado").
              if (parcial) {
                // Palavras vazias a ignorar na comparação de nomes de via
                const STOP = new Set(['de','da','do','das','dos','e','a','o','as','os','em','na','no']);
                // Extrai nomes próprios do logradouro (sem tipo e sem número)
                const _palavrasVia = (end) => _normalizar(
                  end.trim()
                    .replace(/^(rua|avenida|av\.?\s*|praça|alameda|travessa|tv\.?\s*|estrada|rodovia|rod\.?\s*|r\.\s*)/i, '')
                    .replace(/[\d,\-\.].*/,'')
                    .trim()
                ).split(/\s+/).filter(w => w.length > 1 && !STOP.has(w));

                const palavrasPedidas   = _palavrasVia(endereco);
                const palavrasRetornadas = _palavrasVia(res.formatted_address);
                // Todo nome próprio pedido deve aparecer no resultado
                const naoEncontradas = palavrasPedidas.filter(w => !palavrasRetornadas.includes(w));

                if (naoEncontradas.length > 0) {
                  console.log(`[ENDERECO] Geocoding logradouro partial_match rejeitado — pedido="${palavrasPedidas.join(' ')}", retornado="${palavrasRetornadas.join(' ')}", ausentes=[${naoEncontradas}], resultado="${res.formatted_address}" → nao_confere`);
                  return { ok: false, motivo: 'nao_confere', endereco_interpretado: res.formatted_address };
                }
                console.log(`[ENDERECO] Geocoding logradouro partial_match aceito — pedido="${palavrasPedidas.join(' ')}" ⊂ retornado="${palavrasRetornadas.join(' ')}", resultado="${res.formatted_address}"`);
              } else {
                console.log(`[ENDERECO] Geocoding logradouro aceito — types=[${tipos}], locType=${locType}, partial=${parcial}, resultado="${res.formatted_address}"`);
              }
              const loc = res.geometry.location;
              const r   = _zonaParaLatLng(loc.lat, loc.lng);
              if (r) return _cacheEntrega(r);
              return { ok: false, motivo: 'fora_zona', endereco_formatado: res.formatted_address };
            }
            console.log(`[ENDERECO] Geocoding logradouro rejeitado — types=[${tipos}] não é logradouro, resultado="${res.formatted_address}" → nao_localizado`);
          } else {
            console.log(`[ENDERECO] Geocoding logradouro status=${gData.status} para "${queryComCidade}" → nao_localizado`);
          }
        } catch (e) {
          console.warn('[ENDERECO] Geocoding logradouro falhou:', e.message);
        }
        // Não encontrado via Geocoding → pede confirmação ou PIN
        return { ok: false, motivo: 'nao_localizado', mensagem: 'Não encontrei esse endereço na nossa área de entrega. Pode confirmar a rua e número, ou nos mandar sua localização pelo 📎 do WhatsApp?' };
      }

      // ── NOME DE LUGAR (bar, restaurante, ponto de referência): Places Text Search ─
      // Resolve "Bar do Banana", "Koch Ubatuba", "em frente ao posto" etc.
      // Desambiguação por proximidade à loja — o código escolhe, nunca a IA.
      try {
        // locationbias (circle) prioriza resultados próximos da loja no ranking do Google
        const bias = (lojaLat && lojaLng) ? `&locationbias=circle:30000@${lojaLat},${lojaLng}` : '';
        const placesUrl = `https://maps.googleapis.com/maps/api/place/textsearch/json?query=${encodeURIComponent(queryComCidade)}&language=pt-BR&region=br${bias}&key=${mapsKey}`;
        console.log(`[ENDERECO] Places Text Search: "${queryComCidade}" bias=${lojaLat ? `${lojaLat},${lojaLng}` : 'sem'}`);
        const resp  = await fetch(placesUrl, { signal: AbortSignal.timeout(6000) });
        const pData = await resp.json();
        const total = pData.results?.length ?? 0;

        if (pData.status === 'OK' && total > 0) {
          // Filtra candidatos por UF da loja (descarta outras UFs quando loja tem UF conhecida)
          const candidatos = pData.results.filter(hit => {
            if (!lojaUF) return true; // sem UF da loja → aceita todos
            const ufHit = _extrairUFComp(hit.address_components) || _extrairUF(hit.formatted_address);
            return !ufHit || ufHit === lojaUF; // aceita resultado sem UF identificável ou mesma UF
          });

          // Entre os candidatos, pega o mais próximo da loja por Haversine
          let melhor = null;
          if (candidatos.length > 0 && lojaLat && lojaLng) {
            let menorDist = Infinity;
            for (const hit of candidatos) {
              const loc  = hit.geometry?.location;
              if (!loc) continue;
              const dist = _haversine(lojaLat, lojaLng, loc.lat, loc.lng);
              if (dist < menorDist) { menorDist = dist; melhor = { hit, dist }; }
            }
            // Rejeita se o mais próximo ainda estiver > 50 km (fora da região)
            if (melhor && melhor.dist > 50000) {
              console.log(`[ENDERECO] Places Text Search — ${total} candidato(s), ${candidatos.length} na UF, mais próximo a ${(melhor.dist/1000).toFixed(1)}km (> 50km → fora da região)`);
              melhor = null;
            } else if (melhor) {
              console.log(`[ENDERECO] Places Text Search → ${total} candidato(s), ${candidatos.length} na UF ${lojaUF||'?'}, escolhido "${melhor.hit.name || melhor.hit.formatted_address}" a ${(melhor.dist/1000).toFixed(1)}km da loja`);
            }
          } else if (candidatos.length > 0) {
            // Sem coords da loja: pega o primeiro candidato na UF
            melhor = { hit: candidatos[0], dist: null };
            console.log(`[ENDERECO] Places Text Search → ${total} candidato(s), ${candidatos.length} na UF ${lojaUF||'?'}, escolhido "${melhor.hit.name || melhor.hit.formatted_address}" (sem coords loja)`);
          } else {
            console.log(`[ENDERECO] Places Text Search → ${total} candidato(s), nenhum na UF ${lojaUF} — rejeitando`);
          }

          if (melhor) {
            const { hit } = melhor;
            // Para endereço estruturado: verifica tipo E nome da rua no resultado.
            // Places não retorna partial_match, então checar o formatted_address é a única forma.
            if (_ehEstruturado(endereco)) {
              const nomeRuaQuery = _nomeRua(endereco);
              const addrNorm     = _normalizar(hit.formatted_address);
              const ruaAusente   = nomeRuaQuery && !addrNorm.includes(nomeRuaQuery);
              const tipoQuery    = _extrairTipo(endereco);
              const tipoResult   = _extrairTipo(hit.name || hit.formatted_address);
              const tipoErrado   = tipoQuery && tipoResult && tipoQuery !== tipoResult;
              if (tipoErrado) {
                console.log(`[ENDERECO] Places: tipo "${tipoQuery}"≠"${tipoResult}" em "${hit.formatted_address}" → nao_confere (não cachear)`);
                return { ok: false, motivo: 'nao_confere', endereco_interpretado: hit.formatted_address };
              }
              if (ruaAusente) {
                console.log(`[ENDERECO] Places: rua "${nomeRuaQuery}" ausente em "${hit.formatted_address}" → nao_localizado (não cachear)`);
                return { ok: false, motivo: 'nao_localizado', endereco_interpretado: hit.formatted_address };
              }
            }
            const loc = hit.geometry.location;
            const r   = _zonaParaLatLng(loc.lat, loc.lng);
            if (r) return _cacheEntrega({ ...r, endereco_formatado: hit.formatted_address });
            return { ok: false, motivo: 'fora_zona', endereco_formatado: hit.formatted_address };
          }
          // Nenhum candidato válido na região → cai no Geocoding ou pede endereço completo
        } else {
          console.log(`[ENDERECO] Places Text Search status=${pData.status} para "${queryComCidade}"`);
        }
      } catch (e) {
        console.warn('[ENDERECO] Places Text Search falhou:', e.message);
      }

      // ── 2ª tentativa: Geocoding API ───────────────────────────────────────
      // Fallback para endereços estruturados quando Places não encontrou.
      try {
        console.log(`[ENDERECO] Geocoding: "${queryComCidade}"`);
        const url   = `https://maps.googleapis.com/maps/api/geocode/json?address=${encodeURIComponent(queryComCidade)}&region=br&key=${mapsKey}`;
        const resp  = await fetch(url, { signal: AbortSignal.timeout(6000) });
        const gData = await resp.json();

        if (gData.status === 'OK' && gData.results[0]) {
          const res     = gData.results[0];
          const locType = res.geometry?.location_type;
          const parcial = res.partial_match === true;

          if (_ehEstruturado(endereco)) {
            // Endereço estruturado: rejeita qualquer match fraco, rua diferente ou tipo diferente.
            const nomeRuaQuery = _nomeRua(endereco);
            const addrNorm     = _normalizar(res.formatted_address);
            const ruaAusente   = nomeRuaQuery && !addrNorm.includes(nomeRuaQuery);
            const tipoQuery    = _extrairTipo(endereco);
            const tipoResult   = _extrairTipo(res.formatted_address);
            const tipoErrado   = tipoQuery && tipoResult && tipoQuery !== tipoResult;
            if (tipoErrado) {
              console.log(`[ENDERECO] Geocoding rejeitado — tipo "${tipoQuery}"≠"${tipoResult}" em "${res.formatted_address}" → nao_confere`);
              return { ok: false, motivo: 'nao_confere', endereco_interpretado: res.formatted_address };
            }
            if (parcial || locType === 'APPROXIMATE' || ruaAusente) {
              console.log(`[ENDERECO] Geocoding rejeitado — estruturado, type=${locType}, partial=${parcial}, rua="${nomeRuaQuery}" em "${res.formatted_address}" → nao_localizado`);
              return { ok: false, motivo: 'nao_localizado', endereco_interpretado: res.formatted_address };
            }
          } else if (locType === 'APPROXIMATE' && parcial) {
            // Nome de lugar: mantém filtro anterior (menos restritivo — aproximação é aceitável)
            console.log(`[ENDERECO] Geocoding impreciso (type=${locType}, partial=${parcial}) para "${queryComCidade}"`);
            return { ok: false, motivo: 'nao_localizado', endereco_interpretado: res.formatted_address };
          }

          console.log(`[ENDERECO] Geocoding aceito — type=${locType}, partial=${parcial}, resultado="${res.formatted_address}"`);
          const loc = res.geometry.location;
          const r   = _zonaParaLatLng(loc.lat, loc.lng);
          if (r) return _cacheEntrega(r);
          return { ok: false, motivo: 'fora_zona', endereco_formatado: res.formatted_address };
        }
        console.log(`[ENDERECO] Geocoding status=${gData.status} para "${queryComCidade}"`);
      } catch (e) {
        console.warn('[ENDERECO] Geocoding falhou:', e.message);
      }
    }

    return { ok: false, motivo: 'nao_localizado', mensagem: 'Não encontrei esse lugar na nossa região de entrega. Pode informar o endereço completo (rua, número e bairro)?' };
  }

  // ── fechar_pedido ──
  if (nomeTool === 'fechar_pedido') {
    if (!carrinho.length) return { erro: 'O carrinho está vazio. Adicione itens antes de fechar o pedido.' };

    // ── Rede de segurança: consolida duplicatas antes de fechar ─────────────
    const carrinhoConsolidado = _consolidarCarrinho(carrinho);
    if (carrinhoConsolidado.length !== carrinho.length) {
      console.warn(`[CARRINHO] ${numero} fechar_pedido: consolidou ${carrinho.length} → ${carrinhoConsolidado.length} linhas`);
      _carrinhos.set(numero, carrinhoConsolidado);
      carrinho.splice(0, carrinho.length, ...carrinhoConsolidado);
    }

    // ── Rede de segurança: produto pode ter ficado esgotado após entrar no carrinho (causa-5) ──
    // Usa o cache de cardápio (TTL 5 min) — zero custo se já foi chamado nesta sessão.
    try {
      const { produtos: _prodAtual } = await _getCardapio();
      const _esgotadosNoCarrinho = carrinho.filter(it => {
        const prod = _prodAtual.find(p => p.id === it.produto_id);
        return prod?.esgotado === true;
      });
      if (_esgotadosNoCarrinho.length > 0) {
        const nomes = _esgotadosNoCarrinho.map(i => `"${i.nome}"`).join(', ');
        console.warn(`[CARRINHO] ${numero} fechar_pedido: produto(s) esgotado(s) no carrinho: ${nomes}`);
        return {
          erro: `Produto(s) esgotado(s) no carrinho: ${nomes}. Remova antes de fechar o pedido.`,
          instrucao: 'Use remover_item para remover os produtos esgotados e pergunte ao cliente se quer substituir por outro item.',
        };
      }
    } catch (_esgErr) {
      console.warn(`[CARRINHO] ${numero} fechar_pedido: não foi possível verificar esgotados — prosseguindo sem verificação:`, _esgErr.message);
    }

    // ── Validação obrigatória: endereço e forma de pagamento ──────────────────
    if (!args.endereco || !String(args.endereco).trim()) {
      return { erro: 'Endereço não confirmado. Pergunte o endereço completo ao cliente antes de fechar o pedido.' };
    }
    if (!args.forma_pagamento || !String(args.forma_pagamento).trim()) {
      return { erro: 'Forma de pagamento não confirmada. Pergunte ao cliente como vai pagar.' };
    }

    // ── Auto-injeção de asaas_payment_id da sessão (BUG 1: IA esquece de passar) ──
    // Se a forma de pagamento é online e a IA não passou o id, recupera do estado da sessão.
    const _pagOnline = /cartao_online|cartão_online|credit.?card/i.test(args.forma_pagamento);
    const _cobrancaSession = _asaasCobrancaMap.get(numero);
    if (_pagOnline && !args.asaas_payment_id && _cobrancaSession?.status === 'pendente') {
      console.warn(`[TOOL] fechar_pedido: asaas_payment_id ausente para pagamento online — injetando da sessão: ${_cobrancaSession.id}`);
      args.asaas_payment_id = _cobrancaSession.id;
    }

    // ── Log do carrinho no momento de fechar (diagnóstico de divergência) ────
    const subtotalReal = carrinho.reduce((s, i) => s + i.subtotal_item, 0);
    const estadoFechamento = carrinho.map(it => `${it.nome}${it.variacao ? ` (${it.variacao})` : ''} x${it.quantidade} = ${_fmtBRL(it.subtotal_item)}`).join(' | ');
    console.log(`[CARRINHO] ${numero} no fechar_pedido (${carrinho.length} itens): ${estadoFechamento} → subtotal calculado: ${_fmtBRL(subtotalReal)}`);

    // Usa nome do argumento; fallback para cadastro do cliente
    const nomeCliente = (args.nome_cliente || '').trim() || _loop_cliente?.nome || 'Cliente';

    const subtotal = carrinho.reduce((s, i) => s + i.subtotal_item, 0);

    // Taxa de entrega: usa cache de definir_entrega + revalida contra zonas ATIVAS atuais
    let taxa      = 0;
    let bairroStr = null;
    let latPed    = null, lngPed = null;

    const _entregaCache = _entregaMap.get(numero);
    if (!_entregaCache) {
      // Sem cache: definir_entrega não foi chamado nesta sessão → bloqueia
      console.warn(`[CARRINHO] ${numero} fechar_pedido: sem cache de definir_entrega → bloqueando`);
      return {
        erro: 'Endereço de entrega não verificado nesta sessão. Chame definir_entrega com o endereço confirmado pelo cliente antes de fechar o pedido.',
        instrucao: 'Chame definir_entrega com o endereço do cliente antes de prosseguir.',
      };
    }

    const cacheLat = _entregaCache.lat ?? null;
    const cacheLng = _entregaCache.lng ?? null;

    if (cacheLat != null && cacheLng != null) {
      // Revalida: busca zonas frescas do banco (bypass do cache de 5min)
      const zonasAtivas = await db.getZonas().catch(() => []);
      const zonaAtual = zonasAtivas.find(z => z.ativa && _pontoNaZona(cacheLat, cacheLng, z));
      if (!zonaAtual) {
        _entregaMap.delete(numero); // invalida cache para forçar novo definir_entrega
        console.warn(`[CARRINHO] ${numero} fechar_pedido: zona do cache não existe mais (lat=${cacheLat},lng=${cacheLng}) → bloqueando`);
        return {
          erro: 'A zona de entrega para o endereço informado não está mais ativa. Informe o cliente e peça um novo endereço dentro da nossa área de entrega atual.',
          instrucao: 'A zona foi desativada ou excluída. Informe o cliente e chame definir_entrega com um novo endereço válido.',
        };
      }
      // Usa taxa e zona ATUAIS (não do cache — zona pode ter mudado a taxa)
      taxa      = zonaAtual.taxa;
      bairroStr = zonaAtual.nome;
      latPed    = cacheLat;
      lngPed    = cacheLng;
      console.log(`[CARRINHO] ${numero} fechar_pedido: zona revalidada="${zonaAtual.nome}" taxa=R$${taxa.toFixed(2)} ✓`);
    } else {
      // Cache sem lat/lng (resolução por bairro — revalida no banco)
      const bairroNome  = _entregaCache.bairroStr;
      const bairrosAtivos = await db.getBairros().catch(() => []);
      const bairroAtual   = bairrosAtivos.find(b => b.nome === bairroNome);
      if (!bairroAtual) {
        _entregaMap.delete(numero);
        console.warn(`[CARRINHO] ${numero} fechar_pedido: bairro "${bairroNome}" não existe mais → bloqueando`);
        return {
          erro: `O bairro de entrega "${bairroNome}" não está mais ativo. Informe o cliente e peça um novo endereço dentro da nossa área de entrega atual.`,
          instrucao: 'O bairro foi desativado. Informe o cliente e chame definir_entrega novamente.',
        };
      }
      taxa      = bairroAtual.taxa;
      bairroStr = bairroAtual.nome;
      console.log(`[CARRINHO] ${numero} fechar_pedido: bairro revalidado="${bairroAtual.nome}" taxa=R$${taxa.toFixed(2)} ✓`);
    }

    // ── Aplica desconto de promoção ou cupom ─────────────────────────────────
    let promoAplicada = null;
    let desconto      = 0;

    // Tenta cupom primeiro (explícito pelo cliente)
    if (args.cupom_codigo) {
      const codNorm = (args.cupom_codigo || '').trim().toLowerCase();
      const cupomCache = _cupomAceitoMap.get(numero);
      if (cupomCache && (cupomCache.codigo || '').toLowerCase() === codNorm) {
        promoAplicada = cupomCache;
      } else {
        try { promoAplicada = await db.getCupomAtivo(args.cupom_codigo); } catch (_) {}
      }
    }

    // Tenta promoção segmentada (por id)
    if (!promoAplicada && args.promocao_id) {
      try { promoAplicada = await db.getPromocaoPorId(args.promocao_id); } catch (_) {}
    }

    if (promoAplicada?.ativa) {
      const pedidoTotal = subtotal + taxa;
      if (promoAplicada.valor_minimo_pedido != null && pedidoTotal < promoAplicada.valor_minimo_pedido) {
        return {
          erro_promo:  true,
          codigo_erro: 'valor_minimo_nao_atingido',
          mensagem:    `Esta promoção exige pedido mínimo de ${_fmtBRL(promoAplicada.valor_minimo_pedido)}. O total atual é ${_fmtBRL(pedidoTotal)}.`,
          instrucao:   'Informe o cliente sobre o valor mínimo e pergunte se quer adicionar mais itens. NÃO feche o pedido ainda.',
        };
      }
      const totalAntes = subtotal + taxa;
      if (promoAplicada.beneficio_tipo === 'frete_gratis') {
        desconto = taxa;
      } else if (promoAplicada.beneficio_tipo === 'desconto_percentual') {
        desconto = subtotal * ((promoAplicada.beneficio_valor || 0) / 100);
      } else if (promoAplicada.beneficio_tipo === 'desconto_valor') {
        desconto = Math.min(promoAplicada.beneficio_valor || 0, subtotal);
      }
      desconto = Math.round(desconto * 100) / 100;
      console.log(`[PROMO] aplicada '${promoAplicada.nome}' desconto=R$${desconto.toFixed(2)} total: R$${totalAntes.toFixed(2)} → R$${(totalAntes - desconto).toFixed(2)}`);
    }

    const total  = subtotal + taxa - desconto;
    const itens  = carrinho.map(it => {
      const adicionaisArr = it.adicionais_str
        ? it.adicionais_str.split(',').map(s => s.trim()).filter(Boolean)
        : [];
      const parts = [it.variacao, ...adicionaisArr].filter(Boolean);
      return {
        produto_id: it.produto_id,
        nome:       parts.length ? `${it.nome} (${parts.join(', ')})` : it.nome,
        variacao:   it.variacao || null,
        adicionais: adicionaisArr,
        quantidade: it.quantidade,
        preco_unit: it.preco_unit,
        subtotal:   it.subtotal_item,
      };
    });

    let pedido;
    try {
      const statusPedido = args.asaas_payment_id ? 'aguardando_pagamento' : 'preparacao';
      // Usa o endereço VALIDADO pela definir_entrega (geocodificado/reverse geocodificado),
      // não o texto cru da IA. Fallback para args.endereco se cache não tiver formatado.
      const enderecoValidado = _entregaCache.endereco_formatado || args.endereco || '';
      // Safety net final (causa-5): se enderecoValidado ficou vazio apesar dos guards anteriores, bloqueia
      if (!enderecoValidado.trim()) {
        console.error(`[CARRINHO] ${numero} fechar_pedido: enderecoValidado vazio após todos os guards (cache="${_entregaCache.endereco_formatado}", args="${args.endereco}") — bloqueando`);
        return { erro: 'Não foi possível confirmar o endereço de entrega. Peça o endereço completo ao cliente.' };
      }
      pedido = await db.createPedido({
        cliente_nome:       nomeCliente,
        cliente_whatsapp:   numero,
        endereco:           enderecoValidado,
        endereco_formatado: enderecoValidado,
        bairro:             bairroStr,
        itens,
        subtotal,
        taxa_entrega:      taxa,
        total,
        forma_pagamento:   _canonicalizarPagamentoOffline(args.forma_pagamento),
        origem:            'whatsapp',
        status:            statusPedido,
        asaas_payment_id:  args.asaas_payment_id || null,
        lat:               latPed,
        lng:               lngPed,
        observacoes:       args.observacoes || null,
        promocao_id:       promoAplicada?.id || null,
        desconto_aplicado: desconto,
        troco_para:        args.troco_para != null ? +args.troco_para : null,
        bandeira_cartao:   args.bandeira_cartao ? String(args.bandeira_cartao).toLowerCase().trim() : null,
      });
    } catch (e) {
      console.error('[WA-agente] Erro ao criar pedido:', e.message);
      return { erro: 'Falha ao registrar o pedido. Tente novamente.' };
    }

    // Limpa carrinho, cache de entrega e marca cobrança Asaas como fechada
    _carrinhos.set(numero, []);
    _entregaMap.delete(numero);
    await db.upsertConversaWA(numero, { carrinho: '[]' });
    if (_asaasCobrancaMap.has(numero)) {
      _asaasCobrancaMap.get(numero).status = 'fechado';
    }

    // Atualiza cadastro do cliente recorrente
    const zonaFechada = bairroStr || null;
    await upsertClienteWA(numero, {
      nome:            nomeCliente !== 'Cliente' ? nomeCliente : undefined,
      ultimo_endereco: args.endereco,
      ultimo_lat:      latPed || undefined,
      ultimo_lng:      lngPed || undefined,
      ultima_zona:     zonaFechada || undefined,
      incrementar_pedido: true,
    }).catch(e => console.warn('[WA-agente] upsertClienteWA falhou:', e.message));

    // Atualiza agregados de marketing (fire-and-forget — não bloqueia a resposta ao cliente)
    db.recalcularHistoricoCliente(numero).catch(e => console.warn('[WA-agente] recalcularHistoricoCliente falhou:', e.message));

    // Conta quantos pedidos este cliente já fez (incluindo o atual) para exibir na comanda
    const _numPedidoCliente = await db.contarPedidosCliente(numero, pedido.criado_em)
      .catch(() => null);

    // Emite SSE para o kanban aparecer em tempo real
    ceiaEmitter.emit('ceia:sse', {
      tipo: 'pedido_criado',
      data: { pedido_id: pedido.id, codigo: pedido.codigo, origem: 'whatsapp', cliente_nome: nomeCliente, pedido_num_cliente: _numPedidoCliente },
    });

    console.log(`[WA-agente] Pedido #${pedido.codigo} criado via WhatsApp para ${numero}${desconto > 0 ? ` (desconto: ${_fmtBRL(desconto)})` : ''}`);

    const _statusFinal = args.asaas_payment_id ? 'aguardando_pagamento' : 'preparacao';
    // Recupera o link de pagamento do cache da sessão para incluir na resposta ao cliente
    const _cobrancaFechada = _asaasCobrancaMap.get(numero);
    const _linkPagamento   = _cobrancaFechada?.link || null;
    const _msgStatus = _statusFinal === 'aguardando_pagamento'
      ? `Pedido registrado! Aguardando confirmação do pagamento. Assim que confirmar, vai automaticamente para a cozinha.${_linkPagamento ? ` Link de pagamento: ${_linkPagamento}` : ''}`
      : 'Pedido registrado! Estamos preparando seu pedido.';

    const _codEnt = pedido.codigo_entrega || null;
    const _codEntMsg = _codEnt
      ? ` Código de entrega: *${_codEnt}* — guarde e informe ao entregador na hora da entrega.`
      : '';

    const retorno = {
      sucesso:             true,
      codigo:              pedido.codigo,
      codigo_entrega:      _codEnt,
      subtotal:            _fmtBRL(subtotal),
      taxa_entrega:        _fmtBRL(taxa),
      total:               _fmtBRL(total),
      forma_pagamento:     args.forma_pagamento,
      status:              _statusFinal,
      mensagem:            `Pedido #${pedido.codigo} registrado!${desconto > 0 ? ` Desconto de ${_fmtBRL(desconto)} aplicado.` : ''} ${_msgStatus}${_codEntMsg}`,
      link_pagamento:      _linkPagamento,
      pedido_num_cliente:  _numPedidoCliente,
      instrucao_agente: _statusFinal === 'aguardando_pagamento'
        ? `OBRIGATÓRIO: informe ao cliente: "Pedido #${pedido.codigo} registrado! 🎉 Para pagar, acesse o link: ${_linkPagamento || '(link indisponível)'}. Assim que o pagamento for confirmado, seu pedido vai automaticamente para a cozinha.${_codEntMsg}" NÃO diga "preparando".`
        : _codEnt
          ? `OBRIGATÓRIO: informe ao cliente que o pedido está registrado e sendo preparado. Inclua OBRIGATORIAMENTE o código de entrega: "Seu código de entrega é *${_codEnt}* — guarde este número! Você vai precisar informar ao entregador quando receber o pedido."`
          : null,
    };
    if (desconto > 0 && promoAplicada) {
      retorno.desconto_aplicado = _fmtBRL(desconto);
      retorno.beneficio         = _beneficioTexto(promoAplicada);
    }
    return retorno;
  }

  // ── verificar_promocoes_cliente ──
  if (nomeTool === 'verificar_promocoes_cliente') {
    // Já ofereceu nesta sessão → não repete
    if (_promoOferecida.get(numero)) {
      return { promocoes: [], motivo: 'ja_oferecido', instrucao: 'Promoção já foi apresentada nesta conversa. Não ofereça de novo.' };
    }
    try {
      const promos = await db.getPromocoesElegiveisCliente(numero);
      const zonaCliente = _loop_cliente?.zona_frequente || null;
      const elegiveis = promos.filter(p => _promoNaJanela(p) && _promoPermiteZona(p, zonaCliente));
      if (!elegiveis.length) {
        return { promocoes: [], motivo: 'nenhuma_elegivel' };
      }
      // Marca como oferecida (o agente já tem o dado — vai oferecer na próxima resposta)
      _promoOferecida.set(numero, true);
      const result = elegiveis.map(p => ({
        id:             p.id,
        nome:           p.nome,
        descricao:      p.descricao || null,
        beneficio_tipo: p.beneficio_tipo,
        beneficio_texto: _beneficioTexto(p),
        valor_minimo:   p.valor_minimo_pedido ? _fmtBRL(p.valor_minimo_pedido) : null,
      }));
      return {
        promocoes: result,
        instrucao: 'Ofereça UMA promoção de forma natural e breve — como uma dica, não como propaganda. Ex: "Ah, vi que você tem direito a frete grátis hoje 😊 Aplico quando fecharmos!" Se houver mais de uma, escolha a de maior valor. Quando o cliente aceitar, passe o promocao_id para fechar_pedido.',
      };
    } catch (e) {
      console.error('[TOOL] verificar_promocoes_cliente erro:', e.message);
      return { promocoes: [] };
    }
  }

  // ── validar_cupom ──
  if (nomeTool === 'validar_cupom') {
    const codigo = (args.codigo || '').trim();
    if (!codigo) return { valido: false, motivo: 'codigo_vazio' };
    try {
      const cupom = await db.getCupomAtivo(codigo);
      if (!cupom) {
        return { valido: false, motivo: 'nao_encontrado', mensagem: 'Cupom não encontrado ou inativo.' };
      }
      if (!_promoNaJanela(cupom)) {
        return { valido: false, motivo: 'fora_janela', mensagem: 'Este cupom não está válido neste horário ou dia.' };
      }
      // Verifica elegibilidade do cliente
      const clienteCupom = await db.getClienteWA(numero).catch(() => null);
      if (cupom.min_pedidos != null && (!clienteCupom || (clienteCupom.total_pedidos || 0) < cupom.min_pedidos)) {
        return { valido: false, motivo: 'criterio_nao_atendido', mensagem: 'Este cupom não está disponível para você ainda.' };
      }
      if (cupom.dias_sem_pedir != null && clienteCupom?.ultimo_pedido_em) {
        const diasSince = (Date.now() - new Date(clienteCupom.ultimo_pedido_em).getTime()) / 86400000;
        if (diasSince < cupom.dias_sem_pedir) {
          return { valido: false, motivo: 'criterio_nao_atendido', mensagem: 'Este cupom não está disponível para você agora.' };
        }
      }
      if (cupom.min_total_gasto != null && (!clienteCupom || (clienteCupom.total_gasto || 0) < cupom.min_total_gasto)) {
        return { valido: false, motivo: 'criterio_nao_atendido', mensagem: 'Este cupom não está disponível para você ainda.' };
      }
      if (cupom.min_ticket_medio != null && (!clienteCupom || (clienteCupom.ticket_medio || 0) < cupom.min_ticket_medio)) {
        return { valido: false, motivo: 'criterio_nao_atendido', mensagem: 'Este cupom não está disponível para você ainda.' };
      }
      if (Array.isArray(cupom.formas_pagamento) && cupom.formas_pagamento.length > 0) {
        if (!clienteCupom?.forma_pagamento_frequente || !cupom.formas_pagamento.includes(clienteCupom.forma_pagamento_frequente)) {
          return { valido: false, motivo: 'criterio_nao_atendido', mensagem: 'Este cupom não está disponível para você.' };
        }
      }
      if (Array.isArray(cupom.zonas_excluidas) && cupom.zonas_excluidas.length > 0) {
        if (clienteCupom?.zona_frequente && cupom.zonas_excluidas.includes(clienteCupom.zona_frequente)) {
          return { valido: false, motivo: 'zona_excluida', mensagem: 'Este cupom não é válido para sua região.' };
        }
      }
      // Armazena para fechar_pedido
      _cupomAceitoMap.set(numero, cupom);
      return {
        valido:          true,
        nome:            cupom.nome,
        beneficio_tipo:  cupom.beneficio_tipo,
        beneficio_texto: _beneficioTexto(cupom),
        valor_minimo:    cupom.valor_minimo_pedido ? _fmtBRL(cupom.valor_minimo_pedido) : null,
        instrucao:       `Cupom válido! Informe o benefício ao cliente. Ao fechar o pedido, passe cupom_codigo="${codigo}" para fechar_pedido.`,
      };
    } catch (e) {
      console.error('[TOOL] validar_cupom erro:', e.message);
      return { valido: false, motivo: 'erro_interno' };
    }
  }

  // ── acrescentar_item_pedido ──
  if (nomeTool === 'acrescentar_item_pedido') {
    // 1. Localiza o pedido ATIVO mais recente do cliente
    // rastrearPedidoByNumero retorna ORDER BY criado_em DESC — o primeiro elegível é o alvo.
    // Aceita 'preparacao' (não empacotado) e 'aguardando_coleta' (empacotado, prestes a sair).
    // Em ambos os casos o motoboy ainda não coletou. 'em_rota'/'finalizado' → intocável.
    const _STATUS_ACR = new Set(['preparacao', 'aguardando_coleta']);
    const _pedidosAcr = await db.rastrearPedidoByNumero(numero).catch(() => []);
    const _pedidoRastr = _pedidosAcr?.find(p => _STATUS_ACR.has(p.status));
    if (!_pedidoRastr) {
      const _primStatus = _pedidosAcr?.[0]?.status;
      if (_primStatus === 'em_rota' || _primStatus === 'entregue' || _primStatus === 'finalizado') {
        return { ok: false, em_rota: true, erro: 'O pedido já saiu para entrega — não é possível acrescentar. Se desejar, posso abrir um novo pedido.' };
      }
      return { ok: false, erro: 'Não encontrei pedido ativo (em preparação ou aguardando coleta) para acrescentar. Se desejar, inicie um novo pedido.' };
    }

    // 2. Busca pedido completo (rastrear não traz itens/subtotal/id)
    const _pedidoAlvo = await db.getPedidoByCodigo(_pedidoRastr.codigo).catch(() => null);
    if (!_pedidoAlvo) return { ok: false, erro: 'Erro ao carregar dados do pedido. Tente novamente.' };

    // 3. Resolve produto (mesma lógica de adicionar_item)
    let _acrProdId = args.produto_id != null ? Number(args.produto_id) : NaN;
    let _acrProd   = isNaN(_acrProdId) ? null : cardapio.produtos.find(p => Number(p.id) === _acrProdId);
    if (!_acrProd && args.nome) {
      const _acrTokens = _tokensBusca(args.nome);
      const _acrMelhor = cardapio.produtos.filter(p => !p.esgotado)
        .map(p => ({ p, score: _scoreProduto(_acrTokens, p) }))
        .sort((a, b) => b.score - a.score)[0];
      if (_acrMelhor && _acrMelhor.score >= 50) { _acrProd = _acrMelhor.p; _acrProdId = _acrProd.id; }
    }
    if (!_acrProd) return { ok: false, erro: `Produto não encontrado. Use buscar_produto para confirmar o id antes de acrescentar.` };
    if (_acrProd.esgotado) return { ok: false, erro: `"${_acrProd.nome}" está esgotado.` };

    let _acrPreco = (_acrProd.preco_promo != null && _acrProd.preco_promo > 0) ? _acrProd.preco_promo : _acrProd.preco;
    let _acrVar   = null;
    if (_acrProd.tem_variacoes && _acrProd.variacoes.length) {
      if (!args.variacao) return { ok: false, precisa_variacao: true, produto: _acrProd.nome, variacoes: _acrProd.variacoes.map(v => ({ nome: v.nome, preco: v.preco, preco_texto: _fmtBRL(v.preco) })), instrucao: 'Pergunte a variação ao cliente e chame acrescentar_item_pedido novamente.' };
      const _acrVarMatch = _acrProd.variacoes.find(v => _normalizar(v.nome).includes(_normalizar(args.variacao)) || _normalizar(args.variacao).includes(_normalizar(v.nome)));
      if (!_acrVarMatch) return { ok: false, precisa_variacao: true, produto: _acrProd.nome, variacoes: _acrProd.variacoes.map(v => ({ nome: v.nome, preco: v.preco, preco_texto: _fmtBRL(v.preco) })), instrucao: 'Variação não encontrada. Apresente as disponíveis ao cliente.' };
      _acrPreco = _acrVarMatch.preco;
      _acrVar   = _acrVarMatch.nome;
    }
    const _acrQtd      = Math.max(1, args.quantidade || 1);
    const _acrPrecoUnit = _acrPreco;
    const _acrSubtItem  = _acrPrecoUnit * _acrQtd;
    const _acrNomeExib  = _acrVar ? `${_acrProd.nome} (${_acrVar})` : _acrProd.nome;

    // 4. Parse dos itens existentes do pedido (usando dados completos do getPedidoByCodigo)
    let _acrItens = [];
    try { _acrItens = JSON.parse(_pedidoAlvo.itens || '[]'); } catch (_) {}

    // 5. Acrescenta novo item
    _acrItens.push({
      produto_id: _acrProd.id,
      nome:       _acrNomeExib,
      variacao:   _acrVar || null,
      adicionais: null,
      quantidade: _acrQtd,
      preco_unit: _acrPrecoUnit,
      subtotal:   _acrSubtItem,
    });

    // 6. Recalcula totais
    const _acrNovoSubtotal = _acrItens.reduce((s, i) => s + (i.subtotal || i.subtotal_item || 0), 0);
    const _acrNovoTotal    = _acrNovoSubtotal + (_pedidoAlvo.taxa_entrega || 0);

    // 7. Patch no pedido — se estava em aguardando_coleta (pacote), volta pra preparação
    const _acrNoPacote  = !!_pedidoAlvo.pacote_id;
    const _acrPacoteId  = _pedidoAlvo.pacote_id;
    const _acrPatch = { itens: _acrItens, subtotal: _acrNovoSubtotal, total: _acrNovoTotal };
    if (_acrNoPacote) {
      _acrPatch.pacote_id = null;
      _acrPatch.status    = 'preparacao';
    }
    await db.patchPedido(_pedidoAlvo.id, _acrPatch);

    // 8. Se estava em pacote: move o pacote de volta pra 'montando' pra operador revisar
    if (_acrNoPacote && _acrPacoteId) {
      await db.patchPacote(_acrPacoteId, { status: 'montando' }).catch(e =>
        console.warn(`[ACRESCENTAR] falha ao resetar pacote ${_acrPacoteId}:`, e.message)
      );
    }

    // 9. Emite SSE para kanban recarregar (e alerta se estava em pacote)
    ceiaEmitter.emit('ceia:sse', {
      tipo: 'pedido_alterado',
      data: {
        pedido_id:    _pedidoAlvo.id,
        codigo:       _pedidoAlvo.codigo,
        cliente_nome: _pedidoAlvo.cliente_nome || null,
        item_novo:    _acrNomeExib,
        saiu_pacote:  _acrNoPacote,
        novo_total:   _acrNovoTotal,
      },
    });

    console.log(`[ACRESCENTAR] ${numero} — pedido ${_pedidoAlvo.codigo} (${_pedidoRastr.status}): +${_acrQtd}x ${_acrNomeExib}${_acrNoPacote ? ` (saiu do pacote ${_acrPacoteId}, pacote voltou pra montando)` : ''}`);
    return {
      ok:              true,
      pedido_codigo:   _pedidoAlvo.codigo,
      item_adicionado: `${_acrQtd}x ${_acrNomeExib}`,
      novo_subtotal:   _fmtBRL(_acrNovoSubtotal),
      novo_total:      _fmtBRL(_acrNovoTotal),
      instrucao:       `Item acrescentado ao pedido ${_pedidoAlvo.codigo}. Confirme ao cliente. NÃO peça endereço nem pagamento — o pedido já tem essas informações.${_acrNoPacote ? ' O pedido saiu do pacote e voltou para preparação — o operador foi alertado.' : ''}`,
    };
  }

  // ── limpar_carrinho ──
  if (nomeTool === 'limpar_carrinho') {
    const qtd = carrinho.length;
    _carrinhos.set(numero, []);
    _asaasCobrancaMap.delete(numero); // reset cobrança pendente junto com o carrinho
    // NÃO apaga _entregaMap: o endereço validado é independente do carrinho.
    // Se o cliente der novo endereço, definir_entrega vai sobrescrever o cache.
    // TODO(causa-2): considerar propagar/alertar — falha aqui deixa carrinho stale no DB ao fechar pedido
    await db.upsertConversaWA(numero, { carrinho: '[]' }).catch(e => console.error('[AGENTE] falha em upsertConversaWA (limpar_carrinho):', e.message));
    console.log(`[CARRINHO] ${numero} limpar_carrinho: ${qtd} item(ns) removidos`);
    return {
      limpo:   true,
      mensagem: qtd > 0
        ? `Carrinho zerado (${qtd} item(ns) removidos). Pode começar um novo pedido!`
        : 'Carrinho já estava vazio. Pode fazer seu pedido!',
    };
  }

  // ── rastrear_pedido ──
  if (nomeTool === 'rastrear_pedido') {
    const pedidos = await db.rastrearPedidoByNumero(numero).catch(() => []);
    if (!pedidos.length) {
      return { sem_pedido: true };
    }
    const STATUS_LABEL = {
      aguardando_pagamento: 'aguardando confirmação do pagamento',
      preparacao:           'sendo preparado na cozinha',
      aguardando_coleta:    'pronto, aguardando o motoboy',
      em_rota:              'saiu para entrega',
      entregue:             'entregue',
    };
    // Pega o pedido mais recente não-entregue, ou o mais recente absoluto
    const pedido = pedidos.find(p => p.status !== 'entregue') || pedidos[0];

    // Formata hora de saída como HH:MM (campo despachado_em no formato "YYYY-MM-DD HH:MM:SS")
    const saiu_em = pedido.despachado_em
      ? pedido.despachado_em.substring(11, 16)
      : null;
    // Primeiro nome do motoboy
    const motoboy = pedido.motoboy_nome
      ? pedido.motoboy_nome.split(' ')[0]
      : null;

    const base = {
      codigo:          pedido.codigo,
      status:          pedido.status,
      status_descricao: STATUS_LABEL[pedido.status] || pedido.status,
      codigo_entrega:  pedido.codigo_entrega || null,
      saiu_em,
      motoboy,
    };

    // Para status != em_rota: retorna só o básico
    if (pedido.status !== 'em_rota') {
      console.log(`[TOOL] rastrear_pedido: numero=${numero} → status=${pedido.status}`);
      return base;
    }

    // em_rota — localização do motoboy
    const mbLat = pedido.mb_lat, mbLng = pedido.mb_lng;
    const ultimaAtualizacao = pedido.mb_ultima_atualizacao;

    // Sem lat/lng do motoboy — rastreamento genuinamente indisponível
    if (!mbLat || !mbLng) {
      console.log(`[TOOL] rastrear_pedido: numero=${numero} → em_rota, motoboy sem localização`);
      return { ...base, rastreio_indisponivel: true, motivo: 'sem_localizacao' };
    }

    // Checa frescor da localização (> 3 minutos → loc_fresca=false)
    let loc_fresca = true;
    if (ultimaAtualizacao) {
      const diffMs = Date.now() - new Date(ultimaAtualizacao + 'Z').getTime();
      if (diffMs > 3 * 60 * 1000) loc_fresca = false;
    } else {
      loc_fresca = false;
    }

    // Sem localização fresca — retorna sem tentar geocode (dado seria enganoso)
    if (!loc_fresca) {
      console.log(`[TOOL] rastrear_pedido: numero=${numero} → em_rota, loc não fresca`);
      return { ...base, loc_fresca: false };
    }

    // Reverse geocoding: descobre onde o motoboy está agora.
    // 1ª fonte: Places Nearby (principal — única que retorna nome de comércio).
    // 2ª fonte: Geocoding reverso → rua/bairro (fallback quando sem estabelecimento).
    const mapsKey = await db.getConfig('google_maps_key').catch(() => null);
    let ref_local = null;

    if (!mapsKey) {
      console.log('[TOOL] rastrear_pedido: sem google_maps_key — ref_local indisponível');
    } else {
      // ── 1ª tentativa: Places Nearby (radius 500 m) ───────────────────────────
      // Tipos que NÃO são estabelecimento real (cidade, bairro, rota, etc.)
      const SKIP_TYPES = new Set([
        'locality', 'political', 'sublocality', 'sublocality_level_1', 'sublocality_level_2',
        'neighborhood', 'route', 'administrative_area_level_1', 'administrative_area_level_2',
        'administrative_area_level_3', 'country', 'postal_code', 'postal_town',
        'plus_code', 'natural_feature',
      ]);
      try {
        const nearbyUrl = `https://maps.googleapis.com/maps/api/place/nearbysearch/json?location=${mbLat},${mbLng}&radius=500&language=pt-BR&key=${mapsKey}`;
        const resp = await fetch(nearbyUrl, { signal: AbortSignal.timeout(5000) });
        const data = await resp.json();
        const total = data.results?.length ?? 0;
        console.log(`[TOOL] rastrear_pedido: Places Nearby status=${data.status} results=${total}`);

        if (data.status === 'OK' && total > 0) {
          // Aceita apenas resultados com "establishment" ou "point_of_interest" no types
          const candidatos = data.results.filter(r =>
            r.name &&
            r.geometry?.location &&
            (r.types.includes('establishment') || r.types.includes('point_of_interest')) &&
            !r.types.every(t => SKIP_TYPES.has(t))
          );

          if (candidatos.length > 0) {
            // Places não ordena por distância — calcula Haversine e pega o mais próximo
            let melhor = null, menorDist = Infinity;
            for (const c of candidatos) {
              const dist = _haversine(mbLat, mbLng, c.geometry.location.lat, c.geometry.location.lng);
              if (dist < menorDist) { menorDist = dist; melhor = c; }
            }
            ref_local = `perto de ${melhor.name}`;
            console.log(`[TOOL] rastrear_pedido: Places Nearby → ${candidatos.length} candidato(s), escolhido "${melhor.name}" a ${Math.round(menorDist)}m`);
          } else {
            console.log(`[TOOL] rastrear_pedido: Places Nearby — ${total} result(s), nenhum é estabelecimento`);
          }
        }
      } catch (e) {
        console.warn('[TOOL] rastrear_pedido: Places Nearby falhou:', e.message);
      }

      // ── 2ª tentativa: Geocoding reverso — rua + bairro (fallback) ────────────
      if (!ref_local) {
        try {
          const geoUrl = `https://maps.googleapis.com/maps/api/geocode/json?latlng=${mbLat},${mbLng}&language=pt-BR&key=${mapsKey}`;
          const resp = await fetch(geoUrl, { signal: AbortSignal.timeout(5000) });
          const data = await resp.json();
          if (data.status === 'OK' && data.results?.length) {
            const comps  = data.results[0].address_components;
            const rua    = comps.find(c => c.types.includes('route'))?.long_name;
            const bairro = comps.find(c =>
              c.types.includes('sublocality_level_1') ||
              c.types.includes('sublocality') ||
              c.types.includes('neighborhood')
            )?.long_name;
            const cidade = comps.find(c =>
              c.types.includes('administrative_area_level_2') ||
              c.types.includes('locality')
            )?.long_name;

            if (rua && bairro) ref_local = `na ${rua}, bairro ${bairro}`;
            else if (rua)      ref_local = `na ${rua}`;
            else if (bairro)   ref_local = `no bairro ${bairro}`;
            else if (cidade)   ref_local = `em ${cidade}`;

            if (ref_local) console.log(`[TOOL] rastrear_pedido: Geocoding reverso → "${ref_local}"`);
          }
        } catch (e) {
          console.warn('[TOOL] rastrear_pedido: Geocoding reverso falhou:', e.message);
        }
      }
    }

    console.log(`[TOOL] rastrear_pedido: numero=${numero} → em_rota loc_fresca=${loc_fresca} ref_local="${ref_local}"`);
    return { ...base, loc_fresca, ref_local };
  }

  // ── consultar_status_pedido (legado) ──
  if (nomeTool === 'consultar_status_pedido') {
    return { erro: 'Use rastrear_pedido.' };
  }

  // ── abrir_chamado ──
  if (nomeTool === 'abrir_chamado') {
    try {
      // Para a IA desse número imediatamente
      await db.upsertConversaWA(_loop_numero, { modo_manual: 1 });
      // Cria registro de chamado
      const chamado = await db.createChamado({
        numero:       _loop_numero,
        nome_cliente: args.nome_cliente || null,
        motivo:       args.motivo || 'Solicitou atendimento humano',
      });
      // Notifica a UI via SSE
      ceiaEmitter.emit('ceia:sse', {
        tipo: 'CHAMADO_ABERTO',
        data: { id: chamado.id, numero: _loop_numero, nome: args.nome_cliente || null, motivo: chamado.motivo },
      });
      // Sinaliza para o loop encerrar com mensagem fixa (não passa pela IA)
      _loop_chamado_aberto = _pick(MSGS_CHAMADO_ABERTO);
      console.log(`[WA-agente] Chamado #${chamado.id} aberto para ${_loop_numero}`);
      return { sucesso: true };
    } catch (e) {
      console.error('[WA-agente] Erro ao abrir chamado:', e.message);
      return { erro: 'Falha ao abrir chamado.' };
    }
  }

  // ── gerar_cobranca_asaas ──
  if (nomeTool === 'gerar_cobranca_asaas') {
    const asaasKey = await db.getConfig('asaas_key').catch(() => null);
    if (!asaasKey) return { erro: 'Chave Asaas não configurada. Configure em Configurações → Chaves de API.' };

    // Detecta ambiente pelo prefixo da chave (fonte da verdade)
    const baseUrl = asaasKey.startsWith('$aact_prod_')
      ? 'https://api.asaas.com/v3'
      : 'https://sandbox.asaas.com/api/v3';
    const asaasEnv = asaasKey.startsWith('$aact_prod_') ? 'producao' : 'sandbox';

    const valor = parseFloat(args.valor) || 0;
    if (valor <= 0) return { erro: 'Valor inválido para cobrança Asaas.' };

    // ── Anti-duplicação: reusa cobrança pendente da sessão ────────────────────
    const cobrancaExistente = _asaasCobrancaMap.get(numero);
    if (cobrancaExistente && cobrancaExistente.status === 'pendente') {
      console.log(`[ASAAS] ⚠ Reusando cobrança existente da sessão: id=${cobrancaExistente.id} (evitando duplicata)`);
      const instrucaoReuso = cobrancaExistente.qr_code
        ? `Cobrança já gerada. Reenvie ao cliente:\n1. Link: ${cobrancaExistente.link}\n2. PIX Copia e Cola: ${cobrancaExistente.qr_code}\nChame fechar_pedido com asaas_payment_id="${cobrancaExistente.id}".`
        : `Cobrança já gerada. Reenvie ao cliente o link: ${cobrancaExistente.link}\nChame fechar_pedido com asaas_payment_id="${cobrancaExistente.id}".`;
      return { sucesso: true, id_cobranca: cobrancaExistente.id, link: cobrancaExistente.link, qr_code: cobrancaExistente.qr_code || null, valor: cobrancaExistente.valor, instrucao: instrucaoReuso, reutilizado: true };
    }

    const nomeCliente = args.nome_cliente || 'Cliente';

    // Asaas exige valor mínimo de R$ 5,00 para paymentLinks
    const VALOR_MINIMO_ASAAS = 5.00;
    if (valor < VALOR_MINIMO_ASAAS) {
      console.warn(`[ASAAS] valor R$${valor.toFixed(2)} abaixo do mínimo (R$5,00) — ajustando para R$5,00`);
    }
    const valorAsaas = Math.max(valor, VALOR_MINIMO_ASAAS);

    try {
      // ── Usa paymentLink DETACHED com billingType UNDEFINED ───────────────────
      // billingType UNDEFINED = cliente escolhe PIX ou cartão no checkout.
      // chargeType DETACHED   = checkout público sem exigir login na conta Asaas.
      // NÃO usar billingType específico (PIX/CREDIT_CARD) pois pode redirecionar
      // para tela de login. UNDEFINED abre checkout neutro sem redirecionamento.
      const plResp = await fetch(`${baseUrl}/paymentLinks`, {
        method:  'POST',
        headers: { 'access_token': asaasKey, 'Content-Type': 'application/json' },
        body:    JSON.stringify({
          name:             args.descricao || 'Pedido delivery',
          billingType:      'UNDEFINED',
          chargeType:       'DETACHED',
          value:            valorAsaas,
          description:      args.descricao || 'Pedido delivery',
          dueDateLimitDays: 3,
        }),
        signal: AbortSignal.timeout(10_000),
      });
      const plData = await plResp.json().catch(() => ({}));
      if (!plResp.ok) {
        const errDetail = JSON.stringify(plData);
        console.error(`[ASAAS] Erro ao criar paymentLink HTTP=${plResp.status} body=${errDetail}`);
        const errMsg = plData.errors?.[0]?.description || plData.description || plData.error || `HTTP ${plResp.status}`;
        return { erro: `Falha ao gerar link Asaas: ${errMsg}` };
      }

      // plData.url é a URL de admin/gerenciamento (requer login) —
      // plData.shortUrl é o checkout público. Se ausente, constrói do id.
      const _checkoutBase = asaasKey.startsWith('$aact_prod_')
        ? 'https://www.asaas.com/c/'
        : 'https://sandbox.asaas.com/c/';
      const link = plData.shortUrl || (plData.id ? `${_checkoutBase}${plData.id}` : null);

      console.log(`[ASAAS] cobrança criada: id=${plData.id} valor=R$${valorAsaas.toFixed(2)} env=${asaasEnv} shortUrl=${plData.shortUrl} url=${plData.url} → checkout=${link}`);
      _asaasCobrancaMap.set(numero, { id: plData.id, link, qr_code: null, valor: valorAsaas, forma: 'UNDEFINED', status: 'pendente' });

      const instrucao = `Link de pagamento gerado. Envie ao cliente: ${link}\nAo abrir, o cliente escolhe PIX ou cartão e paga diretamente — sem criar conta no Asaas. Depois chame fechar_pedido com asaas_payment_id="${plData.id}".`;

      return { sucesso: true, link, id_cobranca: plData.id, forma: 'UNDEFINED', valor: valorAsaas, instrucao };
    } catch (e) {
      console.error('[ASAAS] Erro ao gerar cobrança:', e.message);
      return { erro: 'Falha ao conectar com Asaas. Verifique a chave de API e tente novamente.' };
    }
  }

  return { erro: `Tool desconhecida: ${nomeTool}` };
}

// ── Loop do agente (agentic loop com tool calling) ────────────────────────────
// Palavras que indicam que o cliente está perguntando/pedindo produtos
const _PRODUTO_KEYWORDS = /\b(tem|temos|qual|quais|o que|cardapio|cardápio|bebida|comida|lanche|pizza|hambur|suco|refri|refrigerante|agua|água|cerveja|vinho|sobremesa|preco|preço|custa|valor|opção|opções|opcao|opcoes|menu|categoria|item|items|itens|quero|pedir|peço|adiciona|coloca)\b/i;

// Frases que indicam que a IA ANUNCIOU que vai buscar mas não chamou nenhuma tool (guard de anúncio vazio)
// Ex: "Vou buscar os detalhes...", "Um instante...", "Deixa eu verificar...", "Já te trago..."
const _ANUNCIO_SEM_ACAO = /\b(vou\s+buscar|vou\s+verificar|vou\s+confirmar|vou\s+checar|vou\s+procurar|deixa\s+(eu|me)\s+(ver|verificar|buscar|checar)|um\s+instante|um\s+momento|aguarda?|já\s+te\s+trago|já\s+verifico|vou\s+consultar|deixa\s+eu\s+olhar|vou\s+olhar)\b/i;

// Palavras que indicam que a IA AFIRMOU que o pedido já foi concluído (guard antifraude).
// Só dispara em assertivas definitivas: menção de código de pedido OU passado de conclusão.
// NÃO dispara em: "Resumo do Pedido:", "Confirma?", "seu pedido contém", "seu pedido está:".
const _FECHAMENTO_KEYWORDS = /(c[oó]digo\s+(do\s+)?pedido\s*[:=#]|seu\s+c[oó]digo\s+(de\s+pedido\s+)?(é|e|:)\s*\S|\bpedido\s+(foi\s+|est[aá]\s+)?(registrado|conclu[íi]do|realizado|feito)\b(?!\s*\?)|\bpedido\s+confirmado\b(?!\s*\?)|\bregistrei\s+(seu|o)\s+pedido\b)/i;

// ── Roteador de modelo ────────────────────────────────────────────────────────
// Sinais de ação/pedido que quase certamente exigem chamada de ferramenta.
// Qualquer match → MODELO_FORTE independente do que mini avaliaria.
const _ROTEADOR_FORTE_RE = /\b(quer(?:o|ia)?|pedir?|pe[çc]o|mand[aer]|me\s+v[eê]|adiciona(?:r)?|coloca(?:r)?|p[õoe]r?|fecha(?:r)?|finaliza(?:r)?|confirma(?:r)?|cancela(?:r)?|remov(?:e|er)|tira(?:r)?|pagar|pagamento|entrega(?:r)?|endere[cç]o|taxa|frete|bairro|rua\b|avenida|rastrear|rastreiar|rastreia|acompanhar|j[aá]\s+saiu|meu\s+pedido|meu\s+carrinho|minha\s+entrega|status\s+do|quanto\s+(?:fica|custa|[eé]|vai)|total(?:\s+do)?|subtotal|troco|pix|dinheiro|cart[aã]o|cr[eé]dito|d[eé]bito|c[oó]digo\s+do\s+pedido|onde\s+est[aá]|onde\s+t[aá]|ver\s+(?:o\s+)?(?:pedido|carrinho|itens)|o\s+que\s+(?:eu\s+)?pedi|meu\s+pedido|já\s+foi|saiu\s+pra|saiu\s+p\/|quando\s+chega|hora\s+de\s+entrega)\b/i;

// Mensagens claramente simples — saudação, agradecimento, confirmação sem ação.
// Só vai p/ mini se ISSO bater E curta E _ROTEADOR_FORTE_RE não bater.
const _ROTEADOR_MINI_RE = /^(?:oi+|ol[aá]|e\s*a[íi]|bom\s+dia|boa\s+tarde|boa\s+noite|tudo\s+(?:bem|bom|certo|[oó]timo)|como\s+vai|show|blz|beleza|ok\b|okay|certo|entendi|perfeito|sim\b|n[aã]o\b|pode\s+ser|valeu|obrigad[ao]|muito\s+obrigad[ao]|de\s+nada|claro|com\s+certeza|at[eé]\s+logo|tchau|flw|[👍🙏✅😊🤝❤️]+)[!?.,\s]*$/i;

/**
 * Decide qual modelo usar para este turno.
 * A decisão é DETERMINÍSTICA — depende apenas do estado e da heurística de texto.
 * NÃO depende de julgamento do mini (que erra tool calling).
 *
 * @param {string}  texto       Texto já transcrito (pós-áudio)
 * @param {boolean} isAudio     Mensagem era áudio (antes da transcrição)
 * @param {Array}   carrinho    Itens do carrinho desta sessão
 * @param {string}  modeloMini  String de modelo barato
 * @param {string}  modeloForte String de modelo forte
 * @returns {{ modelo: string, motivo: string }}
 */
function _rotearModelo(texto, isAudio, carrinho, modeloMini, modeloForte) {
  // 1. Áudio → forte sempre (cliente de delivery quase sempre pede por áudio)
  if (isAudio)
    return { modelo: modeloForte, motivo: 'audio' };

  // 2. Carrinho ativo → forte (qualquer resposta pode tocar em tool de pedido)
  if (carrinho && carrinho.length > 0)
    return { modelo: modeloForte, motivo: 'carrinho_ativo' };

  const t = (texto || '').trim();

  // 3. Sinais explícitos de ação/pedido/entrega/rastreio → forte
  if (_ROTEADOR_FORTE_RE.test(t))
    return { modelo: modeloForte, motivo: 'sinal_acao' };

  // 4. Claramente saudação/agradecimento/confirmação curta → mini
  if (_ROTEADOR_MINI_RE.test(t) && t.length < 80)
    return { modelo: modeloMini, motivo: 'msg_simples' };

  // 5. Na dúvida → forte (custo de resposta errada > custo de tokens extras)
  return { modelo: modeloForte, motivo: 'default_forte' };
}

async function _runAgenteLoop(mensagens, openai, modelo) {
  const MAX_STEPS = 8;

  // Rastreia tools chamadas em todo o loop (para os guards antifraude)
  const _toolsChamadasNoLoop = new Set();
  // Conta quantas vezes o guard de anúncio vazio já interceptou (limite: 2)
  let _guardAnuncioCount = 0;
  // Conta quantas vezes o guard de produto-sem-tool já interceptou (limite: 2)
  let _guardProdutoSemToolCount = 0;
  // Resultado da última definir_entrega ok:true neste loop (para o guard de endereço)
  let _ultimaEntregaOkNoLoop = null;
  // Quantas vezes o guard de endereço-sem-tool já interceptou (limite: 2)
  let _guardEnderecoCount = 0;
  // Controla se a âncora de endereço já foi injetada no contexto neste loop
  let _entregaAncoraInjetada = false;

  for (let step = 0; step < MAX_STEPS; step++) {
    const resp = await openai.chat.completions.create({
      model:       modelo,
      messages:    mensagens,
      tools:       TOOL_DEFINITIONS,
      tool_choice: 'auto',
    });

    const msg = resp.choices[0].message;
    mensagens.push(msg);

    // Sem tool calls → resposta final de texto
    if (!msg.tool_calls || msg.tool_calls.length === 0) {
      const textoResposta = msg.content || '';

      // ── GUARD: IA anunciou busca/ação mas não chamou nenhuma tool ──────────
      // O modelo às vezes responde "Vou buscar os detalhes..." e encerra o turno
      // sem chamar a ferramenta. O cliente não recebe nada útil.
      // Corrige: remove a mensagem vazia, injeta instrução, deixa loop continuar.
      // Limite de 2 tentativas para não loopar infinito.
      let _guardAnuncioInterceptou = false;
      try {
        const toolsNesteTurno = _toolsChamadasNoLoop.size; // total de tools chamadas no loop até aqui
        if (toolsNesteTurno === 0 && _guardAnuncioCount < 2 && _ANUNCIO_SEM_ACAO.test(textoResposta)) {
          _guardAnuncioCount++;
          console.warn(`[AGENTE] ⚠ GUARD-ANUNCIO (tentativa ${_guardAnuncioCount}): IA anunciou ação SEM chamar tool. Interceptando. resposta="${textoResposta.slice(0, 120)}"`);
          mensagens.pop();
          mensagens.push({
            role:    'system',
            content: 'ERRO: você disse que ia buscar/verificar mas NÃO chamou nenhuma ferramenta. A mensagem foi descartada — o cliente não a viu. PROIBIDO anunciar que vai buscar. Chame a ferramenta (buscar_produto, listar_produtos_categoria, listar_categorias) AGORA e responda já com o resultado real. Não existe "vou buscar depois" — ou você chama e responde, ou você pergunta ao cliente.',
          });
          _guardAnuncioInterceptou = true;
        } else if (_guardAnuncioCount >= 2 && _ANUNCIO_SEM_ACAO.test(textoResposta)) {
          // Esgotou tentativas — responde algo seguro para não loopar
          console.warn(`[AGENTE] ⚠ GUARD-ANUNCIO: limite de ${_guardAnuncioCount} tentativas atingido, encerrando com fallback.`);
          mensagens.pop();
          return { resposta: 'Tive um problema ao buscar os dados do cardápio agora. Pode repetir o que você gostaria?', toolsChamadas: _toolsChamadasNoLoop.size };
        } else if (toolsNesteTurno === 0) {
          // ── GUARD ATIVO: IA citou produto/preço sem chamar tool de cardápio ──────
          // Detecta: resposta com preço (R$ X) E usuário perguntou sobre produtos
          // → remove resposta inventada, injeta correção, deixa o loop continuar.
          const ultimaMsgUsuario = [...mensagens].reverse().find(m => m.role === 'user')?.content || '';
          const _PRECO_NA_RESPOSTA = /R\$\s*\d+[,.]?\d*/i;
          const _TOOLS_CARDAPIO = new Set(['buscar_produto', 'listar_produtos_categoria', 'listar_categorias']);
          const toolsCardapioUsadas = [..._toolsChamadasNoLoop].some(t => _TOOLS_CARDAPIO.has(t));
          if (
            _PRODUTO_KEYWORDS.test(ultimaMsgUsuario) &&
            _PRECO_NA_RESPOSTA.test(textoResposta) &&
            !toolsCardapioUsadas &&
            _guardProdutoSemToolCount < 2
          ) {
            _guardProdutoSemToolCount++;
            console.warn(`[AGENTE] ⚠ GUARD-PRODUTO-SEM-TOOL (tentativa ${_guardProdutoSemToolCount}): IA citou produto/preço SEM chamar tool de cardápio. Interceptando. usuário="${ultimaMsgUsuario.slice(0,80)}" resposta="${textoResposta.slice(0,100)}"`);
            mensagens.pop();
            mensagens.push({
              role:    'system',
              content: 'ERRO CRÍTICO: você mencionou produtos e/ou preços SEM ter consultado o cardápio neste turno. Essa resposta foi descartada — o cliente não a viu. NUNCA cite produto, nome comercial (Coca-Cola, Guaraná, Sprite, etc.) ou preço de memória. AGORA chame buscar_produto ou listar_produtos_categoria e responda APENAS com o que a ferramenta retornar. Não invente nomes, tamanhos nem valores.',
            });
            _guardAnuncioInterceptou = true;
          } else if (_guardProdutoSemToolCount >= 2 && _PRODUTO_KEYWORDS.test(ultimaMsgUsuario) && /R\$\s*\d+/i.test(textoResposta)) {
            console.warn(`[AGENTE] ⚠ GUARD-PRODUTO-SEM-TOOL: limite de tentativas atingido, encerrando com fallback.`);
            mensagens.pop();
            return { resposta: 'Deixa eu verificar o cardápio certinho pra você. Pode repetir o que está procurando?', toolsChamadas: _toolsChamadasNoLoop.size };
          } else if (_PRODUTO_KEYWORDS.test(ultimaMsgUsuario)) {
            console.warn(`[AGENTE] ⚠ respondeu sobre produtos SEM chamar nenhuma tool | usuário: "${ultimaMsgUsuario.slice(0,80)}" | resposta: "${textoResposta.slice(0,100)}"`);
          }
        }
      } catch (guardAnuncioErr) {
        console.error(`[AGENTE] ⚠ GUARD-ANUNCIO erro interno (ignorado): ${guardAnuncioErr.message}`);
      }

      if (_guardAnuncioInterceptou) continue;

      // ── GUARD-ENDERECO-SEM-TOOL: IA afirmou entrega sem definir_entrega ok:true ──
      // Case A: IA diz "entrega será feita no Bar do Banana" sem ter chamado a tool.
      // Case B: coberto pela âncora injetada após Promise.all (endereço correto no contexto).
      let _guardEnderecoInterceptou = false;
      try {
        const _ENDERECO_AFIRMADO_RE = /\b(entrega\s+ser[aá]\s+feita|taxa\s+de\s+entrega\s+[eé]|ser[aá]\s+entregue\s+em|entrega\s+(confirmad[ao]|ok)\b|entrega\s+para\s+(o|a)\s*\*{0,2}[A-ZÀ-Ÿa-zà-ÿ]|endere[çc]o\s+(de\s+entrega\s+)?(foi\s+)?confirmad[ao]|est[aá]\s+dentro\s+da\s+(nossa\s+)?[aá]rea\b)/i;
        const _definirEntregaOkNoLoop = _toolsChamadasNoLoop.has('definir_entrega') && _ultimaEntregaOkNoLoop !== null;
        if (!_definirEntregaOkNoLoop && _ENDERECO_AFIRMADO_RE.test(textoResposta)) {
          if (_guardEnderecoCount < 2) {
            _guardEnderecoCount++;
            console.warn(`[AGENTE] ⚠ GUARD-ENDERECO-SEM-TOOL (tentativa ${_guardEnderecoCount}): IA afirmou endereço sem definir_entrega ok:true → interceptando. resposta="${textoResposta.slice(0,120)}"`);
            mensagens.pop();
            mensagens.push({
              role:    'system',
              content: 'ERRO: você afirmou que a entrega será realizada em um endereço SEM ter chamado definir_entrega com resultado ok:true neste turno. Essa resposta foi descartada — o cliente não a viu. CHAME definir_entrega com o endereço ou PIN do cliente AGORA e só confirme após obter ok:true.',
            });
            _guardEnderecoInterceptou = true;
          } else {
            console.warn(`[AGENTE] ⚠ GUARD-ENDERECO-SEM-TOOL: limite de tentativas atingido.`);
            mensagens.pop();
            return { resposta: 'Para confirmar a entrega, preciso validar seu endereço. Pode me informar a rua e número, ou mandar sua localização pelo 📎?', toolsChamadas: _toolsChamadasNoLoop.size };
          }
        }
      } catch (guardEndErr) {
        console.error(`[AGENTE] ⚠ GUARD-ENDERECO erro interno (ignorado): ${guardEndErr.message}`);
      }
      if (_guardEnderecoInterceptou) continue;

      // ── GUARD ANTIFRAUDE: IA afirmou conclusão do pedido sem chamar fechar_pedido ──
      // Detecta quando o modelo escreve "Código do Pedido:" ou "pedido registrado" sem ter
      // chamado a tool. Remove a mensagem alucinada e injeta correção para que a IA retome
      // o fluxo corretamente — seja chamando fechar_pedido ou pedindo dados ao cliente.
      // NUNCA força tool_choice: isso causava fechar_pedido sem endereço/pagamento.
      let _guardInterceptou = false;
      try {
        if (!_toolsChamadasNoLoop.has('fechar_pedido') && _FECHAMENTO_KEYWORDS.test(textoResposta)) {
          const carrinho = _getCarrinho(_loop_numero);
          if (carrinho.length > 0) {
            console.warn(`[AGENTE] ⚠ GUARD: IA afirmou conclusão SEM chamar fechar_pedido (carrinho=${carrinho.length} itens). Interceptando.`);
            console.warn(`[AGENTE] ⚠ GUARD: resposta interceptada: "${textoResposta.slice(0, 150)}"`);
            // Remove a mensagem alucinada
            mensagens.pop();
            // Injeta correção ciente do Asaas (BUG 4)
            const _cobrancaGuard = _asaasCobrancaMap.get(_loop_numero);
            let guardContent;
            if (_cobrancaGuard?.status === 'pendente') {
              guardContent = `ATENÇÃO: você escreveu texto de conclusão de pedido SEM ter chamado fechar_pedido. Essa mensagem foi descartada. Existe uma cobrança Asaas pendente para esta sessão (id="${_cobrancaGuard.id}"). CHAME fechar_pedido agora passando asaas_payment_id="${_cobrancaGuard.id}" (além de endereco e forma_pagamento). O pedido ficará com status aguardando_pagamento — NÃO diga ao cliente que está sendo preparado.`;
            } else {
              guardContent = 'ATENÇÃO: você escreveu texto de conclusão de pedido (código/confirmado/registrado) SEM ter chamado fechar_pedido. Essa mensagem foi descartada. Retome a conversa: se você já tem endereço e forma de pagamento confirmados pelo cliente, CHAME fechar_pedido agora. Se ainda faltam informações, PERGUNTE ao cliente normalmente.';
            }
            mensagens.push({ role: 'system', content: guardContent });
            _guardInterceptou = true;
          }
        }
      } catch (guardErr) {
        console.error(`[AGENTE] ⚠ GUARD erro interno (ignorado, fluxo continua): ${guardErr.message}`);
      }

      if (_guardInterceptou) continue;

      console.log(`[AGENTE] resposta final ao cliente (${textoResposta.length} chars): "${textoResposta.slice(0, 120)}${textoResposta.length > 120 ? '…' : ''}"`);
      return { resposta: textoResposta, toolsChamadas: _toolsChamadasNoLoop.size };
    }

    // Loga quais tools foram chamadas neste turno
    const nomesTools = msg.tool_calls.map(tc => tc.function.name);
    console.log(`[AGENTE] tools chamadas neste turno (step ${step + 1}): [${nomesTools.join(', ')}]`);

    // Executa todas as tool calls em paralelo
    await Promise.all(
      msg.tool_calls.map(async (tc) => {
        let resultado;
        try {
          const args = JSON.parse(tc.function.arguments || '{}');

          // Log específico de fechar_pedido para rastreabilidade total
          if (tc.function.name === 'fechar_pedido') {
            console.log(`[TOOL] fechar_pedido CHAMADO ← endereco="${args.endereco}", pagamento="${args.forma_pagamento}", nome="${args.nome_cliente || ''}", asaas_payment_id="${args.asaas_payment_id || ''}"`);
          } else {
            console.log(`[TOOL] ${tc.function.name}(${JSON.stringify(args)}) → chamando...`);
          }

          // ── GUARD-LIMPAR: bloqueia limpar_carrinho sem comando explícito de cancelar ──
          // "Não" como resposta a pergunta (endereço, "quer mais?", etc.) NUNCA deve limpar o
          // carrinho. Só executa se a mensagem do cliente contiver intenção explícita de cancelar.
          let _limparBloqueado = false;
          if (tc.function.name === 'limpar_carrinho') {
            const _msgCliente = [...mensagens].reverse().find(m => m.role === 'user')?.content || '';
            const _CANCELAR_EXPLICITO = /\b(cancela(r|ndo|e)?|cancele|esquece(\s+tudo)?|remove\s+tudo|limpa(\s+o)?\s+carrinho|limpar\s+(o\s+)?carrinho|desist[oiur]|apaga(\s+tudo)?|come[çc]a(\s+de\s+novo)?|recomeç(a|ar)?|quero\s+refazer|refazer\s+tudo)\b/i;
            if (!_CANCELAR_EXPLICITO.test(_msgCliente)) {
              console.warn(`[AGENTE] ⚠ GUARD-LIMPAR: tentativa de limpar carrinho sem comando explícito de cancelar → bloqueado. msg="${_msgCliente.slice(0, 120)}"`);
              resultado = {
                bloqueado: true,
                instrucao: 'GUARD-LIMPAR: o carrinho NÃO foi limpo. A mensagem do cliente não contém pedido explícito de cancelar — "Não" ou negações genéricas são respostas a perguntas, não comandos de cancelamento. Retome o fluxo conforme o contexto: se o cliente respondeu "Não" a uma confirmação de endereço, peça o endereço correto; se respondeu "Não" a "quer mais alguma coisa?", avance para entrega. Os itens do carrinho permanecem intactos.',
              };
              _limparBloqueado = true;
            }
          }

          if (!_limparBloqueado) {
            resultado = await _executarTool(tc.function.name, args, _loop_numero);
          }
          _toolsChamadasNoLoop.add(tc.function.name);

          // Rastreia resultado de definir_entrega ok:true para o guard de endereço
          if (tc.function.name === 'definir_entrega' && resultado?.ok === true) {
            _ultimaEntregaOkNoLoop = resultado;
          }

          // Log específico de resultado de fechar_pedido
          if (tc.function.name === 'fechar_pedido') {
            if (resultado.sucesso) {
              console.log(`[TOOL] fechar_pedido OK → código=${resultado.codigo}, total=${resultado.total}`);
            } else {
              console.warn(`[TOOL] fechar_pedido RETORNOU ERRO → ${JSON.stringify(resultado)}`);
            }
          } else {
            console.log(`[TOOL] ${tc.function.name} ← ${JSON.stringify(resultado).slice(0, 300)}${JSON.stringify(resultado).length > 300 ? '…' : ''}`);
          }
        } catch (e) {
          resultado = { erro: `Erro ao executar ${tc.function.name}: ${e.message}` };
          console.error(`[TOOL] ${tc.function.name} ERRO: ${e.message}\n${e.stack}`);
          if (tc.function.name === 'fechar_pedido') {
            console.error(`[TOOL] fechar_pedido ERRO CRÍTICO: ${e.message}`);
          }
        }
        mensagens.push({
          role:         'tool',
          tool_call_id: tc.id,
          content:      JSON.stringify(resultado),
        });
      })
    );

    // ── Âncora de endereço validado (GUARD-ENDERECO — Case B) ──────────────────
    // Após definir_entrega ok:true, injeta uma mensagem de sistema que ancora o
    // endereço/zona correto no contexto ANTES de o modelo gerar a resposta.
    // Impede a IA de citar o endereço ANTERIOR em vez do recém-validado.
    if (_ultimaEntregaOkNoLoop && !_entregaAncoraInjetada) {
      const endRef = _ultimaEntregaOkNoLoop.endereco_formatado
        || _ultimaEntregaOkNoLoop.bairro
        || _ultimaEntregaOkNoLoop.zona
        || '';
      if (endRef) {
        mensagens.push({
          role:    'system',
          content: `ÂNCORA (definir_entrega ok:true): o endereço/zona validado NESTE turno é "${endRef}". Use EXATAMENTE este ao informar o cliente. PROIBIDO usar endereço de turnos ou mensagens anteriores.`,
        });
        _entregaAncoraInjetada = true;
      }
    }

    // Se abrir_chamado foi executado, encerra o loop com mensagem fixa (não chama OpenAI de novo)
    if (_loop_chamado_aberto) {
      const mensagem = _loop_chamado_aberto;
      _loop_chamado_aberto = null;
      return { resposta: mensagem, toolsChamadas: _toolsChamadasNoLoop.size };
    }
  }

  return { resposta: 'Desculpe, não consegui processar sua solicitação agora. Tente novamente.', toolsChamadas: _toolsChamadasNoLoop.size };
}

// Variáveis de contexto do loop ativo (passadas por módulo para evitar refatorar assinaturas)
let _loop_numero         = null;
let _loop_cliente        = null; // registro de clientes_wa do número atual (pode ser null)
let _loop_chamado_aberto = null; // quando não-null: encerra o loop com esta mensagem fixa

// ── Vitrine: parse e processamento de pedidos automáticos ────────────────────

/**
 * Parseia o texto estruturado [PEDIDO_VITRINE] enviado pelo plugin WP.
 *
 * Formatos suportados para cabeçalho de lista: "Pedido:", "Itens:", "Produtos:"
 * Formatos suportados para linhas de item:
 *   - "- 1x Combo Churrasquito — R$ 38,90"
 *   - "• 2x Pizza (Grande) [+Borda] | obs: sem cebola"
 *   - "1x Refrigerante"
 * Linhas com 2+ espaços de indentação após um item são tratadas como complementos:
 *   - "+ Cream cheese" ou "Guaraná" → adicional do item anterior
 *   - "obs: sem cebola" → observação do item anterior
 */

/**
 * Normaliza forma_pagamento passada pela IA no fechar_pedido para o valor canônico gravado no DB.
 * Aceita os valores exatos ("dinheiro", "cartao_offline", "pix", "cartao_online") e também
 * variações livres que a IA possa usar como fallback.
 */
function _canonicalizarPagamentoOffline(raw) {
  if (!raw) return null;
  const n = String(raw).normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase().trim();
  if (/online|asaas|credit.?card/.test(n))          return 'cartao_online';
  if (/^pix/.test(n))                                return 'pix';
  if (/dinheiro|especi[ea]|cash/.test(n))            return 'dinheiro';
  if (/cartao_offline|offline|maquininha|cart[ao].*entrega|credito|debito|voucher/.test(n)) return 'cartao_offline';
  // Devolve o valor original limpo como fallback (não bloqueia o fechamento)
  return n.replace(/\s+/g, '_').replace(/[^a-z0-9_]/g, '');
}

/**
 * Normaliza o label de pagamento que chega da vitrine para o ID canônico.
 * A vitrine envia labels em texto livre (ex: "Cartão online (link Asaas)").
 * Retorna { pagamento, tipo_cartao, troco }.
 */
function _normalizarFormaPagamento(raw) {
  // Remove acentos + lowercase para comparação sem falso-negativo
  const norm = raw.normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase().trim();

  // Ordem importa: 'online|asaas' ANTES de 'cart' para não cair em cartao_entrega
  if (/online|asaas/.test(norm)) {
    return { pagamento: 'cartao_online', tipo_cartao: null, troco: null };
  }
  if (/^pix\b/.test(norm)) {
    return { pagamento: 'pix', tipo_cartao: null, troco: null };
  }
  if (/dinheiro|especie/.test(norm)) {
    // Extrai troco embutido: "Dinheiro (troco para R$ 50,00)"
    const mT = raw.match(/troco\s+(?:para\s+)?R?\$?\s*([\d,.]+)/i);
    const troco = mT ? mT[1].replace(',', '.') : null;
    return { pagamento: 'dinheiro', tipo_cartao: null, troco };
  }
  if (/cart[ao]|maquininha|credito|debito|voucher/.test(norm)) {
    let tipo_cartao = null;
    if (/credito/.test(norm))      tipo_cartao = 'crédito';
    else if (/debito/.test(norm))  tipo_cartao = 'débito';
    else if (/voucher/.test(norm)) tipo_cartao = 'voucher';
    return { pagamento: 'cartao_entrega', tipo_cartao, troco: null };
  }
  // Fallback: devolve normalizado
  return { pagamento: norm.replace(/\s+/g, '_').replace(/[^a-z0-9_]/g, ''), tipo_cartao: null, troco: null };
}

function _parsePedidoVitrine(texto) {
  // Preserva linhas RAW para detectar indentação; trim só para matching
  const linhasRaw = texto.replace(/\r/g, '').split('\n');
  let nome = null, endereco = null, pagamento = null, troco = null, tipo_cartao = null;
  const itens = [];
  let modoItens = false;

  for (const linhaRaw of linhasRaw) {
    const linha = linhaRaw.trim();
    if (!linha) continue;

    // Detecta indentação (2+ espaços no início = complemento do item anterior)
    const indentada = /^ {2,}/.test(linhaRaw);

    if (linha.startsWith('[PEDIDO_VITRINE]')) continue;

    if (!modoItens) {
      const mNome     = linha.match(/^Nome\s*:\s*(.+)/i);
      const mEndereco = linha.match(/^Endere[cç]o\s*:\s*(.+)/i);
      const mPag      = linha.match(/^Pagamento\s*:\s*(.+)/i);
      const mTroco    = linha.match(/^Troco\s*:\s*(.+)/i);
      // Aceita "Pedido:", "Itens:", "Items:", "Produtos:" como início da lista
      const mSecao    = linha.match(/^(Pedido|Itens?|Items?|Produtos?)\s*:/i);

      if (mNome)     { nome     = mNome[1].trim();            continue; }
      if (mEndereco) { endereco = mEndereco[1].trim();        continue; }
      if (mPag) {
        const nf = _normalizarFormaPagamento(mPag[1].trim());
        pagamento   = nf.pagamento;
        tipo_cartao = nf.tipo_cartao;
        if (nf.troco && !troco) troco = nf.troco;
        continue;
      }
      if (mTroco)    { troco    = mTroco[1].trim();           continue; }
      if (mSecao)    { modoItens = true;                      continue; }
    } else {
      // "Subtotal:" ou "Total:" → fim dos itens
      if (/^(subtotal|total)\s*:/i.test(linha)) break;

      // Linha indentada → complemento do último item parseado
      if (indentada && itens.length) {
        const ultimo = itens[itens.length - 1];
        const mObsInd = linha.match(/^obs(?:erva[cç][aã]o)?\s*:\s*(.+)/i);
        if (mObsInd) {
          const obsText = mObsInd[1].trim();
          if (obsText.includes('[PEDIDO_VITRINE]')) {
            console.warn('[VITRINE-parser] obs contaminada com [PEDIDO_VITRINE] — descartada');
          } else {
            ultimo.obs = (ultimo.obs ? ultimo.obs + '; ' : '') + obsText;
          }
        } else {
          // Qualquer texto indentado sem "obs:" → adicional (remove "+" inicial se houver)
          const nomeAdic = linha.replace(/^\+\s*/, '').replace(/\s*\(R\$\s*[\d,.]+\)\s*$/i, '').trim();
          if (nomeAdic) ultimo.adicionais.push(nomeAdic);
        }
        continue;
      }

      // Linha de item: prefixo opcional (•, -, *), depois NxNome
      // Aceita: "- 1x Combo", "• 2x Pizza", "1x Refri", "2 x Hamburguer"
      const mItem = linha.match(/^[•\-\*]?\s*(\d+)\s*[xX]?\s+(.+)/);
      if (!mItem) continue;

      const qtd   = parseInt(mItem[1]) || 1;
      let   resto = mItem[2].trim();

      // Captura o preço escrito na mensagem ANTES de removê-lo — usado como fallback
      // quando a variação não bate exatamente no banco.
      // Ex: "— R$ 67,90" → preco_mensagem = 67.90
      let preco_mensagem = 0;
      const mPreco = resto.match(/[\u2014\u2013\-]\s*R\$?\s*([\d,\.]+)\s*$/);
      if (mPreco) preco_mensagem = parseFloat(mPreco[1].replace(',', '.')) || 0;

      // Remove preço ao final — aceita em-dash (—), hífen (–), traço (-)
      // Ex: "— R$ 38,90" | "- R$38.90" | "R$ 58,00"
      resto = resto.replace(/\s*[\u2014\u2013\-]\s*R\$?\s*[\d,\.]+\s*$/, '').trim();
      resto = resto.replace(/\s*R\$\s*[\d,\.]+\s*$/, '').trim();

      // Extrai obs inline: "| obs: ..." ou ", obs: ..."
      let obs = null;
      const mObs = resto.match(/[|,]\s*obs(?:erva[cç][aã]o)?\s*:\s*(.+)$/i);
      if (mObs) { obs = mObs[1].trim(); resto = resto.slice(0, mObs.index).trim(); }

      // Extrai adicionais inline: "[+Borda Recheada, +Queijo]"
      const adicionais = [];
      const mAdic = resto.match(/\[([^\]]+)\]/);
      if (mAdic) {
        mAdic[1].split(',').forEach(a => {
          const an = a.replace(/^\+/, '').trim();
          if (an) adicionais.push(an);
        });
        resto = resto.replace(/\[[^\]]+\]/, '').trim();
      }

      // Extrai variação no FINAL entre parênteses — suporta parênteses ANINHADOS.
      // Ex: "Combo Brutus Max (Combo Monster (Suco + Batata))"
      //     → variacao="Combo Monster (Suco + Batata)", nome="Combo Brutus Max"
      // A regex simples [^)]+ quebra nesses casos; usamos scan de profundidade.
      let variacao = null;
      const lastClose = resto.lastIndexOf(')');
      if (lastClose === resto.length - 1) {
        let depth = 0, openIdx = -1;
        for (let i = lastClose; i >= 0; i--) {
          if (resto[i] === ')') depth++;
          else if (resto[i] === '(') { depth--; if (depth === 0) { openIdx = i; break; } }
        }
        if (openIdx > 0) {
          variacao = resto.slice(openIdx + 1, lastClose).trim();
          resto    = resto.slice(0, openIdx).trim();
        }
      }

      if (!resto) continue; // item sem nome → ignora

      itens.push({ qtd, nome: resto, variacao, adicionais, obs, preco_mensagem });
    }
  }

  return { nome, endereco, pagamento, tipo_cartao, troco, itens };
}

/**
 * Processa um pedido vindo da vitrine web.
 * - Popula o carrinho com os itens
 * - Injeta contexto e roda o agente para responder conforme forma de pagamento
 */
async function _processarPedidoVitrine({ numero, texto, jid, sock, msg, openai, modelo, cfg, cardapio, cliente }) {
  const parsed = _parsePedidoVitrine(texto);
  console.log(`[VITRINE-WA] pedido recebido: nome=${parsed.nome} pag=${parsed.pagamento} itens=${parsed.itens.length}`);

  // Popula carrinho diretamente (e reseta estado Asaas + entrega para nova sessão de compra)
  _carrinhos.set(numero, []);
  _asaasCobrancaMap.delete(numero);
  _entregaMap.delete(numero);
  const carrinho = _getCarrinho(numero);

  for (const item of parsed.itens) {
    const tokens  = _tokensBusca(item.nome);
    const match   = cardapio.produtos
      .filter(p => !p.esgotado)
      .map(p => ({ p, score: _scoreProduto(tokens, p) }))
      .sort((a, b) => b.score - a.score)[0];

    if (!match || match.score < 20) {
      console.warn(`[VITRINE-WA] produto "${item.nome}" não encontrado no cardápio — ignorado`);
      continue;
    }

    const produto = match.p;
    let preco     = (produto.preco_promo != null && produto.preco_promo > 0) ? produto.preco_promo : produto.preco;
    let variacao_nome = null;

    if (produto.tem_variacoes && produto.variacoes.length) {
      if (item.variacao) {
        // Normalização ampla: remove tudo que não é letra/número para tolerar
        // diferenças de espaçamento e caracteres especiais (+, /, parênteses, etc.)
        // Ex: "Combo Monster (Suco Prats   Batata/Bacon)" → "combo monster suco prats batata bacon"
        const _normVar = s => _normalizar(s).replace(/[^a-z0-9\s]/g, ' ').replace(/\s+/g, ' ').trim();
        const vnNorm   = _normVar(item.variacao);
        const vMatch   = produto.variacoes.find(v => {
          const dbNorm = _normVar(v.nome);
          return dbNorm === vnNorm || dbNorm.includes(vnNorm) || vnNorm.includes(dbNorm);
        });
        if (vMatch) {
          preco         = vMatch.preco;
          variacao_nome = vMatch.nome;
          console.log(`[VITRINE-WA] variação mapeada: "${item.variacao}" → "${vMatch.nome}" R$${preco}`);
        } else {
          // Variação não encontrada no banco — usa preço da mensagem como fallback
          variacao_nome = item.variacao;
          preco         = item.preco_mensagem > 0 ? item.preco_mensagem : preco;
          console.warn(`[VITRINE-WA] variação "${item.variacao}" não mapeada — fallback preço mensagem: R$${preco}`);
        }
      }
      // Safety net: produto tem variações mas preco base é 0 e não mapeou nada
      if (!variacao_nome && preco === 0 && item.preco_mensagem > 0) {
        preco = item.preco_mensagem;
        console.warn(`[VITRINE-WA] produto "${produto.nome}" sem variação mapeada, preço base=0 — usando preço mensagem: R$${preco}`);
      }
    }

    const adicSelecionados = [];
    let adicExtra = 0;
    for (const aNome of (item.adicionais || [])) {
      const normA = _normalizar(aNome);
      for (const grupo of produto.adicionais) {
        const op = grupo.opcoes.find(o => _normalizar(o.nome).includes(normA));
        if (op) { adicSelecionados.push(op.nome); adicExtra += op.preco || 0; break; }
      }
    }

    const qtd          = item.qtd || 1;
    const precoUnit    = preco + adicExtra;
    const subtotalItem = precoUnit * qtd;
    const adicionaisStr = adicSelecionados.join(', ');

    carrinho.push({
      idx:           carrinho.length + 1,
      produto_id:    produto.id,
      nome:          produto.nome,
      categoria:     produto.categoria,
      variacao:      variacao_nome,
      quantidade:    qtd,
      preco_unit:    precoUnit,
      adicionais_str: adicionaisStr || null,
      subtotal_item: subtotalItem,
      obs:           item.obs || null,
    });
  }

  if (!carrinho.length) {
    // Fallback resiliente: loga o texto bruto e responde ao cliente sem travar
    const itensRaw = parsed.itens.length
      ? `Parser retornou ${parsed.itens.length} item(ns) mas nenhum casou no cardápio. Itens brutos: ${JSON.stringify(parsed.itens.map(i => i.nome))}`
      : `Parser retornou 0 itens. Texto bruto do pedido: ${texto.slice(0, 300)}`;
    console.warn(`[VITRINE-WA] nenhum item mapeado — ${itensRaw}`);
    await _enviarComPresenca(
      numero, jid,
      'Recebi seu pedido pela vitrine, mas tive um problema interpretando os itens. Pode me dizer de novo o que pediu? 😊',
      sock, msg?.key
    );
    return;
  }

  // Salva carrinho na conversa
  // TODO(causa-2): considerar propagar/alertar — falha aqui deixa item removido no DB mas presente em memória
  await db.upsertConversaWA(numero, { carrinho: JSON.stringify(carrinho) }).catch(e => console.error('[AGENTE] falha em upsertConversaWA (remover_item):', e.message));

  // BUG 2 FIX: seed do nome parseado no _loop_cliente antes de rodar o loop.
  // O fechar_pedido usa `args.nome_cliente || _loop_cliente?.nome || 'Cliente'` como fallback.
  // Sem isso, se a IA não passar nome_cliente explicitamente, cai em "Cliente".
  if (parsed.nome) {
    _loop_cliente = { ...(_loop_cliente || {}), nome: parsed.nome };
    // Persiste nome no DB imediatamente para que turnos subsequentes o encontrem via getClienteWA
    await upsertClienteWA(numero, { nome: parsed.nome }).catch(e =>
      console.warn('[VITRINE-WA] falha ao salvar nome cliente:', e.message)
    );
  }

  // Monta descrição dos pagamentos Asaas
  const pixModo  = cfg['pix_modo'] === 'asaas' ? 'asaas' : 'manual';
  const pixChave = cfg['pix_chave'] || null;

  // Contexto injetado para o agente
  const ctxParts = [
    `PEDIDO DA VITRINE WEB — já pré-carregado no carrinho (${carrinho.length} linha(s)).`,
    parsed.nome     ? `Cliente: ${parsed.nome}.` : '',
    parsed.endereco ? `Endereço informado: "${parsed.endereco}".` : '',
    parsed.pagamento ? `Forma de pagamento escolhida na vitrine: "${parsed.pagamento}".` : '',
    parsed.troco    ? `Troco para: R$ ${parsed.troco}.` : '',
    '',
    'INSTRUÇÕES PARA RESPOSTA:',
    '- O carrinho já está montado. NÃO chame adicionar_item.',
    '- Se o endereço foi informado, chame definir_entrega para calcular a taxa.',
    '- Após calcular taxa, chame ver_carrinho para obter subtotal real.',
    parsed.nome ? `- Ao chamar fechar_pedido, passe obrigatoriamente nome_cliente="${parsed.nome}".` : '',
    '- Responda ao cliente com resumo do pedido (itens, subtotal, taxa, total) e instrução de pagamento conforme forma escolhida:',
  ];

  if (parsed.pagamento === 'cartao_online') {
    ctxParts.push(
      `⚠️ FORMA DE PAGAMENTO: cartão online (Asaas). SEQUÊNCIA OBRIGATÓRIA — não pule nenhum passo:`,
      `  1. Chame definir_entrega (endereço já informado).`,
      `  2. Chame ver_carrinho para obter o total real com frete.`,
      `  3. OBRIGATÓRIO ANTES DE FECHAR: chame gerar_cobranca_asaas com:`,
      `     valor=<total real>, descricao="Pedido delivery ${carrinho.length} item(ns)", forma="CREDIT_CARD"`,
      `     nome_cliente="${parsed.nome || 'Cliente'}", cliente_telefone="${numero}"`,
      `  4. Envie ao cliente: "Para pagar com cartão, acesse o link: <link retornado>"`,
      `  5. SOMENTE ENTÃO chame fechar_pedido passando asaas_payment_id=<id_cobranca retornado> — OBRIGATÓRIO.`,
      `  6. Após fechar: diga "Pedido registrado! Aguardando confirmação do pagamento — assim que confirmar, vai pra cozinha 🎉". NUNCA diga "preparando".`,
      `PROIBIDO: chamar fechar_pedido sem ter chamado gerar_cobranca_asaas com sucesso nesta conversa.`,
      `PROIBIDO: chamar gerar_cobranca_asaas mais de uma vez (o sistema reutiliza automaticamente se chamado de novo).`,
    );
  } else if (parsed.pagamento === 'pix' && pixModo === 'asaas') {
    ctxParts.push(
      `⚠️ FORMA DE PAGAMENTO: PIX via Asaas. SEQUÊNCIA OBRIGATÓRIA:`,
      `  1. Chame definir_entrega (endereço já informado).`,
      `  2. Chame ver_carrinho para obter o total real com frete.`,
      `  3. OBRIGATÓRIO ANTES DE FECHAR: chame gerar_cobranca_asaas com:`,
      `     valor=<total real>, descricao="Pedido delivery ${carrinho.length} item(ns)", forma="PIX"`,
      `     nome_cliente="${parsed.nome || 'Cliente'}", cliente_telefone="${numero}"`,
      `  4. Se retornar qr_code (Copia e Cola): envie ao cliente o código PIX e o link.`,
      `     Se só retornar link: envie "Clique para pagar via PIX: <link>".`,
      `  5. SOMENTE ENTÃO chame fechar_pedido passando asaas_payment_id=<id_cobranca retornado> — OBRIGATÓRIO.`,
      `  6. Após fechar: diga "Pedido registrado! Aguardando confirmação do pagamento — assim que confirmar, vai pra cozinha 🎉". NUNCA diga "preparando".`,
      `PROIBIDO: chamar fechar_pedido sem ter chamado gerar_cobranca_asaas com sucesso nesta conversa.`,
      `PROIBIDO: chamar gerar_cobranca_asaas mais de uma vez (o sistema reutiliza automaticamente se chamado de novo).`,
    );
  } else if (parsed.pagamento === 'pix' && pixModo === 'manual') {
    ctxParts.push(`  • PIX manual: informe a chave PIX ao cliente${pixChave ? ` (chave: ${pixChave})` : ' (busque a chave em Configurações)'} e peça o comprovante. Depois chame fechar_pedido.`);
  } else if (parsed.pagamento === 'cartao_entrega') {
    const tipoLabel = parsed.tipo_cartao ? ` (${parsed.tipo_cartao})` : '';
    ctxParts.push(`  • Cartão na entrega${tipoLabel}: confirme ao cliente que o motoboy leva a maquininha${tipoLabel ? ` para ${parsed.tipo_cartao}` : ''}. Chame fechar_pedido direto, sem gerar cobrança Asaas.`);
  } else if (parsed.pagamento === 'dinheiro') {
    if (parsed.troco) {
      ctxParts.push(`  • Dinheiro: cliente pediu troco para R$ ${parsed.troco}. Confirme o troco e chame fechar_pedido.`);
    } else {
      ctxParts.push(`  • Dinheiro: pergunte se precisa de troco e para quanto. Depois chame fechar_pedido.`);
    }
  } else {
    ctxParts.push(`  • Pagamento "${parsed.pagamento}": confirme a forma com o cliente e chame fechar_pedido.`);
  }

  ctxParts.push('- Após fechar_pedido: informe o código do pedido. Se status=aguardando_pagamento (pagamento online), diga que está aguardando confirmação — NUNCA diga "preparando".');
  const ctxVitrine = ctxParts.filter(Boolean).join('\n');

  // Monta mensagens para o agente
  const systemPt  = await _buildSystemPrompt(cfg, cardapio, cliente);
  const mensagens = [
    { role: 'system', content: systemPt },
    { role: 'user',   content: texto },
    { role: 'system', content: ctxVitrine },
  ];

  _loop_numero         = numero;
  _loop_cliente        = cliente;
  _loop_chamado_aberto = null;

  const { resposta } = await _runAgenteLoop(mensagens, openai, modelo);
  if (!resposta) return;

  await _enviarComPresenca(numero, jid, resposta, sock, msg?.key);

  // Salva histórico
  const conversa = await db.getConversaWA(numero).catch(() => null);
  let historico = [];
  try { historico = JSON.parse(conversa?.historico || '[]'); } catch (_) {}
  historico.push({ role: 'user',      content: texto });
  historico.push({ role: 'assistant', content: resposta });
  const limiteCtx = parseInt(await db.getConfig('ia_limite_msgs').catch(() => '20')) || 20;
  const hist = historico.slice(-(limiteCtx * 2));
  await db.upsertConversaWA(numero, { historico: JSON.stringify(hist) }).catch(e => console.error('[AGENTE] falha em upsertConversaWA (salvar historico):', e.message));
}

// ── processarMensagem — entry point ──────────────────────────────────────────
async function processarMensagem({ numero, texto, msg, jid, sock }) {
  console.log(`[WA-agente] processarMensagem chamado — numero=${numero}, texto="${(texto || '').slice(0, 60)}"`);

  // Guard: mensagens do próprio número já são filtradas em index.js (fromMe)
  if (msg?.key?.fromMe) return;

  // Detecta tipo de mídia antecipadamente
  const msgContent    = msg?.message || {};
  const isAudio       = !!(msgContent.audioMessage || msgContent.pttMessage);
  const isLocalizacao = !!(msgContent.locationMessage);
  const localizacao   = isLocalizacao
    ? { lat: msgContent.locationMessage.degreesLatitude, lng: msgContent.locationMessage.degreesLongitude }
    : null;
  if (localizacao) console.log(`[WA] localização recebida: lat=${localizacao.lat}, lng=${localizacao.lng}`);
  const isOtherMedia  = !isAudio && !isLocalizacao && !(texto && texto.trim()) && !!(
    msgContent.imageMessage || msgContent.documentMessage ||
    msgContent.videoMessage || msgContent.stickerMessage
  );

  try {
    // ── 1. Killswitch global ──────────────────────────────────────────────────
    const iaAtiva = await db.getConfig('ia_ativa').catch(() => '1');
    if (iaAtiva === '0') return;

    // ── 2. Modo manual por conversa ──────────────────────────────────────────
    const conversa = await db.getConversaWA(numero).catch(() => null);
    if (conversa?.modo_manual) {
      const textoChat = texto || '[mídia]';
      // Persiste no thread e incrementa badge de não-lidas
      // TODO(causa-2): considerar propagar/alertar — falha aqui perde msg do chat humano no DB
      await db.addMensagemWAChat(numero, 'cliente', textoChat).catch(e => console.error('[AGENTE] falha em addMensagemWAChat (modo_manual cliente):', e.message));
      // TODO(causa-2): considerar propagar/alertar — falha aqui zera badge, operador não vê alerta
      await db.incrementarMsgsNaoLidas(numero).catch(e => console.error('[AGENTE] falha em incrementarMsgsNaoLidas:', e.message));
      ceiaEmitter.emit('ceia:sse', {
        tipo: 'MENSAGEM_MANUAL',
        data: { numero, texto: textoChat },
      });
      return;
    }

    // ── 3. Rejeita mídia não-suportada (imagem, doc, figurinha) ──────────────
    if (isOtherMedia) {
      await _enviarComPresenca(numero, jid, _pick(MSGS_MIDIA_INVALIDA), sock, msg?.key);
      return;
    }

    // ── 4. OpenAI key ────────────────────────────────────────────────────────
    const openaiKey = await db.getConfig('openai_key').catch(() => null)
      || process.env.OPENAI_API_KEY;
    if (!openaiKey) {
      console.warn('[WA-agente] Chave OpenAI não configurada. Configure em Configurações → Chaves de API.');
      return;
    }

    // ── Modelos configuráveis ────────────────────────────────────────────────
    // ia_model_forte: modelo capaz de tool calling (padrão: gpt-4o)
    // ia_model_mini : modelo barato para msgs simples (padrão: gpt-4o-mini)
    // Mantém ia_model como alias de forte para retrocompatibilidade.
    const modeloForte = await db.getConfig('ia_model_forte').catch(() => null)
      || await db.getConfig('ia_model').catch(() => null)
      || 'gpt-4o';
    const modeloMini  = await db.getConfig('ia_model_mini').catch(() => null)
      || 'gpt-4o-mini';
    const openai = new OpenAI({ apiKey: openaiKey });

    // ── 5. Transcrição de áudio (Bloco 1) ────────────────────────────────────
    if (isAudio) {
      try {
        const transcricao = await _transcreverAudio(msg, sock, openai);
        if (!transcricao) throw new Error('Transcrição vazia');
        console.log(`[AGENTE] áudio transcrito: ${transcricao}`);
        texto = transcricao;
      } catch (e) {
        console.warn('[WA-agente] Falha na transcrição de áudio:', e.message);
        await _enviarComPresenca(numero, jid, _pick(MSGS_AUDIO_ERRO), sock, msg?.key);
        return;
      }
    }

    // Localização sem texto — define um texto representativo
    if ((!texto || !texto.trim()) && localizacao) {
      texto = '📍 (enviei minha localização)';
    }
    if (!texto || !texto.trim()) return; // mensagem vazia sem conteúdo

    // Persiste msg do cliente no thread de chat (caminho IA — não incrementa nao_lidas)
    await db.addMensagemWAChat(numero, 'cliente', texto).catch(e => console.error('[AGENTE] falha em addMensagemWAChat (cliente IA path):', e.message));

    // ── Avaliação de entrega pendente ────────────────────────────────────────
    // Intercept ANTES do agente: se há uma avaliação aguardando deste número e a mensagem
    // for exatamente "1"–"5", salva a nota e retorna. Caso contrário, cai no fluxo normal.
    const _avPendente = _avaliacoesPendentes.get(numero);
    if (_avPendente && (Date.now() - _avPendente.at) < 24 * 3600_000) {
      const _textoNorm = texto.trim();
      const _nota = parseInt(_textoNorm, 10);
      if (_nota >= 1 && _nota <= 5 && String(_nota) === _textoNorm) {
        await db.patchPedido(_avPendente.pedido_id, { avaliacao_entrega: _nota });
        _avaliacoesPendentes.delete(numero);
        console.log(`[AVALIACAO] ${numero} → pedido #${_avPendente.pedido_id} nota ${_nota}/5`);
        await _enviarComPresenca(numero, jid, `Obrigado pela avaliação! ⭐ Nota ${_nota}/5 registrada. Até a próxima! 😊`, sock, msg?.key);
        return;
      }
      // Não é um número 1-5 — mantém pendente e segue fluxo normal
    }

    // ── 5b. Detecta pedido da vitrine web ────────────────────────────────────
    if (texto.includes('[PEDIDO_VITRINE]')) {
      const openaiKey5b = await db.getConfig('openai_key').catch(() => null) || process.env.OPENAI_API_KEY;
      if (!openaiKey5b) { console.warn('[WA-agente] chave OpenAI ausente para pedido vitrine'); return; }
      const modelo5b = await db.getConfig('ia_model').catch(() => null) || 'gpt-4o-mini';
      const openai5b = new OpenAI({ apiKey: openaiKey5b });
      const allCfg5b = await db.getAllConfig().catch(() => []);
      const cfg5b    = Object.fromEntries(allCfg5b.map(r => [r.key, r.value]));
      const cardapio5b = await _getCardapio();
      const cliente5b  = await getClienteWA(numero).catch(() => null);
      await _processarPedidoVitrine({ numero, texto, jid, sock, msg, openai: openai5b, modelo: modelo5b, cfg: cfg5b, cardapio: cardapio5b, cliente: cliente5b });
      return;
    }

    // ── 6. Configurações e histórico ─────────────────────────────────────────
    const limiteCtx = parseInt(await db.getConfig('ia_limite_msgs').catch(() => '20')) || 20;

    let historico = [];
    if (conversa?.historico) {
      try { historico = JSON.parse(conversa.historico); } catch (_) {}
    }

    if (!_carrinhos.has(numero) && conversa?.carrinho) {
      try {
        const c = JSON.parse(conversa.carrinho);
        if (Array.isArray(c)) _carrinhos.set(numero, c);
      } catch (_) {}
    }

    // ── Limpeza de carrinho stale ────────────────────────────────────────────
    // Regra 1: histórico vazio = nova sessão → zera qualquer carrinho residual.
    // Regra 2: TTL de inatividade (6h) → se a última interação foi há mais de 6h,
    //   considera sessão nova e zera o carrinho mesmo se há histórico curto.
    const TTL_CARRINHO_MS = 6 * 60 * 60 * 1000; // 6 horas
    const ultimaInteracao = conversa?.ultima_interacao ? new Date(conversa.ultima_interacao) : null;
    const inatividade     = ultimaInteracao ? (Date.now() - ultimaInteracao.getTime()) : Infinity;
    const sessaoExpirou   = inatividade > TTL_CARRINHO_MS;

    if (historico.length === 0 || sessaoExpirou) {
      const carrinhoAtual = _getCarrinho(numero);
      if (carrinhoAtual.length > 0) {
        const motivo = historico.length === 0 ? 'histórico vazio' : `inatividade de ${Math.round(inatividade / 3600000)}h`;
        console.log(`[CARRINHO] ${numero} — sessão nova (${motivo}), limpando ${carrinhoAtual.length} item(ns) stale`);
        _carrinhos.set(numero, []);
        // TODO(causa-2): considerar propagar/alertar — falha aqui deixa carrinho stale no DB na nova sessão
        await db.upsertConversaWA(numero, { carrinho: '[]' }).catch(e => console.error('[AGENTE] falha em upsertConversaWA (limpar carrinho sessão expirada):', e.message));
      }
      // Reseta histórico se sessão expirou (não carrega mensagens de 6h+ atrás)
      if (sessaoExpirou && historico.length > 0) {
        console.log(`[AGENTE] ${numero} — sessão expirada (${Math.round(inatividade / 3600000)}h), resetando histórico`);
        historico = [];
        await db.upsertConversaWA(numero, { historico: '[]' }).catch(e => console.error('[AGENTE] falha em upsertConversaWA (limpar historico sessão expirada):', e.message));
      }
      // Reseta estado de promoções, cobrança Asaas e cache de entrega da sessão expirada
      if (sessaoExpirou) {
        _promoOferecida.delete(numero);
        _cupomAceitoMap.delete(numero);
        _asaasCobrancaMap.delete(numero);
        _entregaMap.delete(numero);
      }
    }

    // ── Limpeza de sessão stale por pedido em rota/finalizado ───────────────────
    // Quando o último pedido já saiu para entrega ou foi entregue, o histórico
    // contém tool results antigos (carrinho_completo com itens) que enganam a IA:
    // ela "acha" que o carrinho ainda tem itens. Resetamos histórico+carrinho para
    // garantir que a próxima mensagem começa um pedido novo, do zero.
    // EXCEPÇÃO 1: pedido em preparacao → cliente ainda pode adicionar itens.
    // EXCEPÇÃO 2: carrinho JÁ tem itens → pedido novo em andamento; não resetar
    //   por causa do pedido antigo. O reset só é válido na transição (carrinho vazio).
    // 'aguardando_coleta' NÃO está aqui — cliente ainda pode acrescentar item (handler move pacote de volta).
    // Só reseta quando o pedido já saiu de fato (em_rota) ou foi encerrado.
    const _STATUS_INTOCAVEL = new Set(['em_rota', 'entregue', 'finalizado']);
    const _carrinhoAtualPreReset = _getCarrinho(numero);
    if (historico.length > 0 && _carrinhoAtualPreReset.length === 0) {
      try {
        const _pedidosRecentes = await db.rastrearPedidoByNumero(numero);
        const _ultimoPedido    = _pedidosRecentes?.[0]; // mais recente das 24h
        if (_ultimoPedido && _STATUS_INTOCAVEL.has(_ultimoPedido.status)) {
          console.log(`[AGENTE] ${numero} — pedido ${_ultimoPedido.codigo} status="${_ultimoPedido.status}" (intocável) → histórico stale, resetando sessão para pedido novo`);
          historico = [];
          // TODO(causa-2): considerar propagar/alertar — falha aqui deixa sessão corrompida (pedido intocável com histórico stale)
          await db.upsertConversaWA(numero, { historico: '[]', carrinho: '[]' }).catch(e => console.error('[AGENTE] falha em upsertConversaWA (reset sessão pedido intocável):', e.message));
        }
      } catch (_resetErr) {
        // Não bloqueia o fluxo se a consulta falhar
      }
    }

    // ── 7. Build system prompt ────────────────────────────────────────────────
    const allCfg   = await db.getAllConfig().catch(() => []);
    const cfg      = Object.fromEntries(allCfg.map(r => [r.key, r.value]));

    // ── 7a. Shortcircuit: pedido de cardápio com vitrine configurada ──────────
    // A IA não formula o link — o código envia a mensagem pronta, evitando alucinação.
    const _vitrineUrl = _resolverVitrineUrl(cfg);
    if (_vitrineUrl && texto && /card[áa]pio|menu\b|o que (tem|têm|vocês? (tem|têm))|ver os pratos|o que voc[eê]s? vend|tem pra comer|ver os produtos/i.test(texto.trim())) {
      console.log(`[AGENTE] cardápio shortcircuit → enviando link direto: ${_vitrineUrl}`);
      await enviarMensagemWhatsApp(numero, `Aqui está nosso cardápio completo! 😊\n${_vitrineUrl}\n\nÉ só escolher por lá e me avisar, ou me diga o que quer e eu monto o pedido aqui.`);
      return;
    }

    const cardapio = await _getCardapio();
    const cliente  = await getClienteWA(numero).catch(() => null);
    const systemPt = await _buildSystemPrompt(cfg, cardapio, cliente);

    // ── 8. Monta mensagens para OpenAI ────────────────────────────────────────
    const ctxSlice  = historico.slice(-limiteCtx);
    const mensagens = [
      { role: 'system', content: systemPt },
      ...ctxSlice,
      { role: 'user',   content: texto },
    ];

    // ── 8b. Injeta contexto de localização (pin do WhatsApp) ─────────────────
    if (localizacao) {
      mensagens.push({
        role:    'system',
        content: `O cliente acabou de compartilhar sua localização via pin do WhatsApp: lat=${localizacao.lat}, lng=${localizacao.lng}. Chame definir_entrega com lat=${localizacao.lat} e lng=${localizacao.lng} diretamente (sem geocoding, sem pedir endereço de texto).`,
      });
    }

    // ── 9. Roteamento de modelo + agentic loop ────────────────────────────────
    _loop_numero         = numero;
    _loop_cliente        = cliente;
    _loop_chamado_aberto = null;

    const carrinho = _getCarrinho(numero);
    const { modelo: modeloEscolhido, motivo: motivoRoteamento } = _rotearModelo(
      texto, isAudio, carrinho, modeloMini, modeloForte
    );
    console.log(`[ROTEADOR] modelo=${modeloEscolhido === modeloMini ? 'mini' : 'forte'} (${modeloEscolhido}) motivo=${motivoRoteamento}`);

    // Snapshot das mensagens antes do loop — necessário para reescalonamento
    const mensagensSnapshot = [...mensagens];

    const { resposta: respostaBruta, toolsChamadas } = await _runAgenteLoop(mensagens, openai, modeloEscolhido);

    // ── Rede de segurança: mini sem tool em mensagem de ação → reescalona pro forte ──
    // Cobre o bug original onde o mini respondia de cabeça sem chamar nenhuma ferramenta.
    let resposta = respostaBruta;
    if (modeloEscolhido === modeloMini && toolsChamadas === 0 && _ROTEADOR_FORTE_RE.test(texto)) {
      console.warn(`[ROTEADOR] mini não chamou tool em msg de ação → reescalando p/ forte (${modeloForte})`);
      _loop_chamado_aberto = null; // reset state para o segundo loop
      const { resposta: respostaForte } = await _runAgenteLoop([...mensagensSnapshot], openai, modeloForte);
      resposta = respostaForte;
    }

    if (!resposta) return;

    // ── 10. Validação anti-alucinação (loga aviso, não bloqueia) ─────────────
    const _PLACEHOLDERS = /pre[çc]o a confirmar|aguardando pre[çc]o|vou verificar o pre[çc]o|pre[çc]o indispon/i;
    if (_PLACEHOLDERS.test(resposta)) {
      console.warn(`[AGENTE] ⚠️  POSSÍVEL PLACEHOLDER DE PREÇO na resposta para ${numero}: "${resposta.slice(0, 120)}"`);
    }

    // ── 11. Envia resposta com comportamento humano (Bloco 2) ─────────────────
    // PRINCÍPIO ANTI-BAN: estamos RESPONDENDO a uma mensagem que o cliente enviou.
    await _enviarComPresenca(numero, jid, resposta, sock, msg?.key);

    // Persiste resposta da IA no thread de chat
    await db.addMensagemWAChat(numero, 'ia', resposta).catch(e => console.error('[AGENTE] falha em addMensagemWAChat (resposta IA):', e.message));

    // ── 12. Salva histórico ───────────────────────────────────────────────────
    historico.push({ role: 'user',      content: texto });
    historico.push({ role: 'assistant', content: resposta });
    const hist = historico.slice(-(limiteCtx * 2));
    await db.upsertConversaWA(numero, { historico: JSON.stringify(hist) }).catch(e =>
      console.error('[WA-agente] Erro ao salvar histórico:', e.message)
    );

  } catch (e) {
    console.error(`[WA-agente] ERRO ao processar mensagem de ${numero}: ${e.message}\n${e.stack}`);
  }
}

// ── Inicialização — registra o handler no gancho WA-1 ─────────────────────────
function iniciarAgente() {
  onMensagemRecebida(processarMensagem);
  console.log('[WA-agente] Agente de IA WhatsApp registrado.');
}

/**
 * Registra que o cliente `numero` está aguardando dar nota para o pedido `pedidoId`.
 * Chamado pelo bot Telegram após confirmar a entrega e enviar a mensagem de avaliação.
 * TTL de 24 h — se o cliente não responder, a avaliação fica NULL sem problema.
 */
function marcarAvaliacaoPendente(numero, pedidoId) {
  _avaliacoesPendentes.set(numero, { pedido_id: pedidoId, at: Date.now() });
}

module.exports = { iniciarAgente, processarMensagem, marcarAvaliacaoPendente };
