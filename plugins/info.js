const sleep = (ms) => new Promise(resolve => setTimeout(resolve, ms));

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

    if (query) return;
    
    bot.onText(/\/info (.+)/s, async (msg, match) => {
        const chatId = msg.chat.id;
        const msgId = msg.message_id;
        const userId = msg.from.id;

        if (userId.toString() !== settings.ownerId) {
            return sendSafeReply(bot, chatId, "❌ Perintah ini hanya untuk Owner.", { reply_to_message_id: msgId });
        }

        const messageText = match[1];

        try {
            const userIds = await db.getAllUserIds();
            if (userIds.length === 0) {
                return sendSafeReply(bot, chatId, "Database pengguna masih kosong.", { reply_to_message_id: msgId });
            }
            
            await sendSafeReply(bot, chatId, `⏳ Memulai broadcast ke *${userIds.length}* pengguna...`, {
                parse_mode: "Markdown",
                reply_to_message_id: msgId
            });

            let successCount = 0;
            let failCount = 0;

            for (const id of userIds) {
                try {
                    await bot.sendMessage(id, messageText, { 
                        parse_mode: "Markdown",
                        disable_web_page_preview: true
                    });
                    successCount++;
                } catch (e) {
                    if (e.response && (e.response.body.error_code === 403 || e.response.body.error_code === 400)) {
                        failCount++;

                        // await db.removeUser(id); 
                    } else {
                        console.error(`Gagal broadcast ke ${id}:`, e.message);
                        failCount++;
                    }
                }
                await sleep(100); 
            }

            await sendSafeReply(bot, chatId, `✅ Broadcast Selesai.\n\n` +
                `Berhasil Terkirim: *${successCount}*\n` +
                `Gagal (Bot Diblokir): *${failCount}*`, {
                parse_mode: "Markdown",
                reply_to_message_id: msgId
            });

        } catch (error) {
            console.error("Error pada fitur /info:", error);
            await sendSafeReply(bot, chatId, `😥 Gagal melakukan broadcast.\n\n*Pesan:* ${error.message}`, {
                parse_mode: "Markdown",
                reply_to_message_id: msgId
            });
        }
    });
};