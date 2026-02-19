const express = require('express');
const admin = require('firebase-admin');
const crypto = require('crypto');
const cors = require('cors');
const axios = require('axios');
const app = express();

<<<<<<< HEAD
=======
// Initialize Firebase
>>>>>>> d8a51e2 (yh server)
const serviceAccount = require("./serviceAccountKey.json");
if (!admin.apps.length) {
    admin.initializeApp({ credential: admin.credential.cert(serviceAccount) });
}
const db = admin.firestore();

<<<<<<< HEAD
app.use(cors());
app.use(express.json());

const paystack = axios.create({
    baseURL: 'https://api.paystack.co',
    headers: {
        Authorization: `Bearer ${process.env.PAYSTACK_SECRET_KEY}`,
        'Content-Type': 'application/json'
    }
});

app.post('/withdraw', async (req, res) => {
    const { userId, amount, bankCode, accountNumber } = req.body;

    try {
        const userRef = db.collection('users').doc(userId);
        let finalRecipientCode;

        // 1. Transaction to handle Firestore safely
        await db.runTransaction(async (t) => {
            const userDoc = await t.get(userRef);
            if (!userDoc.exists) throw new Error("User not found");
            const userData = userDoc.data();

            if ((userData.wallet_balance || 0) < amount) throw new Error("Insufficient balance");

            finalRecipientCode = userData.paystack_recipient_code;

            // 2. Create recipient if missing
            if (!finalRecipientCode) {
                if (!bankCode || !accountNumber) throw new Error("Bank details required for first withdrawal");
                
                const rcpt = await paystack.post('/transferrecipient', {
                    type: "nuban",
                    name: userData.username || "User",
                    account_number: accountNumber,
                    bank_code: bankCode,
                    currency: "NGN"
                });
                finalRecipientCode = rcpt.data.data.recipient_code;
                t.update(userRef, { paystack_recipient_code: finalRecipientCode });
            }

            t.update(userRef, { wallet_balance: admin.firestore.FieldValue.increment(-amount) });
        });

        // 3. Trigger Real Money Transfer
        await paystack.post('/transfer', {
            source: "balance",
            amount: amount * 100,
            recipient: finalRecipientCode
        });

        res.status(200).json({ success: true });
    } catch (error) {
        console.error("WITHDRAW ERROR:", error.response?.data || error.message);
        res.status(400).json({ success: false, message: error.message });
    }
});

// ... Webhook remains the same ...

const PORT = process.env.PORT || 10000;
app.listen(PORT, () => console.log(`Server running on ${PORT}`));
=======
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
>>>>>>> d8a51e2 (yh server)
