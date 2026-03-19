const Alpaca = require('@alpacahq/alpaca-trade-api');

const alpaca = new Alpaca({
  keyId: process.env.ALPACA_KEY,
  secretKey: process.env.ALPACA_SECRET,
  paper: true // KEEP THIS TRUE (safe mode)
});
const express = require('express');
const cors = require('cors');
const fs = require('fs');
const { v4: uuidv4 } = require('uuid');

const app = express();
app.use(cors());
app.use(express.json());

/* ======================
   ENV
====================== */
const PORT = process.env.PORT || 3000;
const API_KEY = process.env.API_KEY || "supersecret123";

/* ======================
   GLOBAL STATE
====================== */
let AUTO_TRADING = false;
let SAFE_MODE = false;
let isExecuting = false;

let ACCOUNT_SIZE = 10000;
let equity = ACCOUNT_SIZE;

let equityCurve = [ACCOUNT_SIZE];
let openTrades = {};
let recentSignals = new Set();
let tradeQueue = [];

let wins = 0;
let losses = 0;
let totalPnL = 0;
let tradesToday = 0;
let dailyLoss = 0;

let lastTick = Date.now();

/* ======================
   RISK SETTINGS
====================== */
let MAX_TRADES_PER_DAY = 5;
let MAX_DAILY_LOSS = 3;

/* ======================
   UTIL
====================== */
function logResult(status, trade) {
  console.log(JSON.stringify({ status, symbol: trade?.symbol }));
  return status;
}

function normalize(value, min, max) {
  if (typeof value !== 'number' || isNaN(value)) return min;
  return Math.max(min, Math.min(max, value));
}

/* ======================
   STATE SAVE
====================== */
function saveState() {
  fs.writeFileSync('state.json', JSON.stringify({
    openTrades,
    equity,
    equityCurve,
    stats: { wins, losses }
  }));
}

function loadState() {
  if (fs.existsSync('state.json')) {
    const data = JSON.parse(fs.readFileSync('state.json'));
    openTrades = data.openTrades || {};
    equity = data.equity || ACCOUNT_SIZE;
    equityCurve = data.equityCurve || [];
    wins = data.stats?.wins || 0;
    losses = data.stats?.losses || 0;
  }
}

/* ======================
   CORE LOGIC
====================== */
function isDuplicate(trade) {
  const key = `${trade.symbol}-${trade.side}-${Math.round(trade.entry)}`;
  if (recentSignals.has(key)) return true;
  recentSignals.add(key);
  setTimeout(() => recentSignals.delete(key), 60000);
  return false;
}

function calculateLevels(trade) {
  const risk = 0.005;
  return trade.side === 'BUY'
    ? { stop: trade.entry * (1 - risk), tp: trade.entry * (1 + risk * 2) }
    : { stop: trade.entry * (1 + risk), tp: trade.entry * (1 - risk * 2) };
}

function applyCosts(trade) {
  const slip = trade.entry * 0.0005;
  trade.entry += trade.side === 'BUY' ? slip : -slip;
  return trade;
}

function validateTrade(t) {
  return t.entry && t.stop && t.tp;
}

function getRR(t) {
  return t.side === 'BUY'
    ? (t.tp - t.entry) / (t.entry - t.stop)
    : (t.entry - t.tp) / (t.stop - t.entry);
}

function getDrawdown() {
  const peak = Math.max(...equityCurve);
  return ((peak - equity) / peak) * 100;
}

function enhancedScore({ trendStrength, volume, breakoutStrength, rr }) {
  return (
    normalize(trendStrength, 0, 1) * 30 +
    normalize(volume, 0, 3) * 20 +
    normalize(breakoutStrength, 0, 1) * 20 +
    normalize(rr, 0, 5) * 30
  );
}

function registerTrade(trade) {
  const id = uuidv4();
  openTrades[id] = { id, ...trade };
  saveState();
  return id;
}

/* ======================
   EXECUTION
====================== */
async function executeTrade(trade) {
  try {
    const order = await alpaca.createOrder({
      symbol: trade.symbol,
      qty: 1,
      side: trade.side.toLowerCase(),
      type: 'market',
      time_in_force: 'gtc'
    });

    console.log('✅ ORDER PLACED:', order);
    console.log("🚀 EXECUTED:", trade.symbol);

    return { filled: true, price: trade.entry };

  } catch (err) {
    console.error('❌ ORDER FAILED:', err.message);
    return { filled: false };
  }
}

/* ======================
   MAIN ENGINE
====================== */
async function handleTradeSignal(trade, headers) {
  const key = headers['x-api-key'] || trade.apiKey;

  // if (key !== API_KEY) return "Unauthorized";
  if (!AUTO_TRADING) return "OFF";

  // ✅ RISK CONTROLS
  if (tradesToday >= MAX_TRADES_PER_DAY)
    return "DAILY_LIMIT";

  if (dailyLoss >= MAX_DAILY_LOSS) {
    AUTO_TRADING = false;
    return "MAX_LOSS_STOP";
  }

  if (!trade.symbol || !trade.entry || !trade.side)
    return logResult("INVALID", trade);

  if (isDuplicate(trade))
    return logResult("DUPLICATE", trade);

  const { stop, tp } = calculateLevels(trade);
  let t = applyCosts({ ...trade, stop, tp });

  if (!validateTrade(t))
    return logResult("INVALID_TRADE", trade);

  const rr = getRR(t);
  if (rr < 1.5)
    return logResult("LOW_RR", trade);

  const score = enhancedScore({
    trendStrength: trade.trend || 0.5,
    volume: trade.volume || 1,
    breakoutStrength: trade.breakout || 0.5,
    rr
  });

  if (score < 60)
    return logResult("LOW_SCORE", trade);

  if (getDrawdown() > 8) {
    AUTO_TRADING = false;
    return "DD_STOP";
  }

  if (isExecuting) return "LOCKED";

  const id = registerTrade(t);

  isExecuting = true;
  const success = await executeTrade({ ...t, id });
  isExecuting = false;

  tradesToday++;

  return success ? "EXECUTED" : "FAIL";
}

/* ======================
   ROUTES
====================== */
app.get('/', (req, res) => {
  res.send("🚀 BOT LIVE");
});

app.post('/webhook', async (req, res) => {
  const result = await handleTradeSignal(req.body, req.headers);
  res.json({ result });
});

app.post('/api/toggle', (req, res) => {
  AUTO_TRADING = req.body.autoTrading;
  res.json({ ok: true });
});

/* ======================
   START
====================== */
loadState();


app.listen(PORT, () => {
  console.log(`🚀 Running on ${PORT}`);
});

/* ======================
   TRADE ROUTE
====================== */
app.get("/trade", async (req, res) => {
  try {
    const order = await alpaca.createOrder({
      symbol: "AAPL",
      qty: 1,
      side: "buy",
      type: "market",
      time_in_force: "gtc"
    });

    res.send("Trade executed 🚀");
  } catch (err) {
    console.error(err);
    res.send("Trade failed");
  }
});