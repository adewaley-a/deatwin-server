const express = require('express');
const admin = require('firebase-admin');
const crypto = require('crypto');
const app = express();

// You will download this file from Firebase Settings (Step 2 below)
const serviceAccount = require("./serviceAccountKey.json");

admin.initializeApp({
  credential: admin.credential.cert(serviceAccount)
});

app.use(express.json());

app.post('/paystack-webhook', async (req, res) => {
  const secret = process.env.PAYSTACK_SECRET_KEY;
  const signature = req.headers['x-paystack-signature'];
  
  const hash = crypto.createHmac('sha512', secret)
                     .update(JSON.stringify(req.body))
                     .digest('hex');

  if (hash !== signature) return res.status(401).send('Unauthorized');

  const event = req.body;
  if (event.event === 'charge.success') {
    const { reference, amount, customer } = event.data;
    const amountInNaira = amount / 100;
    const db = admin.firestore();

    await db.runTransaction(async (t) => {
      const paymentRef = db.collection('payments').doc(reference);
      const payDoc = await t.get(paymentRef);
      if (payDoc.exists) return;

      const userQuery = await db.collection('users').where('email', '==', customer.email).limit(1).get();
      if (!userQuery.empty) {
        const userDoc = userQuery.docs[0];
        t.set(paymentRef, { uid: userDoc.id, amount: amountInNaira, status: 'success' });
        t.update(userDoc.ref, { wallet_balance: admin.firestore.FieldValue.increment(amountInNaira) });
      }
    });
  }
  res.status(200).send('OK');
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Server running on port ${PORT}`));