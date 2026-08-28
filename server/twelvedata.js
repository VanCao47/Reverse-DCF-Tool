// Free-tier Twelve Data price quote — used only as a price source. Their free plan
// doesn't include market cap, shares outstanding, or financial statements (those are
// Pro-plan-only), so this is paired with SEC EDGAR (see secEdgar.js) for the rest.
const TWELVE_DATA_BASE = 'https://api.twelvedata.com';

async function fetchQuote(symbol, apiKey) {
  const res = await fetch(`${TWELVE_DATA_BASE}/quote?symbol=${encodeURIComponent(symbol)}&apikey=${apiKey}`);
  if (!res.ok) throw new Error(`Twelve Data returned ${res.status} for "${symbol}".`);

  const data = await res.json();
  if (data.status === 'error' || data.code) {
    throw new Error(`Twelve Data error for "${symbol}": ${data.message || data.code}`);
  }

  const price = parseFloat(data.close);
  if (!Number.isFinite(price)) throw new Error(`Twelve Data had no usable price for "${symbol}".`);

  return { price, companyName: data.name || null };
}

// Tries the ticker as given, then a hyphenated share-class variant (Twelve Data's
// convention for some symbols differs from FMP/S&P's dotted notation).
async function fetchTwelveDataPrice(ticker, apiKey) {
  if (!apiKey) throw new Error('No TWELVE_DATA_API_KEY configured.');
  try {
    return await fetchQuote(ticker, apiKey);
  } catch (err) {
    const alt = ticker.replace(/\./g, '-');
    if (alt === ticker) throw err;
    return fetchQuote(alt, apiKey);
  }
}

module.exports = { fetchTwelveDataPrice };
