const axios = require('axios');

const BASE_URL = 'https://api.jasaotp.id/v1';
const ITEMS_PER_PAGE = 20;
const SERVER2_EXPIRE_MINUTES = 15;
const MIN_CANCEL_MINUTES = 3;
const SERVICES_CACHE_TTL_MS = 2 * 60 * 1000;

if (!global.server2Cache) {
  global.server2Cache = {
    countries: null,
    servicesByCountry: {},
    operatorsByCountry: {}
  };
}
if (!global.server2WatcherStarted) global.server2WatcherStarted = false;

const formatRupiah = (n) => `Rp${parseInt(n || 0, 10).toLocaleString('id-ID')}`;

function toNumberSafe(v) {
  if (typeof v === 'number') return Number.isFinite(v) ? v : 0;
  const cleaned = String(v || '0').replace(/[^0-9.-]/g, '');
  const n = Number(cleaned);
  return Number.isFinite(n) ? n : 0;
}

function getFinalPrice(originalHarga, markupRateString) {
  let markupDecimal = 0;
  try {
    const percentageString = (markupRateString || '0%').replace('%', '');
    const feePercentage = parseFloat(percentageString);
    if (!isNaN(feePercentage)) markupDecimal = feePercentage / 100;
  } catch (e) {}
  const markupAmount = Math.ceil(Number(originalHarga || 0) * markupDecimal);
  return Number(originalHarga || 0) + markupAmount;
}

async function apiGet(path, params = {}) {
  const res = await axios.get(`${BASE_URL}/${path}`, { params, timeout: 15000 });
  return res.data;
}

function normalizeCountries(raw) {
  if (!raw?.success || !Array.isArray(raw?.data)) throw new Error(raw?.message || 'Gagal ambil negara.');
  return raw.data;
}

function normalizeServices(raw, countryId) {
  const cKey = String(countryId);

  let bucket = null;
  if (raw && typeof raw === 'object') {
    if (raw[cKey] && typeof raw[cKey] === 'object') bucket = raw[cKey];
    else if (raw?.data?.[cKey] && typeof raw.data[cKey] === 'object') bucket = raw.data[cKey];
    else if (raw?.data && typeof raw.data === 'object' && raw.data[cKey] && typeof raw.data[cKey] === 'object') bucket = raw.data[cKey];
  }

  if (!bucket || typeof bucket !== 'object') return [];

  const list = Object.entries(bucket).map(([code, v]) => ({
    code: String(code),
    harga: toNumberSafe(v?.harga || 0),
    stok: toNumberSafe(v?.stok || 0),
    layanan: String(v?.layanan || code)
  })).filter((x) => x.code && x.layanan);

  const prioritized = [];
  const rest = [];
  for (const item of list) {
    const svc = String(item.layanan || '').toLowerCase();
    const code = String(item.code || '').toLowerCase();
    if (svc === 'whatsapp' || code === 'wa') prioritized.push({ ...item, __p: 1 });
    else if (svc === 'telegram' || code === 'tg') prioritized.push({ ...item, __p: 2 });
    else rest.push(item);
  }

  rest.sort((a, b) => {
    const nameA = String(a.layanan || a.code || '').toLowerCase();
    const nameB = String(b.layanan || b.code || '').toLowerCase();
    return nameA.localeCompare(nameB);
  });

  prioritized.sort((a, b) => a.__p - b.__p);
  return [...prioritized, ...rest].map(({ __p, ...x }) => x);
}

async function getCountries() {
  if (global.server2Cache.countries) return global.server2Cache.countries;
  const data = await apiGet('negara.php');
  const countries = normalizeCountries(data);
  global.server2Cache.countries = countries;
  return countries;
}

async function getServices(countryId, { force = false } = {}) {
  const key = String(countryId);
  const cached = global.server2Cache.servicesByCountry[key];
  if (!force && cached && (Date.now() - (cached.ts || 0) < SERVICES_CACHE_TTL_MS)) {
    return cached.list || [];
  }

  const data = await apiGet('layanan.php', { negara: countryId });
  const list = normalizeServices(data, countryId);

  if (list.length > 0 || force) {
    global.server2Cache.servicesByCountry[key] = { ts: Date.now(), list };
  }

  return list;
}

async function getOperators(countryId) {
  if (global.server2Cache.operatorsByCountry[countryId]) return global.server2Cache.operatorsByCountry[countryId];
  const data = await apiGet('operator.php', { negara: countryId });
  const list = data?.data?.[String(countryId)] || ['any'];
  global.server2Cache.operatorsByCountry[countryId] = list;
  return list;
}

function buildCountryPage(countries, page = 1) {
  const totalPages = Math.max(1, Math.ceil(countries.length / ITEMS_PER_PAGE));
  const cur = Math.min(Math.max(page, 1), totalPages);
  const start = (cur - 1) * ITEMS_PER_PAGE;
  const items = countries.slice(start, start + ITEMS_PER_PAGE);

  const kb = [];
  let row = [];
  for (const c of items) {
    const name = c.nama_negara || `country-${c.id_negara}`;
    row.push({ text: name, callback_data: `s2_pick_country:${c.id_negara}:1` });
    if (row.length === 2) { kb.push(row); row = []; }
  }
  if (row.length) kb.push(row);

  const nav = [];
  if (cur > 1) nav.push({ text: '⬅️ Prev', callback_data: `s2_page_country:${cur - 1}` });
  nav.push({ text: '🏠 Menu', callback_data: 'start' });
  if (cur < totalPages) nav.push({ text: 'Next ➡️', callback_data: `s2_page_country:${cur + 1}` });
  kb.push(nav);

  return {
    caption: `🌐 *SERVER 2 - PILIH NEGARA*\n\nPilih negara terlebih dahulu.\nHalaman ${cur}/${totalPages}`,
    reply_markup: { inline_keyboard: kb }
  };
}

function buildServicePage(countryId, services, page = 1, markupRate = '0%') {
  const totalPages = Math.max(1, Math.ceil(services.length / ITEMS_PER_PAGE));
  const cur = Math.min(Math.max(page, 1), totalPages);
  const start = (cur - 1) * ITEMS_PER_PAGE;
  const items = services.slice(start, start + ITEMS_PER_PAGE);

  const kb = [];
  let row = [];
  for (const s of items) {
    const finalPrice = getFinalPrice(s.harga, markupRate);
    let label = `${s.layanan} (${formatRupiah(finalPrice)})`;
    if (s.stok <= 0) label = `🔴 ${s.layanan}`;
    if (label.length > 30) label = label.slice(0, 28) + '..';
    row.push({ text: label, callback_data: s.stok > 0 ? `s2_buy:${countryId}:${s.code}` : 'noop' });
    if (row.length === 2) { kb.push(row); row = []; }
  }
  if (row.length) kb.push(row);

  const nav = [];
  if (cur > 1) nav.push({ text: '⬅️ Prev', callback_data: `s2_pick_country:${countryId}:${cur - 1}` });
  nav.push({ text: '🌐 Ganti Negara', callback_data: 's2_page_country:1' });
  if (cur < totalPages) nav.push({ text: 'Next ➡️', callback_data: `s2_pick_country:${countryId}:${cur + 1}` });
  kb.push(nav);

  return {
    caption: `📦 *SERVER 2 - PILIH LAYANAN*\n\nNegara ID: *${countryId}*\nHalaman ${cur}/${totalPages}`,
    reply_markup: { inline_keyboard: kb }
  };
}

function capitalizeWords(str = '') {
  return String(str).replace(/\b\w/g, (c) => c.toUpperCase());
}


async function smartEdit(bot, query, text, options) {
  const chatId = query.message.chat.id;
  const messageId = query.message.message_id;
  const opts = { ...options, chat_id: chatId, message_id: messageId };

  try {
    if (query.message.photo) await bot.editMessageCaption(text, opts);
    else await bot.editMessageText(text, opts);
  } catch (e) {
    if (!String(e.message || '').includes('message is not modified')) {}
  }
}

function extractOtpValue(smsResponse) {
  const rawOtp = String(smsResponse?.data?.otp ?? '').trim();
  if (rawOtp && !/menunggu/i.test(rawOtp)) return rawOtp;

  const message = String(smsResponse?.message || smsResponse?.data?.message || '').trim();
  const digit = message.match(/\b(\d{4,8})\b/);
  if (digit) return digit[1];

  return null;
}

async function forceExpireServer2Order(db, settings, userId, order, reason = 'Pesanan telah expired (15 menit)') {
  const orderId = String(order?.orderId || '');
  if (!orderId) return { canceledAtApi: false, refunded: false };

  let canceledAtApi = false;
  try {
    const cancel = await apiGet('cancel.php', { api_key: settings.jasaOtpApiKey, id: orderId });
    canceledAtApi = cancel?.success === true;
  } catch (e) {}

  const lock = await db.removeOrder(orderId);

  await db.updateOrderHistoryStatus(userId, orderId, 'expired', {
    cancel_reason: `${reason}${canceledAtApi ? ' | canceled_api' : ' | cancel_api_failed'}`
  });

  return { canceledAtApi, refunded: false, removedActiveOrder: Boolean(lock) };
}

function scheduleServer2AutoExpire(bot, db, settings, userId, chatId, orderId, amount) {
  setTimeout(async () => {
    try {
      const ownerId = await db.getOrderOwner(orderId);
      if (!ownerId || String(ownerId) !== String(userId)) return;

      await forceExpireServer2Order(db, settings, userId, { orderId, harga: amount }, 'Pesanan telah expired (timer 15 menit)');
      const saldoBaru = await db.cekSaldo(userId);
      const history = await db.getOrderHistory(userId);
      const orderData = history.find((x) => String(x.orderId) === String(orderId)) || {};

      await bot.sendMessage(chatId,
        `⌛ *PESANAN EXPIRED/HANGUS*

🆔 Order: \`${orderId}\`
🧩 ID Layanan: \`${orderData.layananId || '-'}\`
📱 Layanan: ${orderData.layanan || '-'}
🌐 Negara: ${orderData.negara || '-'}
📞 Nomor: \`${orderData.nomor || '-'}\`
ℹ️ Batas waktu layanan tercapai. Pesanan otomatis dibatalkan.
💰 Refund: ❌ Tidak ada pengembalian saldo
💳 Saldo tersisa: *${formatRupiah(saldoBaru)}*

Terima kasih telah menggunakan layanan kami.`,
        { parse_mode: 'Markdown' }
      ).catch(() => {});
    } catch (e) {}
  }, SERVER2_EXPIRE_MINUTES * 60 * 1000);
}


async function processServer2ExpiryOrder(db, settings, userId, order) {
  return forceExpireServer2Order(db, settings, userId, order, 'Pesanan telah expired (watcher 15 menit)');
}

function startServer2ExpiryWatcher(bot, db, settings) {
  if (global.server2WatcherStarted) return;
  global.server2WatcherStarted = true;

  setInterval(async () => {
    try {
      const allUsers = await db.getAllUsersFull();
      const now = Date.now();

      for (const user of allUsers || []) {
        const userId = String(user._id || '');
        const history = Array.isArray(user.history) ? user.history : [];

        for (const order of history) {
          const isServer2 = String(order?.server || '').toLowerCase() === 'server2';
          const status = String(order?.status || '').toLowerCase();
          if (!isServer2 || status !== 'pending') continue;

          const createdAt = new Date(order?.tanggal || order?.updated_at || 0).getTime();
          if (!createdAt) continue;

          if ((now - createdAt) >= SERVER2_EXPIRE_MINUTES * 60 * 1000) {
            await processServer2ExpiryOrder(db, settings, userId, order);
          }
        }
      }
    } catch (e) {
      console.error('[Server2Watcher] gagal sweep expired:', e.message);
    }
  }, 30000);
}

module.exports = (bot, db, settings, pendingDeposits, query) => {
  if (!query) {
    startServer2ExpiryWatcher(bot, db, settings);
    return;
  }

  const data = query.data || '';
  if (!data.startsWith('order_srv2') &&
      !data.startsWith('s2_page_country:') &&
      !data.startsWith('s2_pick_country:') &&
      !data.startsWith('s2_buy:') &&
      !data.startsWith('ord2_cekotp:') &&
      !data.startsWith('ord2_batal:')) return;

  (async () => {
    const chatId = query.message.chat.id;
    const messageId = query.message.message_id;
    const userId = query.from.id;

    try {
      if (data === 'order_srv2' || data.startsWith('s2_page_country:')) {
        const page = data === 'order_srv2' ? 1 : parseInt(data.split(':')[1], 10) || 1;
        const countries = await getCountries();
        const pageData = buildCountryPage(countries, page);
        await bot.editMessageCaption(pageData.caption, {
          chat_id: chatId,
          message_id: messageId,
          parse_mode: 'Markdown',
          reply_markup: pageData.reply_markup
        });
        await bot.answerCallbackQuery(query.id);
        return;
      }

      if (data.startsWith('s2_pick_country:')) {
        const [, countryId, pageStr] = data.split(':');
        const page = parseInt(pageStr, 10) || 1;
        let services = await getServices(countryId);
        if (!services.length) services = await getServices(countryId, { force: true });
        if (!services.length) {
          await bot.answerCallbackQuery(query.id, {
            text: 'Layanan kosong sementara, coba lagi beberapa detik.',
            show_alert: true
          });
          return;
        }

        const pageData = buildServicePage(countryId, services, page, settings.layananMarkupRate);
        await bot.editMessageCaption(pageData.caption, {
          chat_id: chatId,
          message_id: messageId,
          parse_mode: 'Markdown',
          reply_markup: pageData.reply_markup
        });
        await bot.answerCallbackQuery(query.id);
        return;
      }

      if (data.startsWith('s2_buy:')) {
        const [, countryId, serviceCode] = data.split(':');
        let services = await getServices(countryId);
        if (!services.length) services = await getServices(countryId, { force: true });
        const target = services.find((x) => String(x.code).toLowerCase() === String(serviceCode).toLowerCase());
        if (!target || target.stok <= 0) {
          await bot.answerCallbackQuery(query.id, { text: 'Stok habis.', show_alert: true });
          return;
        }

        const finalPrice = getFinalPrice(target.harga, settings.layananMarkupRate);

        const saldo = await db.cekSaldo(userId);
        if (saldo < finalPrice) {
          await bot.answerCallbackQuery(query.id, { text: `Saldo kurang. Butuh ${formatRupiah(finalPrice)}`, show_alert: true });
          return;
        }

        await bot.answerCallbackQuery(query.id, { text: '⏳ Membuat order...' });

        const operators = await getOperators(countryId);
        const operator = operators.includes('any') ? 'any' : (operators[0] || 'any');

        const order = await apiGet('order.php', {
          api_key: settings.jasaOtpApiKey,
          negara: countryId,
          layanan: target.code,
          operator
        });

        if (!order?.success || !order?.data?.order_id) throw new Error(order?.message || 'Order gagal dibuat.');

        const orderId = String(order.data.order_id);
        await db.kurangSaldo(userId, finalPrice);
        await db.saveOrder(orderId, userId);
        const countries = await getCountries();
        const countryName = countries.find((c) => String(c.id_negara) === String(countryId))?.nama_negara || String(countryId);

        await db.addOrderHistory(userId, {
          orderId,
          layananId: `${target.code}`,
          layanan: `${target.layanan}`,
          nomor: order.data.number,
          harga: finalPrice,
          tanggal: new Date().toISOString(),
          status: 'pending',
          server: 'server2',
          operator,
          negaraId: `${countryId}`,
          negara: capitalizeWords(countryName)
        });

        scheduleServer2AutoExpire(bot, db, settings, userId, chatId, orderId, finalPrice);

        const sisa = await db.cekSaldo(userId);
        await bot.editMessageCaption(
          `✅ *ORDER BERHASIL (SERVER 2)*\n\n🆔 Order: \`${orderId}\`\n📞 Nomor: \`${order.data.number}\`\n📱 Layanan: ${target.layanan}\n🌐 Negara: ${capitalizeWords(countryName)}\n💰 Harga: ${formatRupiah(finalPrice)}\n💳 Saldo: ${formatRupiah(sisa)}`,
          {
            chat_id: chatId,
            message_id: messageId,
            parse_mode: 'Markdown',
            reply_markup: {
              inline_keyboard: [
                [
                  { text: '📩 Cek OTP', callback_data: `ord2_cekotp:${orderId}` },
                  { text: '❌ Batalkan', callback_data: `ord2_batal:${orderId}` }
                ],
                [{ text: '🏠 Menu', callback_data: 'start' }]
              ]
            }
          }
        );

        try {
          const Notifikasi = require('../notifikasi');
          await Notifikasi.orderCreated({
            server: 'Server 2',
            order_id: orderId,
            user_id: userId,
            user_name: query.from.first_name || 'User',
            username: query.from.username || '',
            number: order.data.number,
            layanan: capitalizeWords(target.layanan),
            negara: capitalizeWords(countryName),
            harga_final: finalPrice
          });
        } catch {}

        return;
      }

      if (data.startsWith('ord2_cekotp:')) {
        const orderId = data.split(':')[1];
        const ownerId = await db.getOrderOwner(orderId);
        if (!ownerId || String(ownerId) !== String(userId)) {
          await bot.answerCallbackQuery(query.id, { text: 'Ini bukan order kamu.', show_alert: true });
          return;
        }

        const history = await db.getOrderHistory(userId);
        const orderLocal = history.find((x) => String(x.orderId) === String(orderId));
        const createdAt = new Date(orderLocal?.tanggal || Date.now()).getTime();
        if (Date.now() - createdAt >= SERVER2_EXPIRE_MINUTES * 60 * 1000) {
          await bot.answerCallbackQuery(query.id, { text: '⌛ Pesanan telah expired.', show_alert: true });
          await forceExpireServer2Order(db, settings, userId, orderLocal || { orderId, harga: 0 }, 'Pesanan telah expired saat cek OTP');
          const saldoBaru = await db.cekSaldo(userId);
          const expiredCaption = `⌛ *PESANAN EXPIRED/HANGUS*\n\n` +
            `🆔 Order: \`${orderId}\`\n` +
            `🧩 ID Layanan: \`${orderLocal?.layananId || '-'}\`\n` +
            `📱 Layanan: ${orderLocal?.layanan || '-'}\n` +
            `🌐 Negara: ${orderLocal?.negara || '-'}\n` +
            `📞 Nomor: \`${orderLocal?.nomor || '-'}\`\n` +
            `ℹ️ Batas waktu layanan tercapai. Pesanan otomatis dibatalkan.\n` +
            `💰 Refund: ❌ Tidak ada pengembalian saldo\n` +
            `💳 Saldo tersisa: *${formatRupiah(saldoBaru)}*\n\n` +
            `Terima kasih telah menggunakan layanan kami.`;
          await smartEdit(bot, query, expiredCaption, {
            parse_mode: 'Markdown',
            reply_markup: { inline_keyboard: [[{ text: '🏠 Menu', callback_data: 'start' }]] }
          });
          return;
        }

        const sms = await apiGet('sms.php', { api_key: settings.jasaOtpApiKey, id: orderId });
        const otp = extractOtpValue(sms);

        const createdAt2 = new Date(orderLocal?.tanggal || Date.now()).getTime();
        const elapsedMs = Math.max(0, Date.now() - createdAt2);
        const remainingMs = Math.max(0, SERVER2_EXPIRE_MINUTES * 60 * 1000 - elapsedMs);
        const timeLeftStr = `${Math.ceil(remainingMs / 60000)} Menit`;
        const timeNow = new Date().toLocaleTimeString('id-ID', {
          hour: '2-digit',
          minute: '2-digit',
          second: '2-digit',
          hour12: false,
          timeZone: 'Asia/Jakarta'
        }).replace(/\./g, ':');
        const currentSaldo = await db.cekSaldo(userId);

        if (otp) {
          await db.updateOrderHistoryStatus(userId, orderId, 'success', { otp_code: otp });
          await db.removeOrder(orderId);

          const updateCaption = `✅ *ORDER BERHASIL DIBUAT*\n` +
            `━━━━━━━━━━━━━━━━━━\n` +
            `🆔 Order ID: \`${orderId}\`\n` +
            `📞 Nomor: \`${orderLocal?.nomor || '-'}\`\n` +
            `📱 Layanan: ${orderLocal?.layanan || '-'}\n` +
            `💰 Harga: Rp${Number(orderLocal?.harga || 0).toLocaleString('id-ID')}\n` +
            `━━━━━━━━━━━━━━━━━━\n\n` +
            `🔑 *KODE OTP:* \`${otp}\`\n` +
            `📊 *Status:* ✅ RECEIVED\n\n` +
            `🔄 _Update: ${timeNow} WIB_\n` +
            `💳 Sisa Saldo: *Rp${currentSaldo.toLocaleString('id-ID')}*`;

          await smartEdit(bot, query, updateCaption, {
            parse_mode: 'Markdown',
            reply_markup: { inline_keyboard: [[{ text: '🏠 Menu', callback_data: 'start' }]] }
          });
          await bot.answerCallbackQuery(query.id, { text: `OTP: ${otp}`, show_alert: true });
          return;
        }

        const updateCaption = `✅ *ORDER BERHASIL DIBUAT*\n` +
          `━━━━━━━━━━━━━━━━━━\n` +
          `🆔 Order ID: \`${orderId}\`\n` +
          `📞 Nomor: \`${orderLocal?.nomor || '-'}\`\n` +
          `📱 Layanan: ${orderLocal?.layanan || '-'}\n` +
          `💰 Harga: Rp${Number(orderLocal?.harga || 0).toLocaleString('id-ID')}\n` +
          `━━━━━━━━━━━━━━━━━━\n\n` +
          `🔑 *KODE OTP:* _Menunggu OTP..._\n` +
          `📊 *Status:* ⏳ WAITING\n\n` +
          `⏳ Sisa Waktu: ${timeLeftStr}\n` +
          `🔄 _Update: ${timeNow} WIB_\n` +
          `💳 Sisa Saldo: *Rp${currentSaldo.toLocaleString('id-ID')}*`;

        await smartEdit(bot, query, updateCaption, {
          parse_mode: 'Markdown',
          reply_markup: {
            inline_keyboard: [[
              { text: '📩 Cek OTP', callback_data: `ord2_cekotp:${orderId}` },
              { text: '❌ Batalkan', callback_data: `ord2_batal:${orderId}` }
            ]]
          }
        });

        await bot.answerCallbackQuery(query.id, { text: 'Masih menunggu OTP...' });
        return;
      }

      if (data.startsWith('ord2_batal:')) {
        const orderId = data.split(':')[1];
        const ownerId = await db.getOrderOwner(orderId);
        if (!ownerId || String(ownerId) !== String(userId)) {
          await bot.answerCallbackQuery(query.id, { text: 'Ini bukan order kamu.', show_alert: true });
          return;
        }

        const history = await db.getOrderHistory(userId);
        const orderLocal = history.find((x) => String(x.orderId) === String(orderId));
        const refund = Number(orderLocal?.harga || 0);

        const createdAt = new Date(orderLocal?.tanggal || Date.now()).getTime();
        const minutesRunning = (Date.now() - createdAt) / 60000;
        if (minutesRunning < MIN_CANCEL_MINUTES) {
          await bot.answerCallbackQuery(query.id, {
            text: `Batalkan order bisa setelah ${MIN_CANCEL_MINUTES} menit.`,
            show_alert: true
          });
          return;
        }

        const cancel = await apiGet('cancel.php', { api_key: settings.jasaOtpApiKey, id: orderId });
        if (!cancel?.success) throw new Error(cancel?.message || 'Gagal membatalkan order.');

        const lock = await db.removeOrder(orderId);
        if (lock && refund > 0) {
          await db.markOrderAsRefundedOnce(userId, orderId, 'canceled', { cancel_reason: 'Canceled by user (server2)' });
          await db.tambahSaldo(userId, refund);
        }
        const saldoBaru = await db.cekSaldo(userId);

        await bot.editMessageCaption(
          `❌ *ORDER DIBATALKAN (SERVER 2)*\n\n🆔 Order: \`${orderId}\`\n💰 Refund: ${formatRupiah(refund)}\n💳 Saldo: ${formatRupiah(saldoBaru)}`,
          {
            chat_id: chatId,
            message_id: messageId,
            parse_mode: 'Markdown',
            reply_markup: { inline_keyboard: [[{ text: '🏠 Menu', callback_data: 'start' }]] }
          }
        );
        await bot.answerCallbackQuery(query.id, { text: 'Order dibatalkan.' });
      }

    } catch (e) {
      await bot.answerCallbackQuery(query.id, { text: e.message || 'Terjadi error.', show_alert: true }).catch(() => {});
    }
  })();
};
