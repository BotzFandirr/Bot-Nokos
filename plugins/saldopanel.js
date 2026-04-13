// plugins/saldopanel.js
const axios = require('axios');
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

module.exports = (bot, db, settings, pendingDeposits, query) => {

  // Helper untuk Header Auth RumahOTP
  const getHeaders = () => ({
    'x-apikey': settings.rumahOtpApiKey, // Pastikan ini diisi API Key RumahOTP di settings
    'Accept': 'application/json'
  });

  // 1. Handle Callback Query (Saat tombol ditekan)
  if (query) {
    (async () => {
      const chatId = query.message.chat.id;
      const messageId = query.message.message_id;

      try {
        const apiUrl = `https://www.rumahotp.io/api/v1/user/balance`;
        
        // PANGGIL API DENGAN HEADER
        const res = await axios.get(apiUrl, { headers: getHeaders() });
        const data = res.data;

        if (!data?.success || !data?.data) {
          throw new Error(data?.message || 'Gagal mengambil data saldo dari API.');
        }

        // Ambil saldo terformat (Rp...) atau format manual jika tidak ada
        const saldoFormatted = data.data.formated || `Rp${(Number(data.data.balance) || 0).toLocaleString('id-ID')}`;

        const caption =
          `*「 SALDO PANEL RUMAHOTP 」*\n\n` +
          `Saldo panel saat ini:\n*${saldoFormatted}*`;

        await bot.editMessageCaption(caption, {
          chat_id: chatId,
          message_id: messageId,
          parse_mode: 'Markdown',
          reply_markup: backKeyboard() // ⬅️ Kembali ke Menu Utama
        });
      } catch (e) {
        console.error('Error saldopanel (callback):', e);
        await bot.editMessageCaption(
          `😥 Maaf, gagal mengecek saldo panel.\n\n*Pesan:* ${e.message}`,
          { chat_id: chatId, message_id: messageId, parse_mode: 'Markdown', reply_markup: backKeyboard() }
        );
      }
    })();
    return;
  }

  // 2. Handle Command /saldopanel (Ketik Manual)
  bot.onText(/\/saldopanel/, async (msg) => {
    const chatId = msg.chat.id;
    const msgId = msg.message_id;

    const waitMsg = await sendSafeReply(
      bot,
      chatId,
      '⏳ Sedang mengecek saldo panel RumahOTP... Mohon tunggu.',
      { reply_to_message_id: msgId, parse_mode: 'Markdown' }
    );
    if (!waitMsg) return;

    try {
      const apiUrl = `https://www.rumahotp.io/api/v1/user/balance`;
      
      // PANGGIL API DENGAN HEADER
      const res = await axios.get(apiUrl, { headers: getHeaders() });
      const data = res.data;

      if (!data?.success || !data?.data) {
        throw new Error(data?.message || 'Gagal mengambil data saldo dari API.');
      }

      const saldoFormatted = data.data.formated || `Rp${(Number(data.data.balance) || 0).toLocaleString('id-ID')}`;

      const successMsg =
        `*「 SALDO PANEL RUMAHOTP 」*\n\n` +
        `Saldo panel saat ini:\n*${saldoFormatted}*`;

      await bot.editMessageText(successMsg, {
        chat_id: chatId,
        message_id: waitMsg.message_id,
        parse_mode: 'Markdown'
      });
    } catch (e) {
      console.error('Error saldopanel (command):', e);
      const errMsg = `😥 Maaf, gagal mengecek saldo panel.\n\n*Pesan:* ${e.message}`;
      await bot.editMessageText(errMsg, {
        chat_id: chatId,
        message_id: waitMsg.message_id,
        parse_mode: 'Markdown'
      }).catch(() =>
        sendSafeReply(bot, chatId, errMsg, { parse_mode: 'Markdown', reply_to_message_id: msgId })
      );
    }
  });
};
