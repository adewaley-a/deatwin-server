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
 * SECURE LOCK-IN AND ESCROW
 * This handles the 80/20 split and starts the game
 */
app.post('/lock-in-bet', async (req, res) => {
    const { roomId, userId } = req.body;

    try {
        await db.runTransaction(async (t) => {
            const roomRef = db.collection('rooms').doc(roomId);
            const roomDoc = await t.get(roomRef);
            
            if (!roomDoc.exists) throw new Error("Room not found");
            const data = roomDoc.data();

            // 1. Check if both players have voted and votes match
            const voteValues = Object.values(data.votes || {});
            if (voteValues.length !== 2 || voteValues[0] !== voteValues[1]) {
                throw new Error("Votes do not match yet");
            }

            // 2. Prevent double-charging if the room is already active
            if (data.status === "active") return;

            const stake = voteValues[0]; // The agreed amount (e.g., 500)
            const hostRef = db.collection('users').doc(data.hostId);
            const guestRef = db.collection('users').doc(data.guestId);

            const hostSnap = await t.get(hostRef);
            const guestSnap = await t.get(guestRef);

            // 3. Verify both players have enough money
            if ((hostSnap.data().wallet_balance || 0) < stake || (guestSnap.data().wallet_balance || 0) < stake) {
                throw new Error("One or more players have insufficient balance");
            }

            // 4. Calculate 80/20 Split
            // Total Pool = stake * 2 (e.g., 500 * 2 = 1000)
            // Winner Prize (80%) = 800
            // Admin Commission (20%) = 200
            const totalStake = stake * 2;
            const prizePool = totalStake * 0.8;
            const adminCommission = totalStake * 0.2;

            // 5. Deduct money from both players
            t.update(hostRef, { 
                wallet_balance: admin.firestore.FieldValue.increment(-stake) 
            });
            t.update(guestRef, { 
                wallet_balance: admin.firestore.FieldValue.increment(-stake) 
            });

            // 6. Record commission in your admin settings
            const adminRef = db.collection('admin').doc('finances');
            t.set(adminRef, {
                total_commission: admin.firestore.FieldValue.increment(adminCommission),
                lastUpdate: admin.firestore.FieldValue.serverTimestamp()
            }, { merge: true });

            // 7. Activate the room and set the prize
            t.update(roomRef, {
                status: "active",
                entryFee: stake,
                prizePool: prizePool,
                activatedAt: admin.firestore.FieldValue.serverTimestamp()
            });
        });

        console.log(`Bet locked for Room ${roomId}. Game is now Active.`);
        res.status(200).json({ success: true });

    } catch (error) {
        console.error("LOCK-IN ERROR:", error.message);
        res.status(400).json({ success: false, message: error.message });
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
 * 2. PAYSTACK WEBHOOK (Updates Balance)
 */
app.post('/paystack-webhook', async (req, res) => {
    // SECURITY: Verify that this request actually came from Paystack
    const hash = crypto.createHmac('sha512', process.env.PAYSTACK_SECRET_KEY)
                       .update(JSON.stringify(req.body))
                       .digest('hex');

    if (hash !== req.headers['x-paystack-signature']) {
        return res.sendStatus(400); // Secret hash doesn't match
    }

    const event = req.body;

    // Only process if the payment was successful
    if (event.event === 'charge.success') {
        const amountNaira = event.data.amount / 100;
        const customerEmail = event.data.customer.email;

        try {
            const usersRef = db.collection('users');
            const snapshot = await usersRef.where('email', '==', customerEmail).limit(1).get();

            if (!snapshot.empty) {
                const userDoc = snapshot.docs[0];
                await userDoc.ref.update({
                    wallet_balance: admin.firestore.FieldValue.increment(amountNaira)
                });
                console.log(`Successfully credited ${customerEmail} with ₦${amountNaira}`);
            } else {
                console.log(`User not found for email: ${customerEmail}`);
            }
        } catch (err) {
            console.error("Database Update Error:", err);
        }
    }

    res.sendStatus(200); // Tell Paystack we received it
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
app.listen(PORT, () => console.log(`Server running on ${PORT}`));