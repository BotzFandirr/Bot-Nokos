// plugins/ceklayanan.js
const axios = require('axios');

// --- KONFIGURASI ---
const ITEMS_PER_PAGE = 20; 

// [FIX] Global Cache
if (!global.layananCache) global.layananCache = {}; 

const DEFAULT_IMG = "https://img1.pixhost.to/images/10473/665370140_alwayszakzz.jpg";

// --- TEKS PANDUAN (HALAMAN 1 - INDO) ---
const GUIDE_ID = 
`🇮🇩 *PANDUAN ORDER (INDONESIA)*
━━━━━━━━━━━━━━━━━━
1️⃣ *Pilih Layanan*
Pilih aplikasi yang kamu butuhkan di menu layanan.

2️⃣ *Pilih Negara & Harga*
Pilih negara. Harga termurah otomatis ditampilkan di tombol.

3️⃣ *Order & Verifikasi*
Klik negara -> Saldo terpotong -> Nomor muncul. Masukkan nomor ke aplikasi tujuan.

4️⃣ *Cek OTP*
Setelah minta OTP di aplikasi, klik tombol *📩 Cek OTP*.
⏳ _Estimasi: 1 - 10 Menit._
⚠️ _Masa aktif 20 menit. Jangan sampai hangus!_

5️⃣ *Refund & Batal*
OTP tidak masuk > 3 menit? Klik *❌ Batalkan*. Saldo kembali 100%.

📺 *Tutorial:* https://youtu.be/uL75AsQryZg?si=scfQtEV9gChyaJWi
📞 *Support:* @AlwaysZakzz`;

// --- TEKS PANDUAN (HALAMAN 2 - ENGLISH) ---
const GUIDE_EN = 
`🇬🇧 *ORDER GUIDE (ENGLISH)*
━━━━━━━━━━━━━━━━━━
1️⃣ *Select Service*
Choose the app you need from the dashboard.

2️⃣ *Select Country*
Pick a country. Cheapest price is auto-selected.

3️⃣ *Order & Verify*
Click country -> Balance deducted -> Number appears. Input number into the app.

4️⃣ *Check OTP*
After requesting OTP in the app, click *📩 Check OTP*.
⏳ _Estimate: 1 - 10 Mins._
⚠️ _Active time: 20 mins. Don't let it expire!_

5️⃣ *Refund & Cancel*
No OTP after 3 mins? Click *❌ Cancel*. 100% instant refund.

📺 *Tutorial:* https://youtu.be/uL75AsQryZg?si=scfQtEV9gChyaJWi
📞 *Support:* @AlwaysZakzz`;

// --- HELPER FETCH ---
async function fetchServices(settings) {
    const instance = axios.create({ timeout: 10000 });
    const apiUrl = `https://www.rumahotp.com/api/v2/services`;
    const response = await instance.get(apiUrl, { 
        headers: { 'x-apikey': settings.rumahOtpApiKey, 'Accept': 'application/json' }
    });
    
    if (!response.data?.success || !Array.isArray(response.data?.data)) {
        throw new Error("Gagal mengambil data layanan dari API.");
    }
    return response.data.data;
}

// --- GENERATOR TAMPILAN LAYANAN ---
function generateLayananPage(servicesData, currentPage = 1) {
    const totalItems = servicesData.length;
    const totalPages = Math.ceil(totalItems / ITEMS_PER_PAGE);

    if (currentPage < 1) currentPage = 1;
    if (currentPage > totalPages) currentPage = totalPages;

    const startIndex = (currentPage - 1) * ITEMS_PER_PAGE;
    const pageItems = servicesData.slice(startIndex, startIndex + ITEMS_PER_PAGE);

    let caption = `🇮🇩 *PILIH LAYANAN*\n` +
                  `Silakan pilih layanan yang ingin Anda pesan:\n\n` +
                  `📄 Halaman: ${currentPage}/${totalPages}\n` +
                  `📊 Total: ${totalItems} Layanan Tersedia\n` +
                  `━━━━━━━━━━━━━━━━━━\n` +
                  `🇬🇧 *PICK YOUR SERVICE*\n` +
                  `Browse and select the specific app you need:\n\n` +
                  `📄 Page: ${currentPage}/${totalPages}\n` +
                  `📊 Total: ${totalItems} Services Available`;

    const inlineKeyboard = [];
    let row = [];

    pageItems.forEach((s) => {
        const callbackData = `page_neg:${s.service_code}:1`;
        let label = s.service_name;
        if (label.length > 15) label = label.substring(0, 13) + '..';
        row.push({ text: label, callback_data: callbackData });
        if (row.length === 2) { inlineKeyboard.push(row); row = []; }
    });
    if (row.length > 0) inlineKeyboard.push(row);

    const navRow = [];
    if (currentPage > 1) navRow.push({ text: "⬅️ Prev", callback_data: `lay_page:${currentPage - 1}` });
    navRow.push({ text: "🏠 Menu", callback_data: `start` });
    if (currentPage < totalPages) navRow.push({ text: "Next ➡️", callback_data: `lay_page:${currentPage + 1}` });

    inlineKeyboard.push(navRow);
    
    // Arahkan ke Halaman 1 Panduan
    inlineKeyboard.push([{ text: "📚 Panduan / Guide", callback_data: "lay_page:guide:1" }]);

    return { caption, reply_markup: { inline_keyboard: inlineKeyboard } };
}

// --- GENERATOR TAMPILAN PANDUAN (PAGING) ---
function generateGuidePage(page) {
    let caption = "";
    const buttons = [];

    if (page === 1) {
        caption = GUIDE_ID;
        // Tombol Next ke Inggris
        buttons.push([{ text: "🇬🇧 English Guide ➡️", callback_data: "lay_page:guide:2" }]);
    } else {
        caption = GUIDE_EN;
        // Tombol Prev ke Indo
        buttons.push([{ text: "⬅️ Panduan Indo 🇮🇩", callback_data: "lay_page:guide:1" }]);
    }

    // Tombol Kembali ke Layanan
    buttons.push([{ text: "🔙 Kembali / Back", callback_data: "lay_page:1" }]);

    return { caption, reply_markup: { inline_keyboard: buttons } };
}

module.exports = (bot, db, settings, pendingDeposits, query) => {
    
    const photoUrl = settings.startMenuPhotoUrl || DEFAULT_IMG;

    // 1. HANDLE CALLBACK (Tombol)
    if (query) {
        const data = query.data;
        if (!data.startsWith('lay_page:') && !data.startsWith('lay_close') && data !== 'order') return;

        (async () => {
            const chatId = query.message.chat.id;
            const messageId = query.message.message_id;
            const userId = query.from.id;

            try {
                // Indikator Loading
                if (data === 'order') {
                    await bot.answerCallbackQuery(query.id, { text: "⏳ Loading..." });
                    if (query.message.photo) {
                         await bot.editMessageCaption("⏳ *Loading data...*", {
                            chat_id: chatId, message_id: messageId, parse_mode: "Markdown"
                         }).catch(()=>{});
                    }
                }

                // [LOGIKA PANDUAN DENGAN HALAMAN]
                if (data.startsWith('lay_page:guide')) {
                    // Format callback: lay_page:guide:1 atau lay_page:guide:2
                    const parts = data.split(':');
                    const guidePage = parts[2] ? parseInt(parts[2]) : 1; // Default ke hal 1

                    const guideData = generateGuidePage(guidePage);

                    await bot.editMessageCaption(guideData.caption, {
                        chat_id: chatId,
                        message_id: messageId,
                        parse_mode: "Markdown",
                        disable_web_page_preview: true,
                        reply_markup: guideData.reply_markup
                    });
                    await bot.answerCallbackQuery(query.id);
                    return; // Stop di sini
                }

                let page = 1;
                // Parse halaman layanan biasa
                if (data.startsWith('lay_page:')) {
                    const param = data.split(':')[1];
                    // Pastikan bukan 'guide' (sudah dihandle diatas)
                    if (param !== 'guide') page = parseInt(param);
                }

                // Cek Cache
                if (!global.layananCache[userId]) {
                    try {
                        const services = await fetchServices(settings);
                        global.layananCache[userId] = { data: services };
                    } catch (e) {
                        const errMsg = `<!> Error: ${e.message}`;
                        await bot.answerCallbackQuery(query.id, { text: "Failed to load data", show_alert: true });
                        
                        if (data === 'order') {
                             await bot.editMessageCaption(errMsg, {
                                chat_id: chatId, message_id: messageId, parse_mode: "Markdown",
                                reply_markup: { inline_keyboard: [[{ text: "🏠 Menu", callback_data: "start" }]] }
                             });
                        }
                        return;
                    }
                }

                const pageData = generateLayananPage(global.layananCache[userId].data, page);

                // Update Tampilan
                if (query.message.photo) {
                    await bot.editMessageCaption(pageData.caption, {
                        chat_id: chatId,
                        message_id: messageId,
                        parse_mode: "Markdown",
                        reply_markup: pageData.reply_markup
                    });
                } else {
                    await bot.deleteMessage(chatId, messageId).catch(()=>{});
                    await bot.sendPhoto(chatId, photoUrl, {
                        caption: pageData.caption,
                        parse_mode: "Markdown",
                        reply_markup: pageData.reply_markup
                    });
                }
                
                await bot.answerCallbackQuery(query.id);

            } catch (e) {
                console.error("CekLayanan Error:", e.message);
                await bot.answerCallbackQuery(query.id, { text: "System Error", show_alert: true });
            }
        })();
        return;
    }

    // 2. HANDLE COMMAND /ceklayanan (Manual)
    if (!global.ceklayananListener) {
        bot.onText(/\/ceklayanan$/, async (msg) => {
            const chatId = msg.chat.id;
            const userId = msg.from.id;

            const waitMsg = await bot.sendMessage(chatId, "⏳ *Loading...*", { parse_mode: "Markdown" });

            try {
                if (!global.layananCache[userId]) {
                     const services = await fetchServices(settings);
                     global.layananCache[userId] = { data: services };
                }

                const pageData = generateLayananPage(global.layananCache[userId].data, 1);

                await bot.deleteMessage(chatId, waitMsg.message_id).catch(()=>{});
                await bot.sendPhoto(chatId, photoUrl, {
                    caption: pageData.caption,
                    parse_mode: "Markdown",
                    reply_markup: pageData.reply_markup
                });

            } catch (error) {
                await bot.editMessageText(`❌ Error: ${error.message}`, { chat_id: chatId, message_id: waitMsg.message_id });
            }
        });

        global.ceklayananListener = true;
    }
};
