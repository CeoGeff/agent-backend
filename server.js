const express = require('express');
const axios = require('axios');
const cors = require('cors');
const app = express();
app.use(cors());
app.use(express.json());
app.use(express.static(__dirname));

// --- ENV - matches your Render names exactly ---
const KEY = process.env.DARAJA_CONSUMER_KEY || process.env.DARAJA_KEY;
const SECRET = process.env.DARAJA_CONSUMER_SECRET || process.env.DARAJA_SECRET;
const PASSKEY = process.env.DARAJA_PASSKEY;
const SHORTCODE = process.env.DARAJA_SHORTCODE || process.env.SHORTCODE || "3056305";
const ENV = (process.env.DARAJA_ENV || "production").toLowerCase();
const BASE_URL = ENV === "production"
  ? "https://api.safaricom.co.ke"
  : "https://sandbox.safaricom.co.ke";
const CALLBACK_URL = process.env.CALLBACK_URL || "https://agent-backend-nio1.onrender.com/api/callback";

// Till = Buy Goods, Paybill/Test Till = Pay Bill
const TRANSACTION_TYPE = SHORTCODE === "174379" ? "CustomerPayBillOnline" : "CustomerBuyGoodsOnline";

let paidPhones = {};

async function getToken() {
  if (!KEY || !SECRET) throw new Error("Missing DARAJA_CONSUMER_KEY / DARAJA_CONSUMER_SECRET in Render");
  const auth = Buffer.from(`${KEY}:${SECRET}`).toString('base64');
  const res = await axios.get(`${BASE_URL}/oauth/v1/generate?grant_type=client_credentials`, {
    headers: { Authorization: `Basic ${auth}` }
  });
  return res.data.access_token;
}

app.post('/api/stk-push', async (req, res) => {
  try {
    let { phone, name } = req.body || {};
    if (!phone) return res.json({ ResponseCode: "1", ResponseDescription: "Phone required" });

    // 07... / 7... / +254... -> 254...
    phone = phone.toString().replace(/\s/g, "");
    if (phone.startsWith("+")) phone = phone.slice(1);
    if (phone.startsWith("0")) phone = "254" + phone.slice(1);
    if (phone.startsWith("7")) phone = "254" + phone;

    console.log("STK REQUEST:", phone, name, "Shortcode:", SHORTCODE, "Env:", ENV, "Type:", TRANSACTION_TYPE);

    const token = await getToken();

    // Daraja timestamp must be East Africa Time (UTC+3)
    const now = new Date(Date.now() + 3 * 60 * 60 * 1000);
    const timestamp = now.toISOString().replace(/[-:T.]/g, '').slice(0, 14);
    const password = Buffer.from(`${SHORTCODE}${PASSKEY}${timestamp}`).toString('base64');

    const resp = await axios.post(`${BASE_URL}/mpesa/stkpush/v1/processrequest`, {
      BusinessShortCode: SHORTCODE,
      Password: password,
      Timestamp: timestamp,
      TransactionType: TRANSACTION_TYPE,
      Amount: 20,
      PartyA: phone,
      PartyB: SHORTCODE,
      PhoneNumber: phone,
      CallBackURL: CALLBACK_URL,
      AccountReference: "TOURNAMENT",
      TransactionDesc: "Agent Spot The Fake Entry"
    }, { headers: { Authorization: `Bearer ${token}` } });

    console.log("STK SUCCESS:", resp.data);
    paidPhones[phone] = { paid: false, checkoutId: resp.data.CheckoutRequestID, name };
    res.json(resp.data);
  } catch (e) {
    const errData = e.response ? e.response.data : null;
    console.log("STK ERROR:", errData || e.message);
    res.json({
      ResponseCode: "1",
      ResponseDescription: (errData && (errData.errorMessage || errData.ResponseDescription)) || e.message || "STK Failed - Check Render Logs"
    });
  }
});

app.post('/api/callback', (req, res) => {
  try {
    console.log("CALLBACK:", JSON.stringify(req.body));
    const cb = req.body.Body.stkCallback;
    if (cb.ResultCode === 0) {
      const phone = cb.CallbackMetadata.Item.find(i => i.Name === 'PhoneNumber').Value.toString();
      paidPhones[phone] = { paid: true, ticket: cb.CheckoutRequestID };
    } else {
      console.log("CALLBACK FAILED:", cb.ResultDesc);
    }
  } catch (e) { console.log("CALLBACK ERROR:", e.message); }
  res.json({ ResultCode: 0, ResultDesc: "Accepted" });
});

app.get('/api/check-payment', (req, res) => {
  let phone = (req.query.phone || "").toString();
  if (phone.startsWith("0")) phone = "254" + phone.slice(1);
  if (phone.startsWith("+")) phone = phone.slice(1);
  res.json(paidPhones[phone] || { paid: false });
});

app.get('/', (req, res) => res.send("Agent Backend Running - Env: " + ENV + " Shortcode: " + SHORTCODE));

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log("Running on " + PORT + " | Env: " + ENV + " | Shortcode: " + SHORTCODE));
