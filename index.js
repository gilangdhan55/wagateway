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
 

const app = express();
const PORT = 8888;
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(fileUpload());

let sock; // biar bisa dipakai di endpoint juga

const startSock = async () => {
    const { state, saveCreds } = await useMultiFileAuthState("./sessions");
    const { version } = await fetchLatestBaileysVersion();

    sock = makeWASocket({
        version,
        auth: state,
        logger: Pino({ level: "silent" }),
        browser: ["Ubuntu", "Chrome", "22.04.4"],
    });

  // ✅ Tangkap update koneksi & QR
    sock.ev.on("connection.update", async (update) => {
        const { connection, lastDisconnect, qr } = update;

        if (qr) {
        console.log("\n📱 Scan QR berikut dari WhatsApp (Linked Devices):");
        qrcode.generate(qr, { small: true });
        }

        if (connection === "open") {
        console.log("✅ WhatsApp connected!");
        }

        if (connection === "close") {
            const reason = lastDisconnect?.error?.output?.statusCode;
            const shouldReconnect = reason !== DisconnectReason.loggedOut;
            console.log("❌ Koneksi terputus, reconnect:", shouldReconnect);

            // hapus session kalau logout permanen
            if (reason === DisconnectReason.loggedOut) {
                console.log("🚪 Logout terdeteksi, membersihkan session lama...");

                try {
                    await sock.logout(); // pastikan socket logout secara resmi
                } catch (err) {
                    console.warn("⚠️ Error saat logout:", err.message);
                }

                // tutup koneksi dan hapus semua cache
                try {
                    sock.end(); // matikan koneksi socket sepenuhnya
                } catch (e) {}

                fs.rmSync("./sessions", { recursive: true, force: true });

                console.log("✅ Session lama dihapus. Silakan restart untuk scan ulang QR.");
            }


        if (shouldReconnect) {
            setTimeout(startSock, 3000);
        }
        }
    });

    // ✅ Save credentials setiap update
    sock.ev.on("creds.update", saveCreds);

    // ✅ Tangani pesan masuk biar gak error decrypt
    sock.ev.on("messages.upsert", async (m) => {
        try {
        const msg = m.messages[0];
        if (!msg.message) return;
        console.log("📩 Pesan dari:", msg.key.remoteJid);
        } catch (err) {
        console.warn("⚠️ Gagal decrypt pesan:", err.message);
        }
    });
    };

    // ✅ Endpoint kirim pesan teks
    app.post('/send', async (req, res) => {
        const { to, message } = req.body;
        try {
            const sendMsg = await sock.sendMessage(to, { text: message });
            res.json({ success: true, response: sendMsg });
        } catch (err) {
            console.error(err);
            res.json({ success: false, error: err });
        }
    });
 

    // ✅ Endpoint kirim media / dokumen
    app.post("/send-message", async (req, res) => {
        const pesankirim = typeof req.body.message === "string" ? req.body.message.trim() : !req.body.message ? "" : JSON.stringify(req.body.message); 
        const number = req.body.number;
        const fileUpload = req.files?.file_dikirim; // sesuai nama form
        const isConnected = sock?.user ? true : false;

        if (!number) {
            return res.status(400).json({
            status: false,
            response: "Nomor WA belum disertakan!",
            });
        }

        // format ke jid WA
        const numberWA = number.startsWith("62")
            ? `${number}@s.whatsapp.net`
            : `62${number.substring(1)}@s.whatsapp.net`;

        try {
            if (!isConnected) {
                return res.status(500).json({
                    status: false,
                    response: "WhatsApp belum terhubung.",
                });
            }

            // cek apakah nomor valid di WA
            const exists = await sock.onWhatsApp(numberWA);
            const target = exists?.jid || (exists && exists[0]?.jid);
            if (!target) {
                return res.status(404).json({
                    status: false,
                    response: `Nomor ${number} tidak terdaftar di WhatsApp.`,
                });
            }

            // kalau tidak ada file, kirim teks biasa
            if (!fileUpload) {
                const result = await sock.sendMessage(target, { text: pesankirim });
                return res.status(200).json({
                    status: true,
                    message: "Pesan teks berhasil dikirim!",
                    response: result,
                });
            }

            // kalau ada file
            const uploadDir = "./uploads";
            if (!fs.existsSync(uploadDir)) fs.mkdirSync(uploadDir);

            const fileName = `${Date.now()}_${fileUpload.name}`;
            const filePath = path.join(uploadDir, fileName);

            // simpan ke folder uploads
            await fileUpload.mv(filePath);

            const mime = fileUpload.mimetype;
            const ext = path.extname(filePath).toLowerCase();

            // kirim berdasarkan tipe file
            let result;
            if ([".jpeg", ".jpg", ".png", ".gif"].includes(ext)) {
                result = await sock.sendMessage(target, {
                    image: { url: filePath },
                    caption: pesankirim,
                });
            } else if ([".mp3", ".ogg"].includes(ext)) {
                result = await sock.sendMessage(target, {
                    audio: { url: filePath },
                    mimetype: "audio/mp4",
                    caption: pesankirim,
                });
            } else {
                result = await sock.sendMessage(target, {
                    document: { url: filePath },
                    fileName: fileUpload.name,
                    mimetype: mime,
                    caption: pesankirim,
                });
            }

            // hapus file setelah dikirim
            fs.unlink(filePath, (err) => {
                if (err) console.warn("Gagal hapus file:", err.message);
            });

            return res.status(200).json({
                status: true,
                message: "Pesan berhasil dikirim!",
                data: {
                    name: fileUpload.name,
                    mimetype: fileUpload.mimetype,
                    size: fileUpload.size,
                },
                response: result,
            });
        } catch (err) {
            console.error("❌ Gagal kirim pesan:", err);
            return res.status(500).json({
            status: false,
            response: err.message || err,
            });
        }
    });
     
    app.post("/send-group-message", async (req, res) => {
        const pesankirim = typeof req.body.message === "string" ? req.body.message.trim() : !req.body.message ? "" : JSON.stringify(req.body.message);
        const idGroup       = req.body.id_groups;
        const fileUpload    = req.files?.file_dikirim; // form key: file_dikirim
        const isConnected   = sock?.user ? true : false;

        if (!idGroup) {
            return res.status(400).json({
                status: false,
                response: "ID Group belum disertakan!",
            });
        }

        // format ke jid group
        const groupJid = idGroup.endsWith("@g.us") ? idGroup : `${idGroup}@g.us`;

        try {
            if (!isConnected) {
                return res.status(500).json({
                    status: false,
                    response: "WhatsApp belum terhubung.",
                });
            }

            // cek apakah grup valid
            const groups = await sock.groupFetchAllParticipating();
            if (!groups[groupJid]) {
                return res.status(404).json({
                    status: false,
                    response: `Grup ${groupJid} tidak ditemukan atau akun tidak join.`,
                });
            }

            // kirim teks biasa kalau tanpa file
            if (!fileUpload) {
                const result = await sock.sendMessage(groupJid, { text: pesankirim });
                return res.status(200).json({
                    status: true,
                    message: "Pesan teks berhasil dikirim ke grup!",
                    response: result,
                });
            }

            // kalau ada file
            const uploadDir = "./uploads";
            if (!fs.existsSync(uploadDir)) fs.mkdirSync(uploadDir);

            const fileName = `${Date.now()}_${fileUpload.name}`;
            const filePath = path.join(uploadDir, fileName);

            await fileUpload.mv(filePath);

            const mime = fileUpload.mimetype;
            const ext = path.extname(filePath).toLowerCase();

            let result;
            if ([".jpeg", ".jpg", ".png", ".gif"].includes(ext)) {
                result = await sock.sendMessage(groupJid, {
                    image: { url: filePath },
                    caption: pesankirim,
                });
            } else if ([".mp3", ".ogg"].includes(ext)) {
                result = await sock.sendMessage(groupJid, {
                    audio: { url: filePath },
                    mimetype: "audio/mp4",
                    caption: pesankirim,
                });
            } else {
                result = await sock.sendMessage(groupJid, {
                    document: { url: filePath },
                    fileName: fileUpload.name,
                    mimetype: mime,
                    caption: pesankirim,
                });
            }

            fs.unlink(filePath, (err) => {
                if (err) console.warn("Gagal hapus file:", err.message);
            });

            return res.status(200).json({
                status: true,
                message: "Pesan berhasil dikirim ke grup!",
                data: {
                    name: fileUpload.name,
                    mimetype: fileUpload.mimetype,
                    size: fileUpload.size,
                },
                response: result,
            });
        } catch (err) {
            console.error("❌ Gagal kirim pesan grup:", err);
            return res.status(500).json({
                status: false,
                response: err.message || err,
            });
        }
    });



    // ✅ Endpoint ambil daftar grup
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
            res
            .status(500)
            .json({ success: false, message: "Gagal ambil daftar grup" });
        } 
    });

     app.post("/logout", async (req, res) => {
        console.log(';l')
        try {
            await sock.logout();
            sock.end();
            fs.rmSync("./sessions", { recursive: true, force: true });
            res.json({ success: true, message: "Logout berhasil dan session dihapus." });
        } catch (err) {
            res.status(500).json({ success: false, message: err.message });
        }
    });

app.listen(PORT, async () => {
  console.log(`🚀 API berjalan di http://localhost:${PORT}`);
  await startSock();
});
