// plugins/deposit.js
const axios = require('axios');
const moment = require('moment-timezone');
const backKeyboard = require('../utils/backKeyboard');

moment.locale('id');

const EXPIRED_MINUTES = 5;
const CHECK_INTERVAL = 7000;

// ================= SAFE SEND =================
async function sendSafeReply(bot, chatId, text, options = {}) {
    try {
        return await bot.sendMessage(chatId, text, options);
    } catch (error) {
        if (error.response?.body?.description === 'message to be replied not found') {
            delete options.reply_to_message_id;
            return await bot.sendMessage(chatId, text, options).catch(() => {});
        }
        console.error("Send error:", error.message);
        return undefined;
    }
}

// ================= CANCEL =================
async function handleCancelCallback(bot, db, pendingDeposits, query) {
    const userId = query.from.id;
    const chatId = query.message.chat.id;
    const orderId = query.data.split(':')[1];

    await bot.answerCallbackQuery(query.id).catch(() => {});

    const pending = pendingDeposits[userId];
    if (!pending || pending.orderId !== orderId) {
        return sendSafeReply(bot, chatId, "Transaksi tidak ditemukan / sudah selesai.");
    }

    clearInterval(pending.interval);
    await bot.deleteMessage(chatId, pending.msgQrKey).catch(() => {});
    await db.removePendingDeposit(userId).catch(() => {});
    delete pendingDeposits[userId];

    await sendSafeReply(bot, chatId, `✅ Deposit \`${orderId}\` dibatalkan.`, {
        parse_mode: "Markdown"
    });
}

// ================= MODULE =================
module.exports = (bot, db, settings, pendingDeposits, query) => {

    // INLINE CALLBACK
    if (query) {
        const data = (query.data || '').toLowerCase();
        const chatId = query.message.chat.id;
        const messageId = query.message.message_id;

        if (data === 'deposit') {
            const minimal = Number(settings.minimalDeposit || 0).toLocaleString('id-ID');
            const fixedFee = Number(settings.depositFee || 0).toLocaleString('id-ID');

            const caption =
                `💳 *DEPOSIT SALDO OTOMATIS*\n\n` +
                `Deposit akan dikenakan *Biaya Admin Tetap* dan *Kode Unik*.\n\n` +
                `1. Masukkan jumlah deposit (misal: 5000).\n` +
                `2. Sistem akan menghitung: \`Jumlah + Fee Admin + Kode Unik\`.\n` +
                `3. Anda harus membayar *TEPAT* sesuai jumlah total.\n` +
                `4. Batas waktu pembayaran adalah *${EXPIRED_MINUTES} MENIT*.\n` +
                `5. Saldo yang masuk hanya sesuai *Jumlah Deposit Pokok*.\n\n` +
                `*Biaya Admin Tetap:* Rp${fixedFee}\n` +
                `*Minimal Deposit:* Rp${minimal}\n\n` +
                `Ketik perintah: \`/deposit <jumlah>\`\n` +
                `*Contoh:* \`/deposit 5000\``;

            bot.editMessageCaption(caption, {
                chat_id: chatId,
                message_id: messageId,
                parse_mode: "Markdown",
                reply_markup: backKeyboard()
            }).catch(() => {});
            return;
        }

        if (data.startsWith('cancel_deposit:')) {
            handleCancelCallback(bot, db, pendingDeposits, query);
            return;
        }

        return;
    }

    // TANPA NOMINAL
    bot.onText(/\/deposit$/, (msg) => {
        sendSafeReply(
            bot,
            msg.chat.id,
            `Masukkan nominal.\nContoh: /deposit 5000\nMinimal Rp${Number(settings.minimalDeposit || 0).toLocaleString('id-ID')}`,
            { reply_to_message_id: msg.message_id }
        );
    });

    // DENGAN NOMINAL
    bot.onText(/\/deposit (\d+)/, async (msg, match) => {
        const chatId = msg.chat.id;
        const userId = msg.from.id;
        const baseAmount = parseInt(match[1], 10);

        if (!Number.isInteger(baseAmount) || baseAmount <= 0) {
            return bot.sendMessage(chatId, "Nominal tidak valid.");
        }

        if (baseAmount < Number(settings.minimalDeposit || 0)) {
            return bot.sendMessage(chatId, "Nominal kurang dari minimal.");
        }

        if (pendingDeposits[userId]) {
            return bot.sendMessage(chatId, "Masih ada deposit aktif.");
        }

        try {
            const adminFee = Number(settings.depositFee || 0);
            const uniqueCodeMax = Number(settings.uniqueCodeMax || 0);

            if (!Number.isFinite(adminFee) || adminFee < 0) {
                return bot.sendMessage(chatId, "Setting fee deposit tidak valid.");
            }

            if (!Number.isInteger(uniqueCodeMax) || uniqueCodeMax < 1) {
                return bot.sendMessage(chatId, "Setting kode unik tidak valid.");
            }

            const uniqueCode = Math.floor(Math.random() * uniqueCodeMax) + 1;
            const totalAmount = baseAmount + adminFee + uniqueCode;

            const orderId = `DEP-${Date.now()}`;
            const createdAt = moment.tz("Asia/Jakarta");
            const expiredAt = moment.tz("Asia/Jakarta").add(EXPIRED_MINUTES, "minutes");
            const expiryDisplay = expiredAt.format("HH:mm:ss");

            console.log("[DEPOSIT CREATE]", {
                userId,
                orderId,
                baseAmount,
                adminFee,
                uniqueCode,
                totalAmount,
                createdAt: createdAt.format("YYYY-MM-DD HH:mm:ss")
            });

            const loadingMsg = await bot.sendMessage(chatId, "⏳ Membuat QRIS...");

            let res;
            try {
                res = await axios.get(
                    "https://apis.fandir.eu.org/api/orkut/createpayment",
                    {
                        params: {
                            amount: totalAmount,
                            codeqr: settings.qrDecode
                        },
                        timeout: 15000
                    }
                );
            } catch (err) {
                if (loadingMsg) {
                    await bot.deleteMessage(chatId, loadingMsg.message_id).catch(() => {});
                }
                console.log("Create payment error:", err.response?.data || err.message);
                return bot.sendMessage(chatId, "❌ Server pembayaran sedang gangguan.");
            }

            if (!res.data || !res.data.result || !res.data.result.qrImageUrl) {
                if (loadingMsg) {
                    await bot.deleteMessage(chatId, loadingMsg.message_id).catch(() => {});
                }
                console.log("Invalid payment response:", res.data);
                return bot.sendMessage(chatId, "❌ Gagal membuat QRIS.");
            }

            const qrUrl = res.data.result.qrImageUrl;

            if (loadingMsg) {
                await bot.deleteMessage(chatId, loadingMsg.message_id).catch(() => {});
            }

            let qrMsg;
            try {
                const qrImage = await axios.get(qrUrl, {
                    responseType: 'arraybuffer',
                    timeout: 15000
                });

                qrMsg = await bot.sendPhoto(chatId, qrImage.data, {
                    caption:
                        `*「 TUNGGU PEMBAYARAN 」*\n\n` +
                        `<!> *BATAS WAKTU BAYAR: ${EXPIRED_MINUTES} MENIT*\n\n` +
                        `- *ID Pesanan:* \`${orderId}\`\n` +
                        `- *Jumlah Deposit:* Rp${baseAmount.toLocaleString('id-ID')}\n` +
                        `- *Biaya Admin:* Rp${adminFee.toLocaleString('id-ID')}\n` +
                        `- *Kode Unik:* Rp${uniqueCode.toLocaleString('id-ID')}\n` +
                        `----------------------------------\n` +
                        `*Total Bayar TEPAT:* *Rp${totalAmount.toLocaleString('id-ID')}*\n` +
                        `----------------------------------\n` +
                        `- *Kedaluwarsa:* *${expiryDisplay} WIB*\n\n` +
                        `💡 _Wajib bayar tepat sesuai nominal agar saldo masuk otomatis._`,
                    parse_mode: "Markdown",
                    reply_markup: {
                        inline_keyboard: [
                            [{ text: "❌ Batalkan", callback_data: `cancel_deposit:${orderId}` }]
                        ]
                    }
                });
            } catch (err) {
                console.log("Send QR error:", err.message);
                return bot.sendMessage(chatId, `QR berhasil dibuat, tetapi gagal dikirim.\nSilakan buka manual:\n${qrUrl}`);
            }

            if (settings.channelid) {
                const now = moment().tz("Asia/Jakarta");
                const tanggal = now.format("dddd, DD MMMM YYYY");
                const jam = now.format("HH:mm:ss");

                await bot.sendMessage(
                    settings.channelid,
                    `🟡 *DEPOSIT BARU*\n\n` +
                    `👤 *Username:* ${msg.from.username ? '@' + msg.from.username : 'Tidak ada'}\n` +
                    `🆔 *User ID:* \`${userId}\`\n` +
                    `📦 *Order ID:* \`${orderId}\`\n\n` +
                    `💰 *Nominal:* Rp${baseAmount.toLocaleString('id-ID')}\n` +
                    `💸 *Biaya Admin:* Rp${adminFee.toLocaleString('id-ID')}\n` +
                    `🔢 *Kode Unik:* Rp${uniqueCode.toLocaleString('id-ID')}\n` +
                    `💳 *Total Bayar:* Rp${totalAmount.toLocaleString('id-ID')}\n\n` +
                    `📅 *Tanggal:* ${tanggal}\n` +
                    `⏰ *Waktu:* ${jam} WIB`,
                    {
                        parse_mode: "Markdown",
                        reply_markup: {
                            inline_keyboard: [
                                [
                                    { text: "💰 Deposit", url: `https://t.me/AlwaysZakzz_Vitusim_bot` }
                                ]
                            ]
                        }
                    }
                ).catch(() => {});
            }

            let isChecking = false;

            const interval = setInterval(async () => {
                if (isChecking) return;
                isChecking = true;

                try {
                    const pending = pendingDeposits[userId];
                    if (!pending || pending.orderId !== orderId) {
                        clearInterval(interval);
                        return;
                    }

                    if (moment.tz("Asia/Jakarta").isAfter(expiredAt)) {
                        clearInterval(interval);
                        await bot.sendMessage(chatId, `⏰ Deposit \`${orderId}\` expired.`, {
                            parse_mode: "Markdown"
                        }).catch(() => {});
                        await bot.deleteMessage(chatId, qrMsg.message_id).catch(() => {});
                        await db.removePendingDeposit(userId).catch(() => {});
                        delete pendingDeposits[userId];
                        return;
                    }

                    let mutRes;
                    try {
                        mutRes = await axios.post(
                            "https://api.fandir.eu.org/api/orderkuota/mutasi",
                            new URLSearchParams({
                                apikey: settings.orderkuotaApiKey,
                                user_id: settings.orderkuotaUserId,
                                auth_username: settings.orderkuotaAuthUsername,
                                auth_token: settings.orderkuotaAuthToken,
                                jenis: "debit",
                                page: 1
                            }),
                            {
                                headers: { "Content-Type": "application/x-www-form-urlencoded" },
                                timeout: 15000
                            }
                        );
                    } catch (err) {
                        console.log("Mutasi request error:", err.response?.data || err.message);
                        return;
                    }

                    const history = mutRes.data?.qris_history?.results || [];

                    for (const trx of history) {
                        if (String(trx.status || '').toUpperCase() !== "IN") continue;

                        const kredit = parseInt(String(trx.kredit || "0").replace(/[^\d]/g, ""), 10);
                        if (isNaN(kredit)) continue;

                        const trxTime = moment.tz(trx.tanggal, "DD/MM/YYYY HH:mm:ss", "Asia/Jakarta");
                        if (!trxTime.isValid()) continue;

                        // Toleransi 10 detik agar transaksi yang masuk sangat dekat dengan waktu create tidak kelewat
                        if (trxTime.isBefore(createdAt.clone().subtract(10, 'seconds'))) continue;

                        console.log("[MUTASI CHECK]", {
                            orderId,
                            trxId: trx.id,
                            trxKredit: kredit,
                            totalAmount,
                            trxTanggal: trx.tanggal,
                            createdAt: createdAt.format("DD/MM/YYYY HH:mm:ss")
                        });

                        if (kredit === totalAmount) {
                            try {
                                await db.tambahSaldo(userId, baseAmount);
                                await db.removePendingDeposit(userId);
                                delete pendingDeposits[userId];

                                const saldoBaru = await db.cekSaldo(userId);

                                clearInterval(interval);

                                await bot.sendMessage(
                                    chatId,
                                    `✅ *Deposit Berhasil!*\n\n` +
                                    `Jumlah Masuk: Rp${baseAmount.toLocaleString('id-ID')}\n` +
                                    `Biaya Admin: Rp${adminFee.toLocaleString('id-ID')}\n` +
                                    `Saldo Sekarang: Rp${saldoBaru.toLocaleString('id-ID')}`,
                                    { parse_mode: "Markdown" }
                                ).catch(() => {});

                                await bot.deleteMessage(chatId, qrMsg.message_id).catch(() => {});
                                return;
                            } catch (dbErr) {
                                console.log("DB deposit error:", dbErr.message);
                                return;
                            }
                        }
                    }
                } catch (err) {
                    console.log("Mutasi error:", err.message);
                } finally {
                    isChecking = false;
                }
            }, CHECK_INTERVAL);

            pendingDeposits[userId] = {
                orderId,
                baseAmount,
                adminFee,
                totalAmount,
                interval,
                msgQrKey: qrMsg.message_id,
                createdAt: createdAt.valueOf()
            };

            await db.savePendingDeposit(userId, {
                orderId,
                baseAmount,
                adminFee,
                totalAmount,
                createdAt: createdAt.valueOf()
            });

        } catch (err) {
            console.log("Deposit error:", err.message);
            bot.sendMessage(chatId, "Gagal membuat QRIS.").catch(() => {});
        }
    });
};