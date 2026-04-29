// plugins/orderlayanan.js
const axios = require('axios');
const backKeyboard = require('../utils/backKeyboard');
const Notifikasi = require('../notifikasi');
const moment = require('moment'); 
require('moment/locale/id'); 

// --- KONFIGURASI WAKTU ---
const MIN_CANCEL_MINUTES = 3;  // Minimal 3 menit baru bisa batal
const MAX_EXPIRE_MINUTES = 20; // Expired dalam 20 menit
const REMINDER_BEFORE_EXPIRE_MINUTES = 5; // Kirim pengingat saat sisa 5 menit

async function sendSafeReply(bot, chatId, text, options) {
    try {
        const sentMessage = await bot.sendMessage(chatId, text, options);
        return sentMessage;
    } catch (error) {
        if (error.response && error.response.body.description === 'message to be replied not found') {
            delete options.reply_to_message_id;
            return await bot.sendMessage(chatId, text, options).catch(e => console.error("Gagal kirim fallback:", e));
        }
        return undefined;
    }
}

// Hitung Harga + Markup
function getFinalPrice(originalHarga, markupRateString) {
    let markupDecimal = 0;
    try {
        const percentageString = (markupRateString || "0%").replace("%", "");
        const feePercentage = parseFloat(percentageString);
        if (!isNaN(feePercentage)) markupDecimal = feePercentage / 100;
    } catch (e) {}
    const markupAmount = Math.ceil(originalHarga * markupDecimal);
    return originalHarga + markupAmount;
}

// --- FUNGSI SMART EDIT ---
async function smartEdit(bot, query, text, options) {
    const chatId = query.message.chat.id;
    const messageId = query.message.message_id;
    const opts = { ...options, chat_id: chatId, message_id: messageId };

    try {
        if (query.message.photo) {
            await bot.editMessageCaption(text, opts);
        } else {
            await bot.editMessageText(text, opts);
        }
    } catch (e) {
        if (!e.message.includes('message is not modified')) {
            console.error("[SmartEdit] Gagal:", e.message);
        }
    }
}

// --- FUNGSI REFUND (PENGEMBALIAN DANA) ---
async function processRefund(bot, db, userId, orderId, amount, reason, query, finalStatus = 'canceled') {
    const orderLock = await db.removeOrder(orderId);
    if (!orderLock) {
        await smartEdit(bot, query, `ℹ️ *Order sudah diproses sebelumnya*\n\n🆔 \`${orderId}\``, {
            parse_mode: "Markdown",
            reply_markup: {
                inline_keyboard: [[{ text: "🏠 Menu Utama", callback_data: "start" }]]
            }
        });
        return;
    }

    const refundGranted = await db.markOrderAsRefundedOnce(userId, orderId, finalStatus, {
        cancel_reason: reason
    });

    if (!refundGranted) {
        await smartEdit(bot, query, `ℹ️ *Order sudah direfund sebelumnya*\n\n🆔 \`${orderId}\``, {
            parse_mode: "Markdown",
            reply_markup: {
                inline_keyboard: [[{ text: "🏠 Menu Utama", callback_data: "start" }]]
            }
        });
        return;
    }

    // 1. Kembalikan Saldo (hanya sekali, setelah lock refund didapat)
    await db.tambahSaldo(userId, amount);
    
    const saldoBaru = await db.cekSaldo(userId);

    const msg = `❌ *PESANAN DIBATALKAN/EXPIRED*\n` +
        `━━━━━━━━━━━━━━━━━━\n` +
        `🆔 Order ID: \`${orderId}\`\n` +
        `ℹ️ Alasan: ${reason}\n` +
        `💰 Refund: *Rp${amount.toLocaleString('id-ID')}*\n` +
        `💳 Saldo Sekarang: *Rp${saldoBaru.toLocaleString('id-ID')}*\n` + 
        `━━━━━━━━━━━━━━━━━━\n` +
        `_Dana telah dikembalikan ke saldo akun Anda._`;

    // 3. Update Pesan -> TAMPILKAN TOMBOL MENU UTAMA (UNLOCK)
    await smartEdit(bot, query, msg, {
        parse_mode: "Markdown",
        reply_markup: {
            inline_keyboard: [[ { text: "🏠 Menu Utama", callback_data: "start" } ]]
        }
    });
}

async function processExpiredWithoutRefund(bot, db, userId, orderId, reason, query) {
    const orderLock = await db.removeOrder(orderId);
    if (!orderLock) {
        await smartEdit(bot, query, `ℹ️ *Order sudah diproses sebelumnya*\n\n🆔 \`${orderId}\``, {
            parse_mode: "Markdown",
            reply_markup: {
                inline_keyboard: [[{ text: "🏠 Menu Utama", callback_data: "start" }]]
            }
        });
        return;
    }

    await db.updateOrderHistoryStatus(userId, orderId, 'expired', {
        cancel_reason: reason
    });

    const saldoBaru = await db.cekSaldo(userId);
    const history = await db.getOrderHistory(userId);
    const orderData = history.find(h => String(h.orderId) === String(orderId)) || {};

    const msg = `⌛ *PESANAN EXPIRED/HANGUS*\n\n` +
        `🆔 Order: \`${orderId}\`\n` +
        `🧩 ID Layanan: \`${orderData.layananId || '-'}\`\n` +
        `📱 Layanan: ${orderData.layanan || '-'}\n` +
        `🌐 Negara: ${orderData.negara || '-'}\n` +
        `📞 Nomor: \`${orderData.nomor || '-'}\`\n` +
        `ℹ️ Batas waktu layanan tercapai. Pesanan otomatis dibatalkan.\n` +
        `💰 Refund: ❌ Tidak ada pengembalian saldo\n` +
        `💳 Saldo tersisa: *Rp${saldoBaru.toLocaleString('id-ID')}*\n\n` +
        `Terima kasih telah menggunakan layanan kami\\.`;

    await smartEdit(bot, query, msg, {
        parse_mode: "Markdown",
        reply_markup: {
            inline_keyboard: [[ { text: "🏠 Menu Utama", callback_data: "start" } ]]
        }
    });
}

function scheduleOrderExpiryReminder(bot, db, userId, chatId, orderId) {
    const reminderDelayMs = (MAX_EXPIRE_MINUTES - REMINDER_BEFORE_EXPIRE_MINUTES) * 60 * 1000;

    setTimeout(async () => {
        try {
            const ownerId = await db.getOrderOwner(orderId);
            if (!ownerId || ownerId.toString() !== userId.toString()) return; // Sudah selesai / bukan aktif

            const history = await db.getOrderHistory(userId);
            const orderData = history.find(h => String(h.orderId) === String(orderId));
            if (!orderData) return;

            const status = String(orderData.status || '').toLowerCase();
            if (status && status !== 'pending') return;

            const reminderMsg = `⏰ *PENGINGAT ORDER*\n` +
                `Order ID: \`${orderId}\`\n` +
                `Status: ⏳ *PENDING*\n\n` +
                `Sisa waktu sekitar *${REMINDER_BEFORE_EXPIRE_MINUTES} menit* sebelum order expired \\(total ${MAX_EXPIRE_MINUTES} menit\\)\\.\n` +
                `Silakan cek OTP sekarang atau batalkan jika diperlukan\\.`;

            await bot.sendMessage(chatId, reminderMsg, {
                parse_mode: "MarkdownV2",
                reply_markup: {
                    inline_keyboard: [[
                        { text: "📩 Cek OTP", callback_data: `ord_cekotp:${orderId}` },
                        { text: "❌ Batalkan", callback_data: `ord_batal:${orderId}` }
                    ]]
                }
            });
        } catch (err) {
            console.error(`[Reminder] Gagal kirim pengingat order ${orderId}:`, err.message);
        }
    }, reminderDelayMs);
}

// --- HANDLE TOMBOL CEK OTP / BATAL ---
async function handleOrderCallback(bot, db, settings, query) {
    const data = query.data;
    const userId = query.from.id;
    const orderId = data.split(':')[1];
    const getHeaders = () => ({ 'x-apikey': settings.rumahOtpApiKey, 'Accept': 'application/json' });

    try {
        const ownerId = await db.getOrderOwner(orderId);
        if (!ownerId || ownerId.toString() !== userId.toString()) {
            await bot.answerCallbackQuery(query.id, { text: '❌ Anda bukan pemilik order ini.', show_alert: true });
            return;
        }

        const history = await db.getOrderHistory(userId);
        const orderData = history.find(h => h.orderId.toString() === orderId);

        if (!orderData) {
            await bot.answerCallbackQuery(query.id, { text: "Data order hilang dari database.", show_alert: true });
            return;
        }

        // Hitung Waktu Berjalan
        const orderTime = moment(orderData.tanggal);
        const now = moment();
        const durationMinutes = moment.duration(now.diff(orderTime)).asMinutes();
        
        // --- 1. TOMBOL CEK OTP ---
        if (data.startsWith('ord_cekotp:')) {
            
            // A. LOGIKA AUTO-EXPIRED LOKAL
            if (durationMinutes >= MAX_EXPIRE_MINUTES) {
                await bot.answerCallbackQuery(query.id, { text: "⌛ Pesanan telah expired.", show_alert: true });
                try {
                    await axios.get(`https://www.rumahotp.io/api/v1/orders/set_status`, {
                        params: { order_id: orderId, status: 'cancel' },
                        headers: getHeaders()
                    });
                } catch (err) {}
                await processExpiredWithoutRefund(bot, db, userId, orderId, "Waktu Habis (Expired)", query);
                return; 
            }

            // B. CEK STATUS KE API
            const res = await axios.get(`https://www.rumahotp.io/api/v1/orders/get_status`, {
                params: { order_id: orderId },
                headers: getHeaders()
            });
            const dataRes = res.data;

            if (!dataRes.success || !dataRes.data) throw new Error(dataRes.message || "Gagal ambil data API.");

            const apiData = dataRes.data; 
            const otp = apiData.otp_code;
            const status = (apiData.status || '').toLowerCase(); 

            // C. LOGIKA STATUS
            if (status === 'canceled') {
                await bot.answerCallbackQuery(query.id, { text: "❌ Order dibatalkan server, memproses refund...", show_alert: true });
                await processRefund(bot, db, userId, orderId, orderData.harga, "Dibatalkan Server", query, 'canceled');
                return;

            } else if (status === 'expired') {
                await bot.answerCallbackQuery(query.id, { text: "⌛ Pesanan telah expired.", show_alert: true });
                await processExpiredWithoutRefund(bot, db, userId, orderId, "Expired dari Server", query);
                return;
            
            } else if (otp && otp !== '-' && (status === 'received' || status === 'completed')) {
                // [FIX] JIKA SUKSES -> GANTI TOMBOL JADI MENU UTAMA
                await db.updateOrderHistoryStatus(userId, orderId, 'success', { otp_code: otp });
                await db.removeOrder(orderId);
                await bot.answerCallbackQuery(query.id, { text: `OTP: ${otp}`, show_alert: true });
                
                const currentSaldo = await db.cekSaldo(userId);
                let newCaption = `✅ *ORDER BERHASIL*\n` +
                    `━━━━━━━━━━━━━━━━━━\n` +
                    `🆔 Order ID: \`${orderId}\`\n` +
                    `📞 Nomor: \`${orderData.nomor}\`\n` +
                    `📱 Layanan: ${orderData.layanan}\n` +
                    `💰 Harga: Rp${orderData.harga.toLocaleString('id-ID')}\n` +
                    `━━━━━━━━━━━━━━━━━━\n\n` +
                    `🔑 *KODE OTP:* \`${otp}\`\n` +
                    `📊 *Status:* ✅ SUKSES\n\n` +
                    `💳 Sisa Saldo: *Rp${currentSaldo.toLocaleString('id-ID')}*`;

                await smartEdit(bot, query, newCaption, {
                    parse_mode: "Markdown",
                    reply_markup: {
                        inline_keyboard: [[ { text: "🏠 Menu Utama", callback_data: "start" } ]]
                    }
                });
            
            } else {
                 await db.updateOrderHistoryStatus(userId, orderId, 'pending');
                 // [FIX] JIKA WAITING -> TOMBOL TETAP TERKUNCI
                 const sisaMenit = Math.max(0, MAX_EXPIRE_MINUTES - durationMinutes);
                 const sisaDetik = Math.floor((sisaMenit * 60) % 60);
                 const sisaMenitBulat = Math.floor(sisaMenit);
                 
                 await bot.answerCallbackQuery(query.id, { 
                     text: `⏳ Sisa Waktu: ${sisaMenitBulat}m ${sisaDetik}s\n🔄 Menunggu OTP...` 
                 });

                 const timeNow = moment().utcOffset('+07:00').locale('id').format('HH:mm:ss');
                 const currentSaldo = await db.cekSaldo(userId);
                 const timeLeftStr = sisaMenit > 0 ? `${sisaMenitBulat} Menit` : "Expired Check...";

                 let updateCaption = `✅ *ORDER BERHASIL DIBUAT*\n` +
                    `━━━━━━━━━━━━━━━━━━\n` +
                    `🆔 Order ID: \`${orderId}\`\n` +
                    `📞 Nomor: \`${orderData.nomor}\`\n` +
                    `📱 Layanan: ${orderData.layanan}\n` +
                    `💰 Harga: Rp${orderData.harga.toLocaleString('id-ID')}\n` +
                    `━━━━━━━━━━━━━━━━━━\n\n` +
                    `🔑 *KODE OTP:* _Menunggu OTP..._\n` +
                    `📊 *Status:* ⏳ WAITING\n\n` +
                    `⏳ Sisa Waktu: ${timeLeftStr}\n` +
                    `🔄 _Update: ${timeNow} WIB_\n` +
                    `💳 Sisa Saldo: *Rp${currentSaldo.toLocaleString('id-ID')}*`;

                 await smartEdit(bot, query, updateCaption, {
                    parse_mode: "Markdown",
                    // TOMBOL TERKUNCI (LOCK)
                    reply_markup: {
                        inline_keyboard: [[
                            { text: "📩 Cek OTP", callback_data: `ord_cekotp:${orderId}` },
                            { text: "❌ Batalkan", callback_data: `ord_batal:${orderId}` }
                        ]]
                    }
                });
            }
        }

        // --- 2. TOMBOL BATALKAN ---
        if (data.startsWith('ord_batal:')) {
            if (durationMinutes < MIN_CANCEL_MINUTES) {
                const sisaTunggu = (MIN_CANCEL_MINUTES - durationMinutes) * 60; 
                const sisaMenitTunggu = Math.floor(sisaTunggu / 60);
                const sisaDetikTunggu = Math.floor(sisaTunggu % 60);
                return bot.answerCallbackQuery(query.id, { 
                    text: `⚠️ Tunggu sebentar!\nAnda baru bisa membatalkan setelah 3 menit.\n⏳ Sisa tunggu: ${sisaMenitTunggu}m ${sisaDetikTunggu}d`, 
                    show_alert: true 
                });
            }
            await bot.answerCallbackQuery(query.id, { text: "⏳ Membatalkan pesanan..." });
            
            const cancelRes = await axios.get(`https://www.rumahotp.io/api/v1/orders/set_status`, {
                params: { order_id: orderId, status: 'cancel' },
                headers: getHeaders()
            });
            const resData = cancelRes.data;

            if (!resData.success) {
                 const errMsg = resData.message || resData.error?.message || "Gagal cancel.";
                 return bot.answerCallbackQuery(query.id, { text: `❌ Gagal: ${errMsg}`, show_alert: true });
            }

            await processRefund(bot, db, userId, orderId, orderData.harga, "Canceled by User", query, 'canceled');
        }
    } catch (e) {
        console.error("Callback Error:", e);
        await bot.answerCallbackQuery(query.id, { text: `Error sistem: ${e.message}`, show_alert: true });
    }
}


module.exports = (bot, db, settings, pendingDeposits, query) => {
    const getHeaders = () => ({ 'x-apikey': settings.rumahOtpApiKey, 'Accept': 'application/json' });

    if (query) {
        const data = (query.data || '').toLowerCase();
        
        if (data === 'order' || data === 'orderlayanan') {
            const chatId = query.message.chat.id;
            const caption = `🛒 *ORDER LAYANAN OTP*\n\n` +
                `Gunakan tombol menu interaktif untuk kemudahan transaksi.\n` +
                `Atau gunakan format manual:\n\n` +
                `\`/order <KodeNegara> <IDLayanan>\`\n` +
                `Contoh: \`/order id 1\`\n\n` +
                `_Tekan tombol di bawah untuk kembali._`;

            smartEdit(bot, query, caption, {
                parse_mode: "Markdown",
                disable_web_page_preview: true,
                reply_markup: backKeyboard()
            });
            return;
        }
        
        if (data.startsWith('ord_cekotp:') || data.startsWith('ord_batal:')) {
            handleOrderCallback(bot, db, settings, query);
            return;
        }
        return;
    }

    // --- LOGIKA MANUAL ---
    bot.onText(/\/order$/, async (msg) => {
        const chatId = msg.chat.id;
        await sendSafeReply(bot, chatId, "⚠️ *Format Salah*\nContoh: `/order id 1`", { parse_mode: "Markdown" });
    });

    bot.onText(/\/order (\S+) (\d+)(?: (\d+))?/, async (msg, match) => {
        const chatId = msg.chat.id;
        const msgId = msg.message_id;
        const userId = msg.from.id;
        const countryInput = match[1].toLowerCase(); 
        const serviceId = match[2];
        const operatorId = match[3] || "1";

        const waitMsg = await sendSafeReply(bot, chatId, `⏳ Mengecek ketersediaan...`, { reply_to_message_id: msgId });
        if (!waitMsg) return;

        try {
            const countryRes = await axios.get(`https://www.rumahotp.io/api/v2/countries`, { params: { service_id: serviceId }, headers: getHeaders() });
            if (!countryRes.data.success || !countryRes.data.data) throw new Error("API Error / Data Kosong");

            const targetCountry = countryRes.data.data.find(c => c.iso_code.toLowerCase() === countryInput || c.name.toLowerCase() === countryInput);
            if (!targetCountry) throw new Error(`Negara tidak ditemukan.`);

            const providerData = targetCountry.pricelist.find(p => p.stock > 0) || targetCountry.pricelist[0];
            const finalHarga = getFinalPrice(providerData.price, settings.layananMarkupRate);
            const userSaldo = await db.cekSaldo(userId);

            if (userSaldo < finalHarga) throw new Error(`Saldo kurang. Butuh Rp${finalHarga.toLocaleString()}`);

            const orderRes = await axios.get(`https://www.rumahotp.io/api/v2/orders`, {
                params: { number_id: targetCountry.number_id, provider_id: providerData.provider_id, operator_id: operatorId },
                headers: getHeaders()
            });

            if (!orderRes.data.success) throw new Error(orderRes.data.error?.message || "Gagal Order.");
            const { order_id, phone_number, service, country } = orderRes.data.data;

            await db.kurangSaldo(userId, finalHarga);
            await db.saveOrder(order_id, userId);
            await db.addOrderHistory(userId, {
                orderId: order_id,
                layananId: serviceId,
                layanan: service,
                negara: country,
                nomor: phone_number,
                harga: finalHarga,
                tanggal: new Date().toISOString(),
                status: 'pending'
            });
            scheduleOrderExpiryReminder(bot, db, userId, chatId, order_id);

            const newSaldo = await db.cekSaldo(userId);
            const successMsg = `✅ *ORDER BERHASIL*\n\n` +
                `ID: \`${order_id}\`\n` +
                `No: \`${phone_number}\`\n` +
                `Svc: ${service} (${country})\n` +
                `Harga: Rp${finalHarga.toLocaleString('id-ID')}\n` +
                `Sisa Saldo: Rp${newSaldo.toLocaleString('id-ID')}`;

            // [PENTING] TOMBOL AWAL (TERKUNCI)
            await bot.editMessageText(successMsg, {
                chat_id: chatId,
                message_id: waitMsg.message_id,
                parse_mode: "Markdown",
                reply_markup: {
                    inline_keyboard: [[
                        { text: "📩 Cek OTP", callback_data: `ord_cekotp:${order_id}` },
                        { text: "❌ Batalkan", callback_data: `ord_batal:${order_id}` }
                    ]]
                }
            });

            try {
                await Notifikasi.orderCreated({
                    order_id,
                    user_id: userId,
                    user_name: msg.from.first_name || "User",
                    username: msg.from.username || "",
                    number: phone_number,
                    layanan: service,
                    negara: country,
                    harga_final: finalHarga,
                    server: 'Server 1'
                });
            } catch {}

        } catch (error) {
            await bot.editMessageText(`❌ Gagal: ${error.message}`, { chat_id: chatId, message_id: waitMsg.message_id });
        }
    });
};
