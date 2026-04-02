// plugins/cekstatus.js
// OWNER TOOL: Untuk investigasi order member secara detail

const axios = require("axios");

// ===== 1. Helper Send (Safe Reply) =====
async function sendSafeReply(bot, chatId, text, options = {}) {
  try {
    return await bot.sendMessage(chatId, text, options);
  } catch (error) {
    const desc = error?.response?.body?.description || "";
    if (desc.includes("message to be replied not found") && options.reply_to_message_id) {
      const opt2 = { ...options };
      delete opt2.reply_to_message_id;
      return await bot.sendMessage(chatId, text, opt2).catch(() => undefined);
    }
    return undefined;
  }
}

// ===== 2. Utilities =====
function escMd(text = "") {
  return String(text).replace(/[_*[\]()~`>#+\-=|{}.!]/g, "\\$&");
}

const rupiah = (n) => "Rp" + Number(n || 0).toLocaleString("id-ID");

function formatOrderTime(input) {
  if (input == null) return null;
  const d = new Date(Number(input));
  if (isNaN(d.getTime())) return null;

  const parts = new Intl.DateTimeFormat("id-ID", {
    timeZone: "Asia/Jakarta",
    weekday: "long",
    day: "2-digit",
    month: "long",
    year: "numeric",
  }).formatToParts(d);

  const get = (type) => parts.find((p) => p.type === type)?.value || "-";
  const jam = new Intl.DateTimeFormat("id-ID", {
    timeZone: "Asia/Jakarta",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }).format(d);

  return {
    hari: get("weekday"),
    tanggal: get("day"),
    bulan: get("month"),
    tahun: get("year"),
    jam: `${jam} WIB`,
  };
}

// ===== 3. Cari Data Lokal =====
async function findOrderOwnerAndLocal(db, orderId) {
  // A. Coba cari di database berdasarkan orderId
  try {
    const owner = await db.getOrderOwner(orderId);
    if (owner) {
      const hist = await db.getOrderHistory(owner);
      const local = Array.isArray(hist) ? hist.find((x) => String(x.orderId) === String(orderId)) : null;
      return { userId: owner, orderLocal: local };
    }
  } catch {}

  // B. Fallback: Scan manual semua user (jika index belum rapi)
  try {
    const all = await db.getAllUsersFull(); 
    for (const u of all || []) {
      const hist = Array.isArray(u.history) ? u.history : [];
      const local = hist.find((x) => String(x.orderId) === String(orderId));
      if (local) return { userId: u._id, orderLocal: local };
    }
  } catch {}

  return { userId: null, orderLocal: null };
}

// ===== 4. Logic Status Final (SINKRON API V1) =====
function computeFinalStatus({ apiStatus, now, expiresAt, refundedLocal }) {
  const s = String(apiStatus || "").toLowerCase();

  // A. Cek Status API (Prioritas Tertinggi)
  if (s === "canceled" || s === "cancelled" || s === "dibatalkan") {
    return { key: "canceled", label: "DIBATALKAN", emoji: "❌", refund: "REFUND" };
  }
  
  // Status 'expiring' dari API artinya waktu habis -> Refund
  if (s === "expired" || s === "expiring" || s === "timeout") {
    return { key: "expired", label: "EXPIRED (Server)", emoji: "⚠️", refund: "REFUND" };
  }
  
  if (s === "received" || s === "completed" || s === "success") {
    return { key: "success", label: "SUKSES", emoji: "✅", refund: "NO REFUND" };
  }

  // B. Cek Status Lokal (Jika API Waiting/Down)
  if (refundedLocal === true) {
    return { key: "canceled", label: "DIBATALKAN (Lokal)", emoji: "❌", refund: "REFUND" };
  }

  // C. Cek Waktu Habis (Local Timer)
  // Jika API masih 'waiting' tapi waktu lokal sudah lewat 20 menit
  if (expiresAt && now > expiresAt) {
    return { key: "expired", label: "EXPIRED (Waktu Habis)", emoji: "⌛", refund: "REFUND" };
  }

  return { key: "waiting", label: "MENUNGGU SMS", emoji: "⏳", refund: "-" };
}

// ===== 5. MAIN MODULE =====
module.exports = (bot, db, settings, pendingDeposits, query) => {
  if (query) return;

  // Handler /cekstatus tanpa ID
  bot.onText(/^\/cekstatus$/i, async (msg) => {
    const chatId = msg.chat.id;
    if (String(msg.from.id) !== String(settings.ownerId)) {
      return sendSafeReply(bot, chatId, "❌ Khusus Owner.", { reply_to_message_id: msg.message_id });
    }
    return sendSafeReply(bot, chatId, "Gunakan format:\n`/cekstatus <Order ID>`", { parse_mode: "Markdown" });
  });

  // Handler /cekstatus <ID>
  bot.onText(/^\/cekstatus\s+(.+)/i, async (msg, match) => {
    const chatId = msg.chat.id;
    const msgId = msg.message_id;
    const orderId = (match[1] || "").trim();

    // Proteksi Owner
    if (String(msg.from.id) !== String(settings.ownerId)) {
      return sendSafeReply(bot, chatId, "❌ Khusus Owner.", { reply_to_message_id: msgId });
    }

    const waitMsg = await sendSafeReply(
      bot,
      chatId,
      `🕵️‍♂️ Menginvestigasi Order ID \`${escMd(orderId)}\`...`,
      { parse_mode: "Markdown", reply_to_message_id: msgId }
    );
    if (!waitMsg) return;

    try {
      // 1. Cari Data Lokal
      const { userId: targetUserId, orderLocal } = await findOrderOwnerAndLocal(db, orderId);

      if (!targetUserId) {
        await bot.editMessageText("❌ Data tidak ditemukan di database bot.", {
          chat_id: chatId,
          message_id: waitMsg.message_id,
        });
        return;
      }

      // 2. Ambil Profil User
      let displayName = "User";
      try {
        const chat = await bot.getChat(targetUserId);
        displayName = `[${escMd(chat.first_name || "User")}](tg://user?id=${targetUserId})`;
      } catch {
        displayName = `User ID: \`${targetUserId}\``;
      }

      // 3. Saldo User Saat Ini
      const saldoNow = Number(await db.cekSaldo(targetUserId));

      // 4. Request API
      let apiData = null;
      let apiStatus = null;
      let sourceInfo = "Database Lokal";

      try {
        const res = await axios.get("https://www.rumahotp.com/api/v1/orders/get_status", {
          params: { order_id: orderId },
          headers: { "x-apikey": settings.rumahOtpApiKey, Accept: "application/json" },
          timeout: 10000,
        });

        if (res.data?.success && res.data?.data) {
          apiData = res.data.data;
          apiStatus = apiData.status;
          sourceInfo = "Server Pusat (API V1)";
        }
      } catch (e) {
        sourceInfo = "Lokal (API Gagal)";
      }

      // 5. Kalkulasi Waktu & Expired
      // API mengembalikan timestamp number. Jika tidak ada, pakai data lokal.
      const createdTs = apiData?.created_at 
          ? Number(apiData.created_at) 
          : (orderLocal?.tanggal ? new Date(orderLocal.tanggal).getTime() : Date.now());
      
      const expiresTs = apiData?.expires_at
          ? Number(apiData.expires_at)
          : (createdTs + (20 * 60 * 1000)); // Default 20 menit dari created

      const timeInfo = formatOrderTime(createdTs);
      const expInfo = formatOrderTime(expiresTs);

      // 6. Hitung Status Final
      const refunded = orderLocal?.refunded === true; // Flag manual jika ada
      const st = computeFinalStatus({
        apiStatus,
        now: Date.now(),
        expiresAt: expiresTs,
        refundedLocal: refunded
      });

      // 7. Data Detail
      const negara = apiData?.country || orderLocal?.negara || "-";
      const layanan = apiData?.service || orderLocal?.layanan || "-";
      const nomor = apiData?.phone_number || orderLocal?.nomor || "-";
      const otpRaw = apiData?.otp_code || "-";
      const otp = (otpRaw !== "-") ? `\`${escMd(otpRaw)}\`` : "`-`";
      const harga = Number(orderLocal?.harga || 0);

      // 8. Logika Saldo (Estimasi)
      // Jika status Cancel/Refund/Expired -> Uang User harusnya BALIK.
      // Jadi: Saldo Sebelum Order = Saldo Sekarang.
      //       Saldo Jika Terpotong = Saldo Sekarang - Harga.
      let saldoBefore = 0;
      let saldoAfterCut = 0;

      if (st.refund === "REFUND") {
          saldoBefore = saldoNow;
          saldoAfterCut = saldoNow - harga;
      } else {
          // Jika Sukses/Waiting -> Uang User SUDAH KEPOTONG.
          // Jadi: Saldo Sebelum Order = Saldo Sekarang + Harga.
          saldoAfterCut = saldoNow;
          saldoBefore = saldoNow + harga;
      }

      // 9. Susun Laporan
      let text = `👮‍♂️ *INVESTIGASI ORDER (OWNER)*\n`;
      text += `──────────────────\n`;
      text += `🆔 Order ID : \`${escMd(orderId)}\`\n`;
      text += `👤 User     : ${displayName}\n`;
      text += `📱 Nomor    : \`${escMd(nomor)}\`\n`;
      text += `🔑 OTP      : ${otp}\n`;
      text += `📦 Layanan  : ${escMd(layanan)} (${escMd(negara)})\n`;
      text += `──────────────────\n`;
      text += `📊 Status   : ${st.emoji} ${st.label}\n`;
      text += `ℹ️ Ket      : ${st.refund}\n`;
      text += `🌍 Sumber   : ${sourceInfo}\n`;
      text += `──────────────────\n`;
      text += `📅 Dibuat   : ${timeInfo?.jam} (${timeInfo?.tanggal})\n`;
      if (expInfo) {
          text += `⌛ Expired  : ${expInfo?.jam} (${expInfo?.tanggal})\n`;
      }
      text += `──────────────────\n`;
      text += `💰 Harga Order  : ${rupiah(harga)}\n`;
      text += `💳 Saldo User   : ${rupiah(saldoNow)}\n`;
      text += `💸 _Estimasi Awal : ${rupiah(saldoBefore)}_\n`;

      await bot.editMessageText(text, {
        chat_id: chatId,
        message_id: waitMsg.message_id,
        parse_mode: "Markdown",
        disable_web_page_preview: true,
      });

    } catch (err) {
      const msgErr = `❌ Gagal cek status.\nErr: \`${escMd(err.message)}\``;
      await bot.editMessageText(msgErr, {
        chat_id: chatId,
        message_id: waitMsg.message_id,
        parse_mode: "Markdown",
      });
    }
  });
};
