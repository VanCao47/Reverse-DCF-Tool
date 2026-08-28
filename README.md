# Reverse DCF Tool

Given a stock's current price, works backward to solve for the free-cash-flow
growth rate the market is implicitly pricing in — the inverse of a normal DCF.

## Setup

No API key required — fundamentals are fetched for free from Yahoo Finance,
covering the full S&P 500 and effectively any other US-listed ticker.

```
npm install
npm start
```

Open http://localhost:3000

### Optional: fallback data sources

Fundamentals are tried from up to three sources in order, each only used if the
previous one fails or isn't configured:

1. **Yahoo Finance** — free, no key. Note: many cloud hosts (Render included) have
   their outbound IPs blocked by Yahoo's anti-scraping measures, so this may fail
   100% of the time once deployed even though it works fine locally.
2. **Financial Modeling Prep** — free tier, but gates some tickers (new S&P 500
   additions, spinoffs, some share classes) behind a paid plan. Configure:
   - Get a free key at https://site.financialmodelingprep.com/developer/docs.
   - Copy `.env.example` to `.env` and paste it into `FMP_API_KEY`.
3. **SEC EDGAR + Twelve Data** — free, no per-symbol restrictions. SEC EDGAR
   supplies fundamentals (TTM free cash flow, debt, cash, shares outstanding)
   straight from official filings, covering any US company that files with the
   SEC; Twelve Data supplies the stock price (SEC EDGAR has no market data of its
   own). Configure:
   - Get a free key at https://twelvedata.com/pricing (the Basic/free plan).
   - Paste it into `TWELVE_DATA_API_KEY` in `.env`.

   This source has no beta (so the discount-rate suggestion falls back to the
   generic default) and total debt is a best-effort figure — different companies
   tag debt under inconsistent XBRL line items, so it's sometimes unavailable or
   approximate; it's discarded entirely rather than shown if it looks stale.

## How it works

1. Type a ticker or company name (autocompletes against the full S&P 500) and
   click **Fetch data**. This pulls current price, shares outstanding,
   trailing-twelve-month free cash flow, beta, total debt, and cash — free,
   with no API key, from Yahoo Finance. Every field is editable afterward if
   you want to use your own numbers.
2. The discount rate defaults to a CAPM estimate for that specific company —
   risk-free rate (~4%) + beta × equity risk premium (~5%) — rather than one
   fixed number for every company; typically lands in the 8-11% range.
   Terminal growth rate defaults to 3% (approximating long-run US nominal GDP
   growth). Both are editable, with a "why?" note explaining the reasoning.
3. Click **Calculate implied growth**. The tool uses a two-stage FCFE model —
   free cash flow grows at rate *g* for the projection period, then at the
   terminal rate forever after — and solves for the *g* that makes the
   model's present value equal today's market cap (price × shares
   outstanding), via bisection.
4. A questionnaire pops up asking what growth rate *you* believe in (growth
   tier, comparison to a reference stock, industry peers, how long the growth
   can last), narrowing your qualitative answers down to a specific 4-point
   range. Once answered, it's shown right next to the model's implied growth
   rate for comparison — you can reopen it anytime with "Retake
   questionnaire."
5. Click **Show calculations** to see the actual math: the year-by-year
   discounting table, and a bridge from implied equity value down to
   value-per-share (compared against the actual price) and out to an implied
   enterprise value (equity value + total debt − cash).
6. The sensitivity table shows how the implied growth rate shifts across a
   grid of nearby discount rates and terminal growth rates, so you can see
   how sensitive the "market's assumption" is to your own inputs.

## Deploying (Render)

1. Push this repo to GitHub.
2. In Render, choose **New > Blueprint** and point it at the repo — it reads
   `render.yaml` and configures a free Node web service automatically
   (`npm install` to build, `npm start` to run). No environment variables are
   required.
3. Add `FMP_API_KEY` and/or `TWELVE_DATA_API_KEY` as environment variables in the
   Render service's settings if you want those fallbacks in production — strongly
   recommended, since Yahoo Finance is blocked from most cloud hosts' IPs (see
   Limitations below), so without at least one fallback configured, most lookups
   will fail once deployed.

## Limitations

- The core solve is an equity-value (FCFE-style) model using market cap as
  the target, not enterprise-value/WACC — it discounts levered free cash flow
  at a cost-of-equity-style rate straight to equity value. Enterprise value is
  shown only as an informational bridge computed *from* that result, not fed
  back into the solve.
- TTM free cash flow is a simple trailing-quarters sum, not adjusted for
  one-offs, buybacks, or stock-based comp.
- The CAPM discount rate uses fixed risk-free-rate and equity-risk-premium
  assumptions (not live market data) and is clamped to a 5-16% range.
- Yahoo Finance's fundamentals endpoints are undocumented and unofficial —
  the same ones the `yfinance` Python library relies on — so they can change
  without notice. The FMP fallback exists as a hedge against that.
- A reverse DCF is a sanity-check tool, not a substitute for full fundamental
  analysis — treat the implied growth rate as a talking point, not a verdict.
