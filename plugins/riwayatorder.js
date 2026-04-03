// plugins/riwayatorder.js

const moment = require('moment'); 
require('moment/locale/id'); 
const axios = require('axios');

// LIMIT: 10 Transaksi per halaman
const ITEMS_PER_PAGE = 10; 

let riwayatCache = {};

// ===== HELPER FUNCTIONS =====

// 1. Format Status
function formatStatus(status) {
    if (!status) return "⏳ Pending";
    const s = String(status).toLowerCase();
    
    if (s === 'success' || s === 'berhasil' || s === 'completed' || s === 'received') return "✅ Sukses";
    if (s.includes('process') || s.includes('wait') || s.includes('pending')) return "⏳ Pending";
    if (s.includes('cancel') || s.includes('dibatalkan') || s.includes('refund')) return "❌ Dibatalkan";
    if (s.includes('expired') || s.includes('expir') || s.includes('timeout')) return "⚠️ Expired";
    
    return `❓ ${status.toUpperCase()}`;
}

// 2. Helper Kapitalisasi
function capitalize(str) {
    if (!str) return "";
    return str.charAt(0).toUpperCase() + str.slice(1);
}

// 3. Generate Halaman (Text & Buttons)
function generateRiwayatPage(allLines, userId, currentPage = 1) {
    const totalItems = allLines.length;
    const totalPages = Math.ceil(totalItems / ITEMS_PER_PAGE);

    if (currentPage < 1) currentPage = 1;
    if (currentPage > totalPages && totalPages > 0) currentPage = totalPages;

    const startIndex = (currentPage - 1) * ITEMS_PER_PAGE;
    const endIndex = startIndex + ITEMS_PER_PAGE;
    const pageLines = allLines.slice(startIndex, endIndex);

    let content = `📜 *RIWAYAT PESANAN ANDA*\n`;
    content += `Total: ${totalItems} Transaksi\n\n`;
    
    if (pageLines.length > 0) {
        content += pageLines.join('\n\n'); 
    } else {
        content += "_Belum ada riwayat transaksi._";
    }

    content += `\n\n📄 *Halaman ${currentPage} dari ${totalPages || 1}*`;

    let buttonsRow = [];
    if (currentPage > 1) {
        buttonsRow.push({ text: "⬅️ Sebelumnya", callback_data: `ri_page:${userId}:${currentPage - 1}` });
    }
    buttonsRow.push({ text: "🏠 Menu Utama", callback_data: "start" });
    if (currentPage < totalPages) {
        buttonsRow.push({ text: "Selanjutnya ➡️", callback_data: `ri_page:${userId}:${currentPage + 1}` });
    }

    return {
        content: content,
        buttons: { inline_keyboard: [buttonsRow] }
    };
}

// 4. [FIX] Fungsi Fetch & Cache (Dipakai ulang agar tidak error expired)
async function fetchAndCacheHistory(db, settings, userId) {
    let history = await db.getOrderHistory(userId);
    if (!history || history.length === 0) return null;

    history = await syncRecentStatuses(db, settings, userId, history);

    // Sorting Terbaru diatas
    history.sort((a, b) => {
        const dateA = new Date(a.tanggal || a.created_at || 0);
        const dateB = new Date(b.tanggal || b.created_at || 0);
        return dateB - dateA; 
    });

    // Formatting
    const allLines = history.map(order => {
        const serviceName = capitalize(order.layanan || 'Layanan');
        const hargaFormatted = (order.harga || 0).toLocaleString('id-ID');
        const tgl = moment(order.tanggal).locale('id').format('DD MMM YYYY, HH:mm');
        const statusFormatted = formatStatus(order.status);

        return `🆔 \`${order.orderId || order.id}\`\n` +
               `🛍️ *${serviceName}* | ${order.nomor || '-'}\n` +
               `💰 Rp${hargaFormatted} | ${statusFormatted}\n` +
               `📅 ${tgl}\n` + 
               `➖➖➖➖➖➖➖➖➖➖`;
    });

    // Simpan ke Cache
    riwayatCache[userId] = allLines;
    return allLines;
}

async function syncRecentStatuses(db, settings, userId, history) {
    const now = Date.now();
    let hasUpdate = false;
    const synced = [];

    for (const order of history) {
        const currentStatus = String(order.status || '').toLowerCase();

        if (currentStatus === 'success' || currentStatus === 'canceled' || currentStatus === 'expired') {
            synced.push(order);
            continue;
        }

        let nextStatus = currentStatus || 'pending';
        let extraData = {};

        if (settings?.rumahOtpApiKey && order.orderId) {
            try {
                const res = await axios.get(`https://www.rumahotp.com/api/v1/orders/get_status`, {
                    params: { order_id: order.orderId },
                    headers: { 'x-apikey': settings.rumahOtpApiKey, 'Accept': 'application/json' },
                    timeout: 5000
                });
                const apiData = res.data?.data;
                const apiStatus = String(apiData?.status || '').toLowerCase();
                const apiOtp = apiData?.otp_code;

                if (apiStatus === 'received' || apiStatus === 'completed' || apiStatus === 'success') {
                    nextStatus = 'success';
                    if (apiOtp && apiOtp !== '-') extraData.otp_code = apiOtp;
                } else if (apiStatus === 'expired' || apiStatus === 'expiring' || apiStatus === 'timeout') {
                    nextStatus = 'expired';
                    extraData.cancel_reason = 'Expired dari sinkron API riwayat';
                } else if (apiStatus === 'canceled' || apiStatus === 'cancelled') {
                    nextStatus = 'canceled';
                    extraData.cancel_reason = 'Canceled dari sinkron API riwayat';
                } else {
                    nextStatus = 'pending';
                }
            } catch (e) {}
        }

        if (nextStatus === 'pending') {
            const orderTime = new Date(order.tanggal || order.updated_at || 0).getTime();
            const isLocallyExpired = orderTime && (now - orderTime) >= (20 * 60 * 1000);
            if (isLocallyExpired) {
                nextStatus = 'expired';
                extraData.cancel_reason = 'Expired saat sinkron riwayat';
            }
        }

        if (nextStatus !== currentStatus) {
            await db.updateOrderHistoryStatus(userId, order.orderId, nextStatus, extraData);
            synced.push({ ...order, status: nextStatus, ...extraData });
            hasUpdate = true;
            continue;
        }

        synced.push(order);
    }

    return hasUpdate ? synced : history;
}

module.exports = (bot, db, settings, pendingDeposits, query) => {

    // A. HANDLER TOMBOL
    if (query) {
        (async () => {
            const data = query.data;
            const userId = query.from.id;
            const chatId = query.message.chat.id;
            const messageId = query.message.message_id;

            // 1. Navigasi Halaman (Next/Back)
            if (data.startsWith('ri_page:')) {
                const parts = data.split(':');
                const targetUserId = parts[1];
                const newPage = parseInt(parts[2]);

                if (userId.toString() !== targetUserId) {
                    return bot.answerCallbackQuery(query.id, { text: '❌ Akses Ditolak!', show_alert: true });
                }

                // [FIX UTAMA] Cek Cache. Jika kosong, AMBIL ULANG dari DB (Jangan Error)
                let cacheData = riwayatCache[userId];
                if (!cacheData) {
                    // Coba fetch ulang
                    try {
                        cacheData = await fetchAndCacheHistory(db, settings, userId);
                    } catch (e) { console.error(e); }
                }

                // Jika setelah fetch ulang masih kosong, berarti memang ga ada history
                if (!cacheData) {
                    return bot.answerCallbackQuery(query.id, { text: '⚠️ Riwayat kosong / Tidak ditemukan.', show_alert: true });
                }

                const pageData = generateRiwayatPage(cacheData, userId, newPage);
                
                try {
                    await bot.editMessageText(pageData.content, {
                        chat_id: chatId,
                        message_id: messageId,
                        parse_mode: "Markdown",
                        disable_web_page_preview: true,
                        reply_markup: pageData.buttons
                    });
                    await bot.answerCallbackQuery(query.id);
                } catch (e) {
                    // Abaikan jika pesan tidak berubah
                }
            
            // 2. Buka Menu Riwayat (Pertama Kali)
            } else if (data === 'riwayat' || data === 'riwayatorder') {
                try {
                    await bot.answerCallbackQuery(query.id);
                    
                    // Hapus Pesan Foto Menu Utama (Supaya bisa kirim Text Panjang)
                    try { await bot.deleteMessage(chatId, messageId); } catch(e){}

                    const loadingMsg = await bot.sendMessage(chatId, "⏳ *Sedang memuat data...*", { parse_mode: 'Markdown' });

                    // Ambil Data
                    const allLines = await fetchAndCacheHistory(db, settings, userId);

                    if (!allLines) {
                         await bot.editMessageText("📭 Anda belum memiliki riwayat pesanan.", {
                            chat_id: chatId,
                            message_id: loadingMsg.message_id,
                            reply_markup: require('../utils/backKeyboard')()
                        });
                        return;
                    }

                    const pageData = generateRiwayatPage(allLines, userId, 1);

                    // Tampilkan
                    await bot.editMessageText(pageData.content, {
                        chat_id: chatId,
                        message_id: loadingMsg.message_id,
                        parse_mode: "Markdown",
                        disable_web_page_preview: true,
                        reply_markup: pageData.buttons
                    });

                } catch (e) {
                    console.error("Error Riwayat:", e);
                    bot.sendMessage(chatId, "❌ Gagal memuat riwayat.");
                }
            }

        })();
        return;
    }

    // B. HANDLER COMMAND /riwayatorder
    bot.onText(/\/riwayatorder/, async (msg) => {
        const chatId = msg.chat.id;
        const userId = msg.from.id;

        const loadingMsg = await bot.sendMessage(chatId, "⏳ Memuat...", {});

        try {
            const allLines = await fetchAndCacheHistory(db, settings, userId);
            
            if (!allLines) {
                return bot.editMessageText("📭 Anda belum memiliki riwayat pesanan.", {
                    chat_id: chatId,
                    message_id: loadingMsg.message_id
                });
            }

            const pageData = generateRiwayatPage(allLines, userId, 1);

            await bot.editMessageText(pageData.content, {
                chat_id: chatId,
                message_id: loadingMsg.message_id,
                parse_mode: "Markdown",
                disable_web_page_preview: true,
                reply_markup: pageData.buttons
            });
        } catch (error) {
            console.error(error);
        }
    });
};
