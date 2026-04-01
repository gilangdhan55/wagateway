import express from "express";
import makeWASocket, {
  useMultiFileAuthState,
  DisconnectReason,
  fetchLatestBaileysVersion,
} from "@whiskeysockets/baileys";
import qrcode from "qrcode-terminal";
import Pino from "pino";
import fs from "fs";
import path from "path";
import http from "http";
import { WebSocketServer } from "ws";
import fileUpload from "express-fileupload";
import Queue from "p-queue";

const app = express();

// allow configuring host/port via environment variables
const PORT = process.env.PORT ? Number(process.env.PORT) : 23412;
const HOST = process.env.HOST || "0.0.0.0";
// optional separate WS port (if set, WS will listen on this port instead of HTTP upgrade)
const WS_PORT = process.env.WS_PORT ? Number(process.env.WS_PORT) : null;

// create a http server so we can attach WebSocket server to same port
const server = http.createServer(app);
const wss = new WebSocketServer({ noServer: true });

// manage connected clients
const wsClients = new Set();

// lightweight in-memory store for recent messages
const store = {
  _map: new Map(), // jid -> [msg]
  bind(ev) {
    // listen for messages.upsert and store recent messages
    ev.on("messages.upsert", (m) => {
      try {
        if (m.type !== "notify") return;
        const msgs = m.messages?.filter((msg) => !!msg.message) || [];
        for (const msg of msgs) {
          const jid = msg.key?.remoteJid || null;
          if (!jid) continue;
          if (!this._map.has(jid)) this._map.set(jid, []);
          const arr = this._map.get(jid);
          arr.push(msg);
          // keep only latest 1000 messages per jid to avoid unbounded memory
          if (arr.length > 1000) arr.splice(0, arr.length - 1000);
        }
      } catch (e) {
        // ignore
      }
    });
  },
  async loadMessages(jid, limit = 50) {
    const arr = this._map.get(jid) || [];
    return arr.slice(-limit).reverse();
  },
};

// helper to broadcast JSON to all connected websocket clients
const broadcast = (data) => {
  const str = JSON.stringify(data);
  for (const ws of wsClients) {
    try {
      if (ws.readyState === 1) ws.send(str);
    } catch (e) {
      // ignore send errors per-client
    }
  }
};

// simple file-based persistence for messages
const MESSAGES_DIR = path.join(process.cwd(), "messages");
const ensureMessagesDir = () => {
  if (!fs.existsSync(MESSAGES_DIR)) fs.mkdirSync(MESSAGES_DIR, { recursive: true });
};

const jidToFilename = (jid) => {
  // replace characters not safe for filenames
  return jid.replace(/[^a-zA-Z0-9@._-]/g, "_") + ".json";
};

const saveMessageToFile = (jid, item) => {
  try {
    ensureMessagesDir();
    const file = path.join(MESSAGES_DIR, jidToFilename(jid));
    let arr = [];
    if (fs.existsSync(file)) {
      try {
        arr = JSON.parse(fs.readFileSync(file, "utf8") || "[]");
      } catch (e) {
        arr = [];
      }
    }
    arr.push(item);
    fs.writeFileSync(file, JSON.stringify(arr, null, 2), "utf8");
  } catch (e) {
    console.error("Failed to save message to file", e);
  }
};

const readHistoryFromFile = (jid, limit = 50) => {
  try {
    const file = path.join(MESSAGES_DIR, jidToFilename(jid));
    if (!fs.existsSync(file)) return null;
    const arr = JSON.parse(fs.readFileSync(file, "utf8") || "[]");
    if (!Array.isArray(arr)) return [];
    return arr.slice(-limit).reverse(); // return newest first
  } catch (e) {
    return null;
  }
};

// normalize messages to a compact shape for easier consumption
const normalizeBaileysMessage = (msg) => {
  try {
    const key = msg.key || {};
    const id = key.id || msg.id || null;
    const remote = key.remoteJid || msg.remote || null;
    const fromMe = !!key.fromMe;
    const pushName = msg.pushName || msg.pushName || null;
    const mtype = msg.message ? Object.keys(msg.message)[0] : msg.type || null;
    let text = "";
    if (mtype === "conversation") text = msg.message.conversation;
    else if (mtype === "extendedTextMessage") text = msg.message.extendedTextMessage?.text || "";
    else if (mtype === "imageMessage") text = msg.message.imageMessage?.caption || "";
    else if (mtype === "documentMessage") text = msg.message.documentMessage?.fileName || "";
    const timestamp = msg.messageTimestamp || key.timestamp || msg.timestamp || null;
    return { id, remote, fromMe, pushName, type: mtype, text, timestamp };
  } catch (e) {
    return null;
  }
};

const normalizeStoredMessage = (item) => {
  // item expected to be the format we saved to file
  return {
    id: item.id || null,
    remote: item.remote || null,
    fromMe: !!item.fromMe,
    pushName: item.pushName || null,
    type: item.type || null,
    text: item.text || "",
    timestamp: item.timestamp || null,
  };
};

const normalizeMessages = (arr) => {
  if (!Array.isArray(arr)) return [];
  return arr
    .map((m) => {
      if (!m) return null;
      if (m.message || m.key) return normalizeBaileysMessage(m);
      // assume stored item
      return normalizeStoredMessage(m);
    })
    .filter((x) => x !== null);
};

// helper to attach common handlers when a new ws client connects
const attachWsClient = (ws) => {
  ws.on("pong", () => {});
  ws.on("close", () => wsClients.delete(ws));
  ws.on("error", () => wsClients.delete(ws));
  ws.on("message", (data) => {
    // accept simple JSON commands from client, e.g. { type: 'get_history', jid, limit }
    try {
      const json = JSON.parse(data.toString());
      if (json && json.type === "get_history") {
        const jid = json.jid;
        const limit = Number(json.limit) || 50;
        (async () => {
              // Try to read from local file first
              const fileHist = readHistoryFromFile(jid, limit);
              const compact = !!json.compact;
              if (fileHist) {
                const out = compact ? normalizeMessages(fileHist) : fileHist;
                return ws.send(JSON.stringify({ type: "history", jid, messages: out, source: 'file' }));
              }

          if (!WA_READY) return ws.send(JSON.stringify({ type: "error", message: "WA offline and no local history" }));
          if (!store || typeof store.loadMessages !== "function") {
            return ws.send(JSON.stringify({ type: "error", message: "in-memory store not available to load history" }));
          }
          try {
            const msgs = await store.loadMessages(jid, limit);
            const out = compact ? normalizeMessages(msgs) : msgs;
            ws.send(JSON.stringify({ type: "history", jid, messages: out, source: 'store' }));
          } catch (e) {
            ws.send(JSON.stringify({ type: "error", message: e.message }));
          }
        })();
      }
    } catch (e) {
      // ignore non-json or parse errors
    }
  });
  wsClients.add(ws);
  try {
    ws.send(JSON.stringify({ type: "welcome", message: "connected" }));
    ws.send(JSON.stringify({ type: "wa_status", ready: WA_READY }));
  } catch (e) {}
};

app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(fileUpload());

// GET chat history
// Accepts either `jid` (full jid like 62812...@s.whatsapp.net or group@g.us) or `number` (phone like 08123..)
app.get('/history', async (req, res) => {
  const { jid, number, limit } = req.query;
  let targetJid = jid;
  if (!targetJid && number) {
    const n = String(number);
    targetJid = n.startsWith('62') ? `${n}@s.whatsapp.net` : `62${n.substring(1)}@s.whatsapp.net`;
  }

  if (!targetJid) return res.status(400).json({ success: false, message: 'jid or number query parameter required' });

  // try reading from local file first (works even if WA offline)
  const compact = req.query.compact === '1' || req.query.compact === 'true';
  const fileHist = readHistoryFromFile(targetJid, Number(limit) || 50);
  if (fileHist) {
    const out = compact ? normalizeMessages(fileHist) : fileHist;
    return res.json({ success: true, jid: targetJid, count: out.length, messages: out, source: 'file' });
  }

  if (!WA_READY) return res.status(503).json({ success: false, message: 'WhatsApp offline and no local history' });

  // if we have an in-memory store, use it
  if (!store || typeof store.loadMessages !== 'function') {
    return res.status(501).json({ success: false, message: 'in-memory store not available to load history' });
  }

  try {
    const lim = Number(limit) || 50;
  const messages = await store.loadMessages(targetJid, lim);
  const out = compact ? normalizeMessages(messages) : messages;
  return res.json({ success: true, jid: targetJid, count: out.length, messages: out, source: 'store' });
  } catch (e) {
    return res.status(500).json({ success: false, message: e.message });
  }
});

// =======================
// GLOBAL STATE
// =======================
let sock;
let WA_READY = false;

// queue 1 per 1 (anti spam)
const messageQueue = new Queue({ concurrency: 1 });
const DELAY_MS = 5000;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// =======================
// START SOCKET
// =======================
const startSock = async () => {
  const { state, saveCreds } = await useMultiFileAuthState("./sessions");
  const { version } = await fetchLatestBaileysVersion();

  sock = makeWASocket({
    version,
    auth: state,
    logger: Pino({ level: "silent" }),
    browser: ["Ubuntu", "Chrome", "22.04"],
  });

  // bind in-memory store to socket events so it keeps messages
  try {
    store.bind(sock.ev);
  } catch (e) {
    console.warn("store.bind failed", e?.message || e);
  }

  sock.ev.on("connection.update", async ({ connection, lastDisconnect, qr }) => {
    if (qr) {
      console.log("\n📱 Scan QR:");
      qrcode.generate(qr, { small: true });
    }

    if (connection === "open") {
      WA_READY = true;
      messageQueue.clear(); // 🔥 DROP job lama
      console.log("🟢 WhatsApp READY (queue dibersihkan)");
      // inform WS clients that WA is ready
      broadcast({ type: "wa_status", ready: true });
    }

    if (connection === "close") {
      WA_READY = false;
      const reason = lastDisconnect?.error?.output?.statusCode;
      console.log("🔴 WA DISCONNECTED", reason);

      // inform WS clients that WA is disconnected
      broadcast({ type: "wa_status", ready: false, reason });

      if (reason === DisconnectReason.loggedOut) {
        fs.rmSync("./sessions", { recursive: true, force: true });
        console.log("🚪 Logout, session dihapus");
      }

      setTimeout(startSock, 3000);
    }
  });

  sock.ev.on("creds.update", saveCreds);

  // listen for incoming messages and broadcast to websocket clients
  sock.ev.on("messages.upsert", (m) => {
    try {
      if (m.type !== "notify") return;
      const msgs = m.messages?.filter((msg) => !!msg.message) || [];
      for (const msg of msgs) {
        // skip message statuses
        if (msg.key && msg.key.remoteJid === "status@broadcast") continue;

        const parsed = (() => {
          const key = msg.key || {};
          const remote = key.remoteJid || null;
          const fromMe = !!key.fromMe;
          const id = key.id || null;
          const pushName = msg.pushName || null;
          const mtype = msg.message ? Object.keys(msg.message)[0] : null;
          let text = "";
          if (mtype === "conversation") text = msg.message.conversation;
          else if (mtype === "extendedTextMessage") text = msg.message.extendedTextMessage?.text;
          else if (mtype === "imageMessage") text = msg.message.imageMessage?.caption;
          else if (mtype === "documentMessage") text = msg.message.documentMessage?.fileName || "";
          return { id, remote, fromMe, pushName, type: mtype, text };
        })();

        // push to WS clients
        broadcast({ type: "whatsapp_message", payload: parsed });
        // persist to local json file (minimal fields + raw keys/message)
        try {
          const ts = msg.messageTimestamp || msg.key?.timestamp || Date.now();
          const item = {
            ...parsed,
            timestamp: ts,
            key: msg.key || null,
            message: msg.message || null,
          };
          const target = parsed.remote || msg.key?.remoteJid;
          if (target) saveMessageToFile(target, item);
        } catch (e) {
          console.error('failed to persist message', e);
        }
      }
    } catch (e) {
      console.error("Error broadcasting incoming message", e);
    }
  });
};

// =======================
// SEND PRIVATE MESSAGE
// =======================
app.post("/send-message", async (req, res) => {
  const { number, message } = req.body;
  const file = req.files?.file_dikirim;

  if (!WA_READY)
    return res.status(503).json({
      success: false,
      message: "WhatsApp offline, pesan ditolak",
    });

  if (!number)
    return res.status(400).json({ success: false, message: "Nomor wajib" });

  const jid = number.startsWith("62")
    ? `${number}@s.whatsapp.net`
    : `62${number.substring(1)}@s.whatsapp.net`;

  try {
    await messageQueue.add(async () => {
      if (!WA_READY) throw new Error("WA disconnect saat proses");

      const exists = await sock.onWhatsApp(jid);
      if (!exists || !exists.length) throw new Error("Nomor tidak terdaftar");

      const target = exists[0].jid;

      if (!file) {
        await sock.sendMessage(target, { text: message });
      } else {
        const dir = "./uploads";
        if (!fs.existsSync(dir)) fs.mkdirSync(dir);

        const filePath = path.join(dir, `${Date.now()}_${file.name}`);
        await file.mv(filePath);

        const ext = path.extname(filePath).toLowerCase();
        if ([".jpg", ".jpeg", ".png"].includes(ext)) {
          await sock.sendMessage(target, {
            image: { url: filePath },
            caption: message,
          });
        } else {
          await sock.sendMessage(target, {
            document: { url: filePath },
            fileName: file.name,
            mimetype: file.mimetype,
            caption: message,
          });
        }

        fs.unlinkSync(filePath);
      }

      await sleep(DELAY_MS);
    });

    res.json({
      success: true,
      status: "sent",
      message: "Pesan berhasil dikirim ke server WhatsApp",
    });
  } catch (err) {
    res.status(500).json({
      success: false,
      status: "failed",
      message: err.message,
    });
  }
});

// =======================
// SEND GROUP MESSAGE
// =======================
app.post("/send-group-message", async (req, res) => {
  const { id_groups, message } = req.body;
  const file = req.files?.file_dikirim;

  if (!WA_READY)
    return res.status(503).json({
      success: false,
      message: "WhatsApp offline, pesan ditolak",
    });

  if (!id_groups)
    return res.status(400).json({ success: false, message: "ID grup wajib" });

  const groupJid = id_groups.endsWith("@g.us")
    ? id_groups
    : `${id_groups}@g.us`;

  try {
    await messageQueue.add(async () => {
      if (!WA_READY) throw new Error("WA disconnect saat proses");

      const groups = await sock.groupFetchAllParticipating();
      if (!groups[groupJid]) throw new Error("Grup tidak ditemukan");

      if (!file) {
        await sock.sendMessage(groupJid, { text: message });
      } else {
        const dir = "./uploads";
        if (!fs.existsSync(dir)) fs.mkdirSync(dir);

        const filePath = path.join(dir, `${Date.now()}_${file.name}`);
        await file.mv(filePath);
        let result = null;
        const ext = path.extname(filePath).toLowerCase();
        if ([".jpg", ".jpeg", ".png"].includes(ext)) {
          result = await sock.sendMessage(groupJid, {
            image: { url: filePath },
            caption: message,
          });
        } else {
          result = await sock.sendMessage(groupJid, {
            document: { url: filePath },
            fileName: file.name,
            mimetype: file.mimetype,
            caption: message,
          });
        }
        console.log("Pesan grup terkirim:", result.key.id);
        console.log("Pesan grup terkirim ke:", groupJid);
        
        fs.unlinkSync(filePath);
      }

      await sleep(DELAY_MS);
    });

    res.json({
      success: true,
      status: "sent",
      message: "Pesan grup berhasil dikirim ke server WhatsApp",
    });
  } catch (err) {
    res.status(500).json({
      success: false,
      status: "failed",
      message: err.message,
    });
  }
});

// =======================
// GET LIST GROUPS
// =======================
app.get("/groups", async (req, res) => {
  if (!WA_READY) {
    return res.status(503).json({
      success: false,
      message: "WhatsApp belum ready",
    });
  }

  try {
    const groups = await sock.groupFetchAllParticipating();

    const result = Object.values(groups).map((g) => ({
      id: g.id,
      subject: g.subject,
      owner: g.owner,
      creation: g.creation,
      participants_count: g.participants?.length || 0,
    }));

    res.json({
      success: true,
      count: result.length,
      data: result,
    });
  } catch (err) {
    res.status(500).json({
      success: false,
      message: err.message,
    });
  }
});

// =======================
// upgrade http server to handle websocket connections on same port
server.on("upgrade", (request, socket, head) => {
  // You can implement auth here if needed
  wss.handleUpgrade(request, socket, head, (ws) => {
    attachWsClient(ws);
  });
});

// if WS_PORT is provided, also offer a standalone WS server on that port
let standaloneWss = null;
if (WS_PORT) {
  standaloneWss = new WebSocketServer({ port: WS_PORT });
  standaloneWss.on("connection", (ws) => {
    attachWsClient(ws);
  });
}

server.listen(PORT, HOST, async () => {
  console.log(`🚀 WA HTTP API running on http://${HOST === '0.0.0.0' ? 'localhost' : HOST}:${PORT}`);
  if (WS_PORT) console.log(`🚀 WebSocket server also listening on ws://${HOST === '0.0.0.0' ? 'localhost' : HOST}:${WS_PORT}`);
  console.log(`(If you bound to 0.0.0.0, connect using the machine's IP address)`);
  await startSock();
});
