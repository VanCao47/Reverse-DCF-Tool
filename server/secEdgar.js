// Free, no-API-key company fundamentals from SEC EDGAR's XBRL "company facts" API —
// the official primary source that every other financial data provider ultimately
// repackages. Unlike FMP's free tier, there's no per-symbol paywall: this covers
// every US company that files with the SEC, since it's public government data.
//
// SEC EDGAR has no stock price data (it's filings, not market data), so this module
// only supplies fundamentals; price comes from Twelve Data (see twelvedata.js) and
// the two are combined by the caller.
//
// SEC requires a descriptive User-Agent identifying the app (no login/key needed).
const SEC_USER_AGENT = 'ReverseDCFTool/1.0 (contact: h.van.t.cao@gmail.com)';

let tickerMapCache = null; // { TICKER: cikString }
let tickerMapFetchedAt = 0;
const TICKER_MAP_TTL_MS = 24 * 60 * 60 * 1000; // company_tickers.json changes rarely

async function loadTickerMap() {
  if (tickerMapCache && Date.now() - tickerMapFetchedAt < TICKER_MAP_TTL_MS) return tickerMapCache;

  const res = await fetch('https://www.sec.gov/files/company_tickers.json', {
    headers: { 'User-Agent': SEC_USER_AGENT },
  });
  if (!res.ok) throw new Error(`SEC ticker list returned ${res.status}.`);

  const body = await res.json();
  const map = {};
  for (const entry of Object.values(body)) {
    if (entry?.ticker && entry?.cik_str != null) {
      map[entry.ticker.toUpperCase()] = String(entry.cik_str);
    }
  }
  tickerMapCache = map;
  tickerMapFetchedAt = Date.now();
  return map;
}

function resolveCik(map, ticker) {
  const upper = ticker.toUpperCase();
  const candidates = [upper, upper.replace(/\./g, '-'), upper.replace(/\./g, ''), upper.replace(/-/g, '.')];
  for (const c of candidates) {
    if (map[c]) return map[c];
  }
  return null;
}

async function fetchCompanyFacts(cik) {
  const padded = cik.padStart(10, '0');
  const res = await fetch(`https://data.sec.gov/api/xbrl/companyfacts/CIK${padded}.json`, {
    headers: { 'User-Agent': SEC_USER_AGENT },
  });
  if (!res.ok) throw new Error(`SEC company facts returned ${res.status} for CIK ${cik}.`);
  return res.json();
}

// Returns the raw USD duration-fact array for the first tag name that has data.
function pickUsdFacts(gaap, tagNames) {
  for (const name of tagNames) {
    const facts = gaap[name]?.units?.USD;
    if (facts && facts.length) return facts;
  }
  return null;
}

function daysBetween(a, b) {
  return Math.abs((new Date(a) - new Date(b)) / (1000 * 60 * 60 * 24));
}

// Different companies tag the same balance-sheet concept under different XBRL
// elements, and some stop using a tag mid-history (switching presentation) while
// leaving old data behind. Rather than committing to one tag name, this gathers the
// most recent instant fact across ALL candidate tags, so a fresher value under a
// secondary tag name isn't shadowed by a stale value under the "preferred" one.
function latestFactAcrossTags(gaap, tagNames) {
  let best = null;
  for (const name of tagNames) {
    const facts = gaap[name]?.units?.USD;
    if (!facts || !facts.length) continue;
    const latest = [...facts].sort((a, b) => new Date(b.end) - new Date(a.end))[0];
    if (!best || new Date(latest.end) > new Date(best.end)) best = latest;
  }
  return best; // { val, end, ... } or null
}

function factAtDate(gaap, tagNames, endDate) {
  for (const name of tagNames) {
    const facts = gaap[name]?.units?.USD;
    if (!facts) continue;
    const match = facts.find((f) => f.end === endDate);
    if (match) return match.val;
  }
  return null;
}

// Resolves a single instant-fact figure (cash, or the fallback branch of debt) as
// the most recent value across candidate tags, discarding it if it's too stale
// relative to the rest of this company's data (a multi-year-old figure would be
// misleading presented as "current").
function resolveInstant(gaap, tagNames, referenceDate, maxAgeDays = 400) {
  const latest = latestFactAcrossTags(gaap, tagNames);
  if (!latest) return null;
  if (referenceDate && daysBetween(latest.end, referenceDate) > maxAgeDays) return null;
  return latest.val;
}

// Total debt has no single consistent XBRL tag across companies. Prefers a
// noncurrent+current split (summed at the SAME balance-sheet date, since they'd be
// meaningless combined from different dates), but falls back to whichever
// combined-total tag has the most recent data if that's fresher. Discards the
// result entirely if it's too stale to trust.
function resolveTotalDebt(gaap, referenceDate, maxAgeDays = 400) {
  const noncurrentLatest = latestFactAcrossTags(gaap, ['LongTermDebtNoncurrent']);
  const combinedLatest = latestFactAcrossTags(gaap, ['LongTermDebt', 'DebtLongtermAndShorttermCombinedAmount']);

  let best = null;
  if (noncurrentLatest) {
    const currentAtSameDate = factAtDate(gaap, ['LongTermDebtCurrent', 'DebtCurrent'], noncurrentLatest.end) || 0;
    best = { val: noncurrentLatest.val + currentAtSameDate, end: noncurrentLatest.end };
  }
  if (combinedLatest && (!best || new Date(combinedLatest.end) > new Date(best.end))) {
    best = { val: combinedLatest.val, end: combinedLatest.end };
  }

  if (!best) return null;
  if (referenceDate && daysBetween(best.end, referenceDate) > maxAgeDays) return null;
  return best.val;
}

// Reconstructs a trailing-twelve-month figure from XBRL duration facts. Within a
// fiscal year, 10-Q filings report cumulative year-to-date values (not clean
// per-quarter amounts), so: TTM = latest full fiscal year (10-K)
//                                + year-to-date since then
//                                - the same year-to-date period a year earlier.
// This is the standard technique for deriving TTM from quarterly SEC filings.
function computeTTM(facts) {
  if (!facts || facts.length === 0) return null;

  const dedup = new Map();
  for (const f of facts) dedup.set(`${f.start}|${f.end}`, f);
  const list = [...dedup.values()];

  const fiscalYears = list.filter((f) => f.form?.startsWith('10-K'));
  if (fiscalYears.length === 0) return null;
  const latestFY = fiscalYears.reduce((a, b) => (new Date(b.end) > new Date(a.end) ? b : a));

  const newer = list.filter((f) => new Date(f.start) > new Date(latestFY.start));
  if (newer.length === 0) return latestFY.val;
  const latestYTD = newer.reduce((a, b) => (new Date(b.end) > new Date(a.end) ? b : a));

  const targetDuration = daysBetween(latestYTD.start, latestYTD.end);
  const priorCandidates = list.filter((f) => f.start === latestFY.start && f !== latestYTD);
  if (priorCandidates.length === 0) return latestFY.val;

  const priorYTD = priorCandidates.reduce((a, b) => {
    const da = Math.abs(daysBetween(a.start, a.end) - targetDuration);
    const db = Math.abs(daysBetween(b.start, b.end) - targetDuration);
    return db < da ? b : a;
  });

  return latestFY.val + latestYTD.val - priorYTD.val;
}

function latestEndDate(facts) {
  if (!facts || facts.length === 0) return null;
  return [...facts].sort((a, b) => new Date(b.end) - new Date(a.end))[0].end;
}

// Fetches TTM free cash flow, shares outstanding, total debt, and cash for a ticker
// from SEC EDGAR alone. No price/market cap — combine with a price source.
async function fetchSecEdgarFundamentals(ticker) {
  const map = await loadTickerMap();
  const cik = resolveCik(map, ticker);
  if (!cik) throw new Error(`No SEC EDGAR filer found for "${ticker}".`);

  const data = await fetchCompanyFacts(cik);
  const gaap = data.facts?.['us-gaap'] || {};
  const dei = data.facts?.dei || {};

  const ocfFacts = pickUsdFacts(gaap, [
    'NetCashProvidedByUsedInOperatingActivities',
    'NetCashProvidedByUsedInOperatingActivitiesContinuingOperations',
  ]);
  const capexFacts = pickUsdFacts(gaap, [
    'PaymentsToAcquirePropertyPlantAndEquipment',
    'PaymentsForCapitalImprovements',
    'PaymentsToAcquireProductiveAssets',
  ]);

  const ttmOperatingCashFlow = computeTTM(ocfFacts);
  const ttmCapexRaw = computeTTM(capexFacts); // XBRL reports payments as positive outflows
  const ttmCapex = ttmCapexRaw != null ? -Math.abs(ttmCapexRaw) : null; // normalize to negative, matching FMP/Yahoo
  const ttmFreeCashFlow = ttmOperatingCashFlow != null && ttmCapex != null ? ttmOperatingCashFlow + ttmCapex : null;

  const asOf = latestEndDate(ocfFacts);

  const cashAndEquivalents = resolveInstant(
    gaap,
    ['CashAndCashEquivalentsAtCarryingValue', 'CashCashEquivalentsRestrictedCashAndRestrictedCashEquivalents', 'Cash'],
    asOf
  );
  const totalDebt = resolveTotalDebt(gaap, asOf);

  const sharesFacts = dei.EntityCommonStockSharesOutstanding?.units?.shares || null;
  const sharesLatest = sharesFacts?.length
    ? [...sharesFacts].sort((a, b) => new Date(b.end) - new Date(a.end))[0]
    : null;
  const sharesOutstanding = sharesLatest?.val ?? null;

  return {
    ticker: ticker.toUpperCase(),
    companyName: data.entityName || ticker,
    sharesOutstanding,
    ttmFreeCashFlow,
    ttmOperatingCashFlow,
    ttmCapex,
    quartersUsed: ttmFreeCashFlow != null ? 4 : 0,
    asOf,
    beta: null,
    totalDebt,
    cashAndEquivalents,
    netDebt: totalDebt != null && cashAndEquivalents != null ? totalDebt - cashAndEquivalents : null,
  };
}

module.exports = { fetchSecEdgarFundamentals };
