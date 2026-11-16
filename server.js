// AGENT Spot The Fake - Backend - Real Daraja STK Push
const express = require('express');
const axios = require('axios');
const cors = require('cors');
const app = express();

app.use(cors());
app.use(express.json());

// --- Config from Render Environment ---
const CONSUMER_KEY = process.env.DARAJA_CONSUMER_KEY;
const CONSUMER_SECRET = process.env.DARAJA_CONSUMER_SECRET;
const PASSKEY = process.env.DARAJA_PASSKEY;
const SHORTCODE = process.env.DARAJA_SHORTCODE || '3056305';
const ENV = (process.env.DARAJA_ENV || 'production').toLowerCase();
const CALLBACK_URL = process.env.CALLBACK_URL || 'https://agent-backend-nio1.onrender.com/api/callback';
const ADMIN_PIN = '9989#ooko';

// --- Game State ---
let game = { status: 'closed', totalCollected: 0, players: [], winners: [] };

// --- Health Check ---
app.get('/api/health', (req, res) => {
  res.json({ ok: true, game: game.status, env: ENV, shortcode: SHORTCODE, hasKey: !!CONSUMER_KEY, hasSecret: !!CONSUMER_SECRET, hasPasskey: !!PASSKEY, totalCollected: game.totalCollected });
});

// --- Game Status for Admin / Player ---
app.get('/api/game', (req, res) => {
  res.json(game);
});

// --- Admin Open / Close ---
app.post('/api/admin/open', (req, res) => {
  if (req.body.pin !== ADMIN_PIN) return res.status(401).json({ ok: false, error: 'Wrong PIN' });
  game.status = 'open';
  res.json({ ok: true, game });
});

app.post('/api/admin/close', (req, res) => {
  if (req.body.pin !== ADMIN_PIN) return res.status(401).json({ ok: false, error: 'Wrong PIN' });
  game.status = 'closed';
  res.json({ ok: true, game });
});

app.post('/api/admin/reset', (req, res) => {
  if (req.body.pin !== ADMIN_PIN) return res.status(401).json({ ok: false, error: 'Wrong PIN' });
  game = { status: game.status, totalCollected: 0, players: [], winners: [] };
  res.json({ ok: true, game });
});

// --- Daraja Token ---
async function getToken() {
  const base = ENV === 'production' ? 'https://api.safaricom.co.ke' : 'https://sandbox.safaricom.co.ke';
  const auth = Buffer.from(`${CONSUMER_KEY}:${CONSUMER_SECRET}`).toString('base64');
  const r = await axios.get(`${base}/oauth/v1/generate?grant_type=client_credentials`, { headers: { Authorization: `Basic ${auth}` } });
  return { token: r.data.access_token, base };
}

// --- PAY - Real STK Push ---
app.post('/api/pay', async (req, res) => {
  try {
    let { name, phone } = req.body;
    const amount = 20;
    if (game.status !== 'open') return res.status(400).json({ ok: false, error: 'Game is CLOSED. Ask Admin to OPEN.' });
    if (!name || !phone) return res.status(400).json({ ok: false, error: 'Name and Phone are required' });
    if (!CONSUMER_KEY || !CONSUMER_SECRET || !PASSKEY) return res.status(500).json({ ok: false, error: 'Daraja keys missing in Render Environment' });

    // Normalize phone: 079... -> 25479..., 25479... stays, +25479... -> 25479...
    phone = String(phone).replace(/\s/g, '').replace(/^\+/, '');
    if (/^0/.test(phone)) phone = '254' + phone.slice(1);
    if (!/^254[17]\d{8}$/.test(phone)) return res.status(400).json({ ok: false, error: 'Use a valid Safaricom number like 0798892857' });

    const { token, base } = await getToken();

    // Kenya time (UTC + 3) for Daraja timestamp: YYYYMMDDHHMMSS
    const now = new Date(Date.now() + 3 * 60 * 60 * 1000);
    const timestamp = now.toISOString().replace(/[-:TZ.]/g, '').slice(0, 14);
    const password = Buffer.from(`${SHORTCODE}${PASSKEY}${timestamp}`).toString('base64');

    const payload = {
      BusinessShortCode: SHORTCODE,
      Password: password,
      Timestamp: timestamp,
      TransactionType: 'CustomerBuyGoodsOnline',
      Amount: amount,
      PartyA: phone,
      PartyB: SHORTCODE,
      PhoneNumber: phone,
      CallBackURL: CALLBACK_URL,
      AccountReference: 'AGENT',
      TransactionDesc: 'AGENT Spot The Fake Tournament'
    };

    const r = await axios.post(`${base}/mpesa/stkpush/v1/processrequest`, payload, { headers: { Authorization: `Bearer ${token}` } });

    // Save pending player
    game.players.push({ name, phone, amount, checkoutId: r.data.CheckoutRequestID, paid: false, time: new Date().toISOString() });
    res.json({ ok: true, checkoutId: r.data.CheckoutRequestID, message: 'STK sent. Enter PIN on your phone.' });
  } catch (e) {
    console.log('PAY ERROR:', e.response?.data || e.message);
    const d = e.response?.data;
    res.status(400).json({ ok: false, error: d ? (d.errorMessage || d.ResponseDescription || JSON.stringify(d)) : e.message });
  }
});

// --- Callback from Safaricom ---
app.post('/api/callback', (req, res) => {
  try {
    const stk = req.body?.Body?.stkCallback;
    if (!stk) return res.json({ ok: true });
    const checkoutId = stk.CheckoutRequestID;
    const player = game.players.find(p => p.checkoutId === checkoutId);
    if (player && stk.ResultCode === 0) {
      player.paid = true;
      game.totalCollected += player.amount;
      console.log('PAID:', player.name, player.amount);
    } else {
      console.log('CALLBACK NOT PAID:', stk.ResultCode, stk.ResultDesc);
    }
  } catch (e) { console.log('CALLBACK ERROR', e.message); }
  res.json({ ok: true });
});

// --- Winners ---
app.post('/api/winners', (req, res) => {
  if (req.body.pin !== ADMIN_PIN) return res.status(401).json({ ok: false, error: 'Wrong PIN' });
  game.winners = req.body.winners || [];
  res.json({ ok: true });
});

// --- API 404 - Must return JSON, never HTML ---
app.use('/api', (req, res) => {
  res.status(404).json({ ok: false, error: 'API not found: ' + req.path });
});

// --- Static Files LAST ---
app.use(express.static(__dirname));

const PORT = process.env.PORT || 10000;
app.listen(PORT, () => console.log('AGENT Backend Live on', PORT, 'Env:', ENV, 'Shortcode:', SHORTCODE));
