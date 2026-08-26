require('dotenv').config();
const path = require('path');
const express = require('express');
const { fetchYahooCompanyData } = require('./yahoo');
const sp500 = require('./sp500.json');

const app = express();
const PORT = process.env.PORT || 3000;
const FMP_API_KEY = process.env.FMP_API_KEY;
const FMP_BASE = 'https://financialmodelingprep.com/stable';

// CAPM constants used to suggest a per-company discount rate: r = riskFree + beta * ERP.
const RISK_FREE_RATE = 0.04; // approx. long-run 10-year Treasury yield
const EQUITY_RISK_PREMIUM = 0.05; // widely-used long-run US equity risk premium estimate
const MIN_SUGGESTED_RATE = 0.05;
const MAX_SUGGESTED_RATE = 0.16;

app.use(express.static(path.join(__dirname, '..', 'public')));

// GET /api/sp500 -> the full S&P 500 constituent list (ticker, name, sector), for the
// frontend's ticker-picker. Free, static, refreshed by re-running the data pull that
// generated sp500.json.
app.get('/api/sp500', (req, res) => {
  res.json(sp500);
});

function suggestedDiscountRateFor(beta) {
  if (typeof beta !== 'number' || !Number.isFinite(beta)) return null;
  const capmRate = RISK_FREE_RATE + beta * EQUITY_RISK_PREMIUM;
  return Math.min(MAX_SUGGESTED_RATE, Math.max(MIN_SUGGESTED_RATE, capmRate));
}

// Adds the fields that are the same regardless of which upstream source the raw
// fundamentals came from.
function finalize(data) {
  return {
    ...data,
    suggestedDiscountRate: suggestedDiscountRateFor(data.beta),
    riskFreeRate: RISK_FREE_RATE,
    equityRiskPremium: EQUITY_RISK_PREMIUM,
  };
}

async function describeUpstreamFailure(res, label) {
  let bodySnippet = '';
  try {
    bodySnippet = (await res.text()).slice(0, 200);
  } catch {
    // ignore — some error responses have no body
  }
  if (res.status === 402 || res.status === 403) {
    return `Financial Modeling Prep returned ${res.status} for ${label}. This symbol likely requires a paid plan on the free tier.`;
  }
  if (res.status === 429) {
    return `Financial Modeling Prep returned 429 for ${label} — you've likely hit the free tier's daily rate limit.`;
  }
  return `Financial Modeling Prep returned ${res.status} for ${label}.${bodySnippet ? ` (${bodySnippet})` : ''}`;
}

// Fetches fundamentals from Financial Modeling Prep. Throws on any failure (missing
// key, upstream error, no data) so the caller can fall back to another source.
async function fetchFromFMP(ticker) {
  if (!FMP_API_KEY) {
    throw new Error('No FMP_API_KEY configured.');
  }

  const [quoteRes, cashFlowRes, sharesFloatRes, profileRes, balanceSheetRes] = await Promise.all([
    fetch(`${FMP_BASE}/quote?symbol=${ticker}&apikey=${FMP_API_KEY}`),
    fetch(`${FMP_BASE}/cash-flow-statement?symbol=${ticker}&period=quarter&limit=4&apikey=${FMP_API_KEY}`),
    fetch(`${FMP_BASE}/shares-float?symbol=${ticker}&apikey=${FMP_API_KEY}`),
    fetch(`${FMP_BASE}/profile?symbol=${ticker}&apikey=${FMP_API_KEY}`),
    fetch(`${FMP_BASE}/balance-sheet-statement?symbol=${ticker}&period=quarter&limit=1&apikey=${FMP_API_KEY}`),
  ]);

  // Quote and cash flow are required for the tool to function at all.
  if (!quoteRes.ok) {
    throw new Error(await describeUpstreamFailure(quoteRes, `the quote lookup on "${ticker}"`));
  }
  if (!cashFlowRes.ok) {
    throw new Error(await describeUpstreamFailure(cashFlowRes, `the cash flow statement lookup on "${ticker}"`));
  }

  const quoteData = await quoteRes.json();
  const cashFlowData = await cashFlowRes.json();
  // These three are informational/optional — degrade gracefully if unavailable.
  const sharesFloatData = sharesFloatRes.ok ? await sharesFloatRes.json() : null;
  const profileData = profileRes.ok ? await profileRes.json() : null;
  const balanceSheetData = balanceSheetRes.ok ? await balanceSheetRes.json() : null;

  if (!Array.isArray(quoteData) || quoteData.length === 0) {
    throw new Error(`No quote data found for "${ticker}" on Financial Modeling Prep.`);
  }
  if (!Array.isArray(cashFlowData) || cashFlowData.length === 0) {
    throw new Error(`No cash flow statements found for "${ticker}" on Financial Modeling Prep.`);
  }

  const quote = quoteData[0];
  const sharesOutstanding =
    (Array.isArray(sharesFloatData) && sharesFloatData[0]?.outstandingShares) ||
    (quote.marketCap && quote.price ? quote.marketCap / quote.price : null);

  const ttmOperatingCashFlow = cashFlowData.reduce((sum, q) => sum + (q.operatingCashFlow || 0), 0);
  const ttmCapex = cashFlowData.reduce((sum, q) => sum + (q.capitalExpenditure || 0), 0);
  // FMP reports capitalExpenditure as a negative number (cash outflow).
  const ttmFreeCashFlow = ttmOperatingCashFlow + ttmCapex;

  const beta = Array.isArray(profileData) ? profileData[0]?.beta ?? null : null;

  const balanceSheet = Array.isArray(balanceSheetData) ? balanceSheetData[0] : null;
  const totalDebt = balanceSheet?.totalDebt ?? null;
  const cashAndEquivalents = balanceSheet?.cashAndCashEquivalents ?? null;
  const netDebt = balanceSheet?.netDebt ?? (totalDebt != null && cashAndEquivalents != null ? totalDebt - cashAndEquivalents : null);

  return {
    ticker,
    companyName: quote.name || ticker,
    price: quote.price ?? null,
    marketCap: quote.marketCap ?? null,
    sharesOutstanding: sharesOutstanding ?? null,
    ttmFreeCashFlow,
    ttmOperatingCashFlow,
    ttmCapex,
    quartersUsed: cashFlowData.length,
    asOf: cashFlowData[0].date || null,
    beta,
    totalDebt,
    cashAndEquivalents,
    netDebt,
    source: 'fmp',
  };
}

// GET /api/company/AAPL -> price, shares outstanding, TTM free cash flow, suggested
// discount rate, etc. Tries Yahoo Finance first (free, no key, covers virtually every
// US-listed stock including the full S&P 500); falls back to Financial Modeling Prep
// if an API key is configured and Yahoo didn't return usable data.
app.get('/api/company/:ticker', async (req, res) => {
  const ticker = req.params.ticker.trim().toUpperCase();
  if (!/^[A-Z0-9.\-]{1,10}$/.test(ticker)) {
    return res.status(400).json({ error: 'Invalid ticker symbol.' });
  }

  const errors = [];

  try {
    const data = await fetchYahooCompanyData(ticker);
    if (data.price > 0 && data.ttmFreeCashFlow != null) {
      return res.json(finalize(data));
    }
    errors.push('Yahoo Finance: returned no usable price/cash-flow data for this ticker.');
  } catch (err) {
    errors.push(`Yahoo Finance: ${err.message}`);
  }

  if (FMP_API_KEY) {
    try {
      const data = await fetchFromFMP(ticker);
      return res.json(finalize(data));
    } catch (err) {
      errors.push(`Financial Modeling Prep: ${err.message}`);
    }
  }

  console.error(`Failed to fetch company data for ${ticker}: ${errors.join(' | ')}`);
  res.status(502).json({ error: `Could not fetch data for "${ticker}" from any source. ${errors.join(' ')}` });
});

app.listen(PORT, () => {
  console.log(`Reverse DCF Tool running at http://localhost:${PORT}`);
});
