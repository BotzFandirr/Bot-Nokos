function backKeyboard() {
    return {
        inline_keyboard: [
            [{ text: "⬅️ Kembali ke Menu Utama", callback_data: "start" }]
        ]
    };
}

module.exports = backKeyboard;