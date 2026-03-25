import express from "express";
import makeWASocket, {
  useMultiFileAuthState,
  DisconnectReason,
  fetchLatestBaileysVersion,
} from "@whiskeysockets/baileys";
import qrcode from "qrcode-terminal";
import Pino from "pino";
import fs from "fs";
import fileUpload from "express-fileupload";
import path from "path";
import Queue from "p-queue"; // <-- buat antrean kirim pesan

const app = express();
const PORT = 23412;
let WA_READY = false;

app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(fileUpload());

// 🧩 Setup antrean global
const messageQueue = new Queue({ concurrency: 1 }); // kirim 1 pesan per waktu
const DELAY_MS = 5000; // jeda 2,5 detik antar kiriman

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

let sock;

function getMessageText(msg) {
  if (!msg.message) return null;

  const message = msg.message;

  if (message.conversation) {
    return message.conversation;
  }

  if (message.extendedTextMessage?.text) {
    return message.extendedTextMessage.text;
  }

  if (message.imageMessage?.caption) {
    return message.imageMessage.caption;
  }

  if (message.videoMessage?.caption) {
    return message.videoMessage.caption;
  }

  return null;
}

// 🔌 Start WhatsApp socket
const startSock = async () => {
  const { state, saveCreds } = await useMultiFileAuthState("./sessions");
  const { version } = await fetchLatestBaileysVersion();

  sock = makeWASocket({
    version,
    auth: state,
    logger: Pino({ level: "silent" }),
    browser: ["Ubuntu", "Chrome", "22.04.4"],
  });

  sock.ev.on("connection.update", async (update) => {
    const { connection, lastDisconnect, qr } = update;

    if (qr) {
      console.log("\n📱 Scan QR berikut dari WhatsApp (Linked Devices):");
      qrcode.generate(qr, { small: true });
    }

    if (connection === "open") {
      WA_READY = true;
      console.log("✅ WhatsApp connected!");
    }

    if (connection === "close") {
      WA_READY = false;
      const reason = lastDisconnect?.error?.output?.statusCode;
      const shouldReconnect = reason !== DisconnectReason.loggedOut;
      console.log("❌ Koneksi terputus, reconnect:", shouldReconnect);

      if (reason === DisconnectReason.loggedOut) {
        console.log("🚪 Logout terdeteksi, membersihkan session lama...");
        try {
          await sock.logout();
        } catch {}
        try {
          sock.end();
        } catch {}
        fs.rmSync("./sessions", { recursive: true, force: true });
        console.log("✅ Session lama dihapus. Silakan restart untuk scan ulang QR.");
      }

      if (shouldReconnect) setTimeout(startSock, 3000);
    }
  });

  sock.ev.on("creds.update", saveCreds);

  sock.ev.on("messages.upsert", async (m) => {
    try {
      const msg = m.messages[0];
      if (!msg.message) return;
      if (msg.key.fromMe) return;
      const text = getMessageText(msg);

      // console.log("Dari:", msg.pushName);
      // console.log("JID :", msg.key.remoteJid);
      // console.log("Text:", text);
    } catch (err) {
      console.warn("⚠️ Gagal decrypt pesan:", err.message);
    }
  });
};

// ✅ Endpoint kirim pesan pribadi
app.post("/send-message-old", async (req, res) => {
  const { number, message } = req.body;
  const fileUploadData = req.files?.file_dikirim;
  const isConnected = sock?.user ? true : false;

  if (!number) return res.status(400).json({ status: false, response: "Nomor WA belum disertakan!" });

  const numberWA = number.startsWith("62") ? `${number}@s.whatsapp.net` : `62${number.substring(1)}@s.whatsapp.net`;

  messageQueue.add(async () => {
    try {
      if (!isConnected) throw new Error("WhatsApp belum terhubung.");
      const exists = await sock.onWhatsApp(numberWA);
      const target = exists?.jid || (exists && exists[0]?.jid);
      if (!target) throw new Error(`Nomor ${number} tidak terdaftar di WhatsApp.`);

      if (!fileUploadData) {
        await sock.sendMessage(target, { text: message });
      } else {
        const uploadDir = "./uploads";
        if (!fs.existsSync(uploadDir)) fs.mkdirSync(uploadDir);
        const filePath = path.join(uploadDir, `${Date.now()}_${fileUploadData.name}`);
        await fileUploadData.mv(filePath);

        const mime = fileUploadData.mimetype;
        const ext = path.extname(filePath).toLowerCase();

        if ([".jpeg", ".jpg", ".png", ".gif"].includes(ext)) {
          await sock.sendMessage(target, { image: { url: filePath }, caption: message });
        } else {
          await sock.sendMessage(target, {
            document: { url: filePath },
            fileName: fileUploadData.name,
            mimetype: mime,
            caption: message,
          });
        }

        fs.unlink(filePath, () => {});
      }

      console.log(`[QUEUE] ✅ Pesan terkirim ke ${number}`);
    } catch (err) {
      console.error(`[QUEUE ERROR] Gagal kirim ke ${number}: ${err.message}`);
    }

    await sleep(DELAY_MS);
  });

  res.status(200).json({ status: true, response: "Pesan dimasukkan ke antrean!" });
});

app.post("/send-message", async (req, res) => {
  const { number, message } = req.body;
  const fileUploadData = req.files?.file_dikirim;

  if (!number)
    return res.status(400).json({ success: false, message: "Nomor WA wajib" });

  const numberWA = number.startsWith("62")
    ? `${number}@s.whatsapp.net`
    : `62${number.substring(1)}@s.whatsapp.net`;

  try {
    const result = await messageQueue.add(async () => {
      if (!sock || !sock.user) throw new Error("WhatsApp belum terhubung");

      const exists = await sock.onWhatsApp(numberWA);
      if (!exists || exists.length === 0)
        throw new Error("Nomor tidak terdaftar di WhatsApp");

      const target = exists[0].jid;

      if (!fileUploadData) {
        await sock.sendMessage(target, { text: message });
      } else {
        const uploadDir = "./uploads";
        if (!fs.existsSync(uploadDir)) fs.mkdirSync(uploadDir);

        const filePath = path.join(uploadDir, `${Date.now()}_${fileUploadData.name}`);
        await fileUploadData.mv(filePath);

        const ext = path.extname(filePath).toLowerCase();

        if ([".jpg", ".jpeg", ".png"].includes(ext)) {
          await sock.sendMessage(target, {
            image: { url: filePath },
            caption: message,
          });
        } else {
          await sock.sendMessage(target, {
            document: { url: filePath },
            fileName: fileUploadData.name,
            mimetype: fileUploadData.mimetype,
            caption: message,
          });
        }

        fs.unlinkSync(filePath);
      }

      await sleep(DELAY_MS);
      return true;
    });

    return res.json({
      success: true,
      message: "Pesan berhasil dikirim",
    });
  } catch (err) {
    return res.status(500).json({
      success: false,
      message: err.message,
    });
  }
});


// ✅ Endpoint kirim pesan ke grup
app.post("/send-group-message-old", async (req, res) => {
  const { id_groups, message } = req.body;
  const fileUploadData = req.files?.file_dikirim;
  const isConnected = sock?.user ? true : false;
  console.log("ID Group:", id_groups);
  if (!id_groups) return res.status(400).json({ status: false, response: "ID Group belum disertakan!" });
  const groupJid = id_groups.endsWith("@g.us") ? id_groups : `${id_groups}@g.us`;

  messageQueue.add(async () => {
    try {
      if (!isConnected) throw new Error("WhatsApp belum terhubung.");
      const groups = await sock.groupFetchAllParticipating();
      if (!groups[groupJid]) throw new Error(`Grup ${groupJid} tidak ditemukan.`);

      if (!fileUploadData) {
        await sock.sendMessage(groupJid, { text: message });
      } else {
        const uploadDir = "./uploads";
        if (!fs.existsSync(uploadDir)) fs.mkdirSync(uploadDir);
        const filePath = path.join(uploadDir, `${Date.now()}_${fileUploadData.name}`);
        await fileUploadData.mv(filePath);

        const mime = fileUploadData.mimetype;
        const ext = path.extname(filePath).toLowerCase();

        if ([".jpeg", ".jpg", ".png", ".gif"].includes(ext)) {
          await sock.sendMessage(groupJid, { image: { url: filePath }, caption: message });
        } else {
          await sock.sendMessage(groupJid, {
            document: { url: filePath },
            fileName: fileUploadData.name,
            mimetype: mime,
            caption: message,
          });
        }

        fs.unlink(filePath, () => {});
      }

      console.log(`[QUEUE] ✅ Pesan grup terkirim ke ${groupJid}`);
    } catch (err) {
      console.error(`[QUEUE ERROR] Gagal kirim ke grup ${groupJid}: ${err.message}`);
    }

    await sleep(DELAY_MS);
  });

  res.status(200).json({ status: true, response: "Pesan grup dimasukkan ke antrean!" });
});

app.post("/send-group-message", async (req, res) => {
  const { id_groups, message } = req.body;
  const fileUploadData = req.files?.file_dikirim;

  if (!id_groups)
    return res.status(400).json({ success: false, message: "ID Group wajib" });

  const groupJid = id_groups.endsWith("@g.us")
    ? id_groups
    : `${id_groups}@g.us`;

  try {
    await messageQueue.add(async () => {
      if (!sock || !sock.user) throw new Error("WhatsApp belum terhubung");

      const groups = await sock.groupFetchAllParticipating();
      if (!groups[groupJid]) throw new Error("Grup tidak ditemukan");

      if (!fileUploadData) {
        await sock.sendMessage(groupJid, { text: message });
      } else {
        const uploadDir = "./uploads";
        if (!fs.existsSync(uploadDir)) fs.mkdirSync(uploadDir);

        const filePath = path.join(uploadDir, `${Date.now()}_${fileUploadData.name}`);
        await fileUploadData.mv(filePath);

        const ext = path.extname(filePath).toLowerCase();

        if ([".jpg", ".jpeg", ".png"].includes(ext)) {
          await sock.sendMessage(groupJid, {
            image: { url: filePath },
            caption: message,
          });
        } else {
          await sock.sendMessage(groupJid, {
            document: { url: filePath },
            fileName: fileUploadData.name,
            mimetype: fileUploadData.mimetype,
            caption: message,
          });
        }

        fs.unlinkSync(filePath);
      }

      await sleep(DELAY_MS);
    });

    res.json({ success: true, message: "Pesan grup berhasil dikirim" });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});


// ✅ Ambil daftar grup
app.get("/groups", async (req, res) => {
  try {
    const groups = await sock.groupFetchAllParticipating();
    const groupList = Object.values(groups).map((g) => ({
      id: g.id,
      subject: g.subject,
      participantsCount: g.participants?.length || 0,
      owner: g.owner || "-",
    }));

    res.json({ success: true, total: groupList.length, groups: groupList });
  } catch (error) {
    console.error("Gagal ambil grup:", error);
    res.status(500).json({ success: false, message: "Gagal ambil daftar grup" });
  }
});

// ✅ Logout
app.post("/logout", async (req, res) => {
  try {
    await sock.logout();
    sock.end();
    fs.rmSync("./sessions", { recursive: true, force: true });
    res.json({ success: true, message: "Logout berhasil dan session dihapus." });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

app.listen(PORT, "0.0.0.0", async () => {
  console.log(`🚀 API berjalan di http://localhost:${PORT}`);
  await startSock();
});
