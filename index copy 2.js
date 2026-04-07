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
const WS_PORT = process.env.WS_PORT ? Number(process.env.WS_PORT) : 4651;

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
          console.log(`store: saved message id=${msg.key?.id || 'unknown'} jid=${jid}`);
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
  console.log(`Broadcasting event type=${data.type} to ${wsClients.size} WS clients`);
  let sent = 0;
  for (const ws of wsClients) {
    const clientInfo = ws._info || {};
    try {
      if (ws.readyState === 1) {
        ws.send(str);
        sent++;
        console.log(` -> sent to client ${clientInfo.remoteAddress || clientInfo.remote || 'unknown'}:${clientInfo.remotePort || ''}`);
      } else {
        console.log(` -> skip client (not open) ${clientInfo.remoteAddress || 'unknown'}`);
      }
    } catch (e) {
      console.log(` -> error sending to client ${clientInfo.remoteAddress || 'unknown'}:`, e?.message || e);
    }
  }
  console.log(`Broadcast complete: ${sent}/${wsClients.size} clients sent`);
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

// media helpers
const MEDIA_DIR = path.join(MESSAGES_DIR, "media");
const ensureMediaDir = (jid) => {
  const d = path.join(MEDIA_DIR, jidToFilename(jid).replace(/\.json$/, ""));
  if (!fs.existsSync(d)) fs.mkdirSync(d, { recursive: true });
  return d;
};

const getExtFromMime = (mimetype, fileName) => {
  if (fileName) {
    const e = path.extname(fileName);
    if (e) return e;
  }
  if (!mimetype) return "";
  if (mimetype.includes("jpeg") || mimetype.includes("jpg")) return ".jpg";
  if (mimetype.includes("png")) return ".png";
  if (mimetype.includes("gif")) return ".gif";
  if (mimetype.includes("mp4")) return ".mp4";
  if (mimetype.includes("webp")) return ".webp";
  if (mimetype.includes("pdf")) return ".pdf";
  return "";
};

const downloadMediaSafe = async (msg, mtype) => {
  try {
    const mod = await import("@whiskeysockets/baileys").catch(() => ({}));
    const downloadContentFromMessage = mod.downloadContentFromMessage;
  
    // 🔥 FIX: ensure participant for group
    const msgFixed = {
      ...msg,
      key: {
        ...msg.key,
        participant:
            msg.key?.participantPn ||   // 🔥 PRIORITAS UTAMA
            msg.key?.participant ||
            msg.participant ||
            msg.key?.remoteJid
      }
    };
    console.log(msgFixed);

    const content = msgFixed.message?.[mtype];
    if (!content) {
      console.log("❌ content kosong");
      return null;
    }

    if (!content.mediaKey) {
      console.log("❌ mediaKey tidak ada → skip");
      return null;
    }

    const sleepMs = (ms) => new Promise((r) => setTimeout(r, ms));

    // 🔥 debug penting
    console.log("participant:", msgFixed.key?.participant);

    if (downloadContentFromMessage) {
      for (let i = 0; i < 3; i++) {
        try {
          await sleepMs(1000 * (i + 1));

          const stream = await downloadContentFromMessage(content, mtype);

          const chunks = [];
          for await (const chunk of stream) chunks.push(chunk);

          const buffer = Buffer.concat(chunks);

          console.log("✅ media berhasil di-download");
          return buffer;

        } catch (e) {
          console.warn(`⚠️ attempt ${i + 1} gagal:`, e?.message || e);
        }
      }
    }

    console.log("❌ semua attempt gagal (bad decrypt)");
    return null;

  } catch (err) {
    console.error("❌ downloadMediaSafe error:", err?.message || err);
    return null;
  }
};

const downloadMediaToFile = async (msg, jid, mtype, id) => {
  try {
    const buffer = await downloadMediaSafe(msg, mtype);

    if (!buffer) {
      console.log("❌ gagal download media");
      return null;
    }

    const content = msg.message?.[mtype];
    const mimetype = content?.mimetype || "application/octet-stream";

    const ext = getExtFromMime(mimetype, content?.fileName || null) || "";
    const dir = ensureMediaDir(jid);

    const filename = `${Date.now()}_${id || Math.random().toString(36).slice(2, 9)}${ext}`;
    const filePath = path.join(dir, filename);

    fs.writeFileSync(filePath, buffer);

    console.log(`✅ Media saved for ${jid} -> ${filePath}`);

    const isImage =
      mtype === "imageMessage" ||
      (mimetype && mimetype.startsWith("image"));

    return {
      path: filePath,
      mime: mimetype,
      name: filename,
      isImage,
    };

  } catch (e) {
    console.error("downloadMediaToFile error", e?.message || e);
    return null;
  }
};

// ---------------------
// Media re-processing (retry pending downloads)
// ---------------------
const MEDIA_RETRY_MAX = 5;
const MEDIA_RETRY_INTERVAL = 30 * 1000; // 30 seconds

const reprocessPendingMediaOnce = async (specificJid = null) => {
  try {
    ensureMessagesDir();
    const files = fs.readdirSync(MESSAGES_DIR).filter((f) => f.endsWith('.json'));
    for (const fileName of files) {
      const jid = fileName.replace(/\.json$/,'').replace(/_/g, '@'); // best-effort
      if (specificJid && jid !== specificJid) continue;
      const filePath = path.join(MESSAGES_DIR, fileName);
      let arr = [];
      try {
        arr = JSON.parse(fs.readFileSync(filePath, 'utf8') || '[]');
      } catch (e) {
        continue;
      }

      let changed = false;
      for (let i = 0; i < arr.length; i++) {
        const item = arr[i];
        if (!item) continue;
        if (!item.media || !item.media.pending) continue;
        const attempts = item.media.attempts || 0;
        if (attempts >= MEDIA_RETRY_MAX) continue;
        // check delay/backoff
        const last = item.media.lastAttempt || 0;
        const nextDelay = Math.pow(2, attempts) * 1000; // exponential backoff
        if (Date.now() - last < nextDelay) continue;

        console.log(`Reprocessing pending media for ${fileName} id=${item.id} attempt=${attempts + 1}`);

        // reconstruct a minimal msg object from stored key+message
        const retryMsg = { key: item.key || {}, message: item.message || {} };
        const mtype = item.type;
        const mediaInfo = await downloadMediaToFile(retryMsg, fileName.replace(/\.json$/, '').replace(/_/g, '@'), mtype, item.id);

        if (mediaInfo) {
          // attach media similarly to main flow
          try {
            if (mediaInfo.isImage) {
              const b = fs.readFileSync(mediaInfo.path);
              const base64 = b.toString('base64');
              item.media = {
                type: 'image',
                mime: mediaInfo.mime || null,
                name: mediaInfo.name || null,
                base64: `data:${mediaInfo.mime || 'image'};base64,${base64}`,
              };
            } else {
              const mime = mediaInfo.mime || '';
              let t = 'document';
              if (mime.includes('video')) t = 'video';
              else if (mime.includes('audio')) t = 'audio';
              else if (mime.includes('image')) t = 'image';
              item.media = { type: t, mime: mime || null, name: mediaInfo.name || null, path: mediaInfo.path || null };
            }
            changed = true;
            // broadcast success
            broadcast({ type: 'media_saved', payload: { chat: item.remote || jid, id: item.id, media: item.media } });
          } catch (e) {
            console.error('reprocess: failed to attach media', e?.message || e);
          }
        } else {
          // increment attempts and update timestamp
          item.media.attempts = attempts + 1;
          item.media.lastAttempt = Date.now();
          item.media.reason = 'bad_decrypt_or_incompat';
          changed = true;
          // broadcast pending update
          broadcast({ type: 'media_pending', payload: { chat: item.remote || jid, id: item.id, attempts: item.media.attempts } });
          console.log("⚠️ media gagal saat reprocess → tandai pending (attempts=", item.media.attempts, ")");
        }
      }

      if (changed) {
        try {
          fs.writeFileSync(filePath, JSON.stringify(arr, null, 2), 'utf8');
        } catch (e) {
          console.error('reprocess: failed to write file', filePath, e?.message || e);
        }
      }
    }
  } catch (e) {
    console.error('reprocessPendingMediaOnce error', e?.message || e);
  }
};

// start background retry loop
setInterval(() => {
  if (!WA_READY) return; // only attempt when WA connected
  reprocessPendingMediaOnce().catch((e) => console.error('reprocess interval error', e));
}, MEDIA_RETRY_INTERVAL);

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
const attachWsClient = (ws, info = {}) => {
  ws._info = info;
  console.log("WS new connection", info);
  ws.on("pong", () => {});
  ws.on("close", () => {
    wsClients.delete(ws);
    console.log("WS disconnected", info);
  });
  ws.on("error", (err) => {
    wsClients.delete(ws);
    console.log("WS error", info, err?.message || err);
  });
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

// diagnostic endpoint to see connected WS clients
app.get('/ws-clients', (req, res) => {
  const clients = [];
  for (const ws of wsClients) {
    clients.push({ remote: ws._info?.remoteAddress || null, info: ws._info || null });
  }
  res.json({ count: wsClients.size, clients });
});

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
    console.log('connection.update', { connection, hasQr: !!qr, lastDisconnect: lastDisconnect ? (lastDisconnect.error?.output?.statusCode || lastDisconnect.error) : null });
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
  sock.ev.on("messages.upsert", async (m) => {
    try {
      console.log('messages.upsert event', { type: m.type, total: m.messages?.length || 0 });
      if (m.type !== "notify") return;
      const msgs = m.messages?.filter((msg) => !!msg.message) || [];
      console.log('messages.upsert filtered count', msgs.length);
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

        // derive sender
        const senderJid = msg.key?.participant || msg.key?.remoteJid || null;
        const senderNumber = senderJid ? String(senderJid).split("@")[0] : null;
        const senderName = msg.pushName || parsed.pushName || null;
        const isGroup = parsed.remote?.endsWith("@g.us");

        // try fetch group metadata (non-blocking for broadcast)
        let groupName = null;
        if (isGroup) {
          try {
            const g = await sock.groupMetadata(parsed.remote).catch(() => null);
            groupName = g?.subject || null;
          } catch (e) {
            groupName = null;
          }
        }

        // immediate payload to WS: text + meta
        const payload = {
          id: parsed.id,
          text: parsed.text,
          chat: parsed.remote,
          sender: senderNumber,
          senderName,
          isGroup,
          groupName,
          timestamp: msg.messageTimestamp || msg.key?.timestamp || Date.now(),
        };

        console.log('Incoming message for', parsed.remote, 'id=', parsed.id, 'text=', parsed.text);
        broadcast({ type: "whatsapp_message", payload });
        console.log('Broadcasted message to', wsClients.size, 'WS clients');

        // persist to local json file (include sender/group info and raw message)
        try {
          const ts = msg.messageTimestamp || msg.key?.timestamp || Date.now();
          const item = {
            id: parsed.id,
            remote: parsed.remote,
            fromMe: parsed.fromMe,
            pushName: senderName,
            type: parsed.type,
            text: parsed.text,
            timestamp: ts,
            sender: senderNumber,
            groupName: groupName || null,
            key: msg.key || null,
            message: msg.message || null,
          };
          const target = parsed.remote || msg.key?.remoteJid;
          console.log(parsed)
          if (target) {
            saveMessageToFile(target, item);
            console.log(`Saved message id=${item.id} to file for ${target}`);
          }

          // if message contains media, download asynchronously and update file & notify WS
          const mtype = parsed.type;
          if (["imageMessage", "videoMessage", "documentMessage", "audioMessage"].includes(mtype)) {
            (async () => {
              await sleep(2000);
              const msgForDownload = {
                ...msg,
                key: {
                  ...msg.key,
                  participant:
                    msg.key?.participant ||
                    msg.participant ||
                    msg.key?.remoteJid
                }
              };

              const mediaInfo = await downloadMediaToFile(
                msgForDownload,
                target,
                mtype,
                parsed.id
              );
              if (mediaInfo) {
                // update saved file: find message by id and attach media
                try {
                  const file = path.join(MESSAGES_DIR, jidToFilename(target));
                  if (fs.existsSync(file)) {
                    const arr = JSON.parse(fs.readFileSync(file, "utf8") || "[]");
                    for (let i = arr.length - 1; i >= 0; i--) {
                      if (arr[i].id === parsed.id) {
                        try {
                          // if image, embed as base64 inside JSON
                          if (mediaInfo.isImage) {
                            const b = fs.readFileSync(mediaInfo.path);
                            const base64 = b.toString('base64');
                            arr[i].media = {
                              type: 'image',
                              mime: mediaInfo.mime || null,
                              name: mediaInfo.name || null,
                              base64: `data:${mediaInfo.mime || 'image'};base64,${base64}`,
                            };
                          } else {
                            // other media types: do not embed, store metadata and path
                            const mime = mediaInfo.mime || '';
                            let mtype = 'document';
                            if (mime.includes('video')) mtype = 'video';
                            else if (mime.includes('audio')) mtype = 'audio';
                            else if (mime.includes('image')) mtype = 'image';
                            arr[i].media = {
                              type: mtype,
                              mime: mime || null,
                              name: mediaInfo.name || null,
                              path: mediaInfo.path || null,
                            };
                          }
                        } catch (e) {
                          console.error('failed to attach media to message', e?.message || e);
                          // fallback: attach raw mediaInfo
                          arr[i].media = mediaInfo;
                        }
                        break;
                      }
                    }
                    fs.writeFileSync(file, JSON.stringify(arr, null, 2), "utf8");
                    // notify ws clients that media saved (send the same shape we stored)
                    // find the updated message to include in payload
                    const updated = arr.find((x) => x.id === parsed.id) || null;
                    broadcast({ type: 'media_saved', payload: { chat: target, id: parsed.id, media: updated ? updated.media : mediaInfo } });
                  }
                } catch (e) {
                  console.error('failed to update saved message with media', e);
                }
              } else {
                // initial download failed: mark message in file as pending so background reprocessor will retry
                try {
                  const file = path.join(MESSAGES_DIR, jidToFilename(target));
                  if (fs.existsSync(file)) {
                    const arr = JSON.parse(fs.readFileSync(file, 'utf8') || '[]');
                    for (let i = arr.length - 1; i >= 0; i--) {
                      if (arr[i].id === parsed.id) {
                        arr[i].media = arr[i].media || {};
                        arr[i].media.pending = true;
                        arr[i].media.attempts = (arr[i].media.attempts || 0);
                        arr[i].media.lastAttempt = Date.now();
                        arr[i].media.reason = 'initial_download_failed';
                        break;
                      }
                    }
                    fs.writeFileSync(file, JSON.stringify(arr, null, 2), 'utf8');
                    broadcast({ type: 'media_pending', payload: { chat: target, id: parsed.id, attempts: arr.find(x => x.id === parsed.id)?.media?.attempts || 0 } });
                  }
                } catch (e) {
                  console.error('failed to mark message pending after initial download fail', e?.message || e);
                }
              }
            })();
          }
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
    const info = { remoteAddress: request.socket.remoteAddress, remotePort: request.socket.remotePort };
    attachWsClient(ws, info);
  });
});

// if WS_PORT is provided, also offer a standalone WS server on that port
let standaloneWss = null;
if (WS_PORT) {
  standaloneWss = new WebSocketServer({ port: WS_PORT });
  standaloneWss.on("connection", (ws, req) => {
    const info = { remoteAddress: req.socket.remoteAddress, remotePort: req.socket.remotePort };
    attachWsClient(ws, info);
  });
}

server.listen(PORT, HOST, async () => {
  console.log(`🚀 WA HTTP API running on http://${HOST === '0.0.0.0' ? 'localhost' : HOST}:${PORT}`);
  if (WS_PORT) console.log(`🚀 WebSocket server also listening on ws://${HOST === '0.0.0.0' ? 'localhost' : HOST}:${WS_PORT}`);
  console.log(`(If you bound to 0.0.0.0, connect using the machine's IP address)`);
  await startSock();
});
