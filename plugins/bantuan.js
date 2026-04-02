// plugins/bantuan.js

const backKeyboard = require('../utils/backKeyboard'); // Impor tombol kembali

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

    // [BARU] Handler untuk tombol "BANTUAN" (callback_data: "bantuan")
    if (query) {
        (async () => {
            const chatId = query.message.chat.id;
            const messageId = query.message.message_id;

            let helpMessage = `*Butuh Bantuan?*\n\n`;
            helpMessage += `Jika Anda mengalami masalah dengan deposit, pesanan, atau memiliki pertanyaan lain, silakan hubungi Admin.\n\n`;
            helpMessage += `Kontak Admin: @AlwaysZakzz`; // Ganti dengan username admin Anda

            // Edit pesan menu utama menjadi pesan bantuan
            try {
                await bot.editMessageCaption(helpMessage, {
                    chat_id: chatId,
                    message_id: messageId,
                    parse_mode: "Markdown",
                    disable_web_page_preview: true,
                    reply_markup: backKeyboard() // Tambahkan tombol kembali
                });
            } catch (e) {
                // Fallback jika 'start' bukan foto
                await bot.editMessageText(helpMessage, {
                    chat_id: chatId,
                    message_id: messageId,
                    parse_mode: "Markdown",
                    disable_web_page_preview: true,
                    reply_markup: backKeyboard()
                });
            }
        })();
        return;
    }

    // Handler untuk /bantuan (fallback)
    bot.onText(/\/bantuan/, async (msg) => {
        const chatId = msg.chat.id;
        const msgId = msg.message_id;
        
        let helpMessage = `*Butuh Bantuan?*\n\n`;
        helpMessage += `Jika Anda mengalami masalah dengan deposit, pesanan, atau memiliki pertanyaan lain, silakan hubungi Admin.\n\n`;
        helpMessage += `Kontak Admin: @AlwaysZakzz`; // Ganti dengan username admin Anda

        await sendSafeReply(bot, chatId, helpMessage, {
            parse_mode: "Markdown",
            reply_to_message_id: msgId,
            disable_web_page_preview: true
        });
    });

};