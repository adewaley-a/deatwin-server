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

/**
 * SECURE LOCK-IN AND ESCROW (Optimized for Speed)
 */
app.post('/lock-in-bet', async (req, res) => {
    const { roomId } = req.body;

    try {
        const roomRef = db.collection('rooms').doc(roomId);
        const roomDoc = await roomRef.get();
        
        if (!roomDoc.exists) throw new Error("Room not found");
        const data = roomDoc.data();

        // 1. Prevent double-charging if the room is already active
        if (data.status === "active") {
            return res.status(200).json({ success: true, message: "Already active" });
        }

        // 2. Check if both players have voted and votes match
        const voteValues = Object.values(data.votes || {});
        if (voteValues.length !== 2 || voteValues[0] !== voteValues[1]) {
            throw new Error("Votes do not match yet");
        }

        const stake = voteValues[0]; 
        const totalStake = stake * 2;
        const prizePool = totalStake * 0.8;
        const adminCommission = totalStake * 0.2;

        // 3. FAST ACTIVATE: Update room status first to trigger frontend navigation
        await roomRef.update({
            status: "active",
            entryFee: stake,
            prizePool: prizePool,
            activatedAt: admin.firestore.FieldValue.serverTimestamp()
        });

        // 4. Respond to frontend immediately so players see the game start
        res.status(200).json({ success: true });

        // 5. BACKGROUND PROCESSING: Deduct money using a Batch write
        const hostRef = db.collection('users').doc(data.hostId);
        const guestRef = db.collection('users').doc(data.guestId);
        const adminRef = db.collection('admin').doc('finances');

        const batch = db.batch();
        batch.update(hostRef, { wallet_balance: admin.firestore.FieldValue.increment(-stake) });
        batch.update(guestRef, { wallet_balance: admin.firestore.FieldValue.increment(-stake) });
        batch.set(adminRef, {
            total_commission: admin.firestore.FieldValue.increment(adminCommission),
            lastUpdate: admin.firestore.FieldValue.serverTimestamp()
        }, { merge: true });

        await batch.commit();
        console.log(`Transaction for Room ${roomId} finalized in background.`);

    } catch (error) {
        console.error("LOCK-IN ERROR:", error.message);
        if (!res.headersSent) {
            res.status(400).json({ success: false, message: error.message });
        }
    }
});

const paystack = axios.create({
    baseURL: 'https://api.paystack.co',
    headers: {
        Authorization: `Bearer ${process.env.PAYSTACK_SECRET_KEY}`,
        'Content-Type': 'application/json'
    }
});

/**
 * 1. INITIALIZE PAYMENT
 */
app.post('/initialize-payment', async (req, res) => {
    const { email, amount } = req.body;
    try {
        const response = await paystack.post('/transaction/initialize', {
            email,
            amount: Math.round(amount * 100), 
            callback_url: "https://deatwin.netlify.app/second-page", 
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
        res.status(200).json({ url: response.data.data.authorization_url });
    } catch (error) {
        console.error("Payment Init Error:", error.response?.data || error.message);
        res.status(500).json({ success: false, message: "Could not generate payment link" });
    }
});

/**
 * 2. PAYSTACK WEBHOOK
 */
app.post('/paystack-webhook', async (req, res) => {
    const hash = crypto.createHmac('sha512', process.env.PAYSTACK_SECRET_KEY)
                       .update(JSON.stringify(req.body))
                       .digest('hex');

    if (hash !== req.headers['x-paystack-signature']) return res.sendStatus(400);

    const event = req.body;
    if (event.event === 'charge.success') {
        const amountNaira = event.data.amount / 100;
        const customerEmail = event.data.customer.email;

        try {
            const usersRef = db.collection('users');
            const snapshot = await usersRef.where('email', '==', customerEmail).limit(1).get();

            if (!snapshot.empty) {
                await snapshot.docs[0].ref.update({
                    wallet_balance: admin.firestore.FieldValue.increment(amountNaira)
                });
            }
        } catch (err) {
            console.error("Database Update Error:", err);
        }
    }
    res.sendStatus(200);
});

/**
 * 3. WITHDRAWAL LOGIC
 */
app.post('/withdraw', async (req, res) => {
    const { userId, amount, bankCode, accountNumber } = req.body;

    try {
        const userRef = db.collection('users').doc(userId);
        let finalRecipientCode;

        await db.runTransaction(async (t) => {
            const userDoc = await t.get(userRef);
            if (!userDoc.exists) throw new Error("User not found");
            const userData = userDoc.data();

            if ((userData.wallet_balance || 0) < amount) throw new Error("Insufficient balance");

            finalRecipientCode = userData.paystack_recipient_code;

            if (!finalRecipientCode) {
                if (!bankCode || !accountNumber) throw new Error("Bank details required");
                
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

const PORT = process.env.PORT || 10000;
app.listen(PORT, () => console.log(`Staking Server running on ${PORT}`));