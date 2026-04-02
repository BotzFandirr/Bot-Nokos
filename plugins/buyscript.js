// plugins/buyscript.js
const fs = require("fs");
const path = require("path");

// FIX: Nama fungsi disamakan menjadi escMd agar tidak error saat dipanggil
function escMd(text = "") {
  return String(text).replace(/([_*\[\]()~`>#+\-=|{}.!\\])/g, "\\$1");
}

// Kirim pesan aman (handle reply yg sudah hilang)
async function sendSafeReply(bot, chatId, text, options = {}) {
  try {
    return await bot.sendMessage(chatId, text, options);
  } catch (error) {
    if (error?.response?.body?.description === "message to be replied not found") {
      const opts = { ...options };
      delete opts.reply_to_message_id;
      try {
        return await bot.sendMessage(chatId, text, opts);
      } catch (e2) {
        console.error("Gagal kirim fallback:", e2?.response?.body || e2);
        return undefined;
      }
    }
    console.error("Gagal kirim pesan:", error?.response?.body || error);
    return undefined;
  }
}

module.exports = async (bot, db, settings, _pendingDeposits, query) => {
  if (!query) return;

  const PRICE_NOUP = 20000;
  const PRICE_FREEUP = 25000;
  const OWNER_ID = settings.ownerId;
  const CHANNEL_ID = settings.channelid; // FIX: Definisi CHANNEL_ID ditambahkan
  const data = (query.data || "").toLowerCase();
  const chatId = query.message.chat.id;
  const userId = query.from.id;

  // === Menu pilih paket ===
  if (data === "buyscript") {
    const keyboard = {
      inline_keyboard: [
        [{ text: "💾 AlwaysZakzz V10 No-Up — Rp20.000", callback_data: "buy_noup" }],
        [{ text: "🚀 AlwaysZakzz V10 Free-Up — Rp25.000", callback_data: "buy_freeup" }],
        [{ text: "🔙 Kembali", callback_data: "start" }],
      ],
    };

    await bot.editMessageCaption(
      "🛒 *Pilih Script Bot yang ingin kamu beli:*\n\n" +
      "📜 *Script:* AlwaysZakzz V10\n\n" +
      "💾 *Versi No-Update:* Hanya mendapatkan versi V10 tanpa upgrade ke versi berikutnya.\n" +
      "🚀 *Versi Free-Update:* Dapat upgrade otomatis ke V11 dan akses grup pembeli khusus.\n\n" +
      "🎥 *Tonton Video Review:* [Klik di sini](https://youtu.be/xQzc_NJONO4?si=0LZWOwVnR5ia5UK-)",
      {
        chat_id: chatId,
        message_id: query.message.message_id,
        parse_mode: "Markdown",
        reply_markup: keyboard,
      }
    );
    return;
  }

  // --- Helper path (PASTIKAN sesuai folder kamu) ---
  const ZIP_PATH = path.join(__dirname, "../script/AlwaysZakzz V10 [ New Rilis!! ].zip");

  // === Beli No-Up ===
  if (data === "buy_noup") {
    try {
      await sendSafeReply(
        bot,
        chatId,
        "⏳ Mengambil layanan pembelian *AlwaysZakzz V10 No-Up*, mohon tunggu...",
        { parse_mode: "Markdown" }
      );
      
      const saldo = await db.cekSaldo(userId);
      if (saldo < PRICE_NOUP) {
        return bot.sendMessage(
          chatId,
          `❌ *Saldo kamu kurang!*\nSaldo: Rp${saldo.toLocaleString("id-ID")}\nHarga: Rp${PRICE_NOUP.toLocaleString("id-ID")}\n\nSilakan /deposit terlebih dahulu.`,
          { parse_mode: "Markdown" }
        );
      }

      if (!fs.existsSync(ZIP_PATH)) {
        return bot.sendMessage(
          chatId,
          `<!> File script belum tersedia.\nHubungi [Owner](tg://user?id=${OWNER_ID}).`,
          { parse_mode: "Markdown" }
        );
      }

      await db.kurangSaldo(userId, PRICE_NOUP);
      await db.addOrderHistory(userId, {
        orderId: `SCV10-NOUP-${Date.now()}`,
        layanan: "Script AlwaysZakzz V10 No-Up",
        harga: PRICE_NOUP,
        tanggal: new Date().toISOString(),
      });

      await bot.sendDocument(chatId, ZIP_PATH, {
        caption: "✅ Berikut script *AlwaysZakzz V10 (No-Up)* kamu!",
        parse_mode: "Markdown",
      });

      await bot.sendMessage(
        chatId,
        `Pembelian selesai ✅\nJika butuh akses database, hubungi [Owner](tg://user?id=${OWNER_ID}).`,
        { parse_mode: "Markdown" }
      );
      
      // Definisikan jamWIB di atas sebelum bot.sendMessage
        const jamWIB = new Date().toLocaleTimeString('id-ID', { 
          hour: '2-digit', 
          minute: '2-digit', 
          timeZone: 'Asia/Jakarta' 
        }).replace(/\./g, ':');
        
        await bot.sendMessage(
          CHANNEL_ID,
          `*PESANAN SCRIPT*\n` +
          `━━━━━━━━━━━━━━━━━━━━━━\n` +
          `👤 *PEMBELI*\n` +
          `• Nama: [${escMd(query.from.first_name)}](tg://user?id=${userId})\n` +
          `• ID: \`${userId}\`\n\n` +
          `🛒 *ITEM DETAIL*\n` +
          `• Produk: *AlwaysZakzz V10 No-Up*\n` +
          `• Kategori: \`Script Node.js\`\n\n` +
          `💰 *PEMBAYARAN*\n` +
          `• Total: *Rp${PRICE_NOUP.toLocaleString("id-ID")}*\n` +
          `• Status: ✅ \`SUCCESS\`\n` +
          `━━━━━━━━━━━━━━━━━━━━━━\n` +
          `🕒 _Waktu: ${jamWIB} WIB_`,
          { 
            parse_mode: "Markdown",
            reply_markup: {
              inline_keyboard: [
                [
                  { 
                    text: "🛍️ BUY SCRIPT", 
                    url: `https://t.me/AlwaysZakzz_Vitusim_bot` 
                  }
                ]
              ]
            }
          }
        );
    } catch (e) {
      console.error("buy_noup error:", e);
      await bot.sendMessage(chatId, "⚠️ Terjadi kesalahan sistem. Coba lagi nanti.");
    }
    return;
  }

  if (data === "buy_freeup") {
    try {
      await sendSafeReply(
        bot,
        chatId,
        "⏳ Mengambil layanan pembelian *AlwaysZakzz V10 Free-Up*, mohon tunggu...",
        { parse_mode: "Markdown" }
      );
      
      const saldo = await db.cekSaldo(userId);
      if (saldo < PRICE_FREEUP) {
        return bot.sendMessage(
          chatId,
          `❌ *Saldo kamu kurang!*\nSaldo: Rp${saldo.toLocaleString("id-ID")}\nHarga: Rp${PRICE_FREEUP.toLocaleString("id-ID")}\n\nSilakan /deposit terlebih dahulu.`,
          { parse_mode: "Markdown" }
        );
      }

      if (!fs.existsSync(ZIP_PATH)) {
        return bot.sendMessage(
          chatId,
          `<!> File script belum tersedia.\nHubungi [Owner](tg://user?id=${OWNER_ID}).`,
          { parse_mode: "Markdown" }
        );
      }

      await db.kurangSaldo(userId, PRICE_FREEUP);
      await db.addOrderHistory(userId, {
        orderId: `SCV10-FREEUP-${Date.now()}`,
        layanan: "Script AlwaysZakzz V10 Free-Up",
        harga: PRICE_FREEUP,
        tanggal: new Date().toISOString(),
      });

      await bot.sendDocument(chatId, ZIP_PATH, {
        caption: "✅ Berikut script *AlwaysZakzz V10 (Free-Up)* kamu!",
        parse_mode: "Markdown",
      });

      await bot.sendMessage(
        chatId,
        `🎉 Akses *grup khusus* pembeli AlwaysZakzz V10 Free-Up: [Klik di sini](https://t.me/ZakzzGan_Freeup)`,
        { parse_mode: "Markdown" }
      );

      // Definisikan jamWIB agar sinkron ke Asia/Jakarta
        const jamWIB = new Date().toLocaleTimeString('id-ID', { 
          hour: '2-digit', 
          minute: '2-digit', 
          timeZone: 'Asia/Jakarta' 
        }).replace(/\./g, ':');
        
        await bot.sendMessage(
          CHANNEL_ID,
          `*PESANAN SCRIPT*\n` +
          `━━━━━━━━━━━━━━━━━━━━━━\n` +
          `👤 *PEMBELI*\n` +
          `• Nama: [${escMd(query.from.first_name)}](tg://user?id=${userId})\n` +
          `• ID: \`${userId}\`\n\n` +
          `🛒 *ITEM DETAIL*\n` +
          `• Produk: *AlwaysZakzz V10 Free-Up*\n` +
          `• Layanan: \`Free Update Access\`\n\n` +
          `💰 *PEMBAYARAN*\n` +
          `• Total: *Rp${PRICE_FREEUP.toLocaleString("id-ID")}*\n` +
          `• Status: ✅ \`SUCCESS\`\n` +
          `━━━━━━━━━━━━━━━━━━━━━━\n` +
          `🕒 _Waktu: ${jamWIB} WIB_`,
          { 
            parse_mode: "Markdown",
            reply_markup: {
              inline_keyboard: [
                [
                  { 
                    text: "🛍️ BUY SCRIPT", 
                    url: `https://t.me/AlwaysZakzz_Vitusim_bot` 
                  }
                ]
              ]
            }
          }
        );
    } catch (e) {
      console.error("buy_freeup error:", e);
      await bot.sendMessage(chatId, "⚠️ Terjadi kesalahan sistem. Coba lagi nanti.");
    }
    return;
  }
};
