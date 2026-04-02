// plugins/ceknegara.js
const axios = require('axios');
const Notifikasi = require('../notifikasi');

// --- KONFIGURASI ---
const ITEMS_PER_PAGE = 20; 
let negaraCache = {}; 
if (!global.cekNegaraListener) global.cekNegaraListener = false;

// Default Photo (Fallback)
const DEFAULT_IMG = "https://img1.pixhost.to/images/10473/665370140_alwayszakzz.jpg";

// --- HELPER ---
const formatRupiah = (angka) => 'Rp' + parseInt(angka).toLocaleString('id-ID');

function getFinalPrice(originalHarga, markupRateString) {
    let markupDecimal = 0;
    try {
        const percentageString = (markupRateString || "0%").replace("%", "");
        const feePercentage = parseFloat(percentageString);
        if (!isNaN(feePercentage)) markupDecimal = feePercentage / 100;
    } catch (e) {}
    return Math.ceil(originalHarga + (originalHarga * markupDecimal));
}

async function fetchCountryData(serviceId, apiKey) {
    if (!apiKey) throw new Error("API Key belum disetting!");
    try {
        const response = await axios.get(`https://www.rumahotp.com/api/v2/countries`, {
            params: { service_id: serviceId },
            headers: { 'x-apikey': apiKey, 'Accept': 'application/json' },
            timeout: 15000 
        });
        if (response.data?.success && Array.isArray(response.data?.data)) {
            return response.data.data;
        } else {
            throw new Error("Data negara kosong.");
        }
    } catch (e) {
        throw new Error(e.response?.data?.message || e.message);
    }
}

// --- GENERATOR TAMPILAN (DUAL LANGUAGE) ---
function generateCountryPage(data, serviceId, page, markupRate) {
    const totalItems = data.length;
    const totalPages = Math.ceil(totalItems / ITEMS_PER_PAGE);
    
    if (page < 1) page = 1;
    if (page > totalPages) page = totalPages;

    const startIndex = (page - 1) * ITEMS_PER_PAGE;
    const pageItems = data.slice(startIndex, startIndex + ITEMS_PER_PAGE);

    // Caption Dual Bahasa
    let caption = `🇮🇩 *PILIH NEGARA*\n` +
               `🆔 ID Layanan: \`${serviceId}\`\n` +
               `📄 Halaman: ${page}/${totalPages} (${totalItems} Negara)\n` +
               `_Harga termurah otomatis ditampilkan._\n` +
               `━━━━━━━━━━━━━━━━━━\n` +
               `🇬🇧 *SELECT COUNTRY*\n` +
               `_Cheapest price is auto-selected._\n` +
               `_Click button to order:_`;

    const inlineKeyboard = [];
    let row = [];

    pageItems.forEach((country) => {
        // [LOGIKA SORTING HARGA TERMURAH]
        const rawPricelist = country.pricelist || [];
        // 1. Ambil yang stok ada
        let availableProviders = rawPricelist.filter(p => p.stock > 0);
        // 2. Urutkan dari termurah (Ascending)
        availableProviders.sort((a, b) => a.price - b.price);

        let label = `🔴 ${country.name}`; // Default Habis
        let callbackData = "noop"; 

        // Ambil provider termurah (index 0)
        if (availableProviders.length > 0) {
            const cheapestProvider = availableProviders[0]; 
            const finalPrice = getFinalPrice(cheapestProvider.price, markupRate);
            
            // Potong nama negara jika terlalu panjang
            let shortName = country.name;
            if (shortName.length > 14) shortName = shortName.substring(0, 12) + '..';
            
            label = `${shortName} - ${formatRupiah(finalPrice)}`;
            callbackData = `buy_neg:${country.iso_code}:${serviceId}`; 
        }

        row.push({ text: label, callback_data: callbackData });
        
        if (row.length === 2) { inlineKeyboard.push(row); row = []; }
    });
    
    if (row.length > 0) inlineKeyboard.push(row);

    const navRow = [];
    if (page > 1) navRow.push({ text: "⬅️ Prev", callback_data: `page_neg:${serviceId}:${page - 1}` });
    // Tombol Kembali dwibahasa
    navRow.push({ text: "🔙 Layanan / Back", callback_data: "lay_page:1" });
    if (page < totalPages) navRow.push({ text: "Next ➡️", callback_data: `page_neg:${serviceId}:${page + 1}` });
    
    inlineKeyboard.push(navRow);

    return { caption, reply_markup: { inline_keyboard: inlineKeyboard } };
}

module.exports = (bot, db, settings) => {
    
    const photoUrl = settings.startMenuPhotoUrl || DEFAULT_IMG;

    if (!global.cekNegaraListener) {
        
        bot.on('callback_query', async (query) => {
            const data = query.data;
            const chatId = query.message.chat.id;
            const messageId = query.message.message_id;
            const userId = query.from.id;

            if (!data.startsWith('page_neg') && !data.startsWith('buy_neg') && !data.startsWith('close_neg')) return;

            try {
                // A. NAVIGASI HALAMAN
                if (data.startsWith('page_neg:')) {
                    const [, serviceId, pageStr] = data.split(':');
                    const newPage = parseInt(pageStr);

                    let cached = negaraCache[userId];
                    
                    if (!cached || cached.serviceId != serviceId) {
                        try {
                            await bot.answerCallbackQuery(query.id, { text: "🔄 Loading data..." });
                            const newData = await fetchCountryData(serviceId, settings.rumahOtpApiKey);
                            negaraCache[userId] = { serviceId, data: newData };
                            cached = negaraCache[userId];
                        } catch (e) {
                             return bot.answerCallbackQuery(query.id, { text: "Error: " + e.message, show_alert: true });
                        }
                    }

                    const pageData = generateCountryPage(cached.data, serviceId, newPage, settings.layananMarkupRate);
                    
                    // Edit Caption (Support Dual Bahasa)
                    if (query.message.photo) {
                        await bot.editMessageCaption(pageData.caption, {
                            chat_id: chatId,
                            message_id: messageId,
                            parse_mode: "Markdown",
                            reply_markup: pageData.reply_markup
                        }).catch(e => {});
                    } else {
                        await bot.deleteMessage(chatId, messageId).catch(()=>{});
                        await bot.sendPhoto(chatId, photoUrl, {
                            caption: pageData.caption,
                            parse_mode: "Markdown",
                            reply_markup: pageData.reply_markup
                        });
                    }
                    await bot.answerCallbackQuery(query.id);
                }

                // B. TUTUP
                else if (data === 'close_neg') {
                    await bot.deleteMessage(chatId, messageId).catch(() => {});
                    delete negaraCache[userId];
                }

                // C. BELI (ORDER)
                else if (data.startsWith('buy_neg:')) {
                    const [, isoCode, serviceId] = data.split(':');
                    
                    let cached = negaraCache[userId];
                    if (!cached) { 
                         try {
                            const newData = await fetchCountryData(serviceId, settings.rumahOtpApiKey);
                            negaraCache[userId] = { serviceId, data: newData };
                            cached = negaraCache[userId];
                        } catch(e) { return bot.answerCallbackQuery(query.id, {text: "Data expired.", show_alert: true}); }
                    }

                    const countryData = cached.data.find(c => c.iso_code === isoCode);
                    if (!countryData) return bot.answerCallbackQuery(query.id, { text: "Negara tidak ditemukan", show_alert: true });

                    // [CONSISTENCY CHECK] Cari provider termurah lagi saat user klik beli
                    // Ini untuk memastikan yang dibeli adalah harga termurah (Rp3.250) bukan default (Rp4.000)
                    const rawPricelist = countryData.pricelist || [];
                    const availableProviders = rawPricelist.filter(p => p.stock > 0);
                    availableProviders.sort((a, b) => a.price - b.price); // SORTING PENTING

                    const providerData = availableProviders[0]; // Ambil yang paling murah
                    
                    if (!providerData) return bot.answerCallbackQuery(query.id, { text: "❌ Stok habis!", show_alert: true });
                    
                    const finalPrice = getFinalPrice(providerData.price, settings.layananMarkupRate);
                    const userSaldo = await db.cekSaldo(userId);

                    if (userSaldo < finalPrice) return bot.answerCallbackQuery(query.id, { text: `Saldo Kurang! Butuh ${formatRupiah(finalPrice)}`, show_alert: true });

                    await bot.answerCallbackQuery(query.id, { text: "⏳ Processing order..." });

                    // -- API ORDER --
                    const orderRes = await axios.get(`https://www.rumahotp.com/api/v2/orders`, {
                        params: { 
                            number_id: countryData.number_id, 
                            provider_id: providerData.provider_id, // Gunakan ID Provider termurah
                            operator_id: 1 
                        },
                        headers: { 'x-apikey': settings.rumahOtpApiKey, 'Accept': 'application/json' }
                    });

                    if (!orderRes.data?.success) throw new Error(orderRes.data?.error?.message || "API Order Failed");

                    const { order_id, phone_number, service, country } = orderRes.data.data;
                    
                    await db.kurangSaldo(userId, finalPrice);
                    await db.saveOrder(order_id, userId);
                    await db.addOrderHistory(userId, { orderId: order_id, layanan: service, nomor: phone_number, harga: finalPrice, tanggal: new Date().toISOString() });

                    const sisaSaldo = await db.cekSaldo(userId);
                    
                    const captionSuccess = `✅ *ORDER SUCCESS / BERHASIL*\n` +
                                       `━━━━━━━━━━━━━━━━━━\n` +
                                       `🆔 Order ID: \`${order_id}\`\n` +
                                       `📱 No: \`${phone_number}\`\n` +
                                       `🏳️ Country: ${country}\n` +
                                       `💰 Price: ${formatRupiah(finalPrice)}\n` +
                                       `💳 Balance: ${formatRupiah(sisaSaldo)}`;

                    if (query.message.photo) {
                        await bot.editMessageCaption(captionSuccess, {
                            chat_id: chatId,
                            message_id: messageId,
                            parse_mode: "Markdown",
                            reply_markup: {
                                inline_keyboard: [[
                                    { text: "📩 Cek SMS/OTP", callback_data: `ord_cekotp:${order_id}` },
                                    { text: "❌ Batalkan / Cancel", callback_data: `ord_batal:${order_id}` }
                                ], [{ text: "🏠 Menu Utama", callback_data: "start" }]]
                            }
                        });
                    }

                    try { await Notifikasi.orderCreated({ order_id, user_id: userId, number: phone_number, harga_final: finalPrice }); } catch {}
                }

            } catch (err) {
                console.error("[CekNegara] Error:", err.message);
                bot.sendMessage(chatId, `<!> Error: ${err.message}`);
            }
        });

        global.cekNegaraListener = true;
    }
};
