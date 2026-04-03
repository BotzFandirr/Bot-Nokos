// plugins/start.js
const fs = require('fs');
const path = require('path');
const Notifikasi = require('../notifikasi');
const axios = require('axios');
let membershipConfigWarned = false;

// Helper: Escape Markdown
function escapeMd(text = "") {
  return text.replace(/([_*\[\]()~`>#+\-=|{}.!])/g, "\\$1");
}

// Helper: Ensure User di Database
async function ensureUser(db, userId, profile = {}) {
  const dbInstance = await db.getDb(); 
  const users = dbInstance.collection("users"); 
  
  const result = await users.updateOne(
    { _id: userId.toString() },
    { 
      $setOnInsert: {
        created_at: new Date().toISOString(),
        profile: { first_name: profile.first_name || '', username: profile.username || '' },
        history: [],
        deposit_history: [],
        saldo: 0
      }
    },
    { upsert: true }
  );

  if (result.upsertedCount > 0) {
    try {
      await Notifikasi.userCreated({
        userId,
        first_name: profile.first_name || '',
        username: profile.username || '',
        saldo: 0,
        total_order: 0,
        recent_orders: []
      });
    } catch {}
    return true; 
  }
  return false; 
}

// Helper: Send Safe Reply
async function sendSafeReply(bot, chatId, text, options = {}) {
  try { await bot.sendMessage(chatId, text, options); }
  catch (error) {
    if (error?.response?.body?.description === "message to be replied not found") {
      delete options.reply_to_message_id;
      try { await bot.sendMessage(chatId, text, options); } catch {}
    } else {
      console.error("Gagal kirim pesan:", error?.response?.body || error);
    }
  }
}

// ===== TAMBAHAN: CEK USER SUDAH JOIN CHANNEL WAJIB =====
async function isUserJoinedRequiredChannel(bot, userId, settings) {
  const configuredChannel = settings.requiredChannel ?? settings.channelid ?? -1003892199273;
  const normalizedChannel =
    typeof configuredChannel === "string" && /^-?\d+$/.test(configuredChannel)
      ? Number(configuredChannel)
      : configuredChannel;

  try {
    const member = await bot.getChatMember(normalizedChannel, userId);
    const allowedStatus = ["member", "administrator", "creator"];
    return allowedStatus.includes(member.status);
  } catch (error) {
    const errBody = error?.response?.body || error;
    const errDesc = String(error?.response?.body?.description || "").toLowerCase();

    if (errDesc.includes("chat not found") && !membershipConfigWarned) {
      membershipConfigWarned = true;
      console.error(
        `[JoinCheck] Channel tidak ditemukan. Pastikan ID/username channel benar dan bot sudah masuk channel.\n` +
        `[JoinCheck] Value saat ini: ${JSON.stringify(configuredChannel)}`
      );
    } else {
      console.error("Gagal cek membership channel:", errBody);
    }
    return false;
  }
}

// ===== TAMBAHAN: TAMPILKAN PESAN WAJIB JOIN =====
async function showJoinChannelMessage(bot, chatId, settings, replyTo = null) {
  const channelUrl = settings.requiredChannelUrl || "https://t.me/InformasiLayananZakzz";

  const text =
`*Akses ditolak sementara*

Kamu harus bergabung ke saluran terlebih dahulu sebelum memakai bot ini.

Silakan join channel di bawah ini, lalu tekan tombol *✅ Saya Sudah Join* untuk cek ulang.`;

  const keyboard = {
    inline_keyboard: [
      [
        { text: "📢 Join Channel", url: channelUrl }
      ],
      [
        { text: "✅ Saya Sudah Join", callback_data: "check_join" }
      ]
    ]
  };

  await sendSafeReply(bot, chatId, text, {
    parse_mode: "Markdown",
    reply_markup: keyboard,
    ...(replyTo ? { reply_to_message_id: replyTo } : {})
  });
}

// ===== MAIN MODULE =====
module.exports = (bot, db, settings, pendingDeposits, query) => {
  
  // 1. HANDLER COMMAND /start (Text Input)
  if (!query) {
    bot.onText(/^\/start$/, async (msg) => {
      const joined = await isUserJoinedRequiredChannel(bot, msg.from.id, settings);

      if (!joined) {
        await showJoinChannelMessage(bot, msg.chat.id, settings, msg.message_id);
        return;
      }

      // Saat command /start, pesan lama tidak perlu dihapus/diedit, langsung kirim baru
      await showMainMenu(bot, db, settings, msg.chat.id, msg.from.id, msg.from.first_name || "Pengguna", null, msg.from);
    });
    return; 
  }

  // 2. HANDLER CALLBACK QUERY (Tombol)
  (async () => {
    try { await bot.answerCallbackQuery(query.id); } catch {}
    const chatId = query.message.chat.id;
    const userId = query.from.id;
    const userName = query.from.first_name || "Pengguna";
    const messageId = query.message.message_id;
    
    if (query.data === 'start') {
      const joined = await isUserJoinedRequiredChannel(bot, userId, settings);

      if (!joined) {
        try {
          await bot.deleteMessage(chatId, messageId);
        } catch {}
        await showJoinChannelMessage(bot, chatId, settings);
        return;
      }

      await showMainMenu(bot, db, settings, chatId, userId, userName, messageId, query.from);
    }

    // ===== TAMBAHAN: CEK TOMBOL SUDAH JOIN =====
    if (query.data === 'check_join') {
      const joined = await isUserJoinedRequiredChannel(bot, userId, settings);

      if (!joined) {
        try {
          await bot.answerCallbackQuery(query.id, {
            text: "Kamu belum join channel.",
            show_alert: true
          });
        } catch {}
        return;
      }

      // Hapus pesan wajib join
      try {
        await bot.deleteMessage(chatId, messageId);
      } catch {}

      // Tampilkan menu utama
      await showMainMenu(bot, db, settings, chatId, userId, userName, null, query.from);
    }
  })();
};

// ===== LOGIKA TAMPILAN MENU UTAMA =====
async function showMainMenu(bot, db, settings, chatId, userId, userNameRaw, messageId = null, fromObj = {}) {
  const userName = escapeMd(userNameRaw);
  
  try {
    // 1. Pastikan User terdaftar
    await ensureUser(db, userId, { first_name: fromObj.first_name, username: fromObj.username });
    
    // 2. Ambil Data Lokal
    const saldo = await db.cekSaldo(userId);
    const history = await db.getOrderHistory(userId);
    const totalPengguna = await db.countTotalUsers(); 
    const totalDeposit = await db.countDeposits(userId);

    // 3. Ambil Saldo Panel RumahOTP (API V1)
    let saldoPanelStr = "Rp0"; 
    try {
        // [DOC] Endpoint V1: user/balance
        const apiUrl = `https://www.rumahotp.com/api/v1/user/balance`;
        const res = await axios.get(apiUrl, { 
            headers: { 
                'x-apikey': settings.rumahOtpApiKey,
                'Accept': 'application/json'
            },
            timeout: 5000 // Timeout biar bot gak hang
        });

        if (res.data?.success && res.data?.data) {
            // [DOC] Field yang benar adalah "formated" (bukan formatted)
            saldoPanelStr = res.data.data.formated || `Rp${(res.data.data.balance || 0).toLocaleString('id-ID')}`;
        }
    } catch (e) {
        console.warn("[start.js] Gagal fetch saldo panel:", e.message);
    }

    // 4. Susun Caption
    const caption =
`*AlwaysZakzz Layanan Otomatis*

👤 ɴᴀᴍᴀ ᴘᴇɴɢɢᴜɴᴀ : *${userName}*
💳 ꜱᴀʟᴅᴏ ᴘᴀɴᴇʟ (ZakzzOTP): ${saldoPanelStr}
💰 ꜱᴀʟᴅᴏ ʟᴏᴋᴀʟ: Rp${saldo.toLocaleString('id-ID')}
📦 ᴛᴏᴛᴀʟ ᴏʀᴅᴇʀ: ${history.length}
🧾 ᴛᴏᴛᴀʟ ᴅᴇᴘᴏꜱɪᴛ: ${totalDeposit}
👥 ᴛᴏᴛᴀʟ ᴘᴇɴɢɢᴜɴᴀ: ${totalPengguna}

────────────────────────────
➤ *ʙᴏᴛ ʟᴀʏᴀɴᴀɴ ᴏᴛᴏᴍᴀᴛɪꜱ ʏᴀɴɢ ʙᴇʀᴛᴜɢᴀꜱ ᴍᴇᴍᴘᴇʀᴄᴇᴘᴀᴛ* ➤ *ᴘᴇꜱᴀɴᴀɴ, ᴛʀᴀɴꜱᴀᴋꜱɪ, ᴅᴀɴ ᴘᴇɴɢᴇʀᴊᴀᴀɴ ʟᴀʏᴀɴᴀɴᴍᴜ.*
────────────────────────────`;

    const photoUrl = settings.startMenuPhotoUrl || "https://img1.pixhost.to/images/10473/665370140_alwayszakzz.jpg";
    const keyboard = mainKeyboard();

    // 5. Logika Pengiriman Pesan (CRUCIAL FIX)
    if (messageId) {
        // Jika dipanggil dari tombol (Callback)
        // KITA HARUS HAPUS PESAN LAMA DULU.
        // Kenapa? Karena menu "Top User" atau "Riwayat" bentuknya Text.
        // Kita tidak bisa mengedit Text menjadi Foto. Jadi hapus dulu, baru kirim foto.
        try {
            await bot.deleteMessage(chatId, messageId);
        } catch (e) {
            // Abaikan jika pesan sudah terhapus
        }
        // Kirim Foto Baru
        await bot.sendPhoto(chatId, photoUrl, { caption, parse_mode: "Markdown", reply_markup: keyboard });
    } else {
        // Jika dipanggil dari command /start
        await bot.sendPhoto(chatId, photoUrl, { caption, parse_mode: "Markdown", reply_markup: keyboard });
    }

  } catch (error) {
    console.error("Error di showMainMenu:", error);
    await sendSafeReply(bot, chatId, "⚠️ Terjadi kesalahan saat memuat menu utama.");
  }
}

// ===== KEYBOARD MENU UTAMA =====
function mainKeyboard() {
  return {
    inline_keyboard: [
      [
        { text: "📦 ORDER NOKOS", callback_data: "order" },
        { text: "💳 DEPOSIT", callback_data: "deposit" }
      ],
      [
        { text: "💰 REFRESH SALDO", callback_data: "start" }, 
        { text: "🧾 RIWAYAT NOKOS", callback_data: "riwayat" }
      ],
      [
        { text: "🏆 TOP USER", callback_data: "topuser" },
        { text: "❓ BANTUAN", callback_data: "bantuan" }
      ],
      [
        { text: "🛒 ORDER SCRIPT BOT", callback_data: "buyscript" }
      ],
      [
        { text: "🖥️ ORDER PANEL", callback_data: "buypanel" },
        { text: "🖥️ LIST PRODUK VPS", callback_data: "buyvps" }
      ],
      [
        { text: "📢 Channel", url: "https://t.me/AlwasyZakzz_New_Era" },
        { text: "👤 Owner", url: "https://t.me/AlwaysZakzz" }
      ]
    ]
  };
}
