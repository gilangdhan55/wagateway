# 💬 WA Gateway (Baileys + Express)

WA Gateway ini adalah API sederhana berbasis **Node.js + Express** yang menggunakan library **@whiskeysockets/baileys** untuk mengirim pesan WhatsApp (teks, media, dan dokumen) baik ke **nomor pribadi** maupun **grup**.

---

## 🚀 Fitur

✅ Koneksi WhatsApp menggunakan QR Code (Multi-device)  
✅ Kirim pesan teks ke nomor pribadi  
✅ Kirim file / media (gambar, dokumen, audio) ke nomor pribadi  
✅ Kirim pesan teks dan file ke grup  
✅ Ambil daftar grup yang diikuti  
✅ Auto reconnect kalau koneksi terputus  
✅ Hapus session otomatis kalau logout

---

## 📦 Instalasi

### 1. Clone repo
```bash
git clone https://github.com/yourusername/wa-gateway.git
cd wa-gateway
```


### 2. Install Dependency

```bash
pnpm install
```

> Kalau belum punya pnpm:  
> Jalankan `npm install -g pnpm`

### 3. Run Programm
```bash
node index.js
```
