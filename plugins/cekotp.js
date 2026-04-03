// plugins/cekotp.js
const axios = require('axios');
const backKeyboard = require('../utils/backKeyboard');

async function sendSafeReply(bot, chatId, text, options) {
    try {
        const sentMessage = await bot.sendMessage(chatId, text, options);
        return sentMessage;
    } catch (error) {
        if (error.response && error.response.body.description === 'message to be replied not found') {
            console.warn(`Pesan reply tidak ditemukan. Mengirim ulang tanpa reply.`);
            delete options.reply_to_message_id;
            return await bot.sendMessage(chatId, text, options).catch(e => {
                console.error("Gagal kirim fallback:", e);
                return undefined;
            });
        } else {
            console.error("Gagal kirim pesan:", error.response ? error.response.body : error);
            return undefined;
        }
    }
}

module.exports = (bot, db, settings, pendingDeposits, query) => {

    // Helper untuk Header Auth
    const getHeaders = () => ({
        'x-apikey': settings.rumahOtpApiKey,
        'Accept': 'application/json'
    });

    if (query) {
        const chatId = query.message.chat.id;
        const messageId = query.message.message_id;

        const infoText = `Untuk mengecek kode OTP dari pesanan yang sudah Anda buat:\n\n` +
            `💬 Ketik perintah: \`/cekotp <ID Order>\`\n\n` +
            `*Contoh:* \`/cekotp RO137229787\`\n\n` +
            `Gunakan perintah ini setelah Anda melakukan /order dan mendapatkan Order ID.`;

        bot.editMessageCaption(infoText, {
            chat_id: chatId,
            message_id: messageId,
            parse_mode: "Markdown",
            disable_web_page_preview: true,
            reply_markup: backKeyboard()
        });
        return;
    }

    bot.onText(/\/cekotp$/, async (msg) => {
        const chatId = msg.chat.id;
        const msgId = msg.message_id;
        await sendSafeReply(bot, chatId, "Harap masukkan *Order ID* yang Anda dapatkan setelah memesan.\n\n*Contoh:* `/cekotp RO137229787`", {
            parse_mode: "Markdown",
            reply_to_message_id: msgId
        });
    });

    bot.onText(/\/cekotp (.+)/, async (msg, match) => {
        const chatId = msg.chat.id;
        const msgId = msg.message_id;
        const orderId = match[1].trim(); // Hapus spasi di awal/akhir

        // HAPUS validasi angka (isNaN), karena Order ID RumahOTP mengandung huruf (contoh: RO...)
        
        const waitMsg = await sendSafeReply(bot, chatId, `⏳ Mengecek SMS untuk Order ID \`${orderId}\`, mohon tunggu...`, {
            reply_to_message_id: msgId,
            parse_mode: "Markdown"
        });
        if (!waitMsg) return;

        try {
            const apiUrl = `https://www.rumahotp.com/api/v1/orders/get_status`;
            
            // Request ke API RumahOTP
            const response = await axios.get(apiUrl, {
                params: { order_id: orderId },
                headers: getHeaders()
            });

            const data = response.data;
            if (!data || data.success !== true) {
                // Tangani jika error message dari API ada
                throw new Error(data.message || data.error?.message || "Gagal mengambil data.");
            }

            const orderData = data.data;
            const otp = orderData.otp_code;
            const status = orderData.status; // status: waiting, received, completed, canceled, expiring
            const ownerId = await db.getOrderOwner(orderId);
            const normalizedStatus = String(status || '').toLowerCase();

            if (ownerId) {
                if (normalizedStatus === 'expired' || normalizedStatus === 'expiring') {
                    await db.updateOrderHistoryStatus(ownerId, orderId, 'expired', { refunded: true, cancel_reason: 'Expired from /cekotp check' });
                } else if (normalizedStatus === 'canceled') {
                    await db.updateOrderHistoryStatus(ownerId, orderId, 'canceled', { refunded: true, cancel_reason: 'Canceled from /cekotp check' });
                } else if ((otp && otp !== '-') && (normalizedStatus === 'received' || normalizedStatus === 'completed')) {
                    await db.updateOrderHistoryStatus(ownerId, orderId, 'success', { otp_code: otp });
                } else {
                    await db.updateOrderHistoryStatus(ownerId, orderId, 'pending');
                }
            }

            let message = "";

            // Logika Status
            if (status === 'canceled') {
                 message = `❌ Order ID \`${orderId}\` telah *DIBATALKAN* (Canceled/Expired).`;
            } else if (otp && otp !== '-' && (status === 'received' || status === 'completed')) {
                message = `*「 KODE OTP DITEMUKAN 」*\n\n`;
                message += `- *Order ID:* \`${orderId}\`\n`;
                message += `- *Status:* ${status.toUpperCase()}\n`;
                message += `- *Kode OTP:* \`${otp}\`\n\n`;
                message += `✅ Silakan gunakan kode ini untuk verifikasi akun Anda.`;
            } else {
                message = `⏳ Belum ada SMS untuk Order ID \`${orderId}\`.\n\n`;
                message += `*Status Saat Ini:* ${status.toUpperCase()}\n`;
                message += `Silakan tunggu beberapa saat lalu cek lagi.`;
            }

            await bot.editMessageText(message, {
                chat_id: chatId,
                message_id: waitMsg.message_id,
                parse_mode: "Markdown",
                disable_web_page_preview: true
            });

        } catch (error) {
            console.error("Error cekotp:", error);
            let errorMsg = `😥 Gagal mengecek OTP.\n\n`;
            
            if (error.response) {
                 errorMsg += `*Pesan Data:* ${error.response.data?.message || error.message}`;
            } else {
                 errorMsg += `*Error:* ${error.message}`;
            }

            await bot.editMessageText(errorMsg, {
                chat_id: chatId,
                message_id: waitMsg.message_id,
                parse_mode: "Markdown"
            }).catch(() =>
                sendSafeReply(bot, chatId, errorMsg, {
                    parse_mode: "Markdown",
                    reply_to_message_id: msgId
                })
            );
        }
    });
};
