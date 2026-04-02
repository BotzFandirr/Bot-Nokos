// plugins/addsaldo.js
// Perintah ini HANYA UNTUK OWNER

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

    // Plugin ini tidak merespons callback, hanya perintah
    if (query) return;

    // Handler jika pengguna hanya mengetik /addsaldo
    bot.onText(/\/addsaldo$/, async (msg) => {
        const chatId = msg.chat.id;
        const msgId = msg.message_id;
        // Cek jika ini owner
        if (msg.from.id.toString() !== settings.ownerId) {
            return sendSafeReply(bot, chatId, "❌ Perintah ini hanya untuk Owner.", { reply_to_message_id: msgId });
        }
        await sendSafeReply(bot, chatId, "Harap masukkan ID User dan Jumlah Saldo.\n\n*Contoh:* /addsaldo 12345678 10000", {
            parse_mode: "Markdown",
            reply_to_message_id: msgId
        });
    });

    // Handler untuk /addsaldo [userId] [amount]
    bot.onText(/\/addsaldo (\S+) (\S+)/, async (msg, match) => {
        const chatId = msg.chat.id;
        const msgId = msg.message_id;
        const userId = msg.from.id;

        // 1. Cek Admin
        if (userId.toString() !== settings.ownerId) {
            return sendSafeReply(bot, chatId, "❌ Perintah ini hanya untuk Owner.", { reply_to_message_id: msgId });
        }

        try {
            const targetUserId = match[1];
            const amount = parseInt(match[2]);

            // 2. Validasi Input
            if (isNaN(amount) || amount <= 0) {
                return sendSafeReply(bot, chatId, "⚠️ Jumlah saldo tidak valid. Harap masukkan angka.", { reply_to_message_id: msgId });
            }

            // 3. Tambah Saldo (Gunakan fungsi dari database.js)
            await db.tambahSaldo(targetUserId, amount);
            
            // 4. Konfirmasi
            const newSaldo = await db.cekSaldo(targetUserId);
            const successMsg = `✅ Saldo berhasil ditambahkan.\n\n` +
                `- *User ID:* \`${targetUserId}\`\n` +
                `- *Jumlah Ditambah:* Rp${amount.toLocaleString('id-ID')}\n` +
                `- *Saldo Baru:* Rp${newSaldo.toLocaleString('id-ID')}`;

            await sendSafeReply(bot, chatId, successMsg, {
                parse_mode: "Markdown",
                reply_to_message_id: msgId
            });

        } catch (error) {
            console.error("Error pada fitur addsaldo:", error);
            await sendSafeReply(bot, chatId, `😥 Gagal menambah saldo.\n\n*Pesan:* ${error.message}`, {
                parse_mode: "Markdown",
                reply_to_message_id: msgId
            });
        }
    });
};