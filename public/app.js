// ---- DOM references ----
const tickerInput = document.getElementById('ticker');
const fetchBtn = document.getElementById('fetch-btn');
const lookupStatus = document.getElementById('lookup-status');

const priceInput = document.getElementById('price');
const sharesInput = document.getElementById('shares');
const fcfInput = document.getElementById('fcf');
const marketCapDisplay = document.getElementById('market-cap-display');
const fundamentalsNote = document.getElementById('fundamentals-note');

const discountRateInput = document.getElementById('discount-rate');
const discountRateWhySummary = document.getElementById('discount-rate-why-summary');
const discountRateWhyBody = document.getElementById('discount-rate-why-body');
const terminalGrowthInput = document.getElementById('terminal-growth');
const projYearsInput = document.getElementById('proj-years');
const calcBtn = document.getElementById('calc-btn');
const calcStatus = document.getElementById('calc-status');

const resultsSection = document.getElementById('results');
const impliedGrowthEl = document.getElementById('implied-growth');
const showCalcBtn = document.getElementById('show-calc-btn');
const calcDetail = document.getElementById('calc-detail');
const cfRateLabel = document.getElementById('cf-rate-label');
const cashflowTable = document.getElementById('cashflow-table');
const bridgeTable = document.getElementById('bridge-table');
const sensitivityTable = document.getElementById('sensitivity-table');

// Extra data from the last successful fetch (beta, debt, cash) — null until a fetch succeeds.
let lastCompanyData = null;

// ---- S&P 500 ticker picker ----
// Populates a shared <datalist> so both ticker inputs autocomplete against the full
// S&P 500 constituent list (name or symbol), while still accepting any other ticker.
async function loadSp500List() {
  const datalist = document.getElementById('sp500-list');
  if (!datalist) return;
  try {
    const res = await fetch('/api/sp500');
    if (!res.ok) return;
    const companies = await res.json();
    const esc = (s) => s.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;');
    datalist.innerHTML = companies
      .map((c) => `<option value="${esc(c.symbol)}" label="${esc(c.name)}">${esc(c.name)}</option>`)
      .join('');
  } catch (err) {
    console.error('Could not load S&P 500 list', err);
  }
}
loadSp500List();

// ---- formatting helpers ----
const fmtMoney = (n) =>
  n == null || Number.isNaN(n) ? '—' : n.toLocaleString(undefined, { style: 'currency', currency: 'USD', maximumFractionDigits: 0 });
const fmtPct = (n, digits = 1) => (n == null || Number.isNaN(n) ? '—' : `${n.toFixed(digits)}%`);

function setStatus(el, message, kind) {
  el.textContent = message || '';
  el.className = 'status' + (kind ? ` ${kind}` : '');
}

// ---- fetch fundamentals ----
async function fetchCompany() {
  const ticker = tickerInput.value.trim();
  if (!ticker) {
    setStatus(lookupStatus, 'Enter a ticker symbol first.', 'error');
    return;
  }

  setStatus(lookupStatus, 'Fetching…');
  fetchBtn.disabled = true;

  try {
    const res = await fetch(`/api/company/${encodeURIComponent(ticker)}`);
    const data = await res.json();

    if (!res.ok) {
      setStatus(lookupStatus, data.error || 'Failed to fetch data.', 'error');
      return;
    }

    priceInput.value = data.price ?? '';
    sharesInput.value = data.sharesOutstanding ?? '';
    fcfInput.value = data.ttmFreeCashFlow != null ? Math.round(data.ttmFreeCashFlow) : '';

    updateMarketCapDisplay();

    lastCompanyData = data;
    if (data.suggestedDiscountRate != null) {
      discountRateInput.value = (data.suggestedDiscountRate * 100).toFixed(1);
    }
    updateDiscountRateWhySummary();
    updateDiscountRateWhyBody(data);

    const sourceLabel = data.source === 'fmp' ? 'Financial Modeling Prep' : 'Yahoo Finance';
    fundamentalsNote.textContent = `${data.companyName} — TTM free cash flow from ${data.quartersUsed} quarters ending ${data.asOf || 'unknown date'}, via ${sourceLabel}. All fields are editable before calculating.`;
    setStatus(lookupStatus, 'Loaded.', 'ok');
  } catch (err) {
    console.error(err);
    setStatus(lookupStatus, 'Network error contacting the server.', 'error');
  } finally {
    fetchBtn.disabled = false;
  }
}

function updateMarketCapDisplay() {
  const price = parseFloat(priceInput.value);
  const shares = parseFloat(sharesInput.value);
  if (Number.isFinite(price) && Number.isFinite(shares)) {
    marketCapDisplay.textContent = fmtMoney(price * shares);
  } else {
    marketCapDisplay.textContent = '—';
  }
}

// Keeps the "Why X%?" summary in sync with whatever rate is actually in the field,
// whether that came from a fetch or the user typing over it.
function updateDiscountRateWhySummary() {
  const val = parseFloat(discountRateInput.value);
  discountRateWhySummary.textContent = Number.isFinite(val) ? `Why ${fmtPct(val, 1)}?` : 'Why this rate?';
}

// Explains the CAPM basis for the fetched company's suggested rate. Only updates on
// fetch (it describes where the number came from, not live edits to the field).
function updateDiscountRateWhyBody(data) {
  if (data.beta == null || data.suggestedDiscountRate == null) {
    discountRateWhyBody.textContent = `No beta available for ${data.companyName || data.ticker} — using the generic default. Riskier, higher-beta companies should sit higher in the typical 8-11% range; stable, low-beta ones lower.`;
    return;
  }
  const rf = data.riskFreeRate * 100;
  const erp = data.equityRiskPremium * 100;
  const capm = rf + data.beta * erp;
  const wasClamped = Math.abs(capm - data.suggestedDiscountRate * 100) > 0.05;
  discountRateWhyBody.innerHTML = `For <strong>${data.companyName}</strong> (beta ${data.beta.toFixed(2)}): risk-free rate ${fmtPct(rf, 1)} + beta &times; equity risk premium (${fmtPct(erp, 1)}) = <strong>${fmtPct(capm, 1)}</strong> via CAPM${wasClamped ? ` (clamped to ${fmtPct(data.suggestedDiscountRate * 100, 1)})` : ''}. This is why the rate varies by company rather than sitting at one fixed number — a higher beta means the market demands a higher return for the extra risk.`;
}

priceInput.addEventListener('input', updateMarketCapDisplay);
sharesInput.addEventListener('input', updateMarketCapDisplay);
discountRateInput.addEventListener('input', updateDiscountRateWhySummary);
fetchBtn.addEventListener('click', fetchCompany);
tickerInput.addEventListener('keydown', (e) => {
  if (e.key === 'Enter') fetchCompany();
});

showCalcBtn.addEventListener('click', () => {
  const isHidden = calcDetail.classList.contains('hidden');
  calcDetail.classList.toggle('hidden');
  showCalcBtn.textContent = isHidden ? 'Hide calculations' : 'Show calculations';
});

updateDiscountRateWhySummary();

// ---- reverse DCF math ----
// Two-stage FCFE model: FCF grows at rate g for N years, then grows at
// terminalGrowth forever after. Returns the model's implied equity value
// (i.e. an estimate of market cap) for a given stage-1 growth rate g.
function impliedEquityValue({ fcf0, g, r, terminalGrowth, years }) {
  if (r <= terminalGrowth) return Infinity; // perpetuity blows up / is undefined
  let pv = 0;
  let fcfT = fcf0;
  for (let t = 1; t <= years; t++) {
    fcfT = fcf0 * Math.pow(1 + g, t);
    pv += fcfT / Math.pow(1 + r, t);
  }
  const terminalFcf = fcfT * (1 + terminalGrowth);
  const terminalValue = terminalFcf / (r - terminalGrowth);
  pv += terminalValue / Math.pow(1 + r, years);
  return pv;
}

// Solve for g such that impliedEquityValue(...) == targetValue, via bisection.
// Assumes impliedEquityValue is monotonically increasing in g (true for fcf0 > 0).
function solveImpliedGrowth({ fcf0, r, terminalGrowth, years, targetValue }) {
  if (!(fcf0 > 0) || !(targetValue > 0) || r <= terminalGrowth) return null;

  let lo = -0.99;
  let hi = 5.0;
  const valueAt = (g) => impliedEquityValue({ fcf0, g, r, terminalGrowth, years }) - targetValue;

  let vLo = valueAt(lo);
  let vHi = valueAt(hi);
  if (!(Number.isFinite(vLo) && Number.isFinite(vHi)) || vLo > 0 === vHi > 0) {
    return null; // target not bracketed in a sane growth range
  }

  for (let i = 0; i < 200; i++) {
    const mid = (lo + hi) / 2;
    const vMid = valueAt(mid);
    if (Math.abs(vMid) < 1e-6 * targetValue || hi - lo < 1e-9) return mid;
    if (vMid > 0 === vLo > 0) {
      lo = mid;
      vLo = vMid;
    } else {
      hi = mid;
    }
  }
  return (lo + hi) / 2;
}

function readInputs() {
  const price = parseFloat(priceInput.value);
  const shares = parseFloat(sharesInput.value);
  const fcf0 = parseFloat(fcfInput.value);
  const r = parseFloat(discountRateInput.value) / 100;
  const terminalGrowth = parseFloat(terminalGrowthInput.value) / 100;
  const years = parseInt(projYearsInput.value, 10);
  const targetValue = price * shares;
  return { price, shares, fcf0, r, terminalGrowth, years, targetValue };
}

function validate(inputs) {
  const { price, shares, fcf0, r, terminalGrowth, years, targetValue } = inputs;
  if (![price, shares, fcf0, r, terminalGrowth, years].every(Number.isFinite)) {
    return 'Fill in all fundamentals and assumptions with numbers.';
  }
  if (!(targetValue > 0)) return 'Price and shares outstanding must be positive.';
  if (!(fcf0 > 0)) return 'Base free cash flow must be positive for a reverse DCF to solve sensibly.';
  if (!(years >= 1)) return 'Projection years must be at least 1.';
  if (r <= terminalGrowth) return 'Discount rate must be greater than the terminal growth rate.';
  return null;
}

function runCalculation() {
  const inputs = readInputs();
  const error = validate(inputs);
  if (error) {
    setStatus(calcStatus, error, 'error');
    resultsSection.classList.add('hidden');
    return;
  }
  setStatus(calcStatus, '');

  const { fcf0, r, terminalGrowth, years, targetValue } = inputs;
  const impliedG = solveImpliedGrowth({ fcf0, r, terminalGrowth, years, targetValue });

  if (impliedG == null) {
    impliedGrowthEl.textContent = 'No solution';
    setStatus(calcStatus, 'Could not find an implied growth rate within a –99% to +500% range for these assumptions.', 'error');
    cashflowTable.innerHTML = '';
    bridgeTable.innerHTML = '';
    lastImpliedGrowth = null;
  } else {
    impliedGrowthEl.textContent = fmtPct(impliedG * 100, 2);
    renderCashflowTable(inputs, impliedG);
    renderBridgeTable(inputs, impliedG);
    lastImpliedGrowth = impliedG;
  }

  renderSensitivityTable(inputs, impliedG);
  resultsSection.classList.remove('hidden');
  retakeQuizBtn.classList.remove('hidden');
  updateQuizResult();
  openQuizModal();
}

// Shows the actual year-by-year discounting: projected FCF, discount factor,
// and present value for each stage-1 year, plus the terminal value, summing
// to today's market cap.
function renderCashflowTable(inputs, g) {
  const { fcf0, r, terminalGrowth, years, targetValue } = inputs;
  cfRateLabel.textContent = fmtPct(r * 100, 1);

  let html = '<thead><tr><th>Year</th><th>Cash flow / value</th><th>Discount factor</th><th>Present value</th></tr></thead><tbody>';

  let fcfT = fcf0;
  let pvSum = 0;
  for (let t = 1; t <= years; t++) {
    fcfT = fcf0 * Math.pow(1 + g, t);
    const discountFactor = 1 / Math.pow(1 + r, t);
    const pv = fcfT * discountFactor;
    pvSum += pv;
    html += `<tr><td>${t}</td><td>${fmtMoney(fcfT)}</td><td>${discountFactor.toFixed(3)}</td><td>${fmtMoney(pv)}</td></tr>`;
  }

  const terminalFcf = fcfT * (1 + terminalGrowth);
  const terminalValue = terminalFcf / (r - terminalGrowth);
  const terminalDiscountFactor = 1 / Math.pow(1 + r, years);
  const pvTerminal = terminalValue * terminalDiscountFactor;
  pvSum += pvTerminal;

  html += `<tr><td>Terminal (after year ${years})</td><td>${fmtMoney(terminalValue)}</td><td>${terminalDiscountFactor.toFixed(3)}</td><td>${fmtMoney(pvTerminal)}</td></tr>`;
  html += `<tr class="current-cell"><td colspan="3">Sum of present values</td><td>${fmtMoney(pvSum)}</td></tr>`;
  html += `<tr><td colspan="3">Today's market cap (target)</td><td>${fmtMoney(targetValue)}</td></tr>`;
  html += '</tbody>';

  cashflowTable.innerHTML = html;
}

// Bridges the solved equity value down to a per-share figure, and (if debt/cash
// data is available from the last fetch) out to an enterprise-value framing.
function renderBridgeTable(inputs, g) {
  const { fcf0, r, terminalGrowth, years, shares, price } = inputs;
  const equityValue = impliedEquityValue({ fcf0, g, r, terminalGrowth, years });
  const valuePerShare = equityValue / shares;

  let html = '<tbody>';
  html += `<tr><td>Implied equity value (sum of present values)</td><td>${fmtMoney(equityValue)}</td></tr>`;
  html += `<tr><td>&divide; Shares outstanding</td><td>${shares.toLocaleString(undefined, { maximumFractionDigits: 0 })}</td></tr>`;
  html += `<tr class="current-cell"><td>= Implied value per share</td><td>${fmtMoney(valuePerShare)}</td></tr>`;
  html += `<tr><td>Actual current price (for comparison)</td><td>${fmtMoney(price)}</td></tr>`;

  const d = lastCompanyData;
  const hasDebtData = d && d.totalDebt != null && d.cashAndEquivalents != null;
  html += '<tr class="spacer"><td colspan="2"></td></tr>';
  if (hasDebtData) {
    const enterpriseValue = equityValue + d.totalDebt - d.cashAndEquivalents;
    html += `<tr><td>Implied equity value</td><td>${fmtMoney(equityValue)}</td></tr>`;
    html += `<tr><td>+ Total debt</td><td>${fmtMoney(d.totalDebt)}</td></tr>`;
    html += `<tr><td>&minus; Cash &amp; equivalents</td><td>${fmtMoney(d.cashAndEquivalents)}</td></tr>`;
    html += `<tr class="current-cell"><td>= Implied enterprise value</td><td>${fmtMoney(enterpriseValue)}</td></tr>`;
  } else {
    html += `<tr><td colspan="2" class="na">Fetch a ticker above to see the enterprise-value bridge (needs total debt and cash from the balance sheet).</td></tr>`;
  }
  html += '</tbody>';

  bridgeTable.className = 'kv-table';
  bridgeTable.innerHTML = html;
}

function renderSensitivityTable(inputs, currentG) {
  const { fcf0, r, terminalGrowth, years, targetValue } = inputs;

  const rateSteps = [-0.02, -0.01, 0, 0.01, 0.02];
  const growthSteps = [-0.01, -0.005, 0, 0.005, 0.01];

  const rDisplay = r * 100;
  const gtDisplay = terminalGrowth * 100;

  let html = '<thead><tr><th>Discount rate \\ Terminal growth</th>';
  growthSteps.forEach((step) => {
    const col = terminalGrowth + step;
    const isCurrent = step === 0;
    html += `<th class="${isCurrent ? 'current-col' : ''}">${fmtPct(col * 100)}</th>`;
  });
  html += '</tr></thead><tbody>';

  rateSteps.forEach((rowStep) => {
    const rowR = r + rowStep;
    const isCurrentRow = rowStep === 0;
    html += `<tr><th class="${isCurrentRow ? 'current-row' : ''}">${fmtPct(rowR * 100)}</th>`;

    growthSteps.forEach((colStep) => {
      const colGt = terminalGrowth + colStep;
      const isCurrentCell = rowStep === 0 && colStep === 0;
      let cellText;
      let cellClass = '';

      if (rowR <= colGt) {
        cellText = 'n/a';
        cellClass = 'na';
      } else {
        const g = solveImpliedGrowth({ fcf0, r: rowR, terminalGrowth: colGt, years, targetValue });
        cellText = g == null ? 'n/a' : fmtPct(g * 100, 1);
        if (g == null) cellClass = 'na';
      }

      if (isCurrentCell) cellClass = (cellClass ? cellClass + ' ' : '') + 'current-cell';
      html += `<td class="${cellClass}">${cellText}</td>`;
    });

    html += '</tr>';
  });

  html += '</tbody>';
  sensitivityTable.innerHTML = html;
}

calcBtn.addEventListener('click', runCalculation);

// ---- growth-belief questionnaire ----
// Narrows a qualitative sense of "how fast does this company grow" down to a
// specific 4-point range, then compares it against the model's implied growth
// rate above. Q1 and Q3/Q4 nudge a running estimate off a generic baseline;
// Q2 anchors to a real number by running this same reverse-DCF solver on a
// reference stock the user already has an intuition for.
let lastImpliedGrowth = null; // decimal; set by runCalculation()

const quizModal = document.getElementById('quiz-modal');
const quizModalCloseBtn = document.getElementById('quiz-modal-close-btn');
const quizSkipBtn = document.getElementById('quiz-skip-btn');
const quizDoneBtn = document.getElementById('quiz-done-btn');
const retakeQuizBtn = document.getElementById('retake-quiz-btn');
const quizRefTickerInput = document.getElementById('quiz-ref-ticker');
const quizRefFetchBtn = document.getElementById('quiz-ref-fetch-btn');
const quizRefStatus = document.getElementById('quiz-ref-status');
const quizQ5Options = document.getElementById('quiz-q5-options');
const quizRangeDisplayEl = document.getElementById('quiz-range-display');
const quizCompareEl = document.getElementById('quiz-compare');

function openQuizModal() {
  quizModal.classList.remove('hidden');
}

function closeQuizModal() {
  quizModal.classList.add('hidden');
}

quizModalCloseBtn.addEventListener('click', closeQuizModal);
quizSkipBtn.addEventListener('click', closeQuizModal);
quizDoneBtn.addEventListener('click', closeQuizModal);
retakeQuizBtn.addEventListener('click', openQuizModal);

const QUIZ_BASE_RATE = 7; // percent; a generic "average company" anchor
const QUIZ_Q1_OFFSETS = { high: 10, medium: 0, low: -6 };
const QUIZ_Q2_OFFSET = { higher: 3, same: 0, slower: -3 };
const QUIZ_Q3_OFFSETS = { faster: 3, average: 0, slower: -3 };
const QUIZ_Q4_OFFSETS = { long: 3, medium: 0, short: -3 };

const quiz = { q1: null, q2: null, refGrowth: null, q3: null, q4: null, q5: null };

['quiz-q1', 'quiz-q2', 'quiz-q3', 'quiz-q4'].forEach((name) => {
  const key = name.slice(5); // 'q1' etc.
  document.querySelectorAll(`input[name="${name}"]`).forEach((el) =>
    el.addEventListener('change', () => {
      quiz[key] = el.value;
      onQuizAnswerChanged();
    })
  );
});

quizRefFetchBtn.addEventListener('click', fetchQuizReference);
quizRefTickerInput.addEventListener('keydown', (e) => {
  if (e.key === 'Enter') fetchQuizReference();
});

// Fetches the reference ticker and solves its own implied growth rate with
// this same engine, using its own CAPM-suggested discount rate and the
// terminal-growth/projection-years assumptions already set above.
async function fetchQuizReference() {
  const ticker = quizRefTickerInput.value.trim();
  if (!ticker) {
    setStatus(quizRefStatus, 'Enter a ticker symbol first.', 'error');
    return;
  }

  setStatus(quizRefStatus, 'Fetching…');
  quizRefFetchBtn.disabled = true;

  try {
    const res = await fetch(`/api/company/${encodeURIComponent(ticker)}`);
    const data = await res.json();

    if (!res.ok) {
      setStatus(quizRefStatus, data.error || 'Failed to fetch data.', 'error');
      quiz.refGrowth = null;
      return;
    }

    const r = data.suggestedDiscountRate ?? 0.09;
    const terminalGrowth = (parseFloat(terminalGrowthInput.value) || 3) / 100;
    const years = parseInt(projYearsInput.value, 10) || 10;
    const targetValue = data.marketCap ?? (data.price * data.sharesOutstanding);
    const g = solveImpliedGrowth({ fcf0: data.ttmFreeCashFlow, r, terminalGrowth, years, targetValue });

    if (g == null) {
      setStatus(quizRefStatus, `Couldn't solve an implied growth rate for ${data.companyName} with these assumptions.`, 'error');
      quiz.refGrowth = null;
    } else {
      quiz.refGrowth = g;
      setStatus(quizRefStatus, `${data.companyName}'s own implied growth rate: ${fmtPct(g * 100, 1)}.`, 'ok');
    }
  } catch (err) {
    console.error(err);
    setStatus(quizRefStatus, 'Network error contacting the server.', 'error');
    quiz.refGrowth = null;
  } finally {
    quizRefFetchBtn.disabled = false;
    onQuizAnswerChanged();
  }
}

// Combines the answered questions into a single running estimate (percent
// units). Q1 alone is enough to produce a center; Q2 only counts once a
// reference growth rate has been solved.
function computeQuizCenter() {
  const e1 = quiz.q1 != null ? QUIZ_BASE_RATE + QUIZ_Q1_OFFSETS[quiz.q1] : null;
  const e2 = quiz.q2 != null && quiz.refGrowth != null ? quiz.refGrowth * 100 + QUIZ_Q2_OFFSET[quiz.q2] : null;

  let center;
  if (e1 != null && e2 != null) center = (e1 + e2) / 2;
  else if (e1 != null) center = e1;
  else if (e2 != null) center = e2;
  else return null;

  if (quiz.q3 != null) center += QUIZ_Q3_OFFSETS[quiz.q3];
  if (quiz.q4 != null) center += QUIZ_Q4_OFFSETS[quiz.q4];
  return center;
}

// Renders three 4-point-wide bands centered on the running estimate. Whichever
// one the user picks becomes the final narrowed range.
function renderQuizQ5(center) {
  if (center == null) {
    quizQ5Options.innerHTML = '<p class="note">Answer question 1 above to see your personalized ranges.</p>';
    return;
  }

  const mid = Math.round(center);
  const bands = [
    { lo: mid - 6, hi: mid - 2 },
    { lo: mid - 2, hi: mid + 2 },
    { lo: mid + 2, hi: mid + 6 },
  ];

  quizQ5Options.innerHTML = bands
    .map((b, i) => `<label><input type="radio" name="quiz-q5" value="${i}" /><span>${fmtPct(b.lo, 0)} &ndash; ${fmtPct(b.hi, 0)}</span></label>`)
    .join('');

  quizQ5Options.querySelectorAll('input[name="quiz-q5"]').forEach((el, i) =>
    el.addEventListener('change', () => {
      quiz.q5 = bands[i];
      quizDoneBtn.disabled = false;
      updateQuizResult();
    })
  );
}

// Reflects the questionnaire's current state onto the results section: the "Your
// estimate" stat, the retake-questionnaire link, and the comparison note against
// the model's implied growth rate.
function updateQuizResult() {
  if (!quiz.q5) {
    quizRangeDisplayEl.textContent = '—';
    retakeQuizBtn.textContent = 'Take questionnaire';
    quizCompareEl.textContent = '';
    return;
  }

  const { lo, hi } = quiz.q5;
  quizRangeDisplayEl.textContent = `${fmtPct(lo, 0)} – ${fmtPct(hi, 0)}`;
  retakeQuizBtn.textContent = 'Retake questionnaire';

  if (lastImpliedGrowth != null) {
    const modelPct = lastImpliedGrowth * 100;
    if (modelPct < lo) {
      quizCompareEl.textContent = `The market is pricing in less growth than you believe in.`;
    } else if (modelPct > hi) {
      quizCompareEl.textContent = `The market is pricing in more growth than you believe in.`;
    } else {
      quizCompareEl.textContent = `Your belief and the market's pricing roughly agree.`;
    }
  } else {
    quizCompareEl.textContent = 'The model found no solution to compare against for these assumptions.';
  }
}

function onQuizAnswerChanged() {
  const center = computeQuizCenter();
  quiz.q5 = null;
  quizDoneBtn.disabled = true;
  renderQuizQ5(center);
  updateQuizResult();
}
