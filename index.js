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
import axios from "axios";
import crypto from "crypto";
import { downloadContentFromMessage } from "@whiskeysockets/baileys";
import sharp from "sharp";
import { fonts } from "./fonts.js";


const app = express();

// allow configuring host/port via environment variables
const PORT = process.env.PORT ? Number(process.env.PORT) : 23412;
const HOST = process.env.HOST || "0.0.0.0";
// optional separate WS port (if set, WS will listen on this port instead of HTTP upgrade)
const WS_PORT = process.env.WS_PORT ? Number(process.env.WS_PORT) : 4651;

// helper to compute MEDIA_BASE_URL early and media url
const getMediaBase = () => {
  const PUBLIC_HOST = process.env.PUBLIC_HOST || (HOST === '0.0.0.0' ? process.env.MEDIA_PUBLIC_IP || '103.169.73.35' : HOST);
  return process.env.MEDIA_BASE_URL || `http://${PUBLIC_HOST}:${PORT}`;
};

const getMediaUrl = (jid, filename) => {
  const sjid = jidToFilename(jid).replace(/\.json$/, "");
  return `${getMediaBase()}/media/${sjid}/${filename}`;
};

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

const hkdf = (key, length, info) => {
  return crypto.hkdfSync("sha256", key, Buffer.alloc(0), Buffer.from(info), length);
};

const decryptMediaFile = (encBuffer, mediaKey, type = "image") => {
  try {
    const infoMap = {
      image: "WhatsApp Image Keys",
      video: "WhatsApp Video Keys",
      audio: "WhatsApp Audio Keys",
      document: "WhatsApp Document Keys",
    };

    const info = infoMap[type] || "WhatsApp Image Keys";

    // derive key
    const expandedKey = hkdf(mediaKey, 112, info);

    const iv = expandedKey.slice(0, 16);
    const cipherKey = expandedKey.slice(16, 48);

    const decipher = crypto.createDecipheriv("aes-256-cbc", cipherKey, iv);
    decipher.setAutoPadding(true); // enable automatic padding removal

    const decrypted = Buffer.concat([
      decipher.update(encBuffer),
      decipher.final(),
    ]);

    return decrypted;

  } catch (e) {
    console.error("❌ decrypt gagal:", e.message);
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
          try {
            if (mediaInfo.isImage) {
              // serve image via HTTP instead of embedding base64
              const sjid = fileName.replace(/\.json$/, '');
              const url = `${MEDIA_BASE_URL}/media/${sjid}/${mediaInfo.name}`;
              item.media = {
                type: 'image',
                mime: mediaInfo.mime || null,
                name: mediaInfo.name || null,
                url,
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

const formatTanggalIndo = (dateStr) => {
  const d = new Date(dateStr);

  return d.toLocaleDateString("id-ID", {
    day: "2-digit",
    month: "short",
    year: "numeric",
  });
};
 

const generateCaption = ({ nama, rute, tanggal, alamat }) => {
  return `${nama}

Rute: ${rute}

${formatTanggalIndo(tanggal)}

${alamat}`;
};
 
function capitalizeWords(str) {
  if (!str) return "";
  
  return str
    .toLowerCase()
    .split(" ")
    .map(word => word.charAt(0).toUpperCase() + word.slice(1))
    .join(" ");
}
 

async function addWatermarkToImage(inputPath, outputPath, data) {
  const { unit, nama, rute, tanggal, alamat } = data;

  const image = sharp(inputPath).rotate().ensureAlpha();
  const { width: W, height: H } = await image.metadata();

  const padding = Math.floor(W * 0.06);
  const isLandscape = W > H;

  // ===== FONT (ADAPTIVE) =====
  const base = Math.min(W, H);

  let fontTitle = Math.floor(base * (isLandscape ? 0.05 : 0.055));
  let fontNormal = Math.floor(base * (isLandscape ? 0.028 : 0.032));
  let fontSmall = Math.floor(base * (isLandscape ? 0.024 : 0.028));
  let fontVerySmall = Math.floor(base * (isLandscape ? 0.022 : 0.026));
  let fontTime = Math.floor(base * (isLandscape ? 0.05 : 0.055));

  const lineGap = Math.floor(fontNormal * 0.6);

  // ===== DATE =====
  const d = new Date(tanggal);
  const jam = d.toLocaleTimeString("id-ID", { hour: "2-digit", minute: "2-digit" });
  const tgl = d.toLocaleDateString("id-ID", {
    day: "numeric",
    month: "short",
    year: "numeric",
  });

  // ===== WIDTH =====
  const boxWidth = isLandscape
    ? W - padding * 2 - 30
    : W - padding * 2;

  const contentWidth = boxWidth - 80;

  // ===== WRAP TEXT =====
  function wrapText(text, maxWidth, fontSize) {
    const words = text.split(" ");
    const lines = [];
    let line = "";

    const charWidth = fontSize * 0.55;
    const getWidth = (str) => str.length * charWidth;

    words.forEach((word) => {
      const testLine = line + word + " ";
      if (getWidth(testLine) > maxWidth) {
        if (line) lines.push(line.trim());
        line = word + " ";
      } else {
        line = testLine;
      }
    });

    if (line) lines.push(line.trim());
    return lines;
  }

  const ruteLines = wrapText(`Rute ${rute} | Unit ${unit}`, contentWidth, fontVerySmall);
  const alamatLines = wrapText(alamat, contentWidth, fontVerySmall);

  // ===== HITUNG HEIGHT DINAMIS =====
  let tempY = 0;

  tempY += fontTitle + 6;
  tempY += ruteLines.length * (fontVerySmall + lineGap * 0.4);
  tempY += fontNormal + lineGap;
  tempY += fontNormal + lineGap;
  tempY += alamatLines.length * (fontVerySmall + lineGap * 0.35);

  const paddingTop = 30;
  const paddingBottom = 20;

  const finalBoxHeight = Math.min(
    tempY + paddingTop + paddingBottom,
    Math.floor(H * 0.7)
  );

  // ===== POSITION =====
  const boxX = padding;
  const boxY = H - finalBoxHeight - 30;

  // ===== CONTENT =====
  let currentY = boxY + paddingTop +20;
  let elements = "";

  // ===== NAMA =====
  elements += `
    <text x="${boxX + 25}" y="${currentY}"
      font-size="${fontTitle}" fill="white"
      font-weight="bold"
      font-family="GTWalsheim">
      ${nama}
    </text>
  `;
  currentY += fontTitle + 4;

  // ===== RUTE (AUTO WRAP) =====
  ruteLines.forEach(line => {
    elements += `
      <text x="${boxX + 25}" y="${currentY}"
        font-size="${fontVerySmall}"
        fill="#FFA500"
        font-family="GTWalsheim">
        ${line}
      </text>
    `;
    currentY += fontVerySmall + lineGap * 0.4;
  });

  // ===== UNIT =====
  elements += `
    <circle cx="${boxX + 33}" cy="${currentY - 6}" r="7" fill="#4FC3F7"/>
    <circle cx="${boxX + 33}" cy="${currentY - 6}" r="3" fill="white"/>

    <text x="${boxX + 50}" y="${currentY}"
      font-size="${fontNormal}"
      fill="white"
      font-weight="bold"
      font-family="GTWalsheimCondensed">
      ${unit}
    </text>
  `;
  currentY += fontNormal + lineGap;

  // ===== TANGGAL =====
  elements += `
    <rect x="${boxX + 25}" y="${currentY - 14}" width="18" height="18" rx="3" fill="white"/>
    <rect x="${boxX + 25}" y="${currentY - 14}" width="18" height="5" rx="2" fill="#FF6B6B"/>

    <text x="${boxX + 50}" y="${currentY}"
      font-size="${fontNormal}"
      fill="white"
      font-family="GTWalsheim">
      ${tgl}
    </text>
  `;
  currentY += fontNormal + lineGap;

  // ===== ALAMAT =====
  alamatLines.forEach((line, i) => {
    if (i === 0) {
      elements += `
        <circle cx="${boxX + 34}" cy="${currentY - 6}" r="8" fill="#FF6B6B"/>
        <circle cx="${boxX + 34}" cy="${currentY - 8}" r="3" fill="white"/>
      `;
    }

    elements += `
      <text x="${boxX + 50}" y="${currentY}"
        font-size="${fontVerySmall}"
        fill="white"
        font-family="GTWalsheim">
        ${escapeXml(line)}
      </text>
    `;

    currentY += fontVerySmall + lineGap * 0.35;
  });

  // ===== TIME (FIX SIZE & CENTER) =====
  const timeHeight = fontTime + 18;
  const timeWidth = jam.length * (fontTime * 0.6) + 30;

  const timeX = boxX + 12;
  const timeY = boxY - timeHeight - 6;

  // ===== LINE MERAH =====
  const lineWidth = 8;
  const lineX = boxX - lineWidth - 6;
  const lineTop = timeY;
  const lineHeight = (boxY + finalBoxHeight) - lineTop;

  // ===== SVG =====
  const svg = `
  <svg width="${W}" height="${H}" xmlns="http://www.w3.org/2000/svg">

    <!-- BOX -->
    <rect x="${boxX}" y="${boxY}"
      rx="16"
      width="${boxWidth}"
      height="${finalBoxHeight}"
      fill="black" fill-opacity="0.5"/>

    <!-- LINE -->
    <rect x="${lineX}" y="${lineTop}"
      width="${lineWidth}"
      height="${lineHeight}"
      fill="#FF3B30"
      rx="4"/>

    <!-- TIME BOX -->
    <rect x="${timeX}" y="${timeY}"
      rx="10"
      width="${timeWidth}"
      height="${timeHeight}"
      fill="black" fill-opacity="0.9"/>

    <!-- TIME TEXT -->
    <text
      x="${timeX + timeWidth / 2}"
      y="${timeY + timeHeight / 2}"
      font-size="${fontTime}"
      fill="white"
      font-weight="bold"
      font-family="GTWalsheim"
      text-anchor="middle"
      dominant-baseline="middle">
      ${jam}
    </text>

    ${elements}
  </svg>
  `;

  await image
    .composite([{ input: Buffer.from(svg), top: 0, left: 0 }])
    .toFile(outputPath);
}

// ===== ESCAPE XML =====
function escapeXml(str) {
  return str
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

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
    return { id, remote, fromMe, pushName, type: mtype, text, timestamp, time: formatDate(timestamp), media: msg.media || null };
  } catch (e) {
    return null;
  }
};

const formatDate = (ts) => {
  const d = new Date(ts * 1000);

  return d.toLocaleString("id-ID", {
    day: "2-digit",
    month: "2-digit",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  });
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
    time: formatDate(timestamp),
    media: item.media || null // 🔥 WAJIB
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
                        // ensure media.url exists for stored items
                        try {
                          for (const it of fileHist) {
                            if (it && it.media && !it.media.url) {
                              const sjid = jidToFilename(jid).replace(/\.json$/, '');
                              if (it.media.name) it.media.url = `${MEDIA_BASE_URL}/media/${sjid}/${it.media.name}`;
                              else if (it.media.path) {
                                const name = path.basename(it.media.path || '');
                                if (name) it.media.url = `${MEDIA_BASE_URL}/media/${sjid}/${name}`;
                              }
                            }
                          }
                        } catch (e) {}
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

// Public URL base for serving media files. Configure via env MEDIA_BASE_URL if needed.
const PUBLIC_HOST = process.env.PUBLIC_HOST || (HOST === '0.0.0.0' ? process.env.MEDIA_PUBLIC_IP || '103.169.73.35' : HOST);
const MEDIA_BASE_URL = process.env.MEDIA_BASE_URL || `http://${PUBLIC_HOST}:${PORT}`;

// Serve uploaded media files under /media/:sjid/:filename
app.get('/media/:sjid/:filename', (req, res) => {
  try {
    const sjid = req.params.sjid;
    const filename = req.params.filename;
    const dir = path.join(MEDIA_DIR, sjid);
    const filePath = path.join(dir, filename);
    if (!fs.existsSync(filePath)) return res.status(404).send('Not found');
    return res.sendFile(filePath);
  } catch (e) {
    console.error('media serve error', e?.message || e);
    return res.status(500).send('Server error');
  }
});

app.get('/output/:sjid/:filename', (req, res) => {
  try {
    const sjid = decodeURIComponent(req.params.sjid);
    const filename = req.params.filename;
    
    const dir = path.join(process.cwd(), "media");
    const filePath = path.join(dir, sjid, filename);

    console.log("REQUEST:", sjid, filename);
    console.log("FILEPATH:", filePath);

    if (!fs.existsSync(filePath)) {
      console.log("❌ FILE TIDAK ADA");
      return res.status(404).send('Not found');
    }

    return res.sendFile(filePath); // sekarang aman karena absolute path
  } catch (e) {
    console.error('media serve error', e?.message || e);
    return res.status(500).send('Server error');
  }
});

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
    // Ensure stored media entries have a public url (for older items that saved path instead of url)
    try {
      for (const it of fileHist) {
        if (it && it.media && !it.media.url) {
          const sjid = jidToFilename(targetJid).replace(/\.json$/, '');
          if (it.media.name) {
            it.media.url = `${MEDIA_BASE_URL}/media/${sjid}/${it.media.name}`;
          } else if (it.media.path) {
            const name = path.basename(it.media.path || '');
            if (name) it.media.url = `${MEDIA_BASE_URL}/media/${sjid}/${name}`;
          }
        }
      }
    } catch (e) {}

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
      if (m.type !== "notify") return;

      const msgs = m.messages?.filter((msg) => !!msg.message) || [];

      for (const msg of msgs) {
        // Skip status messages
        if (msg.key?.remoteJid === "status@broadcast") continue;

        const key = msg.key || {};
        const id = key.id || msg.id || null;
        const remote = key.remoteJid || msg.remote || null;
        const fromMe = !!key.fromMe;
        const pushName = msg.pushName || null;
        const mtype = msg.message ? Object.keys(msg.message)[0] : null;
        const timestamp = msg.messageTimestamp || key.timestamp || Date.now();
        const senderJid = msg.key?.participant || msg.key?.remoteJid || null;
        const senderNumber = senderJid ? String(senderJid).split("@")[0] : null;

        // Extract text from different message types
        let text = "";
        if (mtype === "conversation") text = msg.message.conversation;
        else if (mtype === "extendedTextMessage") text = msg.message.extendedTextMessage?.text || "";
        else if (mtype === "imageMessage") text = msg.message.imageMessage?.caption || "";
        else if (mtype === "documentMessage") text = msg.message.documentMessage?.fileName || "";

        // Get group name if group message
        let groupName = null;
        const isGroup = remote?.endsWith("@g.us");
        if (isGroup) {
          try {
            const g = await sock.groupMetadata(remote).catch(() => null);
            groupName = g?.subject || null;
          } catch (e) {
            groupName = null;
          }
        }

        // Create message item for JSON storage
        const item = {
          id,
          remote,
          fromMe,
          pushName,
          type: mtype,
          text,
          timestamp,
          sender: senderNumber,
          groupName: groupName || null,
          key: key || null,
          message: msg.message || null,
        };

        // If this is a media message, reserve a public URL immediately (pending)
        try {
          const mediaTypes = {
            imageMessage: 'image',
            videoMessage: 'video',
            audioMessage: 'audio',
            documentMessage: 'document'
          };
          if (["imageMessage", "videoMessage", "documentMessage", "audioMessage"].includes(mtype)) {
            const content = msg.message?.[mtype];
            const mimetype = content?.mimetype || null;
            const ext = getExtFromMime(mimetype, content?.fileName || null) || "";
            const fname = `${timestamp}_${id}${ext}`;
            const url = getMediaUrl(remote, fname);
            item.media = {
              pending: true,
              type: mediaTypes[mtype] || 'document',
              mime: mimetype,
              name: fname,
              url,
              attempts: 0,
              lastAttempt: Date.now()
            };
          }
        } catch (e) {
          // ignore any error while computing provisional media url
        }

        // Save message to JSON file
        if (remote) {
          saveMessageToFile(remote, item);
          console.log(`✅ Message saved id=${id} to file for ${remote}`);
        }

        // Broadcast message to WebSocket clients (initial text + metadata)
        const payload = {
          id,
          text,
          chat: remote,
          sender: senderNumber,
          senderName: pushName,
          isGroup,
          groupName,
          timestamp,
          type: mtype,
        };
        // If this is a media message, skip initial broadcast and wait until file is saved
        const isMediaMsg = ["imageMessage", "videoMessage", "documentMessage", "audioMessage"].includes(mtype);
        if (!isMediaMsg) {
          broadcast({ type: "whatsapp_message", payload });
          console.log(`📤 Broadcasted message to ${wsClients.size} WS clients`);
        } else {
          console.log(`🟡 Media message received (id=${id}), deferring broadcast until file saved`);
        }

        // Handle media if present
        if (["imageMessage", "videoMessage", "documentMessage", "audioMessage"].includes(mtype)) {
          (async () => {
            try {
              await sleep(2000);
              
              const message = msg.message;
              if (!message?.[mtype]) return;

              let buffer = null;
              const typeMap = {
                imageMessage: "image",
                videoMessage: "video",
                audioMessage: "audio",
                documentMessage: "document"
              };

              try {
                // Try to download using downloadContentFromMessage
                const downloadContentFromMessage = (await import("@whiskeysockets/baileys")).downloadContentFromMessage;
                const stream = await downloadContentFromMessage(message[mtype], mtype.replace("Message", ""));
                
                buffer = Buffer.from([]);
                for await (const chunk of stream) {
                  buffer = Buffer.concat([buffer, chunk]);
                }
                console.log("✅ Media downloaded successfully");
              } catch (e) {
                console.log("⚠️ Standard download failed:", e?.message);
                buffer = null;
              }

              if (!buffer) {
                console.log("⚠️ Fallback: using raw download");
                const content = message?.[mtype];
                if (content?.directPath) {
                  try {
                    const url = `https://mmg.whatsapp.net${content.directPath}`;
                    const res = await axios.get(url, {
                      responseType: "arraybuffer",
                      headers: {
                        Origin: "https://web.whatsapp.com",
                        Referer: "https://web.whatsapp.com/",
                        "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/120 Safari/537.36"
                      }
                    });
                    
                    if (content.mediaKey && res.data) {
                      buffer = decryptMediaFile(res.data, content.mediaKey, typeMap[mtype] || "image");
                      console.log("✅ Media decrypted from raw download");
                    }
                  } catch (e) {
                    console.log("❌ Raw download failed:", e?.message);
                  }
                }
              }

              if (buffer) {
                // Save media to file
                const content = message?.[mtype];
                const mimetype = content?.mimetype || "application/octet-stream";
                const ext = getExtFromMime(mimetype, content?.fileName || null) || "";
                const dir = ensureMediaDir(remote);
                const filename = `${timestamp}_${id}${ext}`;
                const filePath = path.join(dir, filename);

                fs.writeFileSync(filePath, buffer);
                console.log(`✅ Media saved: ${filePath}`);

                // Update JSON with media info
                try {
                  const file = path.join(MESSAGES_DIR, jidToFilename(remote));
                  if (fs.existsSync(file)) {
                    const arr = JSON.parse(fs.readFileSync(file, "utf8") || "[]");
                    for (let i = arr.length - 1; i >= 0; i--) {
                      if (arr[i].id === id) {
                        if (mtype === "imageMessage" && [".jpg", ".jpeg", ".png", ".gif"].some(ext => filename.endsWith(ext))) {
                          // For images: provide a public URL instead of embedding base64
                          const sjid = jidToFilename(remote).replace(/\.json$/, '');
                          const url = `${MEDIA_BASE_URL}/media/${sjid}/${filename}`;
                          arr[i].media = {
                            type: 'image',
                            mime: mimetype,
                            name: filename,
                            url,
                          };
                        } else {
                          // For other media, store metadata and also provide a public URL
                          const mediaType = typeMap[mtype] || 'document';
                          const sjid = jidToFilename(remote).replace(/\.json$/, '');
                          const url = `${MEDIA_BASE_URL}/media/${sjid}/${filename}`;
                          arr[i].media = {
                            type: mediaType,
                            mime: mimetype,
                            name: filename,
                            path: filePath,
                            url,
                          };
                        }
                        // After attaching media info to saved message, broadcast a single whatsapp_message
                        const outPayload = {
                          id,
                          text,
                          chat: remote,
                          sender: senderNumber,
                          senderName: pushName,
                          isGroup,
                          groupId: isGroup ? remote : null,
                          groupName: groupName || null,
                          timestamp,
                          type: mtype,
                          media: arr[i].media,
                        };
                        broadcast({ type: 'whatsapp_message', payload: outPayload });
                        break;
                      }
                    }
                    fs.writeFileSync(file, JSON.stringify(arr, null, 2), "utf8");
                  }
                } catch (e) {
                  console.error("Failed to update JSON with media:", e?.message);
                }
              } else {
                console.log("⚠️ Media download completely failed, marking as pending");
                // Mark as pending for retry
                try {
                  const file = path.join(MESSAGES_DIR, jidToFilename(remote));
                  if (fs.existsSync(file)) {
                    const arr = JSON.parse(fs.readFileSync(file, "utf8") || "[]");
                    for (let i = arr.length - 1; i >= 0; i--) {
                      if (arr[i].id === id) {
                        arr[i].media = {
                          pending: true,
                          attempts: 0,
                          lastAttempt: Date.now(),
                          reason: "download_failed"
                        };
                        break;
                      }
                    }
                    fs.writeFileSync(file, JSON.stringify(arr, null, 2), "utf8");
                  }
                } catch (e) {
                  console.error("Failed to mark media as pending:", e?.message);
                }
              }
            } catch (e) {
              console.error("Media handling error:", e?.message);
            }
          })();
        }
      }
    } catch (err) {
      console.error("❌ messages.upsert ERROR:", err);
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


app.post("/send-driver-image", async (req, res) => {
  const { number, nama, rute, tanggal, alamat } = req.body;
  const file = req.files?.image;

  if (!file) {
    return res.status(400).json({ success: false, message: "Image wajib" });
  }

  if (!number) {
    return res.status(400).json({ success: false, message: "Nomor wajib" });
  }

  if (!WA_READY) {
    return res.status(503).json({ success: false, message: "WA belum ready" });
  }

  const jid = number.startsWith("62")
    ? `${number}@s.whatsapp.net`
    : `62${number.substring(1)}@s.whatsapp.net`;

  const caption = generateCaption({ nama, rute, tanggal, alamat });

  try {
    const dir = "./uploads";
    if (!fs.existsSync(dir)) fs.mkdirSync(dir);

    const filePath = path.join(dir, `${Date.now()}_${file.name}`);
    await file.mv(filePath);

    await sock.sendMessage(jid, {
      image: { url: filePath },
      caption,
    });

    fs.unlinkSync(filePath);

    res.json({
      success: true,
      message: "Berhasil kirim gambar + caption",
      caption,
    });
  } catch (err) {
    res.status(500).json({
      success: false,
      message: err.message,
    });
  }
});

app.post("/send-driver-group-image", async (req, res) => {
  try {
    const { id_groups, nama, rute, tanggal, alamat, unit } = req.body;
    const file = req.files?.image;

    if (!file) return res.status(400).json({ message: "Image wajib" });
    if (!id_groups) return res.status(400).json({ message: "ID grup wajib" });

    if (!WA_READY) {
      return res.status(503).json({ message: "WA belum ready" });
    }

    const groupJid = id_groups.endsWith("@g.us")
      ? id_groups
      : `${id_groups}@g.us`;

    // simpan file asli
    const dir = path.join("./media", id_groups);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    const ext = path.extname(file.name); // .jpg
    const base = path.basename(file.name, ext);

    const nameFile = `wm_${Date.now()}_${base}${ext}`;
    const inputPath = path.join(dir, `raw_${Date.now()}_${file.name}`);
    const outputPath = path.join(dir, nameFile);

    await file.mv(inputPath);

    // 🔥 tambahin watermark ke gambar
    await addWatermarkToImage(inputPath, outputPath, {
      nama: capitalizeWords(nama),
      rute,
      tanggal,
      alamat,
      unit
    });

    // kirim TANPA caption
    await sock.sendMessage(groupJid, {
      image: { url: outputPath },
    });

    // cleanup 
    // fs.unlinkSync(outputPath);
    fs.unlinkSync(inputPath);

    const protocol = req.protocol;
    const host = req.get("host");

    const fileUrl = `${protocol}://${host}/output/${id_groups}/${nameFile}`;

    res.json({
      success: true,
      message: "Berhasil kirim gambar + watermark ke grup",
      url: fileUrl,
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
