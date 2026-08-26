// Free, no-API-key fundamentals from Yahoo Finance's public endpoints — the same ones
// the yfinance Python library scrapes. Yahoo gates these behind a session cookie +
// crumb (no login needed, just a bot-deterrent), so we do that handshake once and
// cache it for a while before reusing it on every ticker lookup.
//
// Two endpoints are combined:
//   - quoteSummary (price, defaultKeyStatistics, financialData) for price, market cap,
//     shares outstanding, beta, company name.
//   - fundamentals-timeseries for trailing-twelve-month free cash flow and the latest
//     quarterly debt/cash — the old quoteSummary cashflow/balance-sheet modules were
//     stripped down by Yahoo and no longer return this data.

let cached = null; // { cookie, crumb, fetchedAt }
const CRUMB_TTL_MS = 30 * 60 * 1000;

const BROWSER_HEADERS = {
  'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36',
};

function extractCookie(res) {
  const cookies = typeof res.headers.getSetCookie === 'function' ? res.headers.getSetCookie() : [];
  if (cookies.length > 0) return cookies.map((c) => c.split(';')[0]).join('; ');
  const single = res.headers.get('set-cookie');
  return single ? single.split(';')[0] : null;
}

async function getCrumbAndCookie() {
  if (cached && Date.now() - cached.fetchedAt < CRUMB_TTL_MS) return cached;

  const cookieRes = await fetch('https://fc.yahoo.com', { headers: BROWSER_HEADERS, redirect: 'manual' });
  const cookie = extractCookie(cookieRes);
  if (!cookie) throw new Error('Could not obtain a Yahoo Finance session cookie.');

  const crumbRes = await fetch('https://query1.finance.yahoo.com/v1/test/getcrumb', {
    headers: { ...BROWSER_HEADERS, Cookie: cookie },
  });
  const crumb = (await crumbRes.text()).trim();
  if (!crumb || crumb.includes('<html')) throw new Error('Could not obtain a Yahoo Finance crumb.');

  cached = { cookie, crumb, fetchedAt: Date.now() };
  return cached;
}

// Yahoo wraps most numeric fields as { raw, fmt } — unwrap, defaulting to null.
const raw = (v) => (v && typeof v === 'object' ? (v.raw ?? null) : v ?? null);

const QUOTE_MODULES = ['price', 'defaultKeyStatistics', 'financialData'].join(',');
const TIMESERIES_TYPES = [
  'trailingFreeCashFlow',
  'trailingOperatingCashFlow',
  'trailingCapitalExpenditure',
  'quarterlyTotalDebt',
  'quarterlyCashAndCashEquivalents',
].join(',');

async function fetchQuoteSummary(ticker, cookie, crumb) {
  const url = `https://query1.finance.yahoo.com/v10/finance/quoteSummary/${encodeURIComponent(ticker)}?modules=${QUOTE_MODULES}&crumb=${encodeURIComponent(crumb)}`;
  const res = await fetch(url, { headers: { ...BROWSER_HEADERS, Cookie: cookie } });
  if (!res.ok) throw new Error(`Yahoo Finance quote lookup returned ${res.status} for "${ticker}".`);

  const body = await res.json();
  if (body?.quoteSummary?.error) {
    throw new Error(`Yahoo Finance error for "${ticker}": ${body.quoteSummary.error.description || body.quoteSummary.error.code}`);
  }
  const result = body?.quoteSummary?.result?.[0];
  if (!result) throw new Error(`Yahoo Finance had no quote data for "${ticker}".`);
  return result;
}

// Fetches TTM free cash flow and the latest quarterly debt/cash. Returns a map of
// tag -> most recent {raw, asOfDate} entry (or null if Yahoo didn't have that tag).
async function fetchFundamentalsTimeseries(ticker, cookie, crumb) {
  const now = Math.floor(Date.now() / 1000);
  const period1 = now - 60 * 60 * 24 * 450; // ~15 months back, comfortably covers one TTM point
  const url =
    `https://query2.finance.yahoo.com/ws/fundamentals-timeseries/v1/finance/timeseries/${encodeURIComponent(ticker)}` +
    `?symbol=${encodeURIComponent(ticker)}&type=${TIMESERIES_TYPES}&period1=${period1}&period2=${now}&crumb=${encodeURIComponent(crumb)}`;
  const res = await fetch(url, { headers: { ...BROWSER_HEADERS, Cookie: cookie } });
  if (!res.ok) throw new Error(`Yahoo Finance fundamentals lookup returned ${res.status} for "${ticker}".`);

  const body = await res.json();
  const results = body?.timeseries?.result || [];

  const byTag = {};
  for (const entry of results) {
    const tag = entry?.meta?.type?.[0];
    if (!tag) continue;
    const points = (entry[tag] || []).filter(Boolean);
    const latest = points[points.length - 1];
    byTag[tag] = latest ? { value: raw(latest.reportedValue), asOfDate: latest.asOfDate } : null;
  }
  return byTag;
}

// Fetches the same shape of fundamentals as the FMP path (price, shares outstanding,
// TTM free cash flow, beta, debt, cash), sourced entirely from Yahoo Finance's free
// public endpoints. Throws on any failure so the caller can decide how to handle it.
async function fetchYahooCompanyData(ticker) {
  // Yahoo uses a hyphen for share classes (BRK-B) where FMP/S&P use a dot (BRK.B).
  const yahooTicker = ticker.replace(/\./g, '-');
  const { cookie, crumb } = await getCrumbAndCookie();
  const [quote, fundamentals] = await Promise.all([
    fetchQuoteSummary(yahooTicker, cookie, crumb),
    fetchFundamentalsTimeseries(yahooTicker, cookie, crumb),
  ]);

  const price = quote.price || {};
  const stats = quote.defaultKeyStatistics || {};
  const financialData = quote.financialData || {};

  const ttmFreeCashFlow = fundamentals.trailingFreeCashFlow?.value ?? null;
  const ttmOperatingCashFlow = fundamentals.trailingOperatingCashFlow?.value ?? null;
  const ttmCapex = fundamentals.trailingCapitalExpenditure?.value ?? null;
  const totalDebt = fundamentals.quarterlyTotalDebt?.value ?? null;
  const cashAndEquivalents = fundamentals.quarterlyCashAndCashEquivalents?.value ?? null;
  const asOf = fundamentals.trailingFreeCashFlow?.asOfDate || fundamentals.quarterlyTotalDebt?.asOfDate || null;

  return {
    ticker: ticker.toUpperCase(),
    companyName: raw(price.longName) || raw(price.shortName) || ticker,
    price: raw(price.regularMarketPrice),
    marketCap: raw(price.marketCap),
    sharesOutstanding: raw(stats.sharesOutstanding),
    ttmFreeCashFlow,
    ttmOperatingCashFlow,
    ttmCapex,
    quartersUsed: ttmFreeCashFlow != null ? 4 : 0,
    asOf,
    beta: raw(stats.beta) ?? raw(financialData.beta) ?? null,
    totalDebt,
    cashAndEquivalents,
    netDebt: totalDebt != null && cashAndEquivalents != null ? totalDebt - cashAndEquivalents : null,
    source: 'yahoo',
  };
}

module.exports = { fetchYahooCompanyData };
