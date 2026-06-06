if (!globalThis.crypto) {
  globalThis.crypto = require('node:crypto').webcrypto;
}

require("dotenv").config();

const P = require("pino");
const qrcode = require("qrcode-terminal");
const { createOrder, getChatSessaoPorTelefone } = require("./src/data/db");
const { setSocket } = require("./src/whatsapp/socket");
const { processarPedidoSite } = require("./src/whatsapp/ceia-site-handler");
const { startRastreamento } = require("./src/services/rastreamento");

// Baileys é ESM-only — carregado via dynamic import antes do primeiro uso
let makeWASocket, useMultiFileAuthState, DisconnectReason, fetchLatestBaileysVersion;

async function loadBaileys() {
  const m = await import("@whiskeysockets/baileys");
  makeWASocket             = m.default;
  useMultiFileAuthState    = m.useMultiFileAuthState;
  DisconnectReason         = m.DisconnectReason;
  fetchLatestBaileysVersion = m.fetchLatestBaileysVersion;
}

const sessions = {};

async function startBot() {
  await loadBaileys();
  const { state, saveCreds } = await useMultiFileAuthState("auth_info");
  const { version } = await fetchLatestBaileysVersion();

  const sock = makeWASocket({
    version,
    logger: P({ level: "silent" }),
    auth: state,
    printQRInTerminal: false,
  });

  // REGISTRA O SOCKET CORRETAMENTE
  setSocket(sock);

  sock.ev.on("creds.update", saveCreds);

  sock.ev.on("connection.update", (update) => {
    const { connection, lastDisconnect, qr } = update;

    if (qr) {
      console.log("📱 Escaneie o QR code abaixo:");
      qrcode.generate(qr, { small: true });
    }

    if (connection === "open") {
      console.log("✅ WhatsApp conectado!");
      startRastreamento();
    }

    if (connection === "close") {
      const shouldReconnect =
        lastDisconnect?.error?.output?.statusCode !==
        DisconnectReason.loggedOut;

      if (shouldReconnect) {
        startBot();
      }
    }
  });

  sock.ev.on("messages.upsert", async ({ messages }) => {
    const msg = messages[0];
    if (!msg.message || msg.key.fromMe) return;

    const sender = msg.key.remoteJid;

    // Só mensagens de contato individual (não grupos)
    if (sender.endsWith('@g.us')) {
      const foiPedidoSite = await processarPedidoSite(sock, msg).catch(() => false);
      if (foiPedidoSite) return;
      return;
    }

    const text =
      msg.message.conversation ||
      msg.message.extendedTextMessage?.text ||
      "";

    // WhatsApp → Telegram relay (sessões CHAT_CLIENTE ativas)
    const phone = sender.split('@')[0];
    try {
      const sessao = await getChatSessaoPorTelefone(phone);
      if (sessao?.telegram_id && text) {
        const token = process.env.TELEGRAM_BOT_TOKEN;
        if (token) {
          const nomeCliente = sessao.nome_cliente || 'Cliente';
          fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              chat_id: sessao.telegram_id,
              text: `💬 *${nomeCliente} (WhatsApp):* ${text}`,
              parse_mode: 'Markdown',
            }),
          }).catch(e => console.error('[WA→TG relay]', e.message));
        }
        return; // não processa como pedido
      }
    } catch (_) {}

    // Pedidos do cardápio digital têm prioridade — tratados por IA antes do flow manual
    const foiPedidoSite = await processarPedidoSite(sock, msg).catch(() => false);
    if (foiPedidoSite) return;

    const message = text.toLowerCase().trim();

    if (!sessions[sender]) {
      sessions[sender] = { cart: [], step: "idle" };
    }

    const user = sessions[sender];

    if (message === "oi") {
      user.step = "menu";
      return await sock.sendMessage(sender, {
        text: "🍣 Bem-vindo ao CEIA!\nDigite *menu*.",
      });
    }

    if (message === "menu") {
      user.step = "ordering";
      return await sock.sendMessage(sender, {
        text:
          "📋 Cardápio:\n1️⃣ Hot Roll - R$25\n2️⃣ Temaki - R$18\n\nDigite 1 ou 2.",
      });
    }

    if (user.step === "ordering") {
      if (message === "1") {
        user.cart.push({ name: "Hot Roll", price: 25 });
        return await sock.sendMessage(sender, {
          text: "✅ Hot Roll adicionado!\nDigite mais itens ou *finalizar*.",
        });
      }

      if (message === "2") {
        user.cart.push({ name: "Temaki", price: 18 });
        return await sock.sendMessage(sender, {
          text: "✅ Temaki adicionado!\nDigite mais itens ou *finalizar*.",
        });
      }

      if (message === "finalizar") {
        if (user.cart.length === 0) {
          return await sock.sendMessage(sender, {
            text: "⚠️ Seu carrinho está vazio.",
          });
        }

        const total = user.cart.reduce(
          (sum, item) => sum + item.price,
          0
        );

        const orderId = await createOrder({
          customer_phone: sender,
          items: user.cart,
          total,
          status: "RECEIVED",
          origin: "WHATSAPP",
        });

        user.cart = [];
        user.step = "finished";

        return await sock.sendMessage(sender, {
          text:
            `🧾 Pedido #${orderId} confirmado!\n\n` +
            `Total: R$${total}\n\nStatus: RECEIVED`,
        });
      }
    }
  });
}

startBot();
