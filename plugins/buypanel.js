// plugins/buypanel.js
const axios = require("axios");

function escMd(s = "") {
  if (typeof s !== 'string') s = String(s);
  return s.replace(/([_*\[\]()~`\\])/g, "\\$1");
}

// SAFE REPLY (biar ga error kalau reply_to nya hilang)
async function sendSafeReply(bot, chatId, text, options = {}) {
  try {
    return await bot.sendMessage(chatId, text, options);
  } catch (e) {
    const opt = { ...options };
    delete opt.reply_to_message_id;
    return bot.sendMessage(chatId, text, opt);
  }
}

module.exports = async (bot, db, settings, _pendingDeposits, query, message) => {

  //   HANDLE CHAT TEXT (INPUT USERNAME PANEL)
  if (message?.text && db.pendingPanelOrder?.[message.from.id]) {

    const userId = message.from.id;
    const chatId = message.chat.id;
    const order = db.pendingPanelOrder[userId];

    // Kalau belum masuk tahap username, abaikan
    if (!order || order.stage !== "username") return;

    const usernameInput = message.text.trim();
    const paket = order.paket;
    const CHANNEL_ID = settings.channelid;

    // ========== VALIDASI USERNAME ==========
    if (usernameInput.includes(" ")) {
      return bot.sendMessage(
        chatId,
        `⚠ Username tidak valid!\n` +
        `Username *tidak boleh mengandung spasi*.\n` +
        `Contoh yang benar: Zakzz\n\n` +
        `Silakan kirim ulang username yang benar.`,
        { parse_mode: "Markdown" }
      );
    }

    // ========== CEK SALDO ==========
    const saldo = await db.cekSaldo(userId);
    if (saldo < paket.harga) {
      delete db.pendingPanelOrder[userId];
      return bot.sendMessage(
        chatId,
        `❌ *Saldo tidak cukup!*\nHarga: Rp${paket.harga.toLocaleString("id-ID")}`,
        { parse_mode: "Markdown" }
      );
    }

    // ========== TAMPILKAN LOADING ==========
    const waitMsg = await sendSafeReply(
      bot,
      chatId,
      `⏳ Sedang membuat panel...`,
      { parse_mode: "Markdown" }
    );

    // ========== KURANGI SALDO SETELAH LOADING ==========
    await db.kurangSaldo(userId, paket.harga);

    // DATA LOGIN
    const email = `${usernameInput}@gmail.com`;
    const password = `${usernameInput}001`;

    const startupCMD =
      'if [[ -d .git ]] && [[ {{AUTO_UPDATE}} == "1" ]]; then git pull; fi; ' +
      'if [[ ! -z ${NODE_PACKAGES} ]]; then /usr/local/bin/npm install ${NODE_PACKAGES}; fi; ' +
      'if [[ ! -z ${UNNODE_PACKAGES} ]]; then /usr/local/bin/npm uninstall ${UNNODE_PACKAGES}; fi; ' +
      'if [ -f /home/container/package.json ]; then /usr/local/bin/npm install; fi; ' +
      '/usr/local/bin/${CMD_RUN}';

    try {
      // ================== BUAT USER PANEL ==================
      const userRes = await axios.post(
        `${settings.domain}/api/application/users`,
        {
          email,
          username: usernameInput,
          first_name: usernameInput,
          last_name: usernameInput,
          language: "en",
          password
        },
        {
          headers: {
            Accept: "application/json",
            "Content-Type": "application/json",
            Authorization: `Bearer ${settings.plta}`
          }
        }
      );

      const panelUserID = userRes.data.attributes.id;

      // ================== BUAT SERVER PANEL ==================
      const srvRes = await axios.post(
        `${settings.domain}/api/application/servers`,
        {
          name: usernameInput + paket.tag,
          description: "",
          user: panelUserID,
          egg: parseInt(settings.eggs),
          docker_image: "ghcr.io/parkervcp/yolks:nodejs_18",
          startup: startupCMD,
          environment: {
            INST: "npm",
            USER_UPLOAD: "0",
            AUTO_UPDATE: "0",
            CMD_RUN: "npm start"
          },
          limits: {
            memory: paket.ram,
            swap: 0,
            disk: paket.disk,
            io: 500,
            cpu: paket.cpu
          },
          feature_limits: {
            databases: 5,
            backups: 5,
            allocations: 1
          },
          deploy: {
            locations: [parseInt(settings.loc)],
            dedicated_ip: false,
            port_range: []
          }
        },
        {
          headers: {
            Accept: "application/json",
            "Content-Type": "application/json",
            Authorization: `Bearer ${settings.plta}`
          }
        }
      );

      const serverID = srvRes.data.attributes.id;

      // UPDATE pesan loading jadi sukses (opsional, bisa juga kirim baru)
      await bot.editMessageText(
        `𝗣𝗮𝗻𝗲𝗹 𝗯𝗲𝗿𝗵𝗮𝘀𝗶𝗹 𝗱𝗶𝗯𝘂𝗮𝘁𝗸𝗮𝗻 ✅\n\n` +
        `• Paket : *${paket.nama}*\n` +
        `• Username : \`${usernameInput}\`\n` +
        `• Password : \`${password}\`\n` +
        `• Login : ${settings.domain}\n` +
        `• Server ID : ${serverID}\n\n` +
        `• RAM : ${(paket.ram / 1024).toFixed(0)} GB\n` +
        `• DISK : ${(paket.disk / 1024).toFixed(0)} GB\n` +
        `• CPU : ${paket.cpu}%\n\n` +
        `⚠ Data dikirim 1x\n` +
        `⚠ No ddos\n` +
        `⚠ No mining\n` +
        `⚠ Jaga private\n` +
        `⚠ Garansi 10 hari (1x replace)\n` +
        `⚠ Claim garansi? Owner: @AlwaysZakzz`,
        {
          chat_id: chatId,
          message_id: waitMsg.message_id,
          parse_mode: "Markdown"
        }
      );

      // NOTIF CHANNEL 
// Buat variabel jam yang sudah tersinkron ke Asia/Jakarta
    const jamWIB = new Date().toLocaleTimeString('id-ID', { 
      hour: '2-digit', 
      minute: '2-digit', 
      timeZone: 'Asia/Jakarta' 
    }).replace(/\./g, ':'); // Mengubah titik menjadi titik dua (02.30 -> 02:30)
    
    await bot.sendMessage(
      CHANNEL_ID,
      `*PESANAN PANEL*\n` +
      `━━━━━━━━━━━━━━━━━━━━━━\n` +
      `👤 *PELANGGAN*\n` +
      `• Nama: [${escMd(message.from.first_name)}](tg://user?id=${userId})\n` +
      `• ID: \`${userId}\`\n\n` +
      `📦 *DETAIL PAKET*\n` +
      `• Produk: *${escMd(paket.nama)}*\n` +
      `• Server: \`#${serverID}\`\n\n` +
      `💰 *PEMBAYARAN*\n` +
      `• Total: *Rp${paket.harga.toLocaleString("id-ID")}*\n` +
      `• Status: ✅ \`SUCCESS\`\n` +
      `━━━━━━━━━━━━━━━━━━━━━━\n` +
      `🕒 _Waktu: ${jamWIB} WIB_`,
      { 
        parse_mode: "Markdown",
        reply_markup: {
          inline_keyboard: [
            [
              { 
                text: "🚀 ORDER PANEL", 
                url: `https://t.me/AlwaysZakzz_Vitusim_bot` 
              }
            ]
          ]
        }
      }
    );

    } catch (err) {
      console.error("CREATE PANEL ERROR:", err?.response?.data || err);

      // REFUND SALDO JIKA ERROR
      await db.tambahSaldo(userId, paket.harga);

      await bot.editMessageText(
        "⚠ Terjadi kesalahan saat membuat panel. Saldo telah dikembalikan.",
        {
          chat_id: chatId,
          message_id: waitMsg.message_id
        }
      );
    }

    // Hapus pending order
    delete db.pendingPanelOrder[userId];

    return;
  }

  //   HANDLE CALLBACK QUERY (BUTTON)
  if (!query) return;

  const data = (query.data || "").toLowerCase();
  const chatId = query.message.chat.id;
  const userId = query.from.id;

  const PANEL = {
    buypanel1gb:  { harga:1000, ram:1024,  disk:1024,  cpu:30,  tag:"1gb",  nama:"Panel 1GB" },
    buypanel2gb:  { harga:2000, ram:2048,  disk:2048,  cpu:60,  tag:"2gb",  nama:"Panel 2GB" },
    buypanel3gb:  { harga:3000, ram:3072,  disk:3072,  cpu:90,  tag:"3gb",  nama:"Panel 3GB" },
    buypanel4gb:  { harga:4000, ram:4048,  disk:4048,  cpu:110, tag:"4gb",  nama:"Panel 4GB" },
    buypanel5gb:  { harga:5000, ram:5048,  disk:5048,  cpu:140, tag:"5gb",  nama:"Panel 5GB" },
    buypanel6gb:  { harga:6000, ram:6048,  disk:6048,  cpu:170, tag:"6gb",  nama:"Panel 6GB" },
    buypanel7gb:  { harga:7000, ram:7048,  disk:7048,  cpu:200, tag:"7gb",  nama:"Panel 7GB" },
    buypanel8gb:  { harga:8000, ram:8048,  disk:8048,  cpu:230, tag:"8gb",  nama:"Panel 8GB" },
    buypanel9gb:  { harga:9000, ram:9048,  disk:9048,  cpu:260, tag:"9gb",  nama:"Panel 9GB" },
    buypanelunli: { harga:5000,ram:0,     disk:0,     cpu:0,   tag:"unli", nama:"Panel Unlimited" }
  };

  // ========= BUKA MENU PILIH PAKET PANEL =========
  if (data === "buypanel") {
    await bot.editMessageCaption(
      "🖥️ *Pilih Paket Panel Hosting*\nSilakan pilih paket:",
      {
        chat_id: chatId,
        message_id: query.message.message_id,
        parse_mode: "Markdown",
        reply_markup: {
          inline_keyboard: [
            [{ text: "Panel 1GB — 1K", callback_data: "buypanel1gb" }],
            [{ text: "Panel 2GB — 2K", callback_data: "buypanel2gb" }],
            [{ text: "Panel 3GB — 3K", callback_data: "buypanel3gb" }],
            [{ text: "Panel 4GB — 4K", callback_data: "buypanel4gb" }],
            [{ text: "Panel 5GB — 5K", callback_data: "buypanel5gb" }],
            [{ text: "Panel 6GB — 6K", callback_data: "buypanel6gb" }],
            [{ text: "Panel 7GB — 7K", callback_data: "buypanel7gb" }],
            [{ text: "Panel 8GB — 8K", callback_data: "buypanel8gb" }],
            [{ text: "Panel 9GB — 9K", callback_data: "buypanel9gb" }],
            [{ text: "Panel Unlimited — 10K", callback_data: "buypanelunli" }],
            [{ text: "🔙 Kembali", callback_data: "start" }]
          ]
        }
      }
    );
    return;
  }

  // ========= USER PILIH SALAH SATU PAKET PANEL =========
  if (PANEL[data]) {
    if (!db.pendingPanelOrder) db.pendingPanelOrder = {};

    const paket = PANEL[data];

    const successMsgText = 
      `✅ *PESANAN PANEL DITERIMA!*\n\n` +
      `• Paket : *${paket.nama}*\n` +
      `• Harga : Rp${paket.harga.toLocaleString("id-ID")}\n\n` +
      `Silakan lanjutkan proses dengan tombol di bawah ini.`;
      
    const sentMessage = await bot.sendMessage(chatId, successMsgText, {
      parse_mode: "Markdown",
      reply_markup: {
        inline_keyboard: [
          [
            { text: "📩 Buy Panel", callback_data: "panel_buy" },
            { text: "❌ Batalkan", callback_data: "panel_cancel" }
          ]
        ]
      }
    });
    
    db.pendingPanelOrder[userId] = {
      paket,
      stage: "confirm",
      messageId: sentMessage.message_id // <-- PENTING: ID pesan disimpan di sini
    };
    
    return;
  }

  if (data === "panel_buy") {
    const order = db.pendingPanelOrder?.[userId];
    
    if (!order) {
      await bot.answerCallbackQuery(query.id, { text: "⚠ Tidak ada pesanan panel yang aktif.", show_alert: true });
      return; 
    }
    
    const messageId = order.messageId; // Dapatkan ID pesan yang tersimpan

    order.stage = "username";

    const msg = 
      `Silakan kirim *username panel* yang ingin digunakan.\n\nContoh:\n\`Zakzz\``;

    await bot.editMessageText(msg, {
      chat_id: chatId,
      message_id: messageId,
      parse_mode: "Markdown",
      reply_markup: {} // Menghilangkan inline keyboard
    });
    
    await bot.answerCallbackQuery(query.id); 
    
    return;
  }

  // ========= TOMBOL BATALKAN (MENGEDIT PESAN) =========
  if (data === "panel_cancel") {
    const order = db.pendingPanelOrder?.[userId];

    if (order) {
      const messageId = order.messageId; // Dapatkan ID pesan yang tersimpan
      delete db.pendingPanelOrder[userId];
      
      const msg = "❌ Pesanan panel berhasil dibatalkan.";

      await bot.editMessageText(msg, {
        chat_id: chatId,
        message_id: messageId,
        reply_markup: {} // Menghilangkan inline keyboard
      });
      
      await bot.answerCallbackQuery(query.id); 

      return;
    }
    
    await bot.answerCallbackQuery(query.id, { text: "❌ Tidak ada pesanan panel yang aktif untuk dibatalkan.", show_alert: true });
    return;
  }
};
