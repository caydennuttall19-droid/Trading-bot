const express = require('express');
const cors = require('cors');
const { v4: uuidv4 } = require('uuid');

const app = express();

// Middleware
app.use(cors());
app.use(express.json());

// ===== ENV =====
const PORT = process.env.PORT || 3000;
const API_KEY = process.env.API_KEY || "devkey";

// ===== STATE =====
let AUTO_TRADING = false;
let equity = 10000;
let wins = 0;
let losses = 0;
let tradesToday = 0;
let openTrades = {};

// ===== HELPERS =====
function calculateLevels(trade) {
  return trade.side === 'BUY'
    ? { stop: trade.entry * 0.995, tp: trade.entry * 1.01 }
    : { stop: trade.entry * 1.005, tp: trade.entry * 0.99 };
}

function validateTrade(t) {
  return t.entry && t.stop && t.tp;
}

function registerTrade(trade) {
  const id = uuidv4();
  openTrades[id] = { id, ...trade };
  return id;
}

// ===== CORE =====
async function handleTradeSignal(trade) {
  if (!AUTO_TRADING) return "OFF";

  const { stop, tp } = calculateLevels(trade);
  const t = { ...trade, stop, tp };

  if (!validateTrade(t)) return "INVALID";

  const id = registerTrade(t);
  tradesToday++;

  console.log("TRADE EXECUTED:", id, t);
  return "EXECUTED";
}

// ===== ROUTES =====
app.get('/', (req, res) => {
  res.send("🚀 Trading Bot is LIVE");
});

app.post('/api/toggle', (req, res) => {
  AUTO_TRADING = req.body.autoTrading;
  res.json({ ok: true, AUTO_TRADING });
});

app.get('/api/stats', (req, res) => {
  res.json({
    equity,
    wins,
    losses,
    tradesToday,
    status: AUTO_TRADING ? "RUNNING" : "STOPPED",
    openTrades: Object.values(openTrades)
  });
});

app.post('/webhook', async (req, res) => {
  const key = req.headers['x-api-key'];

  if (key !== API_KEY) {
    return res.status(403).json({ error: "Unauthorized" });
  }

  const result = await handleTradeSignal(req.body);
  res.json({ result });
});

// ===== START SERVER =====
app.listen(PORT, () => {
  console.log(`✅ Server running on port ${PORT}`);
});