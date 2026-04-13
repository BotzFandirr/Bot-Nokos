// plugins/batalkanorder.js
const axios = require('axios');
const backKeyboard = require('../utils/backKeyboard');

async function sendSafeReply(bot, chatId, text, options) {
    try {
        await bot.sendMessage(chatId, text, options);
    } catch (error) {
        if (error.response && error.response.body.description === 'message to be replied not found') {
            delete options.reply_to_message_id;
            return await bot.sendMessage(chatId, text, options).catch(e => console.error("Gagal kirim fallback:", e));
        } else {
            console.error("Gagal kirim pesan:", error.response ? error.response.body : error);
            return undefined;
        }
    }
}

module.exports = (bot, db, settings, pendingDeposits, query) => {

    // Helper Header Auth
    const getHeaders = () => ({
        'x-apikey': settings.rumahOtpApiKey,
        'Accept': 'application/json'
    });

    // 1. Handle Callback (Info Menu)
    if (query) {
        const chatId = query.message.chat.id;
        const messageId = query.message.message_id;

        if (query.data === 'batalkanorder') {
             const caption = `Untuk membatalkan pesanan yang sedang berjalan:\n\n` +
                `💬 Ketik perintah: \`/batalkanorder <ID Order>\`\n\n` +
                `*Contoh:* \`/batalkanorder RO137229787\`\n\n` +
                `⚠️ Pembatalan hanya bisa dilakukan jika SMS belum diterima/masuk.`;

            bot.editMessageCaption(caption, {
                chat_id: chatId,
                message_id: messageId,
                parse_mode: "Markdown",
                disable_web_page_preview: true,
                reply_markup: backKeyboard()
            });
        }
        return;
    }

    // 2. Handle Command Tanpa Parameter
    bot.onText(/\/batalkanorder$/, async (msg) => {
        const chatId = msg.chat.id;
        const msgId = msg.message_id;
        await sendSafeReply(bot, chatId, "Harap masukkan Order ID yang ingin Anda batalkan.\n\n*Contoh:* `/batalkanorder RO137229787`", {
            parse_mode: "Markdown",
            reply_to_message_id: msgId
        });
    });

    // 3. Handle Command Dengan Parameter
    bot.onText(/\/batalkanorder (.+)/, async (msg, match) => {
        const chatId = msg.chat.id;
        const msgId = msg.message_id;
        const userId = msg.from.id;
        const orderId = match[1].trim(); // Hapus spasi

        // HAPUS validasi angka (isNaN), karena Order ID RumahOTP formatnya string (RO...)

        const waitMsg = await sendSafeReply(bot, chatId, `⏳ Sedang memproses pembatalan untuk Order ID \`${orderId}\`...`, {
            reply_to_message_id: msgId,
            parse_mode: "Markdown"
        });

        if (!waitMsg) return;

        try {
            // A. Cek Pemilik Order di Database Bot
            const ownerId = await db.getOrderOwner(orderId);
            if (!ownerId) throw new Error(`Order ID \`${orderId}\` tidak ditemukan di database bot.`);
            if (ownerId.toString() !== userId.toString()) throw new Error("Anda bukan pemilik pesanan ini.");

            // B. Ambil Data History untuk tahu HARGA AWAL user (Modal + Markup)
            const history = await db.getOrderHistory(userId);
            const localOrderData = history.find(h => h.orderId.toString() === orderId.toString());
            
            // Harga yang harus dikembalikan ke user
            const refundAmountToUser = localOrderData ? localOrderData.harga : 0;

            // C. Request Batal ke API RumahOTP (set_status)
            const apiUrl = `https://www.rumahotp.com/api/v1/orders/set_status`;
            const response = await axios.get(apiUrl, {
                params: {
                    order_id: orderId,
                    status: 'cancel' // Set status ke cancel
                },
                headers: getHeaders()
            });

            const responseData = response.data;
            if (!responseData || responseData.success !== true) {
                // Tangani error message dari API jika ada
                throw new Error(responseData.message || responseData.error?.message || "Gagal membatalkan pesanan di API.");
            }

            // D. Logika Pengembalian Saldo (Refund)
            // Jika API return success: true, berarti saldo panel sudah aman/kembali.
            // Sekarang kita kembalikan saldo User Lokal.
            
            let refundMsg = "";
            let newSaldo = 0;
            const orderLock = await db.removeOrder(orderId);

            if (!orderLock) {
                refundMsg = "ℹ️ Order ini sudah diproses sebelumnya, saldo tidak ditambahkan lagi.";
            } else if (refundAmountToUser > 0) {
                await db.markOrderAsRefundedOnce(userId, orderId, 'canceled', {
                    cancel_reason: 'Canceled by User (/batalkanorder)'
                });
                await db.tambahSaldo(userId, refundAmountToUser);
                newSaldo = await db.cekSaldo(userId);
                refundMsg = `✅ Saldo *Rp${refundAmountToUser.toLocaleString('id-ID')}* telah dikembalikan.\n💰 Saldo Anda: *Rp${newSaldo.toLocaleString('id-ID')}*`;
            } else {
                await db.markOrderAsRefundedOnce(userId, orderId, 'canceled', {
                    cancel_reason: 'Canceled by User (/batalkanorder)'
                });
                // Fallback jika data history lokal korup/hilang
                refundMsg = "Pesanan dibatalkan di API, namun data harga lokal tidak ditemukan. Hubungi admin jika saldo belum kembali.";
            }

            const successMsg = `*「 PEMBATALAN BERHASIL 」*\n\n` +
                `- *Order ID:* \`${orderId}\`\n` +
                `- *Status:* Canceled (Dibatalkan)\n\n` +
                `${refundMsg}`;

            await bot.editMessageText(successMsg, {
                chat_id: chatId,
                message_id: waitMsg.message_id,
                parse_mode: "Markdown"
            });

        } catch (error) {
            console.error("Error pada fitur batalkanorder:", error);
            const errorMessage = `😥 Gagal membatalkan pesanan.\n\n*Pesan:* ${error.message}`;
            
            // Handle edit message error
            try {
                 await bot.editMessageText(errorMessage, {
                    chat_id: chatId,
                    message_id: waitMsg.message_id,
                    parse_mode: "Markdown"
                });
            } catch (e) {
                 sendSafeReply(bot, chatId, errorMessage, {
                    parse_mode: "Markdown",
                    reply_to_message_id: msgId
                });
            }
        }
    });
};
