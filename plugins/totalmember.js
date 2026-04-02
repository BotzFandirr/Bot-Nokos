// plugins/totalmember.js
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

function fmt(n) {
  const num = Number(n) || 0;
  return num.toLocaleString('id-ID');
}

module.exports = (bot, db, settings, pendingDeposits, query) => {

  if (query) {
    (async () => {
      const chatId = query.message.chat.id;
      const messageId = query.message.message_id;

      try {
        const userDatabase = await db.readUserDB();
        const totalMembers = Object.keys(userDatabase || {}).length;

        const caption =
          `*「 STATISTIK BOT 」*\n\n` +
          `Total pengguna terdaftar:\n*${fmt(totalMembers)} member*`;

        await bot.editMessageCaption(caption, {
          chat_id: chatId,
          message_id: messageId,
          parse_mode: 'Markdown',
          reply_markup: backKeyboard()
        });
      } catch (e) {
        console.error('Error totalmember (callback):', e);
        await bot.editMessageCaption('Maaf, terjadi kesalahan saat mengambil data member.', {
          chat_id: chatId,
          message_id: messageId,
          reply_markup: backKeyboard()
        }).catch(() => {});
      }
    })();
    return;
  }

  bot.onText(/\/totalmember/, async (msg) => {
    const chatId = msg.chat.id;
    const msgId = msg.message_id;

    try {
      const userDatabase = await db.readUserDB();
      const totalMembers = Object.keys(userDatabase || {}).length;

      const successMsg =
        `*「 STATISTIK BOT 」*\n\n` +
        `Total pengguna yang terdaftar (pernah berinteraksi) di bot ini adalah:\n` +
        `*${fmt(totalMembers)} member*`;

      await sendSafeReply(bot, chatId, successMsg, {
        parse_mode: 'Markdown',
        reply_to_message_id: msgId
      });
    } catch (e) {
      console.error('Error totalmember (command):', e);
      await sendSafeReply(bot, chatId, 'Maaf, terjadi kesalahan saat mengambil data member.', {
        reply_to_message_id: msgId
      });
    }
  });
};