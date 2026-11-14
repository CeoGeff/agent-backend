const express = require('express');
const axios = require('axios');
const cors = require('cors');
const app = express();
app.use(cors());
app.use(express.json());
app.use(express.static(__dirname));

const KEY = process.env.DARAJA_KEY;
const SECRET = process.env.DARAJA_SECRET;
const PASSKEY = process.env.DARAJA_PASSKEY;
const SHORTCODE = process.env.SHORTCODE || "174379";
const BASE_URL = process.env.DARAJA_BASE || "https://sandbox.safaricom.co.ke";

let paidPhones = {};

async function getToken(){
  const auth = Buffer.from(`${KEY}:${SECRET}`).toString('base64');
  const res = await axios.get(`${BASE_URL}/oauth/v1/generate?grant_type=client_credentials`, {
    headers: { Authorization: `Basic ${auth}` }
  });
  return res.data.access_token;
}

app.post('/api/stk-push', async (req,res)=>{
  try{
    let { phone, name } = req.body;
    if(phone.startsWith('0')) phone = '254' + phone.slice(1);
    const token = await getToken();
    const timestamp = new Date().toISOString().replace(/[-:T.]/g,'').slice(0,14);
    const password = Buffer.from(`${SHORTCODE}${PASSKEY}${timestamp}`).toString('base64');
    const resp = await axios.post(`${BASE_URL}/mpesa/stkpush/v1/processrequest`, {
      BusinessShortCode: SHORTCODE,
      Password: password,
      Timestamp: timestamp,
      TransactionType: "CustomerPayBillOnline",
      Amount: 20,
      PartyA: phone,
      PartyB: SHORTCODE,
      PhoneNumber: phone,
      CallBackURL: process.env.CALLBACK_URL,
      AccountReference: "TOURNAMENT",
      TransactionDesc: "Agent Spot The Fake Entry"
    }, { headers: { Authorization: `Bearer ${token}` } });
    paidPhones[phone] = { paid: false, checkoutId: resp.data.CheckoutRequestID, name };
    res.json(resp.data);
  }catch(e){
    res.json({ ResponseCode: "1", ResponseDescription: "STK Failed" });
  }
});

app.post('/api/callback', (req,res)=>{
  try{
    const cb = req.body.Body.stkCallback;
    if(cb.ResultCode === 0){
      const phone = cb.CallbackMetadata.Item.find(i=>i.Name==='PhoneNumber').Value.toString();
      paidPhones[phone] = { paid: true, ticket: cb.CheckoutRequestID };
    }
  }catch(e){}
  res.json({ ResultCode: 0, ResultDesc: "Accepted" });
});

app.get('/api/check-payment', (req,res)=>{
  let phone = req.query.phone || "";
  if(phone.startsWith('0')) phone = '254' + phone.slice(1);
  res.json(paidPhones[phone] || { paid: false });
});

app.get('/', (req,res)=> res.send("Agent Backend Running"));

const PORT = process.env.PORT || 3000;
app.listen(PORT, ()=> console.log("Running"));
