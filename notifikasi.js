const fs = require("fs");
const fsp = require("fs/promises");
const path = require("path");
const settings = require('./settings.js');

const CHANNEL_ID = settings.channelid;
const OWNER_ID = settings.ownerId;

let botInstance = null;
let ledgerPath = path.join(process.cwd(), "data", "ledger.ndjson");

function escMd(s = "") {
  if (typeof s !== 'string') s = String(s);
  return s.replace(/([_*\[\]()~`\\])/g, "\\$1");
}

async function ensureDir(p) {
  await fsp.mkdir(p, { recursive: true });
}

async function ensureLedgerFile() {
  await ensureDir(path.dirname(ledgerPath));
  if (!fs.existsSync(ledgerPath)) await fsp.writeFile(ledgerPath, "", "utf8");
  return ledgerPath;
}

async function appendLedger(type, payload = {}) {
  try {
    const file = await ensureLedgerFile();
    const entry = {
      ts: new Date().toISOString(),
      type,
      ...payload
    };
    await fsp.appendFile(file, JSON.stringify(entry) + "\n", "utf8");
  } catch (e) {
    console.error("[notifikasi] Gagal menulis ke ledger:", e.message);
  }
}

async function init(bot, { onAliveText } = {}) {
  botInstance = bot; 
  console.log(`[Notifikasi] Berhasil terhubung ke Owner ID: ${OWNER_ID}`);

  if (onAliveText) {
    try {
      await botInstance.sendMessage(OWNER_ID, onAliveText, {
        parse_mode: "Markdown"
      });
    } catch (e) {
      console.warn("[notifikasi] Gagal kirim pesan awal ke Owner:", e.message);
    }
  }
}

function getChannelId() {
  return CHANNEL_ID;
}

async function sendChannelMessage(text, opts = {}) {
  if (!botInstance) {
      console.warn("[notifikasi] sendChannelMessage gagal: Modul belum di-init().");
      return;
  }
  try {
    await botInstance.sendMessage(CHANNEL_ID, text, {
      parse_mode: "Markdown",
      disable_web_page_preview: true,
      ...opts
    });
  } catch (e) {
    console.warn(`[notifikasi] sendChannelMessage gagal: ${e.message}`);
  }
}

async function sendChannelFile(filePath, caption = "") {
  if (!botInstance) return;
  try {
    await botInstance.sendDocument(CHANNEL_ID, filePath, {
      caption,
      parse_mode: "Markdown"
    });
  } catch (e) {
    console.warn("[notifikasi] sendChannelFile gagal:", e.message);
  }
}

async function sendChannelLedger(caption = "📒 Ledger terkini") {
  const file = await ensureLedgerFile();
  await sendChannelFile(file, caption);
}

async function userCreated({ userId, first_name, username, saldo = 0, total_order = 0, recent_orders = [] }) {
  await appendLedger("user_created", {
    user_id: userId,
    first_name,
    username: username || null,
    saldo,
    total_order,
    recent_orders
  });
}

// FIX: Fungsi orderCreated disesuaikan dengan data yang kamu kirim
async function orderCreated({
  order_id,
  user_id,
  number,
  harga_final,
  layanan,
  negara,
  user_name,
  username,
  notifyText = true
}) {
  // Catat ke ledger
  await appendLedger("order_created", {
    order_id,
    user_id,
    number,
    harga_final,
    layanan: layanan || null,
    negara: negara || null,
    user_name: user_name || null,
    username: username || null
  });

  if (notifyText && botInstance) {
    // Sinkronisasi jam ke WIB
    const jamWIB = new Date().toLocaleTimeString('id-ID', { 
      hour: '2-digit', 
      minute: '2-digit', 
      timeZone: 'Asia/Jakarta' 
    }).replace(/\./g, ':');

    // Template pesan ringkas mengikuti input kamu
    const text =
`*🛒 Order Baru*
• OrderID: \`${order_id}\`
• UserID: \`${user_id}\`
• Nama User: ${escMd(user_name || "-")} ${username ? `(@${escMd(username)})` : ""}
• Layanan: *${escMd(layanan || "-")}*
• Negara: *${escMd(negara || "-")}*
• Nomor: \`${number}\`
• Harga: *Rp${Number(harga_final || 0).toLocaleString('id-ID')}*
• Waktu: \`${jamWIB} WIB\``;

    await sendChannelMessage(text, {
      reply_markup: {
        inline_keyboard: [
          [
            { text: "🛍️ Order Nokos", url: "https://t.me/AlwaysZakzz_Vitusim_bot" }
          ]
        ]
      }
    });
  }
}

module.exports = {
  init,
  getChannelId,
  sendChannelMessage,
  sendChannelFile,
  sendChannelLedger,
  userCreated,
  orderCreated,
  appendLedger,
  escMd
};
