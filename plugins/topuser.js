// plugins/topuser.js

const backKeyboard = require('../utils/backKeyboard');

async function sendSafeReply(bot, chatId, text, options) {
  try {
    const sent = await bot.sendMessage(chatId, text, options);
    return sent;
  } catch (error) {
    const desc = error?.response?.body?.description || '';
    if (desc === 'message to be replied not found') {
      delete options.reply_to_message_id;
      try { return await bot.sendMessage(chatId, text, options); } catch { return undefined; }
    }
    console.error('Gagal kirim pesan:', error?.response?.body || error);
    return undefined;
  }
}

function escapeMarkdown(text) {
    if (typeof text !== 'string') text = String(text);
    return text.replace(/([_*\[\]()~`>#+\-=|{}.!])/g, '\\$1');
}

async function getTopUserLeaderboard(bot, db) {
    const allUsersData = await db.getAllUsersFull(); 

    const allUsers = allUsersData.map(userDoc => {
        return {
            userId: userDoc._id,
            orderCount: (userDoc.history && Array.isArray(userDoc.history)) ? userDoc.history.length : 0
        };
    });

    allUsers.sort((a, b) => b.orderCount - a.orderCount);
    const top10Users = allUsers.slice(0, 10);

    // [FIX] Karakter ( dan ) di judul di-escape
    let leaderboardText = "*🏆 Top 10 Pengguna \\(Order Terbanyak\\) 🏆*\n\n";
    let rank = 1;

    for (const user of top10Users) {
        if (user.orderCount === 0) continue; 
        
        let userName = `User \\(${escapeMarkdown(user.userId)}\\)`; 
        
        try {
            const chat = await bot.getChat(user.userId);
            const firstName = escapeMarkdown(chat.first_name || '');
            const lastName = escapeMarkdown(chat.last_name || '');
            const username = chat.username ? `\\(@${escapeMarkdown(chat.username)}\\)` : '';
            
            let constructedName = `${firstName} ${lastName} ${username}`.trim();
            if (constructedName) {
                userName = constructedName;
            } else {
                 userName = `User \\(${escapeMarkdown(user.userId)}\\)`;
            }

        } catch (e) {
            console.warn(`Gagal fetch nama for user ${user.userId}: ${e.message}`);
        }
        
        let emoji = "";
        if (rank === 1) emoji = "🥇";
        else if (rank === 2) emoji = "🥈";
        else if (rank === 3) emoji = "🥉";
        else emoji = `*${rank}*\\.`;

        leaderboardText += `${emoji} ${userName} \\- *${user.orderCount} order*\n`;
        rank++;
    }

    if (rank === 1) {
         leaderboardText = "*Belum ada pengguna yang melakukan pesanan\\.*";
    }
    
    return leaderboardText;
}


module.exports = (bot, db, settings, pendingDeposits, query) => {

    if (query) {
        (async () => {
            const chatId = query.message.chat.id;
            const messageId = query.message.message_id;

            try {
                await bot.editMessageCaption("⏳ Menganalisis data... Ini mungkin perlu waktu...", {
                    chat_id: chatId,
                    message_id: messageId,
                    parse_mode: 'Markdown'
                });

                const leaderboardText = await getTopUserLeaderboard(bot, db);
                
                await bot.editMessageCaption(leaderboardText, {
                    chat_id: chatId,
                    message_id: messageId,
                    parse_mode: "MarkdownV2",
                    reply_markup: backKeyboard()
                });

            } catch (e) {
                console.error('Error topuser (callback):', e);
                
                // [FIX] Pesan error juga di-escape
                const errorMsg = `😥 Maaf, gagal mengambil data top user\\.\n\n*Pesan:* ${escapeMarkdown(e.message)}`;
                
                await bot.editMessageCaption(
                    errorMsg,
                    { chat_id: chatId, message_id: messageId, parse_mode: 'MarkdownV2', reply_markup: backKeyboard() }
                );
            }
        })();
        return;
    }

    bot.onText(/\/topuser/, async (msg) => {
        const chatId = msg.chat.id;
        const msgId = msg.message_id;

        const waitMsg = await sendSafeReply(bot, chatId, "⏳ Menganalisis data...", {
            reply_to_message_id: msgId
        });
        if (!waitMsg) return;

        try {
            const leaderboardText = await getTopUserLeaderboard(bot, db);

            await bot.editMessageText(leaderboardText, {
                chat_id: chatId,
                message_id: waitMsg.message_id,
                parse_mode: "MarkdownV2"
            });

        } catch (error) {
            console.error("Error di /topuser (command):", error);
            
            // [FIX] Pesan error di-escape dan menggunakan MarkdownV2
            const errorMsg = `Maaf, terjadi kesalahan saat membuat leaderboard\\.`;
            await bot.editMessageText(errorMsg, {
                chat_id: chatId,
                message_id: waitMsg.message_id,
                parse_mode: "MarkdownV2"
            });
        }
    });
};