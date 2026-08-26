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

### Optional: Financial Modeling Prep fallback

If Yahoo Finance ever fails for a given ticker, the server will fall back to
Financial Modeling Prep — but only if you've configured a key:

1. Get a free API key at https://site.financialmodelingprep.com/developer/docs.
2. Copy `.env.example` to `.env` and paste your key into `FMP_API_KEY`.

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
3. If you want the optional FMP fallback in production, add `FMP_API_KEY` as
   an environment variable in the Render service's settings.

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
