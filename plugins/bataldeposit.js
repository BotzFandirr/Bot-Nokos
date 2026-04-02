const axios = require('axios');
const backKeyboard = require('../utils/backKeyboard');

async function sendSafeReply(bot, chatId, text, options) {
    try {
        await bot.sendMessage(chatId, text, options);
    } catch (error) {
        if (error.response && error.response.body.description === 'message to be replied not found') {
            console.warn(`Pesan untuk dibalas (ID: ${options.reply_to_message_id}) tidak ditemukan. Mengirim tanpa reply.`);
            delete options.reply_to_message_id;
            await bot.sendMessage(chatId, text, options).catch(e => console.error("Gagal kirim fallback:", e));
        } else {
            console.error("Gagal kirim pesan:", error.response ? error.response.body : error);
        }
    }
}

module.exports = (bot, db, settings, pendingDeposits, query) => {

    if (query) {
        const data = (query.data || '').toLowerCase();
        if (data.startsWith("cancel_deposit:")) {
            return;
        }
    }

    bot.onText(/\/bataldeposit/, async (msg) => {
        const chatId = msg.chat.id;
        const userId = msg.from.id;
        const originalMsgId = msg.message_id;

        const pending = pendingDeposits[userId];

        if (!pending) {
            return sendSafeReply(bot, chatId, "Anda tidak memiliki transaksi deposit yang sedang berjalan.", {
                reply_to_message_id: originalMsgId
            });
        }

        await sendSafeReply(bot, chatId, `⏳ Membatalkan permintaan deposit dengan ID Pesanan \`${pending.orderId}\`...`, {
            parse_mode: "Markdown",
            reply_to_message_id: originalMsgId
        });

        try {
            const cancelApiUrl = `https://blackhat.web.id/api/payment/update-status?apikey=${settings.blackhatApiKey}`;
            const cancelResponse = await axios.post(cancelApiUrl, 
                { orderId: pending.orderId, newStatus: 'cancel' }, 
                { headers: { 'Content-Type': 'application/json' } }
            );

            clearInterval(pending.interval);
            
            await bot.deleteMessage(chatId, pending.msgQrKey).catch(() => {});
            await db.removePendingDeposit(userId);
            delete pendingDeposits[userId];

            const message = cancelResponse.data.message || `Deposit \`${pending.orderId}\` telah dibatalkan.`;
            await sendSafeReply(bot, chatId, `✅ ${message}`, {
                parse_mode: "Markdown",
                reply_to_message_id: originalMsgId
            });

        } catch (error) {
            console.error("Error bataldeposit (command):", error.response ? error.response.data : error.message);

            clearInterval(pending.interval);
            await bot.deleteMessage(chatId, pending.msgQrKey).catch(() => {});
            await db.removePendingDeposit(userId);
            delete pendingDeposits[userId];

            await sendSafeReply(bot, chatId, "⚠️ Terjadi kesalahan saat membatalkan di API, tetapi transaksi lokal Anda telah dihentikan.", {
                reply_to_message_id: originalMsgId
            });
        }
    });
};