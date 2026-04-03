const { MongoClient } = require('mongodb');
const settings = require('../settings.js'); 

let dbClient = null;
let dbInstance = null;

const DB_NAME = "NokosBotDB"; 
const USERS_COLL = "users";
const ORDERS_COLL = "orders";
const PENDING_DEPOSITS_COLL = "pending_deposits";

async function getDb() {
    if (dbInstance) {
        return dbInstance;
    }
    if (!settings.mongoDbUri) {
        throw new Error("mongoDbUri tidak diatur di settings.js");
    }
    try {
        dbClient = new MongoClient(settings.mongoDbUri);
        await dbClient.connect();
        dbInstance = dbClient.db(DB_NAME);
        console.log("[MongoDB] Berhasil terhubung ke database.");
        return dbInstance;
    } catch (e) {
        console.error("[MongoDB] Gagal terhubung:", e);
        process.exit(1); 
    }
}

async function cekSaldo(userId) {
    const db = await getDb();
    const user = await db.collection(USERS_COLL).findOne({ _id: userId.toString() });
    return user ? user.saldo : 0;
}

async function tambahSaldo(userId, amount) {
    const db = await getDb();
    const result = await db.collection(USERS_COLL).updateOne(
        { _id: userId.toString() },
        { 
            $inc: { saldo: amount },
            $setOnInsert: { history: [], deposit_history: [] } 
        },
        { upsert: true } 
    );
    const newSaldo = await cekSaldo(userId);
    return newSaldo;
}

async function kurangSaldo(userId, amount) {
    const db = await getDb();
    const result = await db.collection(USERS_COLL).updateOne(
        { _id: userId.toString(), saldo: { $gte: amount } },
        { $inc: { saldo: -amount } }
    );
    return result.modifiedCount > 0; 
}

async function addOrderHistory(userId, orderData) {
    const db = await getDb();
    await db.collection(USERS_COLL).updateOne(
        { _id: userId.toString() },
        { 
            $push: { history: orderData },
            $setOnInsert: { saldo: 0, deposit_history: [] }
        },
        { upsert: true }
    );
}

async function getOrderHistory(userId) {
    const db = await getDb();
    const user = await db.collection(USERS_COLL).findOne({ _id: userId.toString() });
    const history = user && Array.isArray(user.history) ? user.history : [];
    return history.sort((a, b) => {
        const dateA = new Date(a?.tanggal || a?.updated_at || 0).getTime();
        const dateB = new Date(b?.tanggal || b?.updated_at || 0).getTime();
        return dateB - dateA; // Terbaru paling atas
    });
}

async function updateOrderHistoryStatus(userId, orderId, status, extraData = {}) {
    const db = await getDb();
    await db.collection(USERS_COLL).updateOne(
        { _id: userId.toString() },
        {
            $set: {
                "history.$[order].status": status,
                "history.$[order].updated_at": new Date().toISOString(),
                ...Object.fromEntries(
                    Object.entries(extraData).map(([key, value]) => [`history.$[order].${key}`, value])
                )
            }
        },
        {
            arrayFilters: [{ "order.orderId": orderId }],
        }
    );
}

async function addDepositHistory(userId, depositData) {
    const db = await getDb();
    await db.collection(USERS_COLL).updateOne(
        { _id: userId.toString() },
        { 
            $push: { deposit_history: depositData },
            $setOnInsert: { saldo: 0, history: [] }
        },
        { upsert: true }
    );
}

async function countDeposits(userId) {
    const db = await getDb();
    const user = await db.collection(USERS_COLL).findOne({ _id: userId.toString() });
    return user && user.deposit_history ? user.deposit_history.length : 0;
}

async function readUserDB() {
    console.warn("[Peringatan] readUserDB() dipanggil, gunakan fungsi spesifik.");
    return {}; 
}

async function countTotalUsers() {
    const db = await getDb();
    return await db.collection(USERS_COLL).countDocuments();
}

async function getAllUserIds() {
    const db = await getDb();
    const users = await db.collection(USERS_COLL).find({}, { projection: { _id: 1 } }).toArray();
    return users.map(user => user._id);
}

async function getAllUsersFull() {
    const db = await getDb();
    const users = await db.collection(USERS_COLL).find({}, { projection: { _id: 1, history: 1 } }).toArray();
    return users;
}

async function saveOrder(orderId, userId) {
    const db = await getDb();
    await db.collection(ORDERS_COLL).updateOne(
        { _id: orderId.toString() },
        { $set: { userId: userId.toString() } },
        { upsert: true }
    );
}

async function getOrderOwner(orderId) {
    const db = await getDb();
    const order = await db.collection(ORDERS_COLL).findOne({ _id: orderId.toString() });
    return order ? order.userId : null;
}

async function removeOrder(orderId) {
    const db = await getDb();
    await db.collection(ORDERS_COLL).deleteOne({ _id: orderId.toString() });
}

async function getAllPendingDeposits() {
    const db = await getDb();
    return await db.collection(PENDING_DEPOSITS_COLL).find({}).toArray(); 
}

async function savePendingDeposit(userId, data) {
    const db = await getDb();
    await db.collection(PENDING_DEPOSITS_COLL).updateOne(
        { _id: userId.toString() },
        { $set: data }, 
        { upsert: true }
    );
}

async function removePendingDeposit(userId) {
    const db = await getDb();
    await db.collection(PENDING_DEPOSITS_COLL).deleteOne({ _id: userId.toString() });
}

module.exports = {
    getDb,
    countTotalUsers,
    getAllUserIds,
    getAllUsersFull,
    cekSaldo,
    tambahSaldo,
    kurangSaldo,
    addOrderHistory,
    getOrderHistory,
    updateOrderHistoryStatus,
    addDepositHistory,
    countDeposits,
    readUserDB, 
    saveOrder,
    getOrderOwner,
    removeOrder,
    getAllPendingDeposits,
    savePendingDeposit,
    removePendingDeposit
};
