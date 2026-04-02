const TelegramBot = require('node-telegram-bot-api');
const fs = require('fs');
const path = require('path');
const axios = require('axios');
const moment = require('moment');

const settings = require('./settings.js');
const db = require('./utils/database.js');
const Notifikasi = require('./notifikasi');

const bot = new TelegramBot(settings.telegramToken, { polling: true });
let pendingDeposits = {};

Notifikasi.init(bot, { onAliveText: "✅ Bot berhasil dihidupkan." });


async function sendSafeReply(bot, chatId, text, options) {
    try {
        await bot.sendMessage(chatId, text, options);
    } catch (error) {
        console.error("Gagal kirim pesan (safeReply):", error.message);
    }
}

async function startDepositChecker(bot, db, settings, pendingDeposits, depositData) {
    const { orderId, userId, originalMsgId, amount, expiryTime, msgQrKey, chatId, userProfile } = depositData;
    const expiryMoment = moment(expiryTime);

    const checkInterval = setInterval(async () => {
        const pendingData = pendingDeposits[userId];
        if (!pendingData || pendingData.orderId !== orderId) {
            clearInterval(checkInterval);
            return;
        }

        try {
            const statusApiUrl = `https://fandirr.store/api/payment/status/${orderId}?apikey=${settings.blackhatApiKey}`;
            const statusRes = await axios.get(statusApiUrl);
            const statusData = statusRes.data;

            if (statusData.status === 'settlement') {
                clearInterval(checkInterval);
                await db.tambahSaldo(userId, amount);
                await db.addDepositHistory(userId, { orderId: orderId, amount: amount, date: new Date().toISOString() });
                const newSaldo = await db.cekSaldo(userId);

                try {
                    const uProfile = userProfile || {}; 
                    const uName = Notifikasi.escMd(uProfile.first_name || 'User');
                    const uUsername = uProfile.username ? `(@${Notifikasi.escMd(uProfile.username)})` : '';
                    await Notifikasi.sendOwnerMessage(
                        `💰 *Deposit Sukses (Pulih)*\n\n` + 
                        `• *User:* ${uName} ${uUsername} (\`${userId}\`)\n` +
                        `• *Order ID:* \`${orderId}\`\n` +
                        `• *Jumlah:* Rp${amount.toLocaleString('id-ID')}\n` +
                        `• *Saldo Baru User:* Rp${newSaldo.toLocaleString('id-ID')}`
                    );
                } catch (notifError) {
                    console.error("Gagal kirim notifikasi deposit (pulih):", notifError);
                }

                const successMsg = `✅ *Pembayaran Berhasil!*\n\n` +
                    `- *Order ID:* \`${orderId}\`\n` +
                    `- *Jumlah:* Rp${amount.toLocaleString('id-ID')}\n\n` +
                    `Saldo Anda sekarang: *Rp${newSaldo.toLocaleString('id-ID')}*`;

                await sendSafeReply(bot, chatId, successMsg, { 
                    parse_mode: "Markdown",
                    reply_to_message_id: originalMsgId
                });
                await bot.deleteMessage(chatId, msgQrKey).catch(() => {});
                
                await db.removePendingDeposit(userId);
                delete pendingDeposits[userId];
            }

            if (moment().isAfter(expiryMoment)) {
                clearInterval(checkInterval);
                if(pendingDeposits[userId] && pendingDeposits[userId].orderId === orderId) {
                    await sendSafeReply(bot, chatId, `⚠️ Pembayaran \`${orderId}\` kedaluwarsa dan dibatalkan otomatis.`, { 
                        parse_mode: "Markdown",
                        reply_to_message_id: originalMsgId 
                    });
                    await bot.deleteMessage(chatId, msgQrKey).catch(() => {});
                    
                    await db.removePendingDeposit(userId);
                    delete pendingDeposits[userId];
                }
            }
        } catch (err) {
            console.error(`Gagal cek status order ${orderId} (saat pemulihan):`, err.message);
        }
    }, 20000);

    return checkInterval;
}

async function restorePendingDeposits() {
    console.log('[Sistem] Memulihkan deposit yang tertunda dari MongoDB...');
    const allDeposits = await db.getAllPendingDeposits();

    if (allDeposits.length === 0) {
        console.log('[Sistem] Tidak ada deposit tertunda untuk dipulihkan.');
        return;
    }

    let restoredCount = 0;
    for (const depositData of allDeposits) { 
        const userId = depositData.userId;
        try {
            if (moment().isAfter(moment(depositData.expiryTime))) {
                console.log(`[Sistem] Deposit ${depositData.orderId} untuk user ${userId} sudah kedaluwarsa. Dihapus.`);
                await db.removePendingDeposit(userId);
                continue;
            }

            const checkInterval = await startDepositChecker(bot, db, settings, pendingDeposits, depositData);
            
            pendingDeposits[userId] = { 
                orderId: depositData.orderId, 
                interval: checkInterval, 
                msgQrKey: depositData.msgQrKey, 
                chatId: depositData.chatId, 
                originalMsgId: depositData.originalMsgId,
                userProfile: depositData.userProfile
            };
            restoredCount++;
        } catch (e) {
            console.error(`[Sistem] Gagal memulihkan deposit untuk user ${userId}:`, e.message);
        }
    }
    console.log(`[Sistem] Berhasil memulihkan ${restoredCount} deposit tertunda.`);
}

const pluginsDir = path.join(__dirname, 'plugins');

fs.readdirSync(pluginsDir).forEach((file) => {
  if (file.endsWith('.js')) {
    try {
      const plugin = require(path.join(pluginsDir, file));
      plugin(bot, db, settings, pendingDeposits);
      console.log(`[Plugin Loaded] ${file} berhasil dimuat.`);
    } catch (err) {
      console.error(`[Plugin Error] Gagal memuat ${file}:`, err.message);
    }
  }
});

console.log('✅ Bot AlwaysZakzz VirtuSIM berjalan dengan sistem plugin...');

restorePendingDeposits();

const exactMap = {
  start: 'start',
  order: 'ceklayanan',
  deposit: 'deposit',
  bataldeposit: 'bataldeposit',
  batalkanorder: 'batalkanorder',
  saldo: 'saldopanel',
  ceksaldo: 'ceksaldo',
  cekotp: 'cekotp',
  ceklayanan: 'ceklayanan',
  ceknegara: 'ceknegara',
  cekoperator: 'cekoperator',
  cekstatus: 'cekstatus',
  riwayat: 'riwayatorder',
  totalmember: 'totalmember',
  topuser: 'topuser',
  bantuan: 'bantuan',
  riwayatorder: 'riwayatorder',
  saldopanel: 'saldopanel',
  orderlayanan: 'orderlayanan',
  buyscript: 'buyscript',
  buypanel: 'buypanel',
  buyvps: 'buyvps',
  buyvps: "buyvps",
  buyvps_start: "buyvps",
  buyvps_pay_execute: "buyvps",
  check_join: "start",
};

const prefixMap = [
  { prefix: 'lay_page:', plugin: 'ceklayanan' },
  { prefix: 'lay_close:', plugin: 'ceklayanan' },
  { prefix: 'page_neg:', plugin: 'ceknegara' },
  { prefix: 'buy_neg:', plugin: 'ceknegara' },
  { prefix: 'close_neg', plugin: 'ceknegara' },
  { prefix: 'ri_page:', plugin: 'riwayatorder' },
  { prefix: 'ri_close:', plugin: 'riwayatorder' },
  { prefix: 'ord_cekotp:', plugin: 'orderlayanan' },
  { prefix: 'ord_batal:', plugin: 'orderlayanan' },
  { prefix: 'cancel_deposit:', plugin: 'deposit' },
  { prefix: 'buy_', plugin: 'buyscript' },
  { prefix: 'buypanel', plugin: 'buypanel' },
  { prefix: 'panel_buy', plugin: 'buypanel' },
  { prefix: 'panel_cancel', plugin: 'buypanel' },
  { prefix: 'panel_', plugin: 'buypanel' },
  { prefix: 'buypanel1gb', plugin: 'buypanel' },
  { prefix: 'buypanel2gb', plugin: 'buypanel' },
  { prefix: 'buypanel3gb', plugin: 'buypanel' },
  { prefix: 'buypanel4gb', plugin: 'buypanel' },
  { prefix: 'buypanel5gb', plugin: 'buypanel' },
  { prefix: 'buypanel6gb', plugin: 'buypanel' },
  { prefix: 'buypanel7gb', plugin: 'buypanel' },
  { prefix: 'buypanel8gb', plugin: 'buypanel' },
  { prefix: 'buypanel9gb', plugin: 'buypanel' },
  { prefix: 'buypanelunli', plugin: 'buypanel' },
  { prefix: "buyvps_pkg:", plugin: "buyvps" },
  { prefix: "buyvps_ram:", plugin: "buyvps" },
  { prefix: "buyvps_os:", plugin: "buyvps" },
  { prefix: "buyvps_region:", plugin: "buyvps" },
  { prefix: "buyvps", plugin: "buyvps" },
];

function resolvePluginByData(data) {
  if (!data) return null;
  if (exactMap[data]) return exactMap[data];
  for (const { prefix, plugin } of prefixMap) {
    if (data.startsWith(prefix)) return plugin;
  }
  return null;
}

bot.on('callback_query', async (query) => {
  if (!query?.message) return;

  const chatId = query.message.chat.id;
  const data = (query.data || '').toLowerCase();
  const messageId = query.message.message_id;

  console.log(`[Callback] ${data} ← from ${query.from.first_name || query.from.id} (${chatId})`);

  const pluginName = resolvePluginByData(data);
  if (!pluginName) {
    return bot.sendMessage(chatId, '⚠️ Fitur ini belum tersedia atau plugin tidak dikenali.', {
      reply_to_message_id: messageId,
    });
  }

  const pluginPath = path.join(pluginsDir, `${pluginName}.js`);
  if (!fs.existsSync(pluginPath)) {
    return bot.sendMessage(chatId, `⚠️ Plugin ${pluginName}.js tidak ditemukan di folder plugins.`, {
      reply_to_message_id: messageId,
    });
  }

  try {
    delete require.cache[require.resolve(pluginPath)];
    const plugin = require(pluginPath);
    await plugin(bot, db, settings, pendingDeposits, query);
    console.log(`✅ Callback → ${pluginName}.js OK`);
  } catch (err) {
    console.error(`❌ Callback error (${pluginName}):`, err);
    await bot.sendMessage(chatId, '❌ Terjadi kesalahan internal saat membuka menu ini.', {
      reply_to_message_id: messageId,
    });
  }
});

bot.on("message", async (message) => {
    if (!message || !message.from) return;

    const userId = message.from.id;

    if (
        db.pendingPanelOrder &&
        db.pendingPanelOrder[userId] &&
        db.pendingPanelOrder[userId].stage === "username"
    ) {
        try {
            const pluginPath = path.join(__dirname, "plugins", "buypanel.js");

            delete require.cache[require.resolve(pluginPath)];
            const plugin = require(pluginPath);

            await plugin(bot, db, settings, pendingDeposits, null, message);
        } catch (err) {
            await bot.sendMessage(
                message.chat.id,
                "<!> Terjadi kesalahan saat memproses username panel.",
                { parse_mode: "Markdown" }
            );
        }

        return;
    }
});

bot.on('polling_error', (err) => {
  console.error('[Polling Error]', err.message);
});

process.on('uncaughtException', (err) => {
  console.error('[Uncaught Exception]', err);
});

process.on('unhandledRejection', (reason) => {
  console.error('[Unhandled Rejection]', reason);
});