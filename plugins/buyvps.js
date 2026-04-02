// plugins/buyvps.js

// FIX: Menambahkan fungsi escMd agar tidak error "escMd is not defined" saat kirim notifikasi
function escMd(text = "") {
  return String(text).replace(/([_*\[\]()~`>#+\-=|{}.!\\])/g, "\\$1");
}

// Kirim pesan aman (kalau reply_to hilang, kirim biasa)
async function safeReply(bot, chatId, text, options = {}) {
  try {
    return await bot.sendMessage(chatId, text, options);
  } catch (e) {
    const opt = { ...options };
    delete opt.reply_to_message_id;
    return bot.sendMessage(chatId, text, opt);
  }
}

let adminHandlersRegistered = false;

module.exports = (bot, db, settings, pendingDeposits, query) => {
  const VPS_CFG = settings.vps || {};

  // =============== BAGIAN CALLBACK (BUTTON) =============
  if (query) {
    const chatId = query.message.chat.id;
    const msgId = query.message.message_id;
    const data = query.data || "";

    // LIST PRODUK VPS
    if (data === "buyvps") {
      return showDashboard(bot, db, VPS_CFG, chatId, msgId);
    }

    // DETAIL PAKET
    if (data.startsWith("vps_detail:")) {
      const paket = data.split(":")[1];
      if (!VPS_CFG[paket]) return;
      return showDetail(bot, db, VPS_CFG, chatId, msgId, paket);
    }

    // BUY VPS
    if (data.startsWith("vps_buy:")) {
      const paket = data.split(":")[1];
      if (!VPS_CFG[paket]) return;
      return processBuy(bot, db, settings, chatId, query.from, paket);
    }

    return;
  }

  // =============== BAGIAN ADMIN (ON TEXT) ===============
  // Plugin dipanggil juga tanpa query
  if (adminHandlersRegistered) return;
  adminHandlersRegistered = true;

  // ---------- /addstokvps  (tata cara) ----------
  bot.onText(/^\/addstokvps$/, async (msg) => {
    const chatId = msg.chat.id;
    const msgId = msg.message_id;

    if (msg.from.id.toString() !== settings.ownerId) {
      return safeReply(bot, chatId, "❌ Perintah ini hanya untuk Owner.", {
        reply_to_message_id: msgId,
      });
    }

    return safeReply(
      bot,
      chatId,
      "📦 *FORMAT TAMBAH STOK VPS*\n\n" +
        "`/addstokvps paket|ip|password|os|region`\n\n" +
        "Contoh:\n`/addstokvps 16x8|1.1.1.1|pw123|Ubuntu 22|SG`",
      { parse_mode: "Markdown", reply_to_message_id: msgId }
    );
  });

  // ---------- /addstokvps paket|ip|pw|os|region ----------
  bot.onText(/^\/addstokvps (.+)$/i, async (msg, match) => {
    const chatId = msg.chat.id;
    const msgId = msg.message_id;

    if (msg.from.id.toString() !== settings.ownerId) {
      return safeReply(bot, chatId, "❌ Perintah ini hanya untuk Owner.", {
        reply_to_message_id: msgId,
      });
    }

    const args = match[1].split("|").map((v) => v.trim());

    if (args.length < 5) {
      return safeReply(
        bot,
        chatId,
        "⚠️ *Format salah!*\nGunakan:\n`/addstokvps paket|ip|password|os|region`",
        { parse_mode: "Markdown", reply_to_message_id: msgId }
      );
    }

    const [paket, ip, pw, os, region] = args;

    if (!VPS_CFG[paket]) {
      return safeReply(
        bot,
        chatId,
        "❌ Paket VPS tidak ditemukan di settings.",
        { reply_to_message_id: msgId }
      );
    }

    const dbConn = await db.getDb();
    const col = dbConn.collection("vps_stock");

    const ada = await col.findOne({ ip });
    if (ada) {
      return safeReply(bot, chatId, "❌ IP tersebut sudah terdaftar.", {
        reply_to_message_id: msgId,
      });
    }

    await col.insertOne({
      paket,
      ip,
      password: pw,
      os,
      region,
      addedAt: new Date(),
    });

    return safeReply(
      bot,
      chatId,
      `✔ *Stok VPS Berhasil Ditambahkan!*\n\n` +
        `• Paket: *${paket}*\n` +
        `• IP: \`${ip}\`\n` +
        `• Password: \`${pw}\`\n` +
        `• OS: ${os}\n` +
        `• Region: ${region}`,
      { parse_mode: "Markdown", reply_to_message_id: msgId }
    );
  });

  // ---------- /delstokvps (tata cara) ----------
  bot.onText(/^\/delstokvps$/, async (msg) => {
    const chatId = msg.chat.id;
    const msgId = msg.message_id;

    if (msg.from.id.toString() !== settings.ownerId) {
      return safeReply(bot, chatId, "❌ Perintah ini hanya untuk Owner.", {
        reply_to_message_id: msgId,
      });
    }

    return safeReply(
      bot,
      chatId,
      "🗑 *FORMAT HAPUS STOK VPS*\n\n" +
        "`/delstokvps paket|ip|password`\n\n" +
        "Contoh:\n`/delstokvps 16x8|1.1.1.1|pw123`",
      { parse_mode: "Markdown", reply_to_message_id: msgId }
    );
  });

  // ---------- /delstokvps paket|ip|password ----------
  bot.onText(/^\/delstokvps (.+)$/i, async (msg, match) => {
    const chatId = msg.chat.id;
    const msgId = msg.message_id;

    if (msg.from.id.toString() !== settings.ownerId) {
      return safeReply(bot, chatId, "❌ Perintah ini hanya untuk Owner.", {
        reply_to_message_id: msgId,
      });
    }

    const args = match[1].split("|").map((v) => v.trim());
    if (args.length < 3) {
      return safeReply(
        bot,
        chatId,
        "⚠️ Format salah.\nGunakan: `/delstokvps paket|ip|password`",
        { parse_mode: "Markdown", reply_to_message_id: msgId }
      );
    }

    const [paket, ip, pw] = args;

    const dbConn = await db.getDb();
    const col = dbConn.collection("vps_stock");

    const del = await col.deleteOne({ paket, ip, password: pw });

    if (!del.deletedCount) {
      return safeReply(bot, chatId, "❌ Stok tidak ditemukan.", {
        reply_to_message_id: msgId,
      });
    }

    return safeReply(
      bot,
      chatId,
      `✔ *Stok VPS dihapus!*\nIP: \`${ip}\``,
      { parse_mode: "Markdown", reply_to_message_id: msgId }
    );
  });

  // ---------- /liststokvps ----------
  bot.onText(/^\/liststokvps$/, async (msg) => {
    const chatId = msg.chat.id;
    const msgId = msg.message_id;

    if (msg.from.id.toString() !== settings.ownerId) {
      return safeReply(bot, chatId, "❌ Perintah ini hanya untuk Owner.", {
        reply_to_message_id: msgId,
      });
    }

    const dbConn = await db.getDb();
    const col = dbConn.collection("vps_stock");

    const all = await col.find().toArray();

    if (!all.length) {
      return safeReply(bot, chatId, "📦 Tidak ada stok VPS.", {
        reply_to_message_id: msgId,
      });
    }

    let text = "📦 *LIST VPS READY*\n━━━━━━━━━━━━━━\n\n";

    all.forEach((v, i) => {
      text +=
        `${i + 1}. Paket: *${v.paket}*\n` +
        `   IP     : \`${v.ip}\`\n` +
        `   PW     : \`${v.password}\`\n` +
        `   OS     : ${v.os}\n` +
        `   Region : ${v.region}\n` +
        `━━━━━━━━━━━━━━\n`;
    });

    return safeReply(bot, chatId, text, {
      parse_mode: "Markdown",
      reply_to_message_id: msgId,
    });
  });
};

// ==================== FUNGSI VIEW =====================
async function showDashboard(bot, db, VPS_CFG, chatId, msgId) {
  const dbConn = await db.getDb();
  const stockCol = dbConn.collection("vps_stock");
  const soldCol = dbConn.collection("vps_sold");

  const totalReady = await stockCol.countDocuments();

  let totalSold = 0;
  for (const id of Object.keys(VPS_CFG)) {
    const s = await soldCol.findOne({ paket: id });
    totalSold += s?.sold || 0;
  }

  let caption =
    `📦 *VPS Digital Ocean High Quality*\n` +
    `━━━━━━━━━━━━━━━━━━━━━━\n` +
    `• 🌐 *Total Paket:* ${Object.keys(VPS_CFG).length}\n` +
    `• 📦 *Total Stok:* ${totalReady}\n` +
    `• 🛒 *Total Terjual:* ${totalSold}\n` +
    `━━━━━━━━━━━━━━━━━━━━━━\n\n` +
    `📚 *Daftar Paket VPS:*\n\n`;

  let idx = 1;
  for (const id of Object.keys(VPS_CFG)) {
    const pkg = VPS_CFG[id];
    const ready = await stockCol.countDocuments({ paket: id });

    caption +=
      `*${idx}. ${pkg.nama}*\n` +
      `   💰 Harga: *Rp${pkg.harga.toLocaleString("id-ID")}*\n` +
      `   📦 Ready: *${ready}*\n` +
      `━━━━━━━━━━━━━━━━━━━━━━\n\n`;
    idx++;
  }

  return bot.editMessageCaption(caption, {
    chat_id: chatId,
    message_id: msgId,
    parse_mode: "Markdown",
    reply_markup: {
      inline_keyboard: [
        Object.keys(VPS_CFG).map((id, i) => ({
          text: `${i + 1}`,
          callback_data: `vps_detail:${id}`,
        })),
        [{ text: "🏠 Menu Utama", callback_data: "start" }],
      ],
    },
  });
}

async function showDetail(bot, db, VPS_CFG, chatId, msgId, paket) {
  const VPS = VPS_CFG[paket];

  const dbConn = await db.getDb();
  const stockCol = dbConn.collection("vps_stock");
  const soldCol = dbConn.collection("vps_sold");

  const stok = await stockCol.find({ paket }).toArray();
  const OS = [...new Set(stok.map((v) => v.os))];
  const REG = [...new Set(stok.map((v) => v.region))];

  const sold = await soldCol.findOne({ paket });
  const terjual = sold?.sold || 0;

  const caption =
    `📦 *${VPS.nama}*\n` +
    `Brand : ${VPS.brand}\n` +
    `Harga : Rp${VPS.harga.toLocaleString("id-ID")}\n\n` +
    `💽 *OS tersedia:*\n` +
    (OS.length ? OS.map((o) => `• ${o}`).join("\n") : "• -") +
    `\n\n🌍 *Region tersedia:*\n` +
    (REG.length ? REG.map((r) => `• ${r}`).join("\n") : "• -") +
    `\n\n📊 *Statistik Paket*\n` +
    `• Terjual: ${terjual}\n` +
    `• Stok  : ${stok.length}\n\n` +
    `📝 *Deskripsi Singkat:*\n` +
    `• Cocok untuk bot WhatsApp, panel Pterodactyl, hosting NodeJS, API, dan proyek server lainnya.\n` +
    `• Garansi suspend akun *Digital Ocean*: *3 Hari*\n` +
    `• Garansi panel bermasalah, error service, instalasi ulang, dll: *20 Hari* (selama akun DO tidak suspend)\n\n` +
    `⚠️ *Catatan Penting:*\n` +
    `Hindari mining, spam CPU/I-O, atau aktivitas melanggar TOS yang bisa menyebabkan suspend.`;

  return bot.editMessageCaption(caption, {
    chat_id: chatId,
    message_id: msgId,
    parse_mode: "Markdown",
    reply_markup: {
      inline_keyboard: [
        [{ text: "🛒 Buy VPS", callback_data: `vps_buy:${paket}` }],
        [{ text: "⬅ Kembali", callback_data: "buyvps" }],
      ],
    },
  });
}

async function processBuy(bot, db, settings, chatId, from, paket) {
  const VPS_CFG = settings.vps[paket];

  const dbConn = await db.getDb();
  const stockCol = dbConn.collection("vps_stock");
  const soldCol = dbConn.collection("vps_sold");

  const saldo = await db.cekSaldo(from.id);
  const harga = VPS_CFG.harga;

  if (saldo < harga) {
    return safeReply(
      bot,
      chatId,
      `❌ *Saldo tidak cukup!*\n\n` +
        `Harga VPS: *Rp${harga.toLocaleString("id-ID")}*`,
      { parse_mode: "Markdown" }
    );
  }

  const vps = await stockCol.findOne({ paket });
  if (!vps) {
    return safeReply(bot, chatId, "❌ Stok VPS kosong untuk paket ini.");
  }

  await db.kurangSaldo(from.id, harga);
  await stockCol.deleteOne({ _id: vps._id });
  await soldCol.updateOne(
    { paket },
    { $inc: { sold: 1 } },
    { upsert: true }
  );

  const orderID = Math.floor(100000 + Math.random() * 900000);
  const saldoAkhir = saldo - harga;

  // ===== NOTIF OWNER =====
  // Definisikan jamWIB agar sinkron ke Asia/Jakarta
const jamWIB = new Date().toLocaleTimeString('id-ID', { 
  hour: '2-digit', 
  minute: '2-digit', 
  timeZone: 'Asia/Jakarta' 
}).replace(/\./g, ':');

const ownerNotif =
  `*PESANAN ORDER VPS*\n` +
  `━━━━━━━━━━━━━━━━━━━━━━\n` +
  `👤 *PELANGGAN*\n` +
  `• Nama: [${escMd(from.first_name)}](tg://user?id=${from.id})\n` +
  `• ID: \`${from.id}\`\n\n` +
  `📦 *DETAIL PAKET*\n` +
  `• Produk: *${escMd(VPS_CFG.nama)}*\n` +
  `• Order ID: \`${orderID}\`\n\n` +
  `💰 *PEMBAYARAN*\n` +
  `• Total: *Rp${harga.toLocaleString("id-ID")}*\n` +
  `• Status: ✅ \`SENT TO USER\`\n` +
  `━━━━━━━━━━━━━━━━━━━━━━\n` +
  `🕒 _Waktu: ${jamWIB} WIB_`; // Menggunakan variabel jamWIB

bot.sendMessage(settings.channelid, ownerNotif, { 
  parse_mode: "Markdown",
  reply_markup: {
    inline_keyboard: [
      [
        { 
          text: "🚀 ORDER VPS", 
          url: `https://t.me/AlwaysZakzz_Vitusim_bot` 
        }
      ]
    ]
  }
});

  // ===== NOTIF USER =====
  const userSuccess =
    `🎉 *PEMBELIAN VPS BERHASIL!*\n` +
    `━━━━━━━━━━━━━━━━━━\n\n` +
    `🆔 *Order ID:* ${orderID}\n` +
    `📦 *Paket:* ${VPS_CFG.nama}\n\n` +
    `🔑 *Detail VPS Anda:*\n` +
    `• IP: \`${vps.ip}\`\n` +
    `• Password: \`${vps.password}\`\n` +
    `• OS: ${vps.os}\n` +
    `• Region: ${vps.region}\n\n` +
    `💰 *Sisa Saldo:* Rp${saldoAkhir.toLocaleString("id-ID")}\n\n` +
    `⚠️ *Catatan:* \n` +
    `Data VPS hanya dikirim *1 kali*. Simpan dengan aman.\n` +
    `Garansi suspend akun *Digital Ocean*: *3 Hari*.\n` +
    `Garansi panel bermasalah (selain kasus suspend akun DO): *20 Hari*.\n\n` +
    `Jika ingin *install Pterodactyl Panel*,\n` +
    `hubungi Owner:\n` +
    `👤 t.me/AlwaysZakzz\n\n` +
    `Terima kasih telah menggunakan layanan *AlwaysZakzz VPS!* 🚀`;

  return safeReply(bot, chatId, userSuccess, { parse_mode: "Markdown" });
}
