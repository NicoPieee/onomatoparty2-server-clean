// server/db.js
const admin = require("firebase-admin");
const serviceAccount = require("./onomatoparty2-firebase-adminsdk-fbsvc-b05605cf5e.json");

admin.initializeApp({
  credential: admin.credential.cert(serviceAccount),
});

const db = admin.firestore();
module.exports = { db };
