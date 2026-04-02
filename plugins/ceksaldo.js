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

    if (query) {
        (async () => {
            const chatId = query.message.chat.id;
            const messageId = query.message.message_id;
            const userId = query.from.id;

            try {
                const saldo = await db.cekSaldo(userId);
                const saldoFormatted = saldo.toLocaleString('id-ID');

                const caption = `💰 *Saldo Lokal Anda Saat Ini:*\n\n*Rp${saldoFormatted}*\n\nGunakan perintah *_/deposit <jumlah>_* untuk menambah saldo Anda.`;

                await bot.editMessageCaption(caption, {
                    chat_id: chatId,
                    message_id: messageId,
                    parse_mode: "Markdown",
                    reply_markup: backKeyboard()
                });
            } catch (error) {
                console.error("Error callback ceksaldo:", error);
                await bot.editMessageCaption("⚠️ Terjadi kesalahan saat memeriksa saldo Anda.", {
                    chat_id: chatId,
                    message_id: messageId
                });
            }
        })();
        return;
    }

    bot.onText(/\/ceksaldo/, async (msg) => {
        const chatId = msg.chat.id;
        const userId = msg.from.id;

        try {
            const saldo = await db.cekSaldo(userId);
            const saldoFormatted = saldo.toLocaleString('id-ID');

            await sendSafeReply(bot, chatId, `💰 *Saldo Lokal Anda:*\n\n*Rp${saldoFormatted}*`, {
                parse_mode: "Markdown",
                reply_to_message_id: msg.message_id,
                reply_markup: backKeyboard()
            });
        } catch (error) {
            console.error("Error pada fitur ceksaldo:", error);
            await sendSafeReply(bot, chatId, "😥 Maaf, terjadi kesalahan saat memeriksa saldo Anda.", {
                reply_to_message_id: msg.message_id
            });
        }
    });
};