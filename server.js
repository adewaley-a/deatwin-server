const express = require('express');
const admin = require('firebase-admin');
const crypto = require('crypto');
const app = express();

// Initialize Firebase
const serviceAccount = require("./serviceAccountKey.json");
if (!admin.apps.length) {
    admin.initializeApp({ credential: admin.credential.cert(serviceAccount) });
}
const db = admin.firestore();

app.use(express.json());

app.post('/paystack-webhook', async (req, res) => {
    console.log("--- WEBHOOK RECEIVED ---");
    
    // 1. Verify Signature
    const hash = crypto.createHmac('sha512', process.env.PAYSTACK_SECRET_KEY)
                       .update(JSON.stringify(req.body))
                       .digest('hex');
    
    if (hash !== req.headers['x-paystack-signature']) {
        console.error("ERROR: Invalid Signature!");
        return res.sendStatus(400);
    }

    const event = req.body;
    console.log("Event Type:", event.event);

    if (event.event === 'charge.success') {
        const email = event.data.customer.email;
        const amount = event.data.amount / 100; // Convert Kobo to Naira
        
        console.log(`Searching for user with email: ${email}`);

        try {
            const userQuery = await db.collection('users').where('email', '==', email).get();

            if (userQuery.empty) {
                console.error(`ERROR: No user found in Firestore with email ${email}`);
                return res.sendStatus(200); // We send 200 so Paystack stops retrying
            }

            const userDoc = userQuery.docs[0];
            const currentBalance = userDoc.data().wallet_balance || 0;
            
            await userDoc.ref.update({
                wallet_balance: currentBalance + amount
            });

            console.log(`SUCCESS: Credited ₦${amount} to ${email}. New Balance: ${currentBalance + amount}`);
        } catch (err) {
            console.error("DATABASE ERROR:", err);
        }
    }
    res.sendStatus(200);
});

const PORT = process.env.PORT || 10000;
app.listen(PORT, () => console.log(`Server listening on port ${PORT}`));
