const express = require('express');
const axios = require('axios');
const cors = require('cors');
const path = require('path');
const app = express();

app.use(cors({ origin: '*', methods: ['GET','POST','OPTIONS'] }));
app.use(express.json());

const KEY = process.env.DARAJA_CONSUMER_KEY || process.env.DARAJA_KEY;
const SECRET = process.env.DARAJA_CONSUMER_SECRET || process.env.DARAJA_SECRET;
const PASSKEY = process.env.DARAJA_PASSKEY;
const SHORTCODE = process.env.DARAJA_SHORTCODE || process.env.SHORTCODE || "3056305";
const ENV = (process.env.DARAJA_ENV || "production").toLowerCase();
const BASE_URL = ENV === "production" ? "https://api.safaricom.co.ke" : "https://sandbox.safaricom.co.ke";
const CALLBACK_URL = process.env.CALLBACK_URL || "https://agent-backend-nio1.onrender.com/api/callback";
const TRANSACTION_TYPE = SHORTCODE === "174379" ? "CustomerPayBillOnline" : "CustomerBuyGoodsOnline";
const ADMIN_PIN = "9989#ooko";

// B2C
const B2C_KEY = process.env.B2C_CONSUMER_KEY || KEY;
const B2C_SECRET = process.env.B2C_CONSUMER_SECRET || SECRET;
const B2C_SHORTCODE = process.env.B2C_SHORTCODE || SHORTCODE;
const B2C_INITIATOR = process.env.B2C_INITIATOR || "AGENT";
const B2C_PASSWORD = process.env.B2C_PASSWORD || "";
const B2C_RESULT_URL = process.env.B2C_RESULT_URL || CALLBACK_URL;
const B2C_TIMEOUT_URL = process.env.B2C_TIMEOUT_URL || CALLBACK_URL;

let paidPhones = {};
let gameState = { status: "closed", sessionId: "SESSION-1", openedAt: null, totalCollected: 0, totalPlayers: 0 };
let plays = {};

// FIX: 079... -> 25479..., +254... -> 254..., 254... stays 254...
function cleanPhone(p) {
  p = (p || "").toString().replace(/\s/g, "");
  if (p.startsWith("+")) p = p.slice(1);
  if (p.startsWith("0")) p = "254" + p.slice(1);
  if (p.startsWith("7")) p = "254" + p;
  return p;
}
function isValidPhone(p) {
  return /^2547\d{8}$/.test(p);
}

async function getToken(key = KEY, secret = SECRET) {
  const auth = Buffer.from(`${key}:${secret}`).toString('base64');
  const res = await axios.get(`${BASE_URL}/oauth/v1/generate?grant_type=client_credentials`, { headers: { Authorization: `Basic ${auth}` } });
  return res.data.access_token;
}

// --- HEALTH ---
app.get('/api/health', (req, res) => res.json({ ok: true, game: gameState.status, env: ENV, shortcode: SHORTCODE }));

// --- GAME CONTROL ---
app.get('/api/game-state', (req, res) => res.json(gameState));

app.post('/api/game-open', (req, res) => {
  const { pin } = req.body || {};
  if (pin !== ADMIN_PIN) return res.json({ ok: false, msg: "Wrong PIN" });
  gameState = { status: "open", sessionId: "SESSION-" + Date.now(), openedAt: new Date().toISOString(), totalCollected: 0, totalPlayers: 0 };
  paidPhones = {}; plays = {};
  res.json({ ok: true, ...gameState });
});

app.post('/api/game-close', (req, res) => {
  const { pin } = req.body || {};
  if (pin !== ADMIN_PIN) return res.json({ ok: false, msg: "Wrong PIN" });
  gameState.status = "closed";
  res.json({ ok: true, ...gameState });
});

app.post('/api/game-reset', (req, res) => {
  const { pin } = req.body || {};
  if (pin !== ADMIN_PIN) return res.json({ ok: false, msg: "Wrong PIN" });
  gameState = { status: "closed", sessionId: "SESSION-" + Date.now(), openedAt: null, totalCollected: 0, totalPlayers: 0 };
  paidPhones = {}; plays = {};
  res.json({ ok: true, ...gameState });
});

// --- STK PUSH ---
app.post('/api/stk-push', async (req, res) => {
  try {
    let { phone, name } = req.body || {};
    if (!phone) return res.status(400).json({ ResponseCode: "1", ResponseDescription: "Phone required", error: "Phone required" });

    phone = cleanPhone(phone);

    // FIX: Show real reason instead of blank 400
    if (!isValidPhone(phone)) {
      return res.status(400).json({
        ResponseCode: "1",
        ResponseDescription: "Invalid phone. Use 0712345678 or 254712345678",
        error: "Invalid phone. Use 0712345678 or 254712345678",
        got: phone
      });
    }

    if ((plays[phone] || 0) >= 2) return res.json({ ResponseCode: "1", ResponseDescription: "You have already played twice for this game. Wait for next game 11AM / 8PM." });
    if (gameState.status !== "open") return res.json({ ResponseCode: "1", ResponseDescription: "Game is CLOSED. Wait for Admin to open 11AM / 8PM game." });

    if (!KEY || !SECRET || !PASSKEY) {
      return res.status(500).json({ ResponseCode: "1", ResponseDescription: "Server missing Daraja keys. Check Render Env Vars.", error: "Server missing Daraja keys" });
    }

    const token = await getToken();
    const now = new Date(Date.now() + 3 * 60 * 60 * 1000);
    const timestamp = now.toISOString().replace(/[-:T.]/g, '').slice(0, 14);
    const password = Buffer.from(`${SHORTCODE}${PASSKEY}${timestamp}`).toString('base64');
    const resp = await axios.post(`${BASE_URL}/mpesa/stkpush/v1/processrequest`, {
      BusinessShortCode: SHORTCODE, Password: password, Timestamp: timestamp,
      TransactionType: TRANSACTION_TYPE, Amount: 20, PartyA: phone, PartyB: SHORTCODE,
      PhoneNumber: phone, CallBackURL: CALLBACK_URL, AccountReference: "TOURNAMENT", TransactionDesc: "Agent Spot The Fake Entry"
    }, { headers: { Authorization: `Bearer ${token}` } });

    // Only count play AFTER Daraja accepts STK
    paidPhones[phone] = { paid: false, checkoutId: resp.data.CheckoutRequestID, name };
    plays[phone] = (plays[phone] || 0) + 1;
    res.json({ ...resp.data, playCount: plays[phone] });
  } catch (e) {
    const errData = e.response ? e.response.data : null;
    const msg = (errData && (errData.errorMessage || errData.ResponseDescription || errData.error_description)) || e.message || "STK Failed";
    console.log("STK ERROR:", e.response?.status, JSON.stringify(errData), e.message);
    // Return Daraja's real status + message so frontend can show it
    res.status(e.response?.status || 500).json({
      ResponseCode: "1",
      ResponseDescription: msg,
      error: msg,
      daraja: errData || null
    });
  }
});

app.post('/api/callback', (req, res) => {
  try {
    const cb = req.body.Body.stkCallback;
    if (cb.ResultCode === 0) {
      const rawPhone = cb.CallbackMetadata.Item.find(i => i.Name === 'PhoneNumber').Value.toString();
      const phone = cleanPhone(rawPhone);
      if (!paidPhones[phone] || !paidPhones[phone].paid) {
        paidPhones[phone] = { paid: true, ticket: cb.CheckoutRequestID, name: paidPhones[phone]?.name };
        gameState.totalCollected += 20;
        gameState.totalPlayers = Object.values(paidPhones).filter(p => p.paid).length;
      }
    }
  } catch (e) { console.log("CALLBACK ERROR", e.message); }
  res.json({ ResultCode: 0, ResultDesc: "Accepted" });
});

app.get('/api/check-payment', (req, res) => {
  let phone = cleanPhone(req.query.phone || "");
  res.json(paidPhones[phone] || { paid: false });
});

app.get('/api/plays', (req, res) => res.json({ plays, gameState }));

// --- PAY WINNERS ---
app.post('/api/pay-winners', async (req, res) => {
  const { pin, winners } = req.body || {};
  if (pin !== ADMIN_PIN) return res.json({ ok: false, msg: "Wrong PIN" });
  if (!winners || winners.length !== 3) return res.json({ ok: false, msg: "Need exactly Top 3" });
  if (!B2C_PASSWORD) {
    return res.json({ ok: true, manual: true, message: "B2C not configured in Render. Pay manually to these numbers:", winners });
  }
  try {
    const token = await getToken(B2C_KEY, B2C_SECRET);
    let results = [];
    for (let w of winners) {
      let phone = cleanPhone(w.phone);
      if (!isValidPhone(phone)) { results.push({ name: w.name, phone, amount: w.amount, res: { error: "Invalid phone" } }); continue; }
      const now = new Date(Date.now() + 3 * 60 * 60 * 1000);
      const timestamp = now.toISOString().replace(/[-:T.]/g, '').slice(0, 14);
      const sec = Buffer.from(`${B2C_SHORTCODE}${B2C_PASSWORD}${timestamp}`).toString('base64');
      const r = await axios.post(`${BASE_URL}/mpesa/b2c/v1/paymentrequest`, {
        InitiatorName: B2C_INITIATOR, SecurityCredential: sec, CommandID: "BusinessPayment",
        Amount: w.amount, PartyA: B2C_SHORTCODE, PartyB: phone, Remarks: "Agent Spot The Fake Winner",
        QueueTimeOutURL: B2C_TIMEOUT_URL, ResultURL: B2C_RESULT_URL, Occassion: "WINNER"
      }, { headers: { Authorization: `Bearer ${token}` } });
      results.push({ name: w.name, phone, amount: w.amount, res: r.data });
    }
    res.json({ ok: true, results });
  } catch (e) { res.json({ ok: false, msg: e.response?.data?.errorMessage || e.message }); }
});

// Static LAST - so it never hijacks /api routes
app.use(express.static(__dirname));

// ROOT - Player face, MUST be after API routes, before listen
app.get('/', (req, res) => res.sendFile(path.join(__dirname, 'index.html')));

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log("Running on " + PORT + " | Env: " + ENV + " | Shortcode: " + SHORTCODE));
