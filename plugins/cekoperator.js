// plugins/cekoperator.js
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

function capitalize(str) {
    if (!str) return "";
    return str.replace(/\b\w/g, char => char.toUpperCase());
}

module.exports = (bot, db, settings, pendingDeposits, query) => {

    // Helper untuk Header Auth
    const getHeaders = () => ({
        'x-apikey': settings.rumahOtpApiKey,
        'Accept': 'application/json'
    });

    // 1. Handle Callback Query (Info Menu)
    if (query) {
        const chatId = query.message.chat.id;
        const messageId = query.message.message_id;

        const infoText = `Untuk melihat daftar operator tersedia:\n\n` +
            `📡 Format: \`/cekoperator <NamaNegara> <ProviderID>\`\n` +
            `_Note: Provider ID bisa dilihat saat Anda melakukan /ceknegara._\n\n` +
            `*Contoh:* \`/cekoperator Indonesia 3837\``;

        bot.editMessageCaption(infoText, {
            chat_id: chatId,
            message_id: messageId,
            parse_mode: "Markdown",
            disable_web_page_preview: true,
            reply_markup: backKeyboard()
        });
        return;
    }

    // 2. Handle Command Tanpa Parameter
    bot.onText(/\/cekoperator$/, async (msg) => {
        const chatId = msg.chat.id;
        const msgId = msg.message_id;
        await sendSafeReply(bot, chatId, "<!> Harap masukkan Nama Negara & Provider ID.\n\n*Contoh:* `/cekoperator Indonesia 3837`", {
            parse_mode: "Markdown",
            reply_to_message_id: msgId
        });
    });

    // 3. Handle Command Dengan Parameter
    // Regex menangkap dua grup: (.+) untuk nama negara (bisa spasi), (.+) untuk ID di belakang
    bot.onText(/\/cekoperator (.+) (.+)/, async (msg, match) => {
        const chatId = msg.chat.id;
        const msgId = msg.message_id;
        
        const countryName = match[1].trim(); // Contoh: Indonesia
        const providerId = match[2].trim();  // Contoh: 3837

        if (!countryName || isNaN(parseInt(providerId))) {
            return sendSafeReply(bot, chatId, "<!> Format salah.\nPastikan Provider ID adalah angka.\n\n*Contoh:* `/cekoperator Indonesia 3837`", {
                parse_mode: "Markdown",
                reply_to_message_id: msgId
            });
        }

        const apiUrl = `https://www.rumahotp.io/api/v2/operators`;
        
        const waitMsg = await sendSafeReply(bot, chatId, `⏳ Mengambil daftar operator untuk *${countryName}* (ID: ${providerId})...`, {
            reply_to_message_id: msgId,
            parse_mode: "Markdown"
        });

        if (!waitMsg) return;

        try {
            const response = await axios.get(apiUrl, {
                params: { 
                    country: countryName,
                    provider_id: providerId
                },
                headers: getHeaders()
            });

            const responseData = response.data;

            // API RumahOTP untuk operator kadang menggunakan 'status: true' bukan 'success'
            if (!responseData || (responseData.status !== true && responseData.success !== true) || !responseData.data) {
                throw new Error(responseData.message || "Gagal mengambil data operator.");
            }

            const operators = responseData.data;
            if (!operators || operators.length === 0) {
                return bot.editMessageText(`<!> Tidak ditemukan operator spesifik untuk konfigurasi ini (Mungkin hanya 'Any').`, {
                    chat_id: chatId,
                    message_id: waitMsg.message_id,
                    parse_mode: "Markdown"
                });
            }

            let message = `*📡 Daftar Operator (${capitalize(countryName)})*\n\n`;
            
            // Mapping data operator
            message += operators.map(op => {
                const opName = op.name === 'any' ? 'Acak (Any)' : capitalize(op.name);
                return `• *${opName}* (ID: \`${op.id}\`)`;
            }).join('\n');

            message += `\n\nGunakan ID Operator saat melakukan order (Opsional).`;

            await bot.deleteMessage(chatId, waitMsg.message_id).catch(() => {});
            await sendSafeReply(bot, chatId, message, {
                parse_mode: "Markdown",
                disable_web_page_preview: true,
                reply_markup: backKeyboard()
            });

        } catch (error) {
            console.error("Error cekoperator:", error);
            let errMsg = "😥 Gagal mengambil data operator.";
            
            if (error.response) {
                errMsg += `\n*Status:* ${error.response.status}`;
                if(error.response.data?.message) errMsg += `\n*API:* ${error.response.data.message}`;
            } else {
                errMsg += `\n*Detail:* ${error.message}`;
            }

            await bot.editMessageText(errMsg, {
                chat_id: chatId,
                message_id: waitMsg.message_id,
                parse_mode: "Markdown"
            }).catch(() =>
                sendSafeReply(bot, chatId, errMsg, {
                    parse_mode: "Markdown",
                    reply_to_message_id: msgId
                })
            );
        }
    });
};
