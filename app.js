const express = require("express");
const sqlite3 = require("sqlite3").verbose();
const path    = require("path");
const P = require("pino");
const qrcode = require("qrcode-terminal");

const app = express();
const db = new sqlite3.Database(path.join(process.cwd(), "ceia.db"));

// ── SQLite: WAL mode + busy retry ─────────────────────────────────────────────
db.run("PRAGMA journal_mode=WAL", (err) => {
  if (err) console.error("[APP-DB] Erro ao ativar WAL:", err.message);
});
db.run("PRAGMA busy_timeout=5000");
db.get("PRAGMA journal_mode", (err, row) => {
  if (err) console.error("[APP-DB] Erro ao verificar journal_mode:", err.message);
  else console.log(`[APP-DB] journal_mode ativo: ${row.journal_mode}`);
});

app.use(express.json());
app.use(express.static("public"));

// Baileys é ESM-only — carregado via dynamic import antes do primeiro uso
let makeWASocket, useMultiFileAuthState, DisconnectReason, fetchLatestBaileysVersion;

async function loadBaileys() {
  const m = await import("@whiskeysockets/baileys");
  makeWASocket              = m.default;
  useMultiFileAuthState     = m.useMultiFileAuthState;
  DisconnectReason          = m.DisconnectReason;
  fetchLatestBaileysVersion = m.fetchLatestBaileysVersion;
}

let sock = null;
const sessions = {};

// ---------------- WHATSAPP ----------------

async function startBot() {
  await loadBaileys();
  const { state, saveCreds } = await useMultiFileAuthState("auth_info");
  const { version } = await fetchLatestBaileysVersion();

  sock = makeWASocket({
    version,
    logger: P({ level: "silent" }),
    auth: state,
  });

  sock.ev.on("creds.update", saveCreds);

  sock.ev.on("connection.update", (update) => {
    const { connection, qr, lastDisconnect } = update;

    if (qr) {
      console.log("📱 Escaneie o QR code:");
      qrcode.generate(qr, { small: true });
    }

    if (connection === "open") {
      console.log("✅ WhatsApp conectado!");
    }

    if (connection === "close") {
      const shouldReconnect =
        lastDisconnect?.error?.output?.statusCode !==
        DisconnectReason.loggedOut;

      if (shouldReconnect) startBot();
    }
  });

  sock.ev.on("messages.upsert", async ({ messages }) => {
    const msg = messages[0];
    if (!msg.message || msg.key.fromMe) return;

    const text =
      msg.message.conversation ||
      msg.message.extendedTextMessage?.text ||
      "";

    const sender = msg.key.remoteJid;
    const message = text.toLowerCase().trim();

    if (!sessions[sender]) {
      sessions[sender] = { cart: [], step: "idle" };
    }

    const user = sessions[sender];

    if (message === "oi") {
      user.step = "menu";
      return sock.sendMessage(sender, {
        text: "🍣 Bem-vindo ao CEIA!\nDigite *menu*.",
      });
    }

    if (message === "menu") {
      user.step = "ordering";
      return sock.sendMessage(sender, {
        text:
          "📋 Cardápio:\n1️⃣ Hot Roll - R$25\n2️⃣ Temaki - R$18\n\nDigite 1 ou 2.",
      });
    }

    if (user.step === "ordering") {
      if (message === "1") {
        user.cart.push({ name: "Hot Roll", price: 25 });
        return sock.sendMessage(sender, {
          text: "✅ Hot Roll adicionado!\nDigite mais itens ou *finalizar*.",
        });
      }

      if (message === "2") {
        user.cart.push({ name: "Temaki", price: 18 });
        return sock.sendMessage(sender, {
          text: "✅ Temaki adicionado!\nDigite mais itens ou *finalizar*.",
        });
      }

      if (message === "finalizar") {
        const total = user.cart.reduce((s, i) => s + i.price, 0);

        db.run(
          `INSERT INTO orders (customer_phone, items, total, status, origin)
           VALUES (?, ?, ?, ?, ?)`,
          [
            sender,
            JSON.stringify(user.cart),
            total,
            "RECEIVED",
            "WHATSAPP",
          ]
        );

        user.cart = [];

        return sock.sendMessage(sender, {
          text: `🧾 Pedido confirmado!\nTotal: R$${total}\nStatus: RECEIVED`,
        });
      }
    }
  });
}

// ---------------- API ----------------

app.get("/orders", (req, res) => {
  db.all("SELECT * FROM orders ORDER BY created_at DESC", [], (err, rows) => {
    res.json(rows);
  });
});

app.patch("/orders/:id/status", (req, res) => {
  const { status } = req.body;
  const { id } = req.params;

  db.run(
    "UPDATE orders SET status = ? WHERE id = ?",
    [status, id],
    function () {
      res.json({ updated: this.changes });

      if (status === "READY" && sock) {
        db.get(
          "SELECT customer_phone FROM orders WHERE id = ?",
          [id],
          async (err, row) => {
            if (row) {
              await sock.sendMessage(
                row.customer_phone,
                { text: "🍣 Seu pedido está pronto!" }
              );
            }
          }
        );
      }
    }
  );
});

const PORT = 3000;

app.listen(PORT, () => {
  console.log("🚀 Servidor rodando em http://localhost:3000");
});

startBot();
