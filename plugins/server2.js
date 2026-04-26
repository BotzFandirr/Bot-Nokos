const axios = require('axios');

const BASE_URL = 'https://api.jasaotp.id/v1';
const ITEMS_PER_PAGE = 20;
const SERVER2_EXPIRE_MINUTES = 15;

if (!global.server2Cache) {
  global.server2Cache = {
    countries: null,
    servicesByCountry: {},
    operatorsByCountry: {}
  };
}

const formatRupiah = (n) => `Rp${parseInt(n || 0, 10).toLocaleString('id-ID')}`;

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
  const bucket = raw?.[String(countryId)] || {};
  const list = Object.entries(bucket).map(([code, v]) => ({
    code,
    harga: Number(v?.harga || 0),
    stok: Number(v?.stok || 0),
    layanan: v?.layanan || code
  }));

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

async function getServices(countryId) {
  if (global.server2Cache.servicesByCountry[countryId]) return global.server2Cache.servicesByCountry[countryId];
  const data = await apiGet('layanan.php', { negara: countryId });
  const list = normalizeServices(data, countryId);
  global.server2Cache.servicesByCountry[countryId] = list;
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

function buildServicePage(countryId, services, page = 1) {
  const totalPages = Math.max(1, Math.ceil(services.length / ITEMS_PER_PAGE));
  const cur = Math.min(Math.max(page, 1), totalPages);
  const start = (cur - 1) * ITEMS_PER_PAGE;
  const items = services.slice(start, start + ITEMS_PER_PAGE);

  const kb = [];
  let row = [];
  for (const s of items) {
    let label = `${s.layanan} (${formatRupiah(s.harga)})`;
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

function scheduleServer2AutoExpire(bot, db, settings, userId, chatId, orderId, amount) {
  setTimeout(async () => {
    try {
      const ownerId = await db.getOrderOwner(orderId);
      if (!ownerId || String(ownerId) !== String(userId)) return;

      const cancel = await apiGet('cancel.php', { api_key: settings.jasaOtpApiKey, id: orderId });
      if (!cancel?.success) return;

      const lock = await db.removeOrder(orderId);
      if (!lock) return;

      await db.markOrderAsRefundedOnce(userId, orderId, 'expired', { cancel_reason: 'Auto expired 15 menit (server2)' });
      await db.tambahSaldo(userId, amount);
      const saldoBaru = await db.cekSaldo(userId);

      await bot.sendMessage(chatId,
        `⌛ *AUTO EXPIRED SERVER 2*\n\n🆔 Order: \`${orderId}\`\nℹ️ Batas bot 15 menit tercapai, order dibatalkan otomatis.\n💰 Refund: ${formatRupiah(amount)}\n💳 Saldo: ${formatRupiah(saldoBaru)}`,
        { parse_mode: 'Markdown' }
      ).catch(() => {});
    } catch (e) {}
  }, SERVER2_EXPIRE_MINUTES * 60 * 1000);
}

module.exports = (bot, db, settings, pendingDeposits, query) => {
  if (!query) return;

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
        const services = await getServices(countryId);
        const pageData = buildServicePage(countryId, services, page);
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
        const services = await getServices(countryId);
        const target = services.find((x) => x.code === serviceCode);
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
          layanan: serviceCode,
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
          layanan: `${target.layanan}`,
          nomor: order.data.number,
          harga: finalPrice,
          tanggal: new Date().toISOString(),
          status: 'pending',
          server: 'server2',
          operator,
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
          await bot.answerCallbackQuery(query.id, { text: 'Order expired 15 menit, auto cancel...', show_alert: true });
          const cancel = await apiGet('cancel.php', { api_key: settings.jasaOtpApiKey, id: orderId });
          if (cancel?.success) {
            const lock = await db.removeOrder(orderId);
            if (lock) {
              const refund = Number(orderLocal?.harga || 0);
              await db.markOrderAsRefundedOnce(userId, orderId, 'expired', { cancel_reason: 'Auto expired 15 menit saat cek otp' });
              await db.tambahSaldo(userId, refund);
            }
          }
          return;
        }

        const sms = await apiGet('sms.php', { api_key: settings.jasaOtpApiKey, id: orderId });
        const otp = sms?.data?.otp;

        if (otp && otp !== 'Menunggu') {
          await db.updateOrderHistoryStatus(userId, orderId, 'success', { otp_code: otp });
          await db.removeOrder(orderId);
          await bot.editMessageCaption(
            `✅ *OTP DITERIMA (SERVER 2)*\n\n🆔 Order: \`${orderId}\`\n🔑 OTP: \`${otp}\``,
            {
              chat_id: chatId,
              message_id: messageId,
              parse_mode: 'Markdown',
              reply_markup: { inline_keyboard: [[{ text: '🏠 Menu', callback_data: 'start' }]] }
            }
          );
          await bot.answerCallbackQuery(query.id, { text: `OTP: ${otp}`, show_alert: true });
          return;
        }

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

        const cancel = await apiGet('cancel.php', { api_key: settings.jasaOtpApiKey, id: orderId });
        if (!cancel?.success) throw new Error(cancel?.message || 'Gagal membatalkan order.');
        const refundedApi = Number(cancel?.data?.refunded_amount || 0);

        const lock = await db.removeOrder(orderId);
        if (lock && refund > 0) {
          await db.markOrderAsRefundedOnce(userId, orderId, 'canceled', { cancel_reason: 'Canceled by user (server2)' });
          await db.tambahSaldo(userId, refund);
        }
        const saldoBaru = await db.cekSaldo(userId);

        await bot.editMessageCaption(
          `❌ *ORDER DIBATALKAN (SERVER 2)*\n\n🆔 Order: \`${orderId}\`\n🏦 Refund API: ${formatRupiah(refundedApi)}\n💰 Refund User: ${formatRupiah(refund)}\n💳 Saldo: ${formatRupiah(saldoBaru)}`,
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
