'use strict';
require('dotenv').config();

function safeJson(val, fallback) {
  if (!val) return fallback;
  if (Array.isArray(val)) return val;
  try { return JSON.parse(val); } catch { return fallback; }
}

async function fetchCrypto() {
  const ids = 'bitcoin,ethereum,solana,avalanche-2,chainlink,polkadot';
  const url = `https://api.coingecko.com/api/v3/coins/markets?vs_currency=usd&ids=${ids}&order=market_cap_desc&price_change_percentage=24h,7d&sparkline=false`;
  const res = await fetch(url, { headers: { Accept: 'application/json' }, signal: AbortSignal.timeout(10000) });
  if (!res.ok) throw new Error(`CoinGecko ${res.status}`);
  const data = await res.json();
  return data.map(c => ({
    symbol: c.symbol.toUpperCase(),
    name: c.name,
    price: c.current_price,
    change24h: c.price_change_percentage_24h,
    change7d: c.price_change_percentage_7d_in_currency,
    marketCap: c.market_cap,
    volume24h: c.total_volume,
  }));
}

async function fetchPolymarket() {
  try {
    const url = 'https://gamma-api.polymarket.com/markets?closed=false&limit=8&sortBy=volume24hr&sortDirection=DESC';
    const res = await fetch(url, { headers: { Accept: 'application/json' }, signal: AbortSignal.timeout(10000) });
    if (!res.ok) return [];
    const data = await res.json();
    return data.map(m => ({
      question: m.question,
      volume24h: parseFloat(m.volume24hr || 0),
      outcomes: safeJson(m.outcomes, []),
      prices: safeJson(m.outcomePrices, []),
    })).filter(m => m.question);
  } catch {
    return [];
  }
}

async function fetchStocks() {
  const key = process.env.ALPHA_VANTAGE_KEY;
  if (!key) return null;
  const symbols = ['SPY', 'QQQ', 'IWM'];
  try {
    const results = await Promise.all(symbols.map(async sym => {
      const url = `https://www.alphavantage.co/query?function=GLOBAL_QUOTE&symbol=${sym}&apikey=${key}`;
      const res = await fetch(url, { signal: AbortSignal.timeout(8000) });
      const data = await res.json();
      const q = data['Global Quote'];
      if (!q || !q['05. price']) return null;
      return {
        symbol: q['01. symbol'],
        price: parseFloat(q['05. price']),
        changePct: parseFloat(q['10. change percent']),
      };
    }));
    return results.filter(Boolean);
  } catch {
    return null;
  }
}

async function fetchSnapshot() {
  const [crypto, polymarket, stocks] = await Promise.all([
    fetchCrypto(),
    fetchPolymarket(),
    fetchStocks(),
  ]);
  return { crypto, polymarket, stocks, timestamp: new Date().toISOString() };
}

function snapshotToText(snapshot) {
  const rows = (snapshot.crypto || []).map(c => {
    const p = c.price >= 1000
      ? `$${c.price.toLocaleString('en-US', { maximumFractionDigits: 0 })}`
      : `$${c.price.toFixed(4)}`;
    const d24 = c.change24h != null ? `${c.change24h >= 0 ? '+' : ''}${c.change24h.toFixed(1)}%` : 'N/A';
    const d7 = c.change7d != null ? `${c.change7d >= 0 ? '+' : ''}${c.change7d.toFixed(1)}%` : 'N/A';
    const vol = c.volume24h >= 1e9 ? `$${(c.volume24h / 1e9).toFixed(1)}B` : `$${(c.volume24h / 1e6).toFixed(0)}M`;
    return `${c.symbol.padEnd(5)} ${p.padEnd(14)} 24h: ${d24.padEnd(8)} 7d: ${d7.padEnd(8)} Vol: ${vol}`;
  }).join('\n');

  const poly = (snapshot.polymarket || []).slice(0, 5).map(m => {
    const p = (m.prices || []).map((pr, i) =>
      `${m.outcomes[i] || '?'}: ${(parseFloat(pr) * 100).toFixed(0)}%`
    ).join(' / ');
    return `• ${m.question}\n  ${p}`;
  }).join('\n');

  let stockLines = '';
  if (snapshot.stocks && snapshot.stocks.length) {
    stockLines = '\nSTOCKS:\n' + snapshot.stocks.map(s =>
      `${s.symbol.padEnd(5)} $${s.price.toFixed(2).padEnd(10)} ${s.changePct >= 0 ? '+' : ''}${s.changePct.toFixed(2)}%`
    ).join('\n');
  }

  return `=== MARKET SNAPSHOT — ${new Date(snapshot.timestamp).toUTCString()} ===${stockLines}

CRYPTO:
${rows || '(unavailable)'}

TOP PREDICTION MARKETS (by 24h volume):
${poly || '(unavailable)'}`;
}

module.exports = { fetchSnapshot, snapshotToText };
