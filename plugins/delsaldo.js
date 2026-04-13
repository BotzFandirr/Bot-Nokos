// plugins/delsaldo.js
// Perintah ini HANYA UNTUK OWNER/ADMIN

async function sendSafeReply(bot, chatId, text, options) {
    try {
        const sentMessage = await bot.sendMessage(chatId, text, options);
        return sentMessage;
    } catch (error) {
        if (error.response && error.response.body.description === 'message to be replied not found') {
            delete options.reply_to_message_id;
            return await bot.sendMessage(chatId, text, options).catch(() => undefined);
        }
        console.error("Gagal kirim pesan:", error.response ? error.response.body : error);
        return undefined;
    }
}

module.exports = (bot, db, settings, pendingDeposits, query) => {
    if (query) return;

    // Handler jika admin hanya mengetik /delsaldo
    bot.onText(/\/delsaldo$/, async (msg) => {
        const chatId = msg.chat.id;
        const msgId = msg.message_id;

        if (msg.from.id.toString() !== settings.ownerId) {
            return sendSafeReply(bot, chatId, "❌ Perintah ini hanya untuk Admin.", { reply_to_message_id: msgId });
        }

        await sendSafeReply(
            bot,
            chatId,
            "Format: `/delsaldo <user_id> <jumlah>`\nContoh: `/delsaldo 12345678 1000`",
            { parse_mode: "Markdown", reply_to_message_id: msgId }
        );
    });

    // Handler /delsaldo [userId] [amount]
    bot.onText(/\/delsaldo (\S+) (\S+)/, async (msg, match) => {
        const chatId = msg.chat.id;
        const msgId = msg.message_id;

        if (msg.from.id.toString() !== settings.ownerId) {
            return sendSafeReply(bot, chatId, "❌ Perintah ini hanya untuk Admin.", { reply_to_message_id: msgId });
        }

        try {
            const targetUserId = match[1];
            const amount = parseInt(match[2], 10);

            if (!Number.isInteger(amount) || amount <= 0) {
                return sendSafeReply(bot, chatId, "⚠️ Jumlah pengurangan tidak valid. Masukkan angka lebih dari 0.", {
                    reply_to_message_id: msgId
                });
            }

            const saldoSekarang = await db.cekSaldo(targetUserId);
            const success = await db.kurangSaldo(targetUserId, amount);

            if (!success) {
                return sendSafeReply(
                    bot,
                    chatId,
                    `❌ Gagal mengurangi saldo.\nSaldo user saat ini: *Rp${Number(saldoSekarang).toLocaleString('id-ID')}*`,
                    { parse_mode: "Markdown", reply_to_message_id: msgId }
                );
            }

            const saldoBaru = await db.cekSaldo(targetUserId);
            const reply = `✅ Saldo berhasil dikurangi.\n\n` +
                `- *User ID:* \`${targetUserId}\`\n` +
                `- *Jumlah Dikurangi:* Rp${amount.toLocaleString('id-ID')}\n` +
                `- *Saldo Baru:* Rp${saldoBaru.toLocaleString('id-ID')}`;

            await sendSafeReply(bot, chatId, reply, {
                parse_mode: "Markdown",
                reply_to_message_id: msgId
            });
        } catch (error) {
            console.error("Error pada fitur delsaldo:", error);
            await sendSafeReply(bot, chatId, `😥 Gagal mengurangi saldo.\n\n*Pesan:* ${error.message}`, {
                parse_mode: "Markdown",
                reply_to_message_id: msgId
            });
        }
    });
};
