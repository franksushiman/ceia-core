/**
 * ceia-site-handler.js
 * Detecta pedidos vindos do cardápio web e processa via OpenAI tool-calling.
 * Adicione processarPedidoSite() no handler de messages.upsert do index.js.
 */

require("dotenv").config();

const OpenAI = require("openai");
const { getProdutos, getBairros, createOrder, getConfig } = require("../data/db");
const { sendMessage } = require("./socket");

async function getOpenAI() {
  const fromDB = await getConfig('openai_key').catch(() => null);
  const key = (fromDB && fromDB.trim()) ? fromDB.trim() : (process.env.OPENAI_API_KEY || null);
  if (!key) return null;
  return new OpenAI({ apiKey: key });
}

// ─── Detecção de mensagem de pedido do site ───────────────────────────────────
const PEDIDO_SITE_REGEX = /🧾\s*NOVO PEDIDO/i;

function isPedidoDoSite(text) {
  return PEDIDO_SITE_REGEX.test(text);
}

// ─── Definição do tool ────────────────────────────────────────────────────────
const TOOL_PROCESSAR_PEDIDO = {
  type: "function",
  function: {
    name: "processar_pedido_do_site",
    description:
      "Quando a mensagem é claramente um pedido do cardápio digital " +
      "(começa com 🧾 NOVO PEDIDO ou tem estrutura formatada de pedido), " +
      "use este tool para extrair os dados e criar o pedido no sistema.",
    parameters: {
      type: "object",
      required: ["cliente_nome", "tipo", "itens"],
      properties: {
        cliente_nome:   { type: "string" },
        tipo:           { type: "string", enum: ["entrega", "retirada"] },
        endereco:       { type: "string" },
        bairro:         { type: "string" },
        complemento:    { type: "string" },
        itens: {
          type: "array",
          items: {
            type: "object",
            properties: {
              nome:        { type: "string" },
              quantidade:  { type: "integer" },
              adicionais:  { type: "array", items: { type: "string" } },
              observacao:  { type: "string" },
              subtotal:    { type: "number" },
            },
            required: ["nome", "quantidade"],
          },
        },
        taxa_entrega:    { type: "number" },
        forma_pagamento: { type: "string" },
        troco_para:      { type: "number" },
        observacao:      { type: "string" },
      },
    },
  },
};

const TOOL_TRANSFERIR = {
  type: "function",
  function: {
    name: "transferir_para_atendente_humano",
    description: "Transfere o atendimento para um humano quando não consegue extrair o pedido.",
    parameters: {
      type: "object",
      required: ["motivo"],
      properties: {
        motivo: { type: "string" },
      },
    },
  },
};

// ─── Validação de total pelo banco local ──────────────────────────────────────
async function calcularTotal(itensTool, taxaEntrega) {
  const produtos = await getProdutos();
  const bairros = await getBairros();

  let subtotal = 0;
  const itensSanitizados = [];

  for (const item of itensTool) {
    const prod = produtos.find(
      (p) => p.nome.toLowerCase().includes(item.nome.toLowerCase())
    );
    const preco = prod ? prod.preco : item.subtotal / (item.quantidade || 1);
    const itemTotal = preco * (item.quantidade || 1);
    subtotal += itemTotal;
    itensSanitizados.push({ ...item, preco_unitario: preco, subtotal: itemTotal });
  }

  // Taxa de entrega: valida contra o banco (ignora o que veio do tool)
  let taxa = 0;
  if (taxaEntrega !== undefined && taxaEntrega !== null) {
    // Aceita o valor do site apenas se bater com algum bairro cadastrado
    const bairroMatch = bairros.find(
      (b) => Math.abs(b.taxa - taxaEntrega) < 0.01
    );
    taxa = bairroMatch ? bairroMatch.taxa : taxaEntrega;
  }

  return { subtotal, taxa, total: subtotal + taxa, itens: itensSanitizados };
}

// ─── Handler principal ────────────────────────────────────────────────────────
async function processarPedidoSite(sock, msg) {
  const text =
    msg.message?.conversation ||
    msg.message?.extendedTextMessage?.text ||
    "";

  if (!isPedidoDoSite(text)) return false;

  const sender = msg.key.remoteJid;

  const _oai = await getOpenAI();
  if (!_oai) {
    console.warn('[CEIA] OpenAI não configurada — transferindo pedido para atendente');
    return false;
  }
  const completion = await _oai.chat.completions.create({
    model: "gpt-4o",
    tool_choice: "required",
    tools: [TOOL_PROCESSAR_PEDIDO, TOOL_TRANSFERIR],
    messages: [
      {
        role: "system",
        content:
          "Você é o sistema de pedidos do CEIA. " +
          "Quando receber uma mensagem de pedido do cardápio digital, " +
          "SEMPRE chame processar_pedido_do_site. " +
          "Se não conseguir extrair, chame transferir_para_atendente_humano. " +
          "NUNCA responda com texto livre a mensagens de pedido.",
      },
      { role: "user", content: text },
    ],
  }).catch((err) => {
    console.error("[CEIA-SITE] erro OpenAI:", err.message);
    return null;
  });

  if (!completion) {
    await sendMessage(sender, "Tivemos um problema ao processar seu pedido. Aguarde, um atendente vai te ajudar.");
    return true;
  }

  const toolCall = completion.choices[0]?.message?.tool_calls?.[0];
  if (!toolCall) return true;

  const fnName = toolCall.function.name;
  const args = JSON.parse(toolCall.function.arguments);

  if (fnName === "transferir_para_atendente_humano") {
    console.warn("[CEIA-SITE] transferindo para humano:", args.motivo);
    await sendMessage(sender, "Não consegui processar seu pedido automaticamente. Um atendente vai te ajudar em instantes!");
    return true;
  }

  if (fnName === "processar_pedido_do_site") {
    return await criarPedidoEResponder(sock, sender, args);
  }

  return true;
}

async function criarPedidoEResponder(sock, sender, args) {
  let calculo;
  try {
    calculo = await calcularTotal(args.itens, args.taxa_entrega);
  } catch (err) {
    console.error("[CEIA-SITE] erro ao calcular total:", err.message);
    await sendMessage(sender, "Erro interno ao calcular seu pedido. Um atendente vai te ajudar.");
    return true;
  }

  const orderId = await createOrder({
    customer_phone: sender,
    items: calculo.itens,
    total: calculo.total,
    status: "RECEIVED",
    origin: "CEIA_SITE",
  }).catch((err) => {
    console.error("[CEIA-SITE] erro ao salvar pedido:", err.message);
    return null;
  });

  if (!orderId) {
    await sendMessage(sender, "Não consegui registrar seu pedido. Um atendente vai te ajudar.");
    return true;
  }

  const totalFmt = calculo.total.toLocaleString("pt-BR", {
    style: "currency",
    currency: "BRL",
  });

  const forma = (args.forma_pagamento || "").toUpperCase();
  let instrucaoPagamento;

  if (forma.includes("PIX")) {
    // TODO: integrar Asaas — gerar cobrança PIX e retornar QR/link
    instrucaoPagamento = "Em breve você receberá o QR Code PIX para pagamento.";
  } else if (forma.includes("CART")) {
    // TODO: integrar Asaas — gerar link de cartão
    instrucaoPagamento = "Em breve você receberá o link de pagamento por cartão.";
  } else {
    instrucaoPagamento = "Pagamento na entrega.";
  }

  const tipo = args.tipo === "retirada" ? "retirada no local" : "entrega";
  await sendMessage(
    sender,
    `✅ Pedido #${orderId} confirmado!\n\n` +
    `📦 Tipo: ${tipo}\n` +
    `💰 Total: ${totalFmt}\n\n` +
    instrucaoPagamento
  );

  return true;
}

module.exports = { processarPedidoSite, isPedidoDoSite };
