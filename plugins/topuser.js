// plugins/topuser.js

const backKeyboard = require('../utils/backKeyboard');
const ITEMS_PER_PAGE = 10;
let topCache = {};

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
    return allUsers.filter(u => u.orderCount > 0);
}

async function renderTopPage(bot, sortedUsers, page = 1) {
    const totalItems = sortedUsers.length;
    const totalPages = Math.max(1, Math.ceil(totalItems / ITEMS_PER_PAGE));
    const safePage = Math.min(Math.max(1, page), totalPages);
    const start = (safePage - 1) * ITEMS_PER_PAGE;
    const items = sortedUsers.slice(start, start + ITEMS_PER_PAGE);

    let leaderboardText = "*🏆 Top Pengguna \\(Order Terbanyak\\) 🏆*\n\n";
    leaderboardText += `Total user berorder: *${totalItems}*\n`;
    leaderboardText += `Halaman: *${safePage}/${totalPages}*\n\n`;

    let rank = start + 1;
    for (const user of items) {
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

    if (items.length === 0) {
         leaderboardText = "*Belum ada pengguna yang melakukan pesanan\\.*";
    }

    const buttons = [];
    if (safePage > 1) {
        buttons.push({ text: "⏮️ Pertama", callback_data: "top_page:first" });
        buttons.push({ text: "⬅️ Sebelumnya", callback_data: `top_page:${safePage - 1}` });
    }
    buttons.push({ text: "🏠 Menu Utama", callback_data: "start" });
    if (safePage < totalPages) {
        buttons.push({ text: "Selanjutnya ➡️", callback_data: `top_page:${safePage + 1}` });
        buttons.push({ text: "Terakhir ⏭️", callback_data: "top_page:last" });
    }

    return {
        text: leaderboardText,
        reply_markup: { inline_keyboard: [buttons] }
    };
}


module.exports = (bot, db, settings, pendingDeposits, query) => {

    if (query) {
        (async () => {
            const chatId = query.message.chat.id;
            const messageId = query.message.message_id;

            try {
                const data = (query.data || "").toLowerCase();
                await bot.editMessageCaption("⏳ Menganalisis data... Ini mungkin perlu waktu...", {
                    chat_id: chatId,
                    message_id: messageId,
                    parse_mode: 'Markdown'
                });

                let sortedUsers = topCache[chatId];
                if (!sortedUsers || data === 'topuser') {
                    sortedUsers = await getTopUserLeaderboard(bot, db);
                    topCache[chatId] = sortedUsers;
                }

                let page = 1;
                if (data.startsWith('top_page:')) {
                    const requested = data.split(':')[1];
                    if (requested === 'first') page = 1;
                    else if (requested === 'last') page = Math.max(1, Math.ceil(sortedUsers.length / ITEMS_PER_PAGE));
                    else page = parseInt(requested, 10) || 1;
                }
                const pageData = await renderTopPage(bot, sortedUsers, page);

                await bot.editMessageCaption(pageData.text, {
                    chat_id: chatId,
                    message_id: messageId,
                    parse_mode: "MarkdownV2",
                    reply_markup: pageData.reply_markup
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
            const sortedUsers = await getTopUserLeaderboard(bot, db);
            const pageData = await renderTopPage(bot, sortedUsers, 1);

            await bot.editMessageText(pageData.text, {
                chat_id: chatId,
                message_id: waitMsg.message_id,
                parse_mode: "MarkdownV2",
                reply_markup: pageData.reply_markup
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
