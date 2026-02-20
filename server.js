const express = require('express');
const admin = require('firebase-admin');
const crypto = require('crypto');
const cors = require('cors');
const axios = require('axios');
const app = express();


const serviceAccount = require("./serviceAccountKey.json");
if (!admin.apps.length) {
    admin.initializeApp({ credential: admin.credential.cert(serviceAccount) });
}
const db = admin.firestore();


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

// Add this above your other app.post routes
app.post('/initialize-payment', async (req, res) => {
    const { email, amount } = req.body;
    try {
        const response = await paystack.post('/transaction/initialize', {
            email,
            amount: Math.round(amount * 100), // Convert to Kobo
            callback_url: "https://deatwin.netlify.app/second-page", // CHANGE THIS to your actual site URL
            metadata: {
                custom_fields: [
                    {
                        display_name: "Action",
                        variable_name: "action",
                        value: "deposit"
                    }
                ]
            }
        });
        // Send the authorization URL back to the frontend
        res.status(200).json({ url: response.data.data.authorization_url });
    } catch (error) {
        console.error("Payment Init Error:", error.response?.data || error.message);
        res.status(500).json({ success: false, message: "Could not generate payment link" });
    }
});