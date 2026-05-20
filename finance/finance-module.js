/**
 * finance/finance-module.js  —  Property Financial Feasibility  (Phase 1)
 *
 * Formula source: Feasibility_-82WPRL-v3.xlsx (exact cell formula transcription)
 *
 * KEY MECHANICS (corrected from v3 spreadsheet):
 *
 *  Rent (yr)        = IF(yr < settlementLag, 0, netIncome * (1+rentalGrowth)^yr)
 *  Principal Start  = IF(yr < settlementLag, 0, IF(yr == settlementLag, totalLoan, prev PrinEnd))
 *  Principal Paid   = (Rent - Interest) * profitUsedForDebt   ← driven by B10/G36
 *  Interest Paid    = PrincipalStart * interestRate
 *  Principal End    = PrincipalStart - PrincipalPaid
 *  Cashflow         = Rent - Interest - PrincipalPaid          ← operating cashflow
 *
 *  Return metrics (rolling cash equity basis):
 *    cashEquity[start of yr 0]  = FTC due in yr 0
 *    cashEquity[start of yr N]  = cashEquity[end of yr N-1] + FTC due in yr N
 *    distribution(yr)           = max(0, cashflow(yr)) * (1 - retainedEarnings%)
 *    cashEquity[end of yr]      = cashEquity[start of yr]
 *                               - distribution(yr)        if cashflow > 0
 *                               - |cashflow(yr)|          if cashflow < 0
 *                                 (positive: retained portion stays, distributed portion leaves;
 *                                  negative: retention irrelevant, full loss erodes equity)
 *
 *    CoC (Rolling) = cashflow(yr) / cashEquity[start of yr]
 *    ROE           = (cashflow(yr) + Δ assetValue + principalPaid) / cashEquity[start of yr]
 *
 *  Cost of Funds:
 *    pre-settlement  = upfrontCash * costOfCapital
 *    post-settlement = totalCashRequired(Total) * costOfCapital * (1+rentalGrowth)^(yr-lag)
 *  NPV (Asset Val)  = AssetValue - CostOfFunds                 (per-year, not cumulative)
 *
 *  totalCashRequired(Upfront) = SUM(deposit + stampDuty + valuation + solicitor + inspections + otherCosts)
 *  totalCashRequired(Total)   = Upfront + cashAtSettlement (kept for KPI display & Cost of Funds)
 *
 * INPUTS (grey cells — user editable):
 *   Feasibility sheet: B2 acquisitionPrice, B3 interestRate, B4 rentalGrowth,
 *     B5 lvr, B6 capitalGrowth, B7 holdDurationPreReval, B8 costOfCapital,
 *     B9 termOfOwnership, B10 profitUsedForDebt, B11 settlementLag, B12 projectDuration,
 *     E2 depositPct, E3 salesCommissionPct,
 *     I5 residualLandVal, I9 lots, I10 avLotSizeSqm, I12 ratePerSqm,
 *     L7 profitMarginPct, M3 lots(m3), M4 tdcPerLot, Q4 targetYieldPct,
 *     G36 profitUsedForDebt (same as B10)
 *   Expenses sheet: B2 managementFeePct, B3 sinkingFundPct,
 *     B7 water, B8 cleaning, B9 insurance, B10 landTax, B12 commonPower,
 *     B13 fireServices — direct $ inputs
 *     B6 council (=1500*4 formula-input), B14 maintenance (=500*12 formula-input)
 *     B20 grossRentYear1 (=550*52 formula-input — weekly rent × 52)
 *
 * CALCULATED (not user inputs):
 *   Council = councilQuarterly * 4
 *   Maintenance = maintenanceMonthly * 12
 *   GrossRent = weeklyRent * 52
 *   Management$ = managementFeePct * grossRent
 *   SinkingFund = sinkingFundPct * acquisitionPrice (Year 0 asset value)
 *   StampDuty = NSW bracket calculation
 *   SalesCommission$ = salesCommissionPct * acquisitionPrice
 *   NDA = 12500/4046 acres (formula in spreadsheet — kept as input here)
 *   GRV = lots * avLotSizeSqm * ratePerSqm * 10/11 (ex GST)
 */

const FIN_API = '/api/finance-api';

let _current           = null;
let _financeVisible    = false;
let _allModels         = {};
let _comparableOpen    = false;  // persists collapse state across re-renders
let _footerLegendOpen  = false;  // persists collapse state for returns legend
let _financeInitDone   = false;  // guard against duplicate initFinance() calls
let _saveTimer         = null;   // debounce timer for auto-save
let _costsInCashflow   = true;   // whether Funds to Complete costs are included in cashflow

// ─── Navigation tracking (V81.3) ─────────────────────────────────────────────
// _entryFromKanban: true if the CURRENT deal view was opened from the kanban
//   "Model" button (external call). False if opened by clicking a property in
//   the in-module finance list. Drives X-button back-navigation.
// _kanbanWasVisible: true if window.kanbanVisible was true when finance opened.
//   On full-close of finance we restore the kanban view so the user lands back
//   where they were instead of always falling through to the map.
let _entryFromKanban   = false;
let _kanbanWasVisible  = false;

// ─── DB helpers ───────────────────────────────────────────────────────────────

async function finDbLoad(id) {
  try {
    const res = await fetch(`${FIN_API}?id=${encodeURIComponent(id)}`);
    if (res.status === 404) return null;
    if (!res.ok) throw new Error(res.status);
    return await res.json();
  } catch (_) { return null; }
}

async function finDbSave(id, data) {
  try {
    await fetch(FIN_API, {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body:    JSON.stringify({ id, data }),
    });
  } catch (_) {}
}

async function finDbLoadAll() {
  try {
    const res = await fetch(FIN_API);
    if (!res.ok) return {};
    return await res.json();
  } catch (_) { return {}; }
}

// ─── Default model (all grey/input cells) ────────────────────────────────────

function defaultModel(acquisitionPrice) {
  return {
    // ── Feasibility sheet inputs ──────────────────────────────────────────
    acquisitionPrice:        acquisitionPrice || 0,   // B2
    interestRate:            0.09,                     // B3
    rentalGrowth:            0.036,                    // B4
    lvr:                     0.65,                     // B5
    capitalGrowth:           0.065,                    // B6
    holdDurationPreReval:    4,                        // B7
    costOfCapital:           0.10,                     // B8
    termOfOwnership:         10,                       // B9
    profitUsedForDebt:       0,                        // B10 / G36  (0–1 fraction)
    settlementLag:           2,                        // B11
    projectDuration:         5,                        // B12
    depositPct:              0.05,                     // E2
    salesCommissionPct:      0,                        // E3
    retainedEarningsPct:     0,                        // 0=all distributed, 1=all retained (positive cashflow only)

    // ── Purchase costs (direct $ inputs) ─────────────────────────────────
    stampDuty:               0,                        // C33 — NSW auto-calc
    valuationCost:           4090,                     // C34
    solicitorCost:           4000,                     // C35
    inspections:             4000,                     // C36

    // ── Expenses sheet inputs ─────────────────────────────────────────────
    managementFeePct:        0,                        // B2 Expenses
    sinkingFundPct:          0,                        // B3 Expenses
    council:                 6000,                     // annual (was 1500/quarter × 4)
    water:                   500,                      // B7
    cleaning:                0,                        // B8
    insurance:               3000,                     // B9
    landTax:                 80000,                    // B10
    commonPower:             0,                        // B12
    fireServices:            0,                        // B13
    maintenance:             6000,                     // annual (was 500/month × 12)
    other:                   0,                        // B16

    // ── Revenue ───────────────────────────────────────────────────────────
    weeklyRent:              28600,                    // annual gross rent (was 550/week × 52)
    revenueOther:            0,                         // other annual revenue

    // ── Comparable value inputs ───────────────────────────────────────────
    netDevelopableAreaAcres: 3.089,                    // I3 = 12500/4046
    comparableValuePerNDA:   2200000,                  // I4 ($/NDA) = I12*1000
    residualLandVal:         200000,                   // I5
    lots:                    31,                       // I9 / M3
    avLotSizeSqm:            366,                      // I10
    ratePerSqm:              2200,                     // I12
    profitMarginPct:         0.20,                     // L7
    tdcPerLot:               350000,                   // M4
    targetYieldPct:          0.07,                     // Q4

    // ── Comparable method inclusion flags (drive Comparable Value tile) ───
    includeM1:               true,
    includeM2:               true,
    includeM3:               true,
    includeM5:               true,

    createdAt: Date.now(),
    updatedAt: Date.now(),
    version:   5,
  };
}

// ─── NSW Stamp Duty ───────────────────────────────────────────────────────────

// ── Transfer Duty / Stamp Duty calculator — state-aware ─────────────────────
//
// OFFICIAL SOURCES — rates confirmed from government websites:
//
// NSW  Revenue NSW — Contracts for Sale of Land and Transfers Guide (revenue.nsw.gov.au)
//      Confirmed: "$186,667 plus $7.00 for every $100 over $3,721,000" (2025-26 premium formula)
//      Standard brackets from NSW Duties Act 1997 s.32, adjustable amounts updated annually via CPI
//      Source: https://www.revenue.nsw.gov.au/property-professionals-resource-centre/duties-guides/contracts-for-sale-of-land-and-transfers
//      Verified spot-check: $650,000 → $23,662 ✓ (confirmed by stampduty.calculatorsaustralia.com.au citing Revenue NSW)
//
// VIC  State Revenue Office Victoria — Fixtures and Duty page (sro.vic.gov.au)
//      Confirmed directly: "$2,870 + 6% of the amount that exceeds $130,000" (up to $960k)
//      Confirmed: "valued at more than $960,000, but not more than $2,000,000, is 5.5%" (flat on full value)
//      Confirmed: "$110,000 + 6.5% of the amount that exceeds $2,000,000" (over $2m)
//      Source: https://www.sro.vic.gov.au/fixtures-and-duty
//      Verified: $750,000 → $40,070 ✓; $1,000,000 → $55,000 ✓
//
// QLD  Queensland Revenue Office — Transfer Duty Rates page (qro.qld.gov.au)
//      Confirmed directly: "$17,325 plus $4.50 for each $100, or part of $100, over $540,000" ($540k–$1m band)
//      Source: https://qro.qld.gov.au/duties/transfer-duty/calculate/rates/
//      Verified: $850,000 → $31,275 ✓ (matches QRO worked example)
//
// SA   RevenueSA — Rate of Stamp Duty page (revenuesa.sa.gov.au)
//      Brackets confirmed via official RevenueSA source (page returns 403 to bots; rates stable since 2021)
//      Cross-verified: multiple sources citing revenuesa.sa.gov.au; $750,000 → $35,080 ✓
//      Source: https://www.revenuesa.sa.gov.au/stampduty/stamp-duty-rates
//
// ACT  ACT Revenue Office — Non-commercial Transfer Duty page (revenue.act.gov.au)
//      Confirmed directly from full rate table (Table 2 — non-owner-occupier, effective 1 July 2025)
//      Source: https://www.revenue.act.gov.au/duties/conveyance-duty/non-commercial-transfer-duty
//      Using investor/non-owner-occupier rates (Table 2) as appropriate for feasibility modelling
//
// All figures use STANDARD/INVESTMENT rates — no first-home-buyer concessions, no foreign surcharges.
// Always verify with the relevant state revenue office calculator before settlement.

function detectState(address, suburb) {
  // Try to extract state from address string — pipeline suburb field or address tail
  const text = ((suburb || '') + ' ' + (address || '')).toUpperCase();
  // Explicit state abbreviations (word boundary)
  if (/ACT/.test(text) || /CANBERRA|BELCONNEN|GUNGAHLIN|TUGGERANONG|WODEN|WESTON/.test(text)) return 'ACT';
  if (/VIC/.test(text) || /VICTORIA/.test(text)) return 'VIC';
  if (/QLD/.test(text) || /QUEENSLAND/.test(text)) return 'QLD';
  if (/SA/.test(text)  || /SOUTH AUSTRALIA/.test(text)) return 'SA';
  if (/NSW/.test(text) || /NEW SOUTH WALES/.test(text)) return 'NSW';
  // Fall back to NSW as default (app is Sydney-centric)
  return 'NSW';
}

function calcStampDutyNSW(price) {
  // Revenue NSW — effective 1 July 2025
  // Formula: base + (price - threshold) * rate%
  const bands = [
    [3_721_000, 186_667, 7.00],
    [1_240_000,  50_212, 5.50],
    [  372_000,  11_152, 4.50],
    [   99_000,   1_597, 3.50],
    [   37_000,     512, 1.75],
    [   17_000,     212, 1.50],
    [        0,       0, 1.25],
  ];
  for (const [threshold, base, rate] of bands) {
    if (price > threshold) return Math.round(base + (price - threshold) * (rate / 100));
  }
  return 0;
}

function calcStampDutyVIC(price) {
  // State Revenue Office Victoria — effective 1 July 2025
  // IMPORTANT: $960,001–$2,000,000 bracket is 5.5% on the FULL value (not marginal)
  if (price > 2_000_000) return Math.round(110_000 + (price - 2_000_000) * 0.065);
  if (price > 960_000)   return Math.round(price * 0.055); // flat rate on full value
  // Marginal brackets below $960,001
  const bands = [
    [130_000, 2_870, 6.00],
    [ 25_000,   350, 2.40],
    [      0,     0, 1.40],
  ];
  for (const [threshold, base, rate] of bands) {
    if (price > threshold) return Math.round(base + (price - threshold) * (rate / 100));
  }
  return 0;
}

function calcStampDutyQLD(price) {
  // Queensland Revenue Office — effective 1 July 2025
  // No duty on first $5,000
  const bands = [
    [1_000_000, 38_025, 5.75],
    [  540_000, 17_325, 4.50],
    [   75_000,  1_050, 3.50],
    [    5_000,      0, 1.50],
    [        0,      0, 0.00],
  ];
  for (const [threshold, base, rate] of bands) {
    if (price > threshold) return Math.round(base + (price - threshold) * (rate / 100));
  }
  return 0;
}

function calcStampDutySA(price) {
  // RevenueSA — rates unchanged as of 2025-26
  // Progressive marginal brackets
  const bands = [
    [500_000, 21_330, 5.50],
    [300_000, 11_330, 5.00],
    [250_000,  8_955, 4.75],
    [200_000,  6_830, 4.25],
    [100_000,  2_830, 4.00],
    [ 50_000,  1_080, 3.50],
    [ 30_000,    480, 3.00],
    [ 12_000,    120, 2.00],
    [      0,      0, 1.00],
  ];
  for (const [threshold, base, rate] of bands) {
    if (price > threshold) return Math.round(base + (price - threshold) * (rate / 100));
  }
  return 0;
}

function calcStampDutyACT(price) {
  // ACT Revenue Office — Non-owner-occupier (investor) rates effective 1 July 2025
  // Using non-owner-occupier table (Table 2) as appropriate for investment feasibility
  if (price > 1_455_000) return Math.round(price * 0.0454); // flat 4.54% on total
  const bands = [
    [1_000_000, 36_950, 6.40],
    [  750_000, 22_200, 5.90],
    [  500_000, 11_400, 4.32],
    [  300_000,  4_600, 3.40],
    [  200_000,  2_400, 2.20],
    [        0,      0, 1.20],
  ];
  for (const [threshold, base, rate] of bands) {
    if (price > threshold) return Math.round(base + (price - threshold) * (rate / 100));
  }
  return 0;
}

function calcStampDuty(price, state) {
  if (!price || price <= 0) return 0;
  switch (state) {
    case 'VIC': return calcStampDutyVIC(price);
    case 'QLD': return calcStampDutyQLD(price);
    case 'SA':  return calcStampDutySA(price);
    case 'ACT': return calcStampDutyACT(price);
    default:    return calcStampDutyNSW(price); // NSW default
  }
}

// ─── Calculation engine (exact spreadsheet formula transcription) ─────────────

// ─── Deposit helpers (module scope — used by both runModel and renderSidebar) ──

function parseDueDays(s) {
  if (s === null || s === undefined || s === '') return null;
  // Already a number (new storage format — days as integer)
  if (typeof s === 'number') return s;
  const m = String(s).match(/(\d+(?:\.\d+)?)\s*(d|day|days|m|mo|month|months|y|yr|year|years)?/i);
  if (!m) return null;
  const n = parseFloat(m[1]);
  const u = (m[2] || 'd').toLowerCase();
  if (/^y/.test(u)) return n * 365;
  if (/^m/.test(u)) return n * 30;
  return n;
}

// Returns the numeric deposit amount.
// If a string is received (old/corrupt data) returns NaN so callers can detect and warn.
function parseDepositAmount(s, price) {
  if (s === null || s === undefined || s === '') return 0;
  if (typeof s === 'number') return s;
  // String received — this is bad data; log and return NaN to surface the problem
  console.error('[Finance] Deposit amount is a string, expected number:', s,
    '— re-enter deposit in the kanban modal to fix.');
  return NaN;
}

function isUpfrontDeposit(due) {
  if (!due) return true;
  const s = String(due).toLowerCase().trim();
  if (/^at settlement$|^settlement$|^on settlement$/.test(s)) return false;
  return true;
}

// Parse a cost input to an annual figure.
// Accepts: "$400/w" "$400/m" "$400/y" "$400" "400" "400/week" "400/month" "400/year"
// Default (no suffix) = annual
function parseAnnual(val) {
  if (val === null || val === undefined || val === '') return 0;
  if (typeof val === 'number') return val; // already stored as annual
  const s = String(val).trim().toLowerCase();
  const m = s.match(/^\$?([\d,]+(?:\.\d+)?)\s*\/?\s*(w|week|wk|m|mo|month|mth|y|yr|year|pa|annual)?/);
  if (!m) return 0;
  const n = parseFloat(m[1].replace(/,/g, ''));
  if (isNaN(n)) return 0;
  const u = m[2] || 'y';
  if (/^w/.test(u)) return Math.round(n * 52);
  if (/^m/.test(u)) return Math.round(n * 12);
  return Math.round(n); // annual
}

// Format a stored annual amount back to display string
function fmtAnnualDisplay(annualVal) {
  if (!annualVal) return fmtDollar(0);
  return fmtDollar(annualVal) + '/y';
}

// ─── Formula evaluator (V81.3) ───────────────────────────────────────────────
// Safe recursive-descent parser for left-pane inputs. NO eval/Function().
// Triggered when input value starts with '='. Supports +, -, *, /, parentheses,
// decimals, and the natural-language operators x / X / × (multiply) and ÷ (divide).
// Returns a finite number, or NaN if the expression is malformed.
function evalFormula(input) {
  if (input == null) return NaN;
  let s = String(input).trim();
  if (s.startsWith('=')) s = s.slice(1);
  // Normalise: strip commas/dollar/percent/whitespace, fold x/×/÷ to */
  s = s.replace(/[\s,$]/g, '').replace(/[xX×]/g, '*').replace(/÷/g, '/');
  if (!s) return NaN;
  // Whitelist: only digits, dot, parens, operators. Reject anything else outright.
  if (!/^[\d.+\-*/()]+$/.test(s)) return NaN;

  let pos = 0;
  function peek()    { return s[pos]; }
  function consume() { return s[pos++]; }
  // expr → term (('+'|'-') term)*
  function parseExpr() {
    let v = parseTerm();
    while (peek() === '+' || peek() === '-') {
      const op = consume();
      const rhs = parseTerm();
      v = op === '+' ? v + rhs : v - rhs;
    }
    return v;
  }
  // term → factor (('*'|'/') factor)*
  function parseTerm() {
    let v = parseFactor();
    while (peek() === '*' || peek() === '/') {
      const op = consume();
      const rhs = parseFactor();
      v = op === '*' ? v * rhs : v / rhs;
    }
    return v;
  }
  // factor → number | '(' expr ')' | unary +/- factor
  function parseFactor() {
    if (peek() === '+') { consume(); return parseFactor(); }
    if (peek() === '-') { consume(); return -parseFactor(); }
    if (peek() === '(') {
      consume();
      const v = parseExpr();
      if (consume() !== ')') throw new Error('mismatched paren');
      return v;
    }
    // number — digits with optional decimal
    let num = '';
    while (pos < s.length && /[\d.]/.test(s[pos])) num += consume();
    if (num === '' || num === '.') throw new Error('expected number');
    const n = parseFloat(num);
    if (!isFinite(n)) throw new Error('bad number');
    return n;
  }

  try {
    const result = parseExpr();
    if (pos !== s.length) return NaN; // trailing junk
    return isFinite(result) ? result : NaN;
  } catch (_) {
    return NaN;
  }
}

function runModel(d) {
  const price = d.acquisitionPrice || 0;

  // ── Derived outgoings — all stored as annual figures now ─────────────
  const council       = d.council || 0;                          // stored as annual
  const maintenance   = d.maintenance || 0;                      // stored as annual
  const grossRentYr1  = (d.weeklyRent || 0) + (d.revenueOther || 0); // total annual revenue
  const management$   = (d.managementFeePct || 0) * grossRentYr1; // B11 = B2*B20
  const sinkingFund   = (d.sinkingFundPct || 0) * price;         // B15 = B3 * Feasibility!B25(=B2)

  const totalOutgoings = council + (d.water || 0) + (d.cleaning || 0) +
    (d.insurance || 0) + (d.landTax || 0) + management$ +
    (d.commonPower || 0) + (d.fireServices || 0) + maintenance +
    sinkingFund + (d.other || 0); // all annual

  const netIncomeYr1 = grossRentYr1 - totalOutgoings;            // B21 = B20 - B17

  // ── Purchase / deal figures ───────────────────────────────────────────
  const stamp      = d.stampDuty || calcStampDuty(price, d._state || 'NSW');
  const commission = price * (d.salesCommissionPct || 0);        // C37 = E3*B2
  const loan       = price * (d.lvr || 0);                       // C31 = B2*B5
  const equity     = price - loan;                               // cash needed at settlement from buyer

  // ── Offer deposit tranches ────────────────────────────────────────────
  // Pulled from the selected offer on the pipeline entry.
  // depositTranches: [{ amount (number), due (string e.g. "on exchange", "90 days") }]
  // We classify each tranche as either:
  //   - upfront: paid before settlement (Year 0 / at exchange)
  //   - atSettlement: paid at settlement
  // Amounts are parsed from the offer deposit fields (formatted strings like "$50,000")
  // Always read fresh from live pipeline — _current.pipelineEntry may be stale
  const _livePipeline = window.getPipelineData ? window.getPipelineData() : {};
  const entry    = _livePipeline[_current?.pipelineId] || _current?.pipelineEntry;
  const offers   = entry?.offers || [];
  const _offeredPrice = _current?.offeredPrice;
  const selOffer = _offeredPrice
    ? offers.find(o => { const n = parseFloat(String(o.price||'').replace(/[^0-9.]/g,'')); return Math.abs(n - _offeredPrice) < 1; })
    : offers[0];
  const offerDeposits = selOffer?.deposits || entry?.terms?.deposits || [];

  // Deposit helpers — module-scope functions, but need price for % parsing
  function parseAmt(s) { return parseDepositAmount(s, price); }

  let offerDepositUpfront    = 0;  // paid before settlement (at exchange)
  let offerDepositSettlement = 0;  // paid at/near settlement but before loan draws

  let _depositDataError = false;
  offerDeposits.forEach(dep => {
    const amt = parseAmt(dep.amount);
    if (isNaN(amt)) { _depositDataError = true; return; }
    if (amt <= 0) return;
    if (isUpfrontDeposit(dep.due || dep.note || '')) {
      offerDepositUpfront += amt;
    } else {
      offerDepositSettlement += amt;
    }
  });

  const totalOfferDeposits = offerDepositUpfront + offerDepositSettlement;

  // Bank deposit = equity - offer deposits already paid (bank tops up the rest)
  const bankDepositRequired = Math.max(0, equity - totalOfferDeposits);

  // Settlement year — from actual offer settlement days
  const _offerSettlementDays = selOffer?.settlement || entry?.terms?.settlement || 0;
  const _settlementYr = _offerSettlementDays > 0
    ? Math.floor((typeof _offerSettlementDays === 'number' ? _offerSettlementDays : parseDueDays(_offerSettlementDays)) / 365)
    : Math.max(0, Math.round(d.settlementLag || 0));

  // Build per-year cost map matching the Funds to Complete table
  // Fixed costs all go to settlementYr; deposit tranches go to their computed year
  const _ftcByYear = {};
  const _addFtc = (yr, amt) => { if (amt) _ftcByYear[yr] = (_ftcByYear[yr] || 0) + amt; };
  _addFtc(_settlementYr, d.stampDuty || 0);
  _addFtc(_settlementYr, d.valuationCost || 0);
  _addFtc(_settlementYr, d.solicitorCost || 0);
  _addFtc(_settlementYr, d.inspections || 0);
  _addFtc(_settlementYr, commission);
  _addFtc(_settlementYr, bankDepositRequired);
  let _cumDepDays = 0;
  offerDeposits.forEach(dep => {
    const amt = parseDepositAmount(dep.amount, price);
    if (!amt || isNaN(amt) || amt <= 0) return;
    const dd = parseDueDays(dep.due);
    _cumDepDays += dd !== null ? dd : 0;
    _addFtc(Math.floor(_cumDepDays / 365), amt);
  });

  // Total Purchase Costs = all FTC items (deposits + stamp + valuation + solicitor + inspections + commission + equity)
  const purchaseCosts = Object.values(_ftcByYear).reduce((s, v) => s + v, 0);

  // Cash Required (Upfront) = everything except commission and equity contribution
  const upfront = purchaseCosts - commission - bankDepositRequired;

  // Cash Required (Settlement) = commission + equity contribution
  const cashAtSettlement = commission + bankDepositRequired;

  // Legacy aliases
  const upfrontCosts = upfront;
  const settlementCosts = cashAtSettlement;

  // Legacy 'deposit' for spreadsheet compatibility (total offer deposits)
  const deposit = totalOfferDeposits || price * (d.depositPct || 0);

  // ── Year-by-year projection ───────────────────────────────────────────
  const lag    = Math.max(0, Math.round(d.settlementLag || 0));
  const terms  = Math.round(d.termOfOwnership || 10);
  const pdPct  = d.profitUsedForDebt || 0;                       // B10/G36
  const rg     = d.rentalGrowth || 0;
  const cg     = d.capitalGrowth || 0;
  const coc    = d.costOfCapital || 0;
  const hold   = Math.round(d.holdDurationPreReval || 0);        // B7

  const years = [];
  let principalStart = 0;

  for (let yr = 0; yr <= terms; yr++) {
    const settled = yr >= lag;
    const firstSettled = yr === lag;

    // Rent: IF(yr < lag, 0, netIncomeYr1 * (1+rg)^yr)  — note: grows from yr=0 base
    const rent = settled ? netIncomeYr1 * Math.pow(1 + rg, yr) : 0;

    // Principal start: IF(yr<lag,0, IF(yr==lag, loan, prevPrinEnd))
    if (!settled) {
      principalStart = 0;
    } else if (firstSettled) {
      principalStart = loan;
    }
    // else carries over from previous loop iteration (set below)

    const interest      = principalStart * (d.interestRate || 0);   // B21 = B19 * B3
    const principalPaid = (rent - interest) * pdPct;                 // B20 = (B17-B21)*G36
    const principalEnd  = principalStart - principalPaid;            // B22 = B19 - B20
    const operatingCashflow = rent - interest - principalPaid;       // B23 = B17-B21-B20 (always raw, used for return metrics)
    const cashflow      = operatingCashflow;                         // display cashflow — may be adjusted below by toggle
    // _costsAdjustment applied below after years array is built
    const assetValue    = yr === 0 ? price : price * Math.pow(1 + cg, yr); // B25, then *(1+B6)

    years.push({
      yr, rent, grossRentYr1: settled ? grossRentYr1 * Math.pow(1 + rg, yr) : 0,
      principalStart, interest, principalPaid, principalEnd,
      cashflow, operatingCashflow, assetValue,
    });

    // Carry principal end forward as next year's start
    principalStart = principalEnd;
  }

  // ── Apply Funds to Complete costs to cashflow when toggled on ──────
  if (_costsInCashflow) {
    // Reuse _ftcByYear which already has all costs correctly placed by year
    years.forEach(y => {
      if (_ftcByYear[y.yr]) y.cashflow -= _ftcByYear[y.yr];
    });
  }

  // ── Total Cash Required (Total) ──────────────────────────────────────
  // = Upfront + Cash at Settlement - sum(cashflows where yr < holdDurationPreReval)
  // Negative cashflows during pre-reval period add to total cash required (funding gap)
  // NOTE: kept for legacy KPI tile + Cost of Funds calc; NOT used in return metrics.
  const preCashflowSum = years
    .filter(y => y.yr < hold)
    .reduce((s, y) => s + y.cashflow, 0);
  const totalCashReqd = upfront + cashAtSettlement - preCashflowSum;

  // ── Return metrics: rolling cash equity basis ────────────────────────
  // cashEquity[start of yr N] = cash actually tied up in the deal at start of yr N
  //   = cumulative Funds-to-Complete paid up to and including yr N
  //   - cumulative distributions taken in yrs 0..N-1
  //   + cumulative absolute losses absorbed in yrs 0..N-1
  //
  // Timing convention: FTC due in year Y is committed AT THE START of year Y
  // (so it's part of the Year Y denominator). Cashflow in year Y arrives during
  // the year, so distribution from it lands at the START of Year Y+1.
  //
  // Distribution rule (asymmetric):
  //   positive operating cashflow → distribution = cashflow * (1 - retainedPct)
  //   negative operating cashflow → no distribution; full loss reduces cash position
  const retainedPct = Math.max(0, Math.min(1, d.retainedEarningsPct || 0));
  let cashEquity = 0;
  years.forEach(y => {
    // Step 1: FTC due in this year is paid at start — increases cash equity now
    const ftcThisYear = _ftcByYear[y.yr] || 0;
    cashEquity += ftcThisYear;

    // Step 2: snapshot start-of-year denominator (after FTC, before this year's cashflow)
    y.cashEquityStart = cashEquity;

    // Step 3: distribution / loss absorption based on operating cashflow
    //   positive op: distribute portion based on retainedPct; cash position falls by distribution
    //   negative op: full loss erodes cash position (retention irrelevant — there's nothing to retain)
    const op = y.operatingCashflow;
    let distribution = 0;
    if (op > 0) {
      distribution = op * (1 - retainedPct);
      cashEquity -= distribution;          // distributed cash leaves the deal
    } else if (op < 0) {
      cashEquity -= Math.abs(op);          // loss erodes cash position fully
    }
    y.cashEquityEnd = cashEquity;
    y.distribution  = distribution;

    // ROE numerator: operating cashflow + appreciation + principal paid down
    // Δ assetValue from start of year (= prev year's assetValue) to end of year
    const prevAssetValue = y.yr === 0 ? price : (years[y.yr - 1]?.assetValue ?? price);
    y.appreciation = y.assetValue - prevAssetValue;

    // Avoid divide-by-zero (only happens if yr 0 has no FTC at all)
    y.coc = y.cashEquityStart > 0 ? y.operatingCashflow / y.cashEquityStart : 0;
    y.roe = y.cashEquityStart > 0
      ? (y.operatingCashflow + y.appreciation + y.principalPaid) / y.cashEquityStart
      : 0;
  });

  // ── Cost of Funds ─────────────────────────────────────────────────────
  // pre-settlement:  upfront * coc
  // post-settlement: totalCashReqd * coc * (1+rg)^(yr-lag)
  // NPV per year = assetValue - costOfFunds
  years.forEach(y => {
    if (y.yr < lag) {
      y.costOfFunds = upfront * coc;
    } else {
      y.costOfFunds = totalCashReqd * coc * Math.pow(1 + rg, y.yr - lag);
    }
    y.npvAssetValue = y.assetValue - y.costOfFunds;
  });

  // ── Interest for holding period (for Method 3) ────────────────────────
  // M6 = SUMIF(B16:L16,"<="&B12, B21:L21)  — sum interest up to projectDuration
  const proj = Math.round(d.projectDuration || 0);
  const interestDuringProject = years
    .filter(y => y.yr <= proj)
    .reduce((s, y) => s + y.interest, 0);

  // ── Comparable value methods ──────────────────────────────────────────
  // GRV = lots * avLotSizeSqm * ratePerSqm * 10/11  (I13 = I9*I12*I10*10/11)
  const nsa = (d.lots || 0) * (d.avLotSizeSqm || 0);
  const grv = nsa * (d.ratePerSqm || 0) * (10 / 11);

  // Method 1: I6 = I4*I3 + I5  (comparable $/NDA * NDA + residual)
  const m1 = (d.comparableValuePerNDA || 0) * (d.netDevelopableAreaAcres || 0) + (d.residualLandVal || 0);

  // Method 2: I14 = I13/3
  const m2 = grv / 3;

  // Method 3: M9 = M8 - SUM(M5:M7) - M3*M4
  //   M8 = GRV (=I13), M5 = holdingCost (=G31-G30), M6 = interestDuringProject, M7 = profitMargin
  const holdingCostM3 = totalCashReqd - price;   // M5 = G31 - G30
  const profitMarginAmt = (grv + holdingCostM3 + interestDuringProject) * (d.profitMarginPct || 0); // M7 = (M3*M4+M5+M6)*L7
  const m3 = grv - holdingCostM3 - interestDuringProject - profitMarginAmt - (d.lots || 0) * (d.tdcPerLot || 0);

  // Method 5: Q5 = Q3/Q4  (net income / target yield)
  const m5 = (d.targetYieldPct || 0) > 0 ? netIncomeYr1 / d.targetYieldPct : 0;

  // Year 1 cashflow for deal summary (G32 = LOOKUP(B11, years, cashflows))
  const yr1Cashflow = years.find(y => y.yr === lag)?.cashflow ?? 0;

  return {
    depositDataError: _depositDataError,
    loan, deposit, commission, stamp,
    equity, bankDepositRequired,
    offerDeposits, offerDepositUpfront, offerDepositSettlement, totalOfferDeposits,
    purchaseCosts, upfront, cashAtSettlement,
    settlementYr: _settlementYr, ftcByYear: _ftcByYear,
    totalCashReqd, preCashflowSum,
    grossRentYr1, management$, sinkingFund,
    council, maintenance,
    totalOutgoings, netIncomeYr1,
    years,
    nsa, grv, m1, m2, m3, m5,
    yr1Cashflow,
  };
}

// ─── Formatting ───────────────────────────────────────────────────────────────

function fmtDollar(v) {
  if (v == null || isNaN(v)) return '—';
  const n = Math.round(v);
  return n < 0 ? '($' + Math.abs(n).toLocaleString('en-AU') + ')' : '$' + n.toLocaleString('en-AU');
}
function fmtPct(v, dp = 2) {
  if (v == null || isNaN(v)) return '—';
  return (v * 100).toFixed(dp) + '%';
}
function fmtDollarK(v) {
  if (v == null || isNaN(v)) return '—';
  const abs = Math.abs(v), neg = v < 0;
  let s = abs >= 1_000_000 ? '$' + (abs / 1_000_000).toFixed(2) + 'm'
        : abs >= 1_000     ? '$' + (abs / 1_000).toFixed(1) + 'k'
        : '$' + Math.round(abs).toLocaleString('en-AU');
  return neg ? '(' + s + ')' : s;
}

function extractPrice(entry) {
  if (!entry) return 0;
  const tp = entry.terms?.price;
  if (tp) { const n = parseFloat(String(tp).replace(/[^0-9.]/g, '')); if (!isNaN(n) && n > 0) return n; }
  const p = entry.property?.price;
  if (!p) return 0;
  if (typeof p === 'number') return p;
  if (typeof p === 'string') { const n = parseFloat(p.replace(/[^0-9.]/g, '')); return isNaN(n) ? 0 : n; }
  if (typeof p === 'object') {
    const { display, from, to } = p;
    if (display) { const n = parseFloat(display.replace(/[^0-9.]/g, '')); if (!isNaN(n) && n > 0) return n; }
    return from || to || 0;
  }
  return 0;
}

// ─── View toggle ──────────────────────────────────────────────────────────────

function toggleFinance(show) {
  const willShow = show !== undefined ? show : !_financeVisible;
  // Capture pre-open context so X-back can restore the kanban view rather than
  // always falling through to the map (V81.3).
  if (willShow && !_financeVisible) {
    _kanbanWasVisible = !!window.kanbanVisible;
  }
  _financeVisible = willShow;
  document.getElementById('financeView')?.classList.toggle('visible', _financeVisible);
  document.getElementById('financeNavBtn')?.classList.toggle('active', _financeVisible);
  if (!_financeVisible) setExportBtnVisible(false);
  // Close kanban when finance opens (they occupy the same full-screen layer)
  if (_financeVisible && typeof toggleKanban === 'function') toggleKanban(false);
}

// Contextual X-button close (V81.3).
// - On deal view: go back one level — either to the in-module property list,
//   or to the kanban modal that opened the deal.
// - On list view: close finance entirely and restore the previous screen.
function handleFinanceClose() {
  // Case A: deal view AND opened from the kanban "Model" button — back to the kanban modal
  if (_current && _entryFromKanban) {
    const id = _current.pipelineId;
    _current = null;
    _entryFromKanban = false;
    _financeVisible = false;
    document.getElementById('financeView')?.classList.remove('visible');
    document.getElementById('financeNavBtn')?.classList.remove('active');
    setExportBtnVisible(false);
    const alreadyOpen = window.kanbanVisible;
    if (typeof toggleKanban === 'function' && !alreadyOpen) toggleKanban(true);
    setTimeout(() => {
      if (typeof openCardModal === 'function') openCardModal(id);
    }, alreadyOpen ? 0 : 300);
    return;
  }
  // Case B: deal view opened from the in-module list — step back to the list
  if (_current && !_entryFromKanban) {
    _current = null;
    renderFinanceView();
    return;
  }
  // Case C: on the list view — close finance entirely
  closeFinanceModule();
}

// Full module close — used by the nav button (when already open) and by
// handleFinanceClose on the list view. Restores the prior screen (kanban if
// it was visible when finance opened; otherwise the map shows through).
function closeFinanceModule() {
  _current = null;
  _entryFromKanban = false;
  toggleFinance(false);
  if (_kanbanWasVisible && typeof toggleKanban === 'function') toggleKanban(true);
  _kanbanWasVisible = false;
}

// offeredPrice: numeric price from the most recent offer or vendor terms (passed from kanban).
// If a saved model already exists, ALL its variables are preserved and only
// acquisitionPrice is updated (if the offered price differs and user hasn't already
// customised it away from the listing price). New models are seeded from offeredPrice.
async function openFinanceForProperty(pipelineId, pipelineEntry, offeredPrice) {
  // Entry source: if finance view is NOT yet visible, this call came from
  // outside the module (kanban "Model" button). If it IS visible, the user
  // clicked a property in the in-module list. Drives X-button back-navigation.
  _entryFromKanban = !_financeVisible;

  const p = pipelineEntry?.property || {};

  // Load existing model or fall back to null
  let data = _allModels[pipelineId] || await finDbLoad(pipelineId);

  // Detect state from property address — used for correct duty calculation
  const _state = detectState(p.address || '', p.suburb || '');

  // Find the selected offer to read its settlement days
  const offers = pipelineEntry?.offers || [];
  const selOffer = offeredPrice
    ? offers.find(o => { const n = parseFloat(String(o.price||'').replace(/[^0-9.]/g,'')); return Math.abs(n - offeredPrice) < 1; })
    : offers[0];
  const offerSettlementDays = selOffer?.settlement || pipelineEntry?.terms?.settlement || 0;
  // Convert settlement days to years (rounded to 1 decimal, capped at termOfOwnership)
  const offerSettlementYrs = offerSettlementDays > 0
    ? Math.max(0, Math.round((parseDueDays(offerSettlementDays) / 365) * 10) / 10)
    : 0;

  if (!data) {
    // No saved model — create fresh, seeding price from offered > listing
    const seedPrice = offeredPrice || extractPrice(pipelineEntry);
    data = defaultModel(seedPrice);
    data._state    = _state;
    data.stampDuty = calcStampDuty(data.acquisitionPrice, _state);
    if (offeredPrice) data._priceSource = 'offer';
  } else {
    // Existing model — carry ALL variables forward, always refresh state detection
    data._state = _state;
    // Update acquisitionPrice if an offered price was passed and differs
    if (offeredPrice && offeredPrice !== data.acquisitionPrice) {
      data.acquisitionPrice = offeredPrice;
      // Do NOT recalculate stampDuty — preserve any manual changes
      data._priceSource = 'offer';
      data.updatedAt = Date.now();
    }
  }

  // Always sync settlementLag from the offer's actual settlement — rent starts at settlement
  if (offerSettlementYrs >= 0) {
    data.settlementLag = offerSettlementYrs;
  }

  _allModels[pipelineId] = data;
  _current = {
    pipelineId,
    address:       p.address || '',
    suburb:        p.suburb  || '',
    data,
    pipelineEntry, // full pipeline entry — needed for offer deposit tranches
    offeredPrice,  // which offer was selected
  };
  renderFinanceView();
  toggleFinance(true);
}

// ─── Render ───────────────────────────────────────────────────────────────────

function renderFinanceView() {
  const container = document.getElementById('financeContent');
  if (!container) return;
  if (!_current) {
    container.innerHTML = renderPropertySelector();
    bindSelectorEvents();
    setExportBtnVisible(false);
    return;
  }

  // Preserve scroll positions across re-render (sidebar inputs and main content
  // each have their own scrollable area; rebuilding innerHTML resets both).
  const sidebarPrev = container.querySelector('.fin-sidebar');
  const mainPrev    = container.querySelector('.fin-main');
  const sidebarScroll = sidebarPrev ? sidebarPrev.scrollTop : 0;
  const mainScroll    = mainPrev    ? mainPrev.scrollTop    : 0;

  const d = _current.data;
  const r = runModel(d);
  container.innerHTML = `<div class="fin-layout">${renderSidebar(d, r)}${renderMain(d, r)}</div>`;

  // Restore scroll positions on the freshly rendered elements
  const sidebarNew = container.querySelector('.fin-sidebar');
  const mainNew    = container.querySelector('.fin-main');
  if (sidebarNew) sidebarNew.scrollTop = sidebarScroll;
  if (mainNew)    mainNew.scrollTop    = mainScroll;

  setExportBtnVisible(true);
  bindInputs(r);
}

function renderPropertySelector() {
  const pipeline = window.getPipelineData ? window.getPipelineData() : {};
  const entries  = Object.entries(pipeline);
  if (!entries.length) {
    return `<div class="fin-empty">
      <div class="fin-empty-icon">📊</div>
      <div class="fin-empty-title">No properties in pipeline</div>
      <div class="fin-empty-sub">Add properties to your pipeline first, then open a financial model from the kanban card.</div>
    </div>`;
  }
  const STAGE_LABELS = { shortlisted:'Shortlisted','under-dd':'Under DD',offer:'Offer',acquired:'Acquired','not-suitable':'Not Suitable',lost:'Lost' };
  return `<div class="fin-selector">
    <div class="fin-selector-title">Select a property to model</div>
    <div class="fin-selector-list">
      ${Object.entries(pipeline).map(([id, item]) => {
        const p = item.property || {};
        return `<div class="fin-selector-card" data-id="${id}">
          <div class="fin-sel-addr">${p.address || 'Unknown address'}</div>
          <div class="fin-sel-meta">${p.suburb||''} · ${STAGE_LABELS[item.stage]||item.stage}</div>
          ${_allModels[id] ? '<span class="fin-sel-badge">Model saved</span>' : ''}
        </div>`;
      }).join('')}
    </div>
  </div>`;
}

function bindSelectorEvents() {
  document.querySelectorAll('.fin-selector-card').forEach(card => {
    card.addEventListener('click', () => {
      const id = card.dataset.id;
      const pipeline = window.getPipelineData ? window.getPipelineData() : {};
      if (pipeline[id]) openFinanceForProperty(id, pipeline[id]);
    });
  });
}

// ─── Field helper ─────────────────────────────────────────────────────────────

// type: 'dollar' | 'pct' | 'int' | 'num'
// calc: true = calculated (display only), false/undefined = input (editable)
// actionHtml: optional HTML rendered as a sibling button next to the value (e.g. refresh icon)
function ff(key, label, display, type, hint, calc, actionHtml) {
  return `<div class="fin-field${calc ? ' fin-field-calc' : ''}${actionHtml ? ' fin-field-with-action' : ''}" data-key="${key}" data-type="${type}">
    <span class="fin-field-label">${label}${hint ? `<span class="fin-field-hint">${hint}</span>` : ''}</span>
    <span class="${calc ? 'fin-calc-val' : 'fin-editable'}" data-key="${key}">${display}</span>
    ${actionHtml || ''}
  </div>`;
}

// ─── Sidebar ──────────────────────────────────────────────────────────────────

function fsc(id, label) {
  // Collapsible section header — toggled via CSS class + delegated click in bindInputs
  return `<div class="fin-section-label fin-section-toggle" data-section="${id}">
    <span>${label}</span><span class="fin-section-chevron">▼</span>
  </div>`;
}

// Track which sidebar sections are collapsed (persists across re-renders)
const _sectionCollapsed = {
  'model-vars':      true,
  'purchase-costs':  true,
  'revenue':         true,
  'outgoings':       true,
  'fin-funds-complete': true,
};

function renderSidebar(d, r) {
  function sec(id) {
    return _sectionCollapsed[id] ? 'style="display:none"' : '';
  }
  return `<div class="fin-sidebar">
    <div class="fin-property-bar">
      <div class="fin-property-info">
        <div class="fin-property-address">${_current.address}, ${_current.suburb} NSW</div>
        <div class="fin-property-id">
          <a class="fin-property-link fin-property-id-link" id="finOpenKanban" href="#" title="Open in pipeline">
            Pipeline ID: ${_current.pipelineId}
          </a>
        </div>
      </div>
      <button class="fin-change-btn" id="finChangeProperty">Change</button>
    </div>

    ${fsc('model-vars', 'Financial Inputs')}
    <div class="fin-section-body" data-section="model-vars" ${sec('model-vars')}>
      <div class="fin-fields">
        ${ff('acquisitionPrice',   'Acquisition Price',           fmtDollar(d.acquisitionPrice),   'dollar')}
      </div>

      <div class="fin-fields" style="margin-top:8px">
        ${ff('interestRate',       'Loan Interest Rate (pa)',      fmtPct(d.interestRate),          'pct')}
        ${ff('rentalGrowth',       'Rental Increase (pa)',         fmtPct(d.rentalGrowth),          'pct')}
        ${ff('lvr',                'Assumed LVR (%)',              fmtPct(d.lvr),                   'pct')}
        ${ff('capitalGrowth',      'Asset Value Growth (pa)',      fmtPct(d.capitalGrowth),         'pct')}
        ${ff('costOfCapital',      'Cost of Capital (%)',          fmtPct(d.costOfCapital),         'pct')}
        ${ff('profitUsedForDebt',  '% Profit → Debt Reduction',   fmtPct(d.profitUsedForDebt),     'pct')}
        ${ff('retainedEarningsPct','Retained Earnings (%)',        fmtPct(d.retainedEarningsPct || 0),   'pct')}
        ${ff('holdDurationPreReval','Next Valuation (yrs)',        d.holdDurationPreReval+' yrs',   'int')}
        ${ff('termOfOwnership',    'Term of Ownership (yrs)',      d.termOfOwnership+' yrs',        'int')}
        ${ff('settlementLag',      'Settlement Lag (yrs)',         d.settlementLag+' yrs',          'int')}
        ${ff('projectDuration',    'Project Duration (yrs)',       d.projectDuration+' yrs',        'int')}
      </div>
    </div>

    ${fsc('revenue', 'Revenue')}
    <div class="fin-section-body" data-section="revenue" ${sec('revenue')}>
      <div class="fin-fields">
        ${ff('weeklyRent',    'Rent',  fmtDollar(d.weeklyRent),    'dollar', '/w, /m or /y')}
        ${ff('revenueOther',  'Other', fmtDollar(d.revenueOther),  'dollar', '/w, /m or /y')}
      </div>
      <div class="fin-summary-row ${r.grossRentYr1 < 0 ? 'fin-summary-neg' : ''}">
        <span>Gross Rent (Year 1)</span><span class="fin-summary-val">${fmtDollar(r.grossRentYr1)}</span>
      </div>
    </div>

    ${fsc('outgoings', 'Outgoings')}
    <div class="fin-section-body" data-section="outgoings" ${sec('outgoings')}>
      <div class="fin-fields">
        <div class="fin-subsection-label">Purchase Costs</div>
        ${/* Offer deposit tranches */ ''}
        ${(() => {
          const _lp2 = window.getPipelineData ? window.getPipelineData() : {};
          const _entry2 = _lp2[_current?.pipelineId] || _current?.pipelineEntry;
          const _offers2 = _entry2?.offers || [];
          const _op2 = _current?.offeredPrice;
          const _sel2 = _op2
            ? _offers2.find(o => { const n = parseFloat(String(o.price||'').replace(/[^0-9.]/g,'')); return Math.abs(n - _op2) < 1; })
            : _offers2[0];
          const allDeps = _sel2?.deposits || _entry2?.terms?.deposits || [];
          const deps = allDeps.filter(dep => dep.amount);
          if (!deps.length) {
            return '<div class="fin-deposit-none">No offer deposits — set in kanban</div>';
          }
          let cumulativeDays = 0;
          return deps.map((dep, i) => {
            const amt      = parseDepositAmount(dep.amount, d.acquisitionPrice);
            const hasError = isNaN(amt);
            const dueDays  = parseDueDays(dep.due);
            cumulativeDays += dueDays !== null ? dueDays : 0;
            const dueStr   = typeof dep.due === 'number' ? dep.due + ' days' : (dep.due || '');
            const dueLabel = dueStr
              ? (i === 0 ? dueStr + ' from contract' : dueStr + ' after Deposit ' + i)
              : (dep.note || 'No date set');
            const pct      = !hasError && d.acquisitionPrice > 0 && amt > 0
              ? ' (' + ((amt / d.acquisitionPrice) * 100).toFixed(2).replace(/\.?0+$/, '') + '%)' : '';
            const display  = hasError ? '⚠️ re-enter in kanban' : (amt > 0 ? fmtDollar(amt) + pct : '—');
            const hint     = hasError ? '' : dueLabel;
            const depLabel = 'Deposit ' + (i + 1) + (hint ? '<span class="fin-field-hint">' + hint + '</span>' : '');
            return '<div class="fin-field fin-field-deposit' + (hasError ? ' fin-deposit-error' : '') + '" data-key="" data-type="dollar">'
              + '<span class="fin-field-label">' + depLabel + '</span>'
              + '<span class="fin-editable fin-deposit-val' + (hasError ? ' fin-neg' : '') + '">' + display + '</span>'
              + '</div>';
          }).join('');
        })()}
        ${ff('stampDuty',        'Stamp Duty',          fmtDollar(d.stampDuty),          'dollar', (d._state||'NSW') + ' transfer duty', false,
              `<button type="button" class="fin-field-action" id="finStampRefresh" title="Recalculate from acquisition price + ${d._state||'NSW'} rates">↻</button>`)}
        ${ff('valuationCost',    'Valuation',            fmtDollar(d.valuationCost),      'dollar')}
        ${ff('solicitorCost',    'Solicitor',            fmtDollar(d.solicitorCost),      'dollar')}
        ${ff('inspections',      'Inspections',          fmtDollar(d.inspections),        'dollar')}
        ${ff('salesCommissionPct','Sales Commission (%)', fmtPct(d.salesCommissionPct),   'pct')}
        ${ff('',                 'Commission ($)',        fmtDollar(r.commission),         'dollar', '', true)}
        ${ff('',                 'Equity Contribution',  fmtDollar(r.bankDepositRequired),'dollar', 'Price × (1−LVR) − deposits', true)}
      </div>
      <div class="fin-summary-row fin-summary-highlight"><span>Total Purchase Costs</span><span class="fin-summary-val">${fmtDollar(r.purchaseCosts)}</span></div>
      <div class="fin-fields" style="margin-top:8px">
        <div class="fin-subsection-label">Running Costs</div>
        ${ff('council',          'Council',                 fmtDollar(d.council),           'dollar', '/w, /m or /y')}
        ${ff('water',            'Water',                   fmtDollar(d.water),             'dollar', '/w, /m or /y')}
        ${ff('cleaning',         'Cleaning',                fmtDollar(d.cleaning),          'dollar', '/w, /m or /y')}
        ${ff('insurance',        'Insurance',               fmtDollar(d.insurance),         'dollar', '/w, /m or /y')}
        ${ff('landTax',          'Land Tax',                fmtDollar(d.landTax),           'dollar', '/w, /m or /y')}
        ${ff('managementFeePct', 'Management Fee (%)',      fmtPct(d.managementFeePct),     'pct',   '% of gross rent')}
        ${ff('',                 'Management Fee ($)',       fmtDollar(r.management$),       'dollar', '', true)}
        ${ff('commonPower',      'Common Power',            fmtDollar(d.commonPower),       'dollar', '/w, /m or /y')}
        ${ff('fireServices',     'Fire Services',           fmtDollar(d.fireServices),      'dollar', '/w, /m or /y')}
        ${ff('maintenance',      'Maintenance',             fmtDollar(d.maintenance),       'dollar', '/w, /m or /y')}
        ${ff('sinkingFundPct',   'Sinking Fund (% of val)', fmtPct(d.sinkingFundPct),       'pct',   '% of acq. price')}
        ${ff('',                 'Sinking Fund ($)',         fmtDollar(r.sinkingFund),       'dollar', '', true)}
        ${ff('other',            'Other',                   fmtDollar(d.other),             'dollar', '/w, /m or /y')}
      </div>
      <div class="fin-summary-row fin-summary-highlight"><span>Total Running Costs</span><span class="fin-summary-val">${fmtDollar(r.totalOutgoings)}</span></div>
      <div class="fin-summary-row ${r.netIncomeYr1 < 0 ? 'fin-summary-neg' : ''}">
        <span>Net Income (Year 1)</span><span class="fin-summary-val">${fmtDollar(r.netIncomeYr1)}</span>
      </div>
    </div>

    <div class="fin-autosave-status" id="finSaveStatus"></div>
  </div>`;
}

// ─── Main panel ───────────────────────────────────────────────────────────────

function renderMain(d, r) {
  const years   = r.years;
  const holdYrs = years.filter(y => y.yr > 0);
  const avg     = arr => arr.length ? arr.reduce((a, b) => a + b, 0) / arr.length : 0;
  const lag     = Math.round(d.settlementLag || 0);

  // Transposed table — metrics as rows, years as columns
  const allCols = [...years, holdYrs.length ? { yr: 'Avg' } : null].filter(Boolean);

  function yearCells(fn) {
    return years.map(y => fn(y)).join('') +
      (holdYrs.length ? `<td class="fin-avg-col">${fn({ _avg: true, yr: 'Avg' }, holdYrs)}</td>` : '');
  }

  // Helper to render a single cell value or the average across holdYrs
  function cell(y, holdYrs, valFn, cls = '') {
    if (y._avg) {
      const v = avg(holdYrs.map(valFn));
      return `<td class="fin-avg-col ${cls}">${typeof v === 'string' ? v : fmtDollar(v)}</td>`;
    }
    const v = valFn(y);
    return `<td class="${cls}">${v}</td>`;
  }

  const metricRows = [
    {
      label: 'Net Rent',
      rows: years.map(y => {
        const cls = (y.yr < lag ? 'fin-lag-cell ' : '') + (y.rent < 0 ? 'fin-neg' : '');
        return `<td class="${cls}">${fmtDollar(y.rent)}</td>`;
      }),
      avg: fmtDollar(avg(holdYrs.map(y => y.rent))),
      avgCls: avg(holdYrs.map(y => y.rent)) < 0 ? 'fin-neg' : '',
    },
    {
      label: 'Yield',
      rows: years.map(y => {
        const v = d.acquisitionPrice ? y.rent / d.acquisitionPrice : 0;
        return `<td class="fin-pct-cell ${v < 0 ? 'fin-neg' : ''}">${d.acquisitionPrice ? fmtPct(v) : '—'}</td>`;
      }),
      avg: d.acquisitionPrice ? fmtPct(avg(holdYrs.map(y => y.rent)) / d.acquisitionPrice) : '—',
      avgCls: 'fin-pct-cell',
    },
    {
      label: 'Principal (Start)',
      rows: years.map(y => `<td>${fmtDollar(y.principalStart)}</td>`),
      avg: '—', avgCls: '',
    },
    {
      label: 'Principal Paid',
      rows: years.map(y => `<td>${fmtDollar(y.principalPaid)}</td>`),
      avg: fmtDollar(avg(holdYrs.map(y => y.principalPaid))),
      avgCls: '',
    },
    {
      label: 'Interest Paid',
      rows: years.map(y => `<td>${fmtDollar(y.interest)}</td>`),
      avg: fmtDollar(avg(holdYrs.map(y => y.interest))),
      avgCls: '',
    },
    {
      label: 'Principal (End)',
      rows: years.map(y => `<td>${fmtDollar(y.principalEnd)}</td>`),
      avg: '—', avgCls: '',
    },
    {
      label: 'Cashflow',
      rows: years.map(y => `<td class="${y.cashflow < 0 ? 'fin-neg' : 'fin-pos'}">${fmtDollar(y.cashflow)}</td>`),
      avg: fmtDollar(avg(holdYrs.map(y => y.cashflow))),
      avgCls: avg(holdYrs.map(y => y.cashflow)) < 0 ? 'fin-neg' : 'fin-pos',
    },
    {
      label: 'CoC (Rolling)',
      rows: years.map(y => `<td class="fin-pct-cell ${y.coc < 0 ? 'fin-neg' : 'fin-pos'}">${y.cashEquityStart > 0 ? fmtPct(y.coc) : '—'}</td>`),
      avg: fmtPct(avg(holdYrs.filter(y => y.cashEquityStart > 0).map(y => y.coc))),
      avgCls: 'fin-pct-cell',
    },
    {
      label: 'ROE',
      rows: years.map(y => `<td class="fin-pct-cell ${y.roe < 0 ? 'fin-neg' : 'fin-pos'}">${y.cashEquityStart > 0 ? fmtPct(y.roe) : '—'}</td>`),
      avg: fmtPct(avg(holdYrs.filter(y => y.cashEquityStart > 0).map(y => y.roe))),
      avgCls: 'fin-pct-cell',
    },
    {
      label: 'Asset Value',
      rows: years.map(y => `<td>${fmtDollar(y.assetValue)}</td>`),
      avg: fmtDollar(avg(holdYrs.map(y => y.assetValue))),
      avgCls: '',
    },
    {
      label: 'Cost of Funds',
      rows: years.map(y => `<td class="fin-muted">${fmtDollar(y.costOfFunds)}</td>`),
      avg: '—', avgCls: 'fin-muted',
    },
    {
      label: 'NPV (Asset Val)',
      rows: years.map(y => `<td class="${y.npvAssetValue < 0 ? 'fin-neg' : 'fin-pos'}">${fmtDollar(y.npvAssetValue)}</td>`),
      avg: '—', avgCls: '',
    },
  ];

  // ── Funds to Complete section rows ────────────────────────────────────
  // Purchase costs + deposit tranches, each placed in the year they fall due.
  // Year 0 = contract/exchange. Settlement lag year = when bank draws.
  const fundsToCompleteRows = (() => {
    // Always read fresh from live pipeline
    const _lp = window.getPipelineData ? window.getPipelineData() : {};
    const entry = _lp[_current?.pipelineId] || _current?.pipelineEntry;
    const offers = entry?.offers || [];
    const _offeredPrice = _current?.offeredPrice;
    const selOffer = _offeredPrice
      ? offers.find(o => { const n = parseFloat(String(o.price||'').replace(/[^0-9.]/g,'')); return Math.abs(n - _offeredPrice) < 1; })
      : offers[0];
    const deps = (selOffer?.deposits || entry?.terms?.deposits || []).filter(dep => dep.amount);

    // Helper: one table row with a value in one specific year, dashes elsewhere
    function singleYearRow(label, yr, amt, cls, hint) {
      const rowCls = cls || 'fin-costs-row';
      const cells = years.map(y => {
        if (y.yr === yr) return '<td class="fin-neg fin-costs-cell">' + fmtDollar(-Math.abs(amt)) + '</td>';
        return '<td></td>';
      }).join('');
      const labelHtml = hint
        ? label + ' <span class="fin-deposit-due-label">' + hint + '</span>'
        : label;
      return '<tr class="' + rowCls + '">'
        + '<th class="fin-row-label fin-costs-label">' + labelHtml + '</th>'
        + cells
        + (holdYrs.length ? '<td class="fin-avg-col"></td>' : '')
        + '</tr>';
    }

    const rows = [];

    // Section header row
    const ftcOpen = !_sectionCollapsed['fin-funds-complete'];
    rows.push('<tr class="fin-costs-header-row" id="finFundsHeader">'
      + '<th class="fin-row-label fin-costs-header">'
      + '<span class="fin-funds-toggle" id="finFundsToggle">' + (ftcOpen ? '▼' : '▶') + '</span>'
      + ' Funds to Complete'
      + '<label class="fin-costs-toggle-label" title="Include in cashflow">'
      + '<input type="checkbox" id="finCostsInCashflow" class="fin-costs-checkbox"' + (_costsInCashflow ? ' checked' : '') + '>'
      + '<span class="fin-costs-checkbox-label">Include in cashflow</span>'
      + '</label>'
      + '</th>'
      + years.map(() => '<td></td>').join('')
      + (holdYrs.length ? '<td class="fin-avg-col"></td>' : '')
      + '</tr>');

    // Purchase costs + deposits — only rendered when section is open
    if (ftcOpen) {
      // Use settlementYr computed in runModel (consistent with KPI tiles)
      const settlementYr = r.settlementYr;
      if (d.stampDuty)           rows.push(singleYearRow('Stamp Duty',    settlementYr, d.stampDuty));
      if (d.valuationCost)       rows.push(singleYearRow('Valuation',     settlementYr, d.valuationCost));
      if (d.solicitorCost)       rows.push(singleYearRow('Solicitor',     settlementYr, d.solicitorCost));
      if (d.inspections)         rows.push(singleYearRow('Inspections',   settlementYr, d.inspections));
      if (r.commission)          rows.push(singleYearRow('Commission',    settlementYr, r.commission));
      if (r.bankDepositRequired) rows.push(singleYearRow('Equity Contribution', settlementYr, r.bankDepositRequired, 'fin-costs-row fin-bank-dep-row'));

      // Deposit tranches — each in their computed year
      let cumulativeDays = 0;
      deps.forEach((dep, i) => {
        const amt = parseDepositAmount(dep.amount, d.acquisitionPrice);
        if (isNaN(amt)) {
          // Bad data — show error row spanning all year columns
          rows.push('<tr class="fin-costs-row fin-deposit-row fin-deposit-error-row">'
            + '<th class="fin-row-label fin-costs-label">Deposit ' + (i + 1) + '</th>'
            + years.map(() => '<td class="fin-deposit-error-cell" colspan="1">⚠️ re-enter in kanban</td>').join('')
            + (holdYrs.length ? '<td class="fin-avg-col"></td>' : '')
            + '</tr>');
          return;
        }
        if (!amt || amt <= 0) return;
        const dueDays = parseDueDays(dep.due);
        cumulativeDays += dueDays !== null ? dueDays : 0;
        const dueYear = Math.floor(cumulativeDays / 365); // no lag cap — deposit timing is independent of settlement lag
        const pct = d.acquisitionPrice > 0 ? ((amt / d.acquisitionPrice) * 100).toFixed(1) + '%' : '';
        const dueStr   = typeof dep.due === 'number' ? dep.due + ' days' : (dep.due || '');
        const dueLabel = dueStr
          ? (i === 0 ? dueStr + ' from contract' : dueStr + ' after Deposit ' + i)
          : (dep.note || '');
        const hint = (pct ? pct + (dueLabel ? ' · ' + dueLabel : '') : dueLabel);
        rows.push(singleYearRow('Deposit ' + (i + 1), dueYear, amt, 'fin-costs-row fin-deposit-row', hint));
      });
    }

    return rows.join('');
  })();

  const tableRows = fundsToCompleteRows + metricRows.map(m => `
    <tr>
      <th class="fin-row-label">${m.label}</th>
      ${m.rows.join('')}
      ${holdYrs.length ? `<td class="fin-avg-col ${m.avgCls}">${m.avg}</td>` : ''}
    </tr>`).join('');

  const yearHeaders = years.map(y =>
    `<th class="${y.yr < lag ? 'fin-lag-col' : ''}">Yr ${y.yr}</th>`
  ).join('') + (holdYrs.length ? '<th class="fin-avg-col">Avg</th>' : '');

  const exit     = years[years.length - 1];
  const firstActive = years.find(y => y.yr >= lag);
  const npvClass = (exit?.npvAssetValue ?? 0) >= 0 ? 'fin-kpi-pos' : 'fin-kpi-neg';

  return `<div class="fin-main">

    <div class="fin-kpis">
      <div class="fin-kpi"><div class="fin-kpi-label">Acquisition Price</div><div class="fin-kpi-val">${fmtDollarK(d.acquisitionPrice)}</div></div>
      <div class="fin-kpi fin-kpi-mean"><div class="fin-kpi-label">Comparable Value</div><div class="fin-kpi-val" id="finKpiMeanVal">${(() => { const m = comparableMean(d, r); return m != null ? fmtDollarK(m) : '—'; })()}</div></div>
      <div class="fin-kpi"><div class="fin-kpi-label">Total Loan</div><div class="fin-kpi-val">${fmtDollarK(r.loan)}</div></div>
      <div class="fin-kpi"><div class="fin-kpi-label">Cash Required (Upfront)</div><div class="fin-kpi-val">${fmtDollarK(r.upfront)}</div></div>
      <div class="fin-kpi"><div class="fin-kpi-label">Cash Required (Settlement)</div><div class="fin-kpi-val">${fmtDollarK(r.cashAtSettlement)}</div></div>
      <div class="fin-kpi"><div class="fin-kpi-label">Cash Required (Total)</div><div class="fin-kpi-val">${fmtDollarK(r.upfront + r.cashAtSettlement)}</div></div>
      <div class="fin-kpi"><div class="fin-kpi-label">Net Income (Yr 1)</div><div class="fin-kpi-val ${r.netIncomeYr1 < 0 ? 'fin-kpi-neg' : 'fin-kpi-pos'}">${fmtDollarK(r.netIncomeYr1)}</div></div>
      <div class="fin-kpi"><div class="fin-kpi-label">Asset Value (Exit)</div><div class="fin-kpi-val">${fmtDollarK(exit?.assetValue)}</div></div>
      <div class="fin-kpi"><div class="fin-kpi-label">NPV at Exit</div><div class="fin-kpi-val ${npvClass}">${fmtDollarK(exit?.npvAssetValue)}</div></div>
    </div>

    <div class="fin-table-wrap">
      <table class="fin-table fin-table-transposed">
        <thead>
          <tr>
            <th class="fin-row-label-header"></th>
            ${yearHeaders}
          </tr>
        </thead>
        <tbody>${tableRows}</tbody>
      </table>
    </div>

    ${renderComparableValues(d, r)}

    <div class="fin-footer-legend" id="finFooterLegend">
      <div class="fin-footer-legend-header" id="finFooterLegendToggle">
        <span class="fin-footer-legend-title">Calculations Explained</span>
        <span class="fin-footer-legend-chevron" id="finFooterLegendChevron">${_footerLegendOpen ? '▼' : '▶'}</span>
      </div>
      <div class="fin-footer-legend-body" id="finFooterLegendBody" style="display:${_footerLegendOpen ? '' : 'none'}">
        <div class="fin-footer-legend-item">
          <div class="fin-footer-legend-label">Principal Paid</div>
          <div class="fin-footer-legend-text">
            (Net Rent − Interest) × % Profit → Debt Reduction. The portion of each year's operating profit that is applied to reduce the loan balance, controlled by the "% Profit → Debt Reduction" input. Interest = Principal (Start) × Loan Interest Rate. Principal (End) = Principal (Start) − Principal Paid; this becomes next year's Principal (Start).
            <em>Currently: ${fmtPct(d.profitUsedForDebt)} of profit applied to debt reduction.</em>
          </div>
        </div>
        <div class="fin-footer-legend-item">
          <div class="fin-footer-legend-label">Cashflow</div>
          <div class="fin-footer-legend-text">
            Net Rent − Interest − Principal Paid (operating cashflow). When "Include in cashflow" is ticked on the Funds to Complete row, deposits and settlement costs are subtracted from the cashflow row in the years they fall due — for display purposes only; this does not affect CoC or ROE.
          </div>
        </div>
        <div class="fin-footer-legend-item">
          <div class="fin-footer-legend-label">Cash-on-Cash (Rolling)</div>
          <div class="fin-footer-legend-text">
            Annual operating cashflow ÷ cash equity at start of year. Denominator grows with each Funds-to-Complete payment and shrinks as positive cashflow is distributed (controlled by Retained Earnings %). Negative cashflow always reduces cash position fully.
            <em>Answers: "What yield am I earning on the cash I currently have tied up?"</em>
          </div>
        </div>
        <div class="fin-footer-legend-item">
          <div class="fin-footer-legend-label">Return on Equity (ROE)</div>
          <div class="fin-footer-legend-text">
            (Operating cashflow + property appreciation + principal paid down) ÷ cash equity at start of year. Captures total wealth return — cash plus equity buildup.
            <em>Answers: "What total annual return am I earning on my equity?"</em>
          </div>
        </div>
        <div class="fin-footer-legend-item">
          <div class="fin-footer-legend-label">Retained Earnings %</div>
          <div class="fin-footer-legend-text">
            Portion of positive annual cashflow kept in the deal vs. distributed. 0% = all distributed (cash position falls each year by full cashflow); 100% = all retained (cash position unchanged by distributions). Negative cashflows always reduce cash position fully regardless of this setting.
          </div>
        </div>
        <div class="fin-footer-legend-item">
          <div class="fin-footer-legend-label">Cost of Funds &amp; NPV</div>
          <div class="fin-footer-legend-text">
            Pre-settlement: Cash Required (Upfront) × Cost of Capital. Post-settlement: Cash Required (Total) × Cost of Capital × (1 + rental growth)^(yr − settlement lag). NPV (Asset Val) = Asset Value − Cost of Funds for that year.
          </div>
        </div>
        <div class="fin-footer-legend-item fin-footer-legend-meta">
          Transfer duty auto-calculated (${d._state||'NSW'} rates, 1 July 2025) · All figures indicative only.
        </div>
      </div>
    </div>
  </div>`;
}

function updateMeanValueHeader(r) {
  const meanEl = document.getElementById('finMeanVal');
  const numEl  = document.getElementById('finMeanNum');
  if (!meanEl || !numEl) return;
  const vals = [r.m1, r.m2, r.m3, r.m5].filter(v => v != null && isFinite(v) && v !== 0);
  if (!vals.length) { meanEl.style.display = 'none'; return; }
  const mean = vals.reduce((a, b) => a + b, 0) / vals.length;
  numEl.textContent = fmtDollarK(mean);
  numEl.className   = 'fin-mean-num ' + (mean < 0 ? 'fin-neg' : '');
  meanEl.style.display = '';
}

function comparableMean(d, r) {
  // Returns the mean of methods that are (a) flagged as included by the user
  // (default true if undefined for legacy models) and (b) have a valid non-zero value.
  const pairs = [
    [d.includeM1 !== false, r.m1],
    [d.includeM2 !== false, r.m2],
    [d.includeM3 !== false, r.m3],
    [d.includeM5 !== false, r.m5],
  ];
  const vals = pairs.filter(([on, v]) => on && v != null && isFinite(v) && v !== 0).map(([, v]) => v);
  return vals.length ? vals.reduce((a, b) => a + b, 0) / vals.length : null;
}

function renderComparableValues(d, r) {
  const methods = [
    {
      includeKey: 'includeM1',
      label:  'Method 1: Gross Area',
      detail: `${(d.netDevelopableAreaAcres||0).toFixed(3)} NDA acres × $${(d.comparableValuePerNDA||0).toLocaleString()}/NDA + residual`,
      value:  r.m1,
      inputs: [
        ff('netDevelopableAreaAcres','NDA (Acres)',             (d.netDevelopableAreaAcres||0).toFixed(4),'num'),
        ff('comparableValuePerNDA',  'Comparable Value ($/NDA)',fmtDollar(d.comparableValuePerNDA),       'dollar'),
        ff('residualLandVal',        'Residual Land Val',       fmtDollar(d.residualLandVal),             'dollar'),
      ],
    },
    {
      includeKey: 'includeM2',
      label:  'Method 2: 30% of GRV',
      detail: `GRV ${fmtDollar(r.grv)} ÷ 3 · NSA ${(r.nsa||0).toLocaleString()} sqm`,
      value:  r.m2,
      inputs: [
        ff('lots',        'Lots',             d.lots,                    'int'),
        ff('avLotSizeSqm','Av Lot Size (sqm)', d.avLotSizeSqm,          'int'),
        ff('ratePerSqm',  'Rate ($/sqm)',      fmtDollar(d.ratePerSqm), 'dollar'),
      ],
    },
    {
      includeKey: 'includeM3',
      label:  'Method 3: Development Estimate (TDC $/lot)',
      detail: `GRV − TDC − holding cost − interest − profit margin`,
      value:  r.m3,
      inputs: [
        ff('lots',           'Lots',             d.lots,                        'int'),
        ff('tdcPerLot',      'TDC ($/lot)',       fmtDollar(d.tdcPerLot),       'dollar'),
        ff('profitMarginPct','Profit Margin (%)', fmtPct(d.profitMarginPct),    'pct'),
      ],
    },
    {
      includeKey: 'includeM5',
      label:  'Method 5: Derived from Yield',
      detail: `Net Income ${fmtDollar(r.netIncomeYr1)} ÷ ${fmtPct(d.targetYieldPct)} target yield`,
      value:  r.m5,
      inputs: [
        ff('targetYieldPct','Target Yield (% pa)', fmtPct(d.targetYieldPct), 'pct'),
      ],
    },
  ];

  const mean = comparableMean(d, r);

  return `<div class="fin-comparable" id="finComparable">
    <div class="fin-comparable-header" id="finComparableToggle">
      <div class="fin-comparable-title">
        Comparable Value Analysis
        ${mean != null ? `<span class="fin-comp-mean-badge ${mean < 0 ? 'fin-neg' : ''}">Mean: ${fmtDollar(mean)}</span>` : ''}
      </div>
      <span class="fin-comp-chevron" id="finCompChevron">▼</span>
    </div>
    <div class="fin-comparable-body" id="finComparableBody">
      <div class="fin-comparable-grid">
        ${methods.map(m => {
          const included = d[m.includeKey] !== false; // default true for legacy models
          return `
          <div class="fin-comp-card${included ? '' : ' fin-comp-card-excluded'}">
            <label class="fin-comp-include-label" title="Include in Comparable Value mean">
              <input type="checkbox" class="fin-comp-include-checkbox" data-include-key="${m.includeKey}"${included ? ' checked' : ''}>
              <span class="fin-comp-method">${m.label}</span>
            </label>
            <div class="fin-comp-detail">${m.detail}</div>
            <div class="fin-comp-value ${m.value < 0 ? 'fin-neg' : ''}">${fmtDollar(m.value)}</div>
            <div class="fin-comp-inputs">${m.inputs.join('')}</div>
          </div>`;
        }).join('')}
      </div>
      <div class="fin-comp-note">GRV (ex GST): ${fmtDollar(r.grv)} · Net Sellable Area: ${(r.nsa||0).toLocaleString()} sqm · Acquisition Price: ${fmtDollar(d.acquisitionPrice)}</div>
    </div>
  </div>`;
}

// ─── Export to Excel (V81.3) ──────────────────────────────────────────────────
// Styled to match the PropMap finance module UI — warm cream backgrounds,
// gold accent, muted-grey labels, green/red for pos/neg. Cell styling requires
// xlsx-js-style (loaded via CDN in index.html), which is a drop-in for the
// SheetJS community edition and writes styles that Excel renders.

// ── Palette (mirrors CSS vars in styles.css / finance-styles.css) ──
const X_BG       = 'F5F4F0'; // --bg (page)
const X_SURFACE  = 'FFFFFF'; // --surface (cards, table body)
const X_SURFACE2 = 'F0EEEA'; // --surface2 (headers, averages, hover)
const X_BORDER   = 'E6E6E6'; // --border solid equivalent
const X_TEXT     = '1A1A1A'; // --text
const X_MUTED    = '666666'; // --muted
const X_ACCENT   = 'C4841A'; // --accent (gold)
const X_RED      = 'C0392B'; // --red
const X_GREEN    = '27AE60'; // --green

// Number formats
const FMT_DOLLAR = '$#,##0;[Red]($#,##0)';
const FMT_PCT2   = '0.00%;[Red](0.00%)';
const FMT_INT    = '#,##0';
const FMT_NUM3   = '0.000';
const FMT_DATE   = 'dd-mmm-yyyy';

// ── Style presets ───────────────────────────────────────────────────────────
const S = {
  title: {
    font: { name: 'Calibri', sz: 16, bold: true, color: { rgb: X_ACCENT } },
    alignment: { vertical: 'center' },
  },
  metaLabel: {
    font: { name: 'Calibri', sz: 10, color: { rgb: X_MUTED } },
    alignment: { horizontal: 'left', vertical: 'center' },
  },
  metaValue: {
    font: { name: 'Calibri', sz: 11, color: { rgb: X_TEXT } },
    alignment: { horizontal: 'left', vertical: 'center' },
  },
  sectionHdr: {
    font: { name: 'Calibri', sz: 11, bold: true, color: { rgb: X_ACCENT } },
    fill: { patternType: 'solid', fgColor: { rgb: X_SURFACE2 } },
    alignment: { horizontal: 'left', vertical: 'center' },
    border: {
      top:    { style: 'thin', color: { rgb: X_BORDER } },
      bottom: { style: 'thin', color: { rgb: X_BORDER } },
    },
  },
  colHdr: {
    font: { name: 'Calibri', sz: 10, bold: true, color: { rgb: X_MUTED } },
    fill: { patternType: 'solid', fgColor: { rgb: X_SURFACE2 } },
    alignment: { horizontal: 'right', vertical: 'center' },
    border: { bottom: { style: 'thin', color: { rgb: X_BORDER } } },
  },
  colHdrLeft: {
    font: { name: 'Calibri', sz: 10, bold: true, color: { rgb: X_MUTED } },
    fill: { patternType: 'solid', fgColor: { rgb: X_SURFACE2 } },
    alignment: { horizontal: 'left', vertical: 'center' },
    border: { bottom: { style: 'thin', color: { rgb: X_BORDER } } },
  },
  rowLabel: {
    font: { name: 'Calibri', sz: 11, color: { rgb: X_MUTED } },
    alignment: { horizontal: 'left', vertical: 'center' },
    border: { bottom: { style: 'thin', color: { rgb: X_BORDER } } },
  },
  rowLabelCost: {
    font: { name: 'Calibri', sz: 11, color: { rgb: X_RED } },
    alignment: { horizontal: 'left', vertical: 'center' },
    border: { bottom: { style: 'thin', color: { rgb: X_BORDER } } },
  },
  data: {
    font: { name: 'Calibri', sz: 11, color: { rgb: X_TEXT } },
    alignment: { horizontal: 'right', vertical: 'center' },
    border: { bottom: { style: 'thin', color: { rgb: X_BORDER } } },
  },
  dataMuted: {
    font: { name: 'Calibri', sz: 11, color: { rgb: X_MUTED } },
    alignment: { horizontal: 'right', vertical: 'center' },
    border: { bottom: { style: 'thin', color: { rgb: X_BORDER } } },
  },
  dataAvg: {
    font: { name: 'Calibri', sz: 11, bold: true, color: { rgb: X_TEXT } },
    fill: { patternType: 'solid', fgColor: { rgb: X_SURFACE2 } },
    alignment: { horizontal: 'right', vertical: 'center' },
    border: {
      top:    { style: 'medium', color: { rgb: X_BORDER } },
      bottom: { style: 'thin',   color: { rgb: X_BORDER } },
      left:   { style: 'medium', color: { rgb: X_BORDER } },
    },
  },
  kpiLabel: {
    font: { name: 'Calibri', sz: 10, bold: true, color: { rgb: X_MUTED } },
    fill: { patternType: 'solid', fgColor: { rgb: X_SURFACE } },
    alignment: { horizontal: 'left', vertical: 'center' },
    border: { bottom: { style: 'thin', color: { rgb: X_BORDER } } },
  },
  kpiValue: {
    font: { name: 'Calibri', sz: 12, bold: true, color: { rgb: X_TEXT } },
    fill: { patternType: 'solid', fgColor: { rgb: X_SURFACE } },
    alignment: { horizontal: 'right', vertical: 'center' },
    border: { bottom: { style: 'thin', color: { rgb: X_BORDER } } },
  },
};

// Helper: clone a base style and overlay a font color (for pos/neg signalling)
function styleColor(base, rgb) {
  return Object.assign({}, base, {
    font: Object.assign({}, base.font, { color: { rgb } }),
  });
}

// Cell builders — each returns a SheetJS cell object with type, format, and style.
function cellText(v, style)   { return { v: v == null ? '' : String(v), t: 's', s: style || S.data }; }
function cellNum(v, fmt, style) {
  if (v == null || isNaN(v) || !isFinite(v)) {
    return { v: '—', t: 's', s: style || S.dataMuted };
  }
  return { v: Number(v), t: 'n', z: fmt || FMT_DOLLAR, s: style || S.data };
}
function cellDate(d, style) {
  return { v: d, t: 'd', z: FMT_DATE, s: style || S.metaValue };
}
// Auto-tint a numeric cell red for negative / green for positive (used in
// metric rows where the on-screen module colours cashflow/yield/CoC/ROE).
function cellSignedNum(v, fmt, baseStyle) {
  if (v == null || isNaN(v) || !isFinite(v)) {
    return { v: '—', t: 's', s: baseStyle || S.dataMuted };
  }
  const styled = v < 0 ? styleColor(baseStyle || S.data, X_RED)
                       : (v > 0 ? styleColor(baseStyle || S.data, X_GREEN) : (baseStyle || S.data));
  return { v: Number(v), t: 'n', z: fmt || FMT_DOLLAR, s: styled };
}

function exportToExcel() {
  if (!_current || typeof XLSX === 'undefined') {
    if (typeof XLSX === 'undefined') {
      console.error('[finance export] XLSX library not loaded');
      alert('Export library failed to load — refresh the page and try again.');
    }
    return;
  }

  const d = _current.data;
  const r = runModel(d);
  const years   = r.years || [];
  const holdYrs = years.filter(y => y.yr > 0);
  const avg     = arr => arr.length ? arr.reduce((a, b) => a + b, 0) / arr.length : 0;
  const exit    = years[years.length - 1] || {};
  const propAddr   = _current.address || 'Property';
  const propSuburb = _current.suburb  || '';

  const wb = XLSX.utils.book_new();

  // ── Sheet 1: Summary ──────────────────────────────────────────────────────
  {
    const aoa = [];
    // Title (merged across cols 0-1)
    aoa.push([cellText('Financial Model', S.title), null]);
    aoa.push([
      cellText('Property',     S.metaLabel),
      cellText(propAddr + (propSuburb ? ', ' + propSuburb : ''), S.metaValue),
    ]);
    aoa.push([cellText('State (duty)', S.metaLabel), cellText(d._state || 'NSW', S.metaValue)]);
    aoa.push([cellText('Generated',    S.metaLabel), cellDate(new Date(), S.metaValue)]);
    aoa.push([null, null]);

    aoa.push([cellText('KEY METRICS', S.sectionHdr), cellText('', S.sectionHdr)]);
    const cmpMean = comparableMean(d, r);
    const kpis = [
      ['Acquisition Price',          d.acquisitionPrice,        FMT_DOLLAR, null],
      ['Comparable Value (mean)',    cmpMean,                   FMT_DOLLAR, null],
      ['Total Loan',                 r.loan,                    FMT_DOLLAR, null],
      ['Cash Required (Upfront)',    r.upfront,                 FMT_DOLLAR, null],
      ['Cash Required (Settlement)', r.cashAtSettlement,        FMT_DOLLAR, null],
      ['Cash Required (Total)',      r.upfront + r.cashAtSettlement, FMT_DOLLAR, null],
      ['Net Income (Yr 1)',          r.netIncomeYr1,            FMT_DOLLAR, 'signed'],
      ['Asset Value (Exit)',         exit.assetValue,           FMT_DOLLAR, null],
      ['NPV at Exit',                exit.npvAssetValue,        FMT_DOLLAR, 'signed'],
    ];
    kpis.forEach(([label, val, fmt, tint]) => {
      aoa.push([
        cellText(label, S.kpiLabel),
        tint === 'signed' ? cellSignedNum(val, fmt, S.kpiValue) : cellNum(val, fmt, S.kpiValue),
      ]);
    });
    aoa.push([null, null]);

    aoa.push([cellText('RUN PARAMETERS', S.sectionHdr), cellText('', S.sectionHdr)]);
    const params = [
      ['Term of Ownership (yrs)',    d.termOfOwnership,      FMT_INT],
      ['Settlement Lag (yrs)',       d.settlementLag,        FMT_NUM3],
      ['Hold to Revaluation (yrs)',  d.holdDurationPreReval, FMT_INT],
      ['LVR',                        d.lvr,                  FMT_PCT2],
      ['Interest Rate',              d.interestRate,         FMT_PCT2],
      ['Rental Growth',              d.rentalGrowth,         FMT_PCT2],
      ['Capital Growth',             d.capitalGrowth,        FMT_PCT2],
      ['Cost of Capital',            d.costOfCapital,        FMT_PCT2],
    ];
    params.forEach(([label, val, fmt]) => {
      aoa.push([cellText(label, S.rowLabel), cellNum(val, fmt, S.data)]);
    });

    const ws = aoaToSheet(aoa);
    ws['!cols']   = [{ wch: 32 }, { wch: 22 }];
    ws['!merges'] = [
      { s: { r: 0, c: 0 }, e: { r: 0, c: 1 } }, // Title merge across both cols
      { s: { r: 5, c: 0 }, e: { r: 5, c: 1 } }, // KEY METRICS hdr
      { s: { r: 5 + kpis.length + 2, c: 0 }, e: { r: 5 + kpis.length + 2, c: 1 } }, // RUN PARAMS hdr
    ];
    // Title row taller
    ws['!rows'] = [{ hpt: 26 }];
    XLSX.utils.book_append_sheet(wb, ws, 'Summary');
  }

  // ── Sheet 2: Cashflow ─────────────────────────────────────────────────────
  {
    const aoa = [];
    // Title row
    const titleRow = [cellText('Cashflow Projection', S.title)];
    for (let i = 0; i < years.length + (holdYrs.length ? 1 : 0); i++) titleRow.push(null);
    aoa.push(titleRow);
    aoa.push([]); // spacer

    // Column headers
    const yrHeader = [cellText('', S.colHdrLeft)].concat(
      years.map(y => cellText('Yr ' + y.yr, S.colHdr))
    );
    if (holdYrs.length) yrHeader.push(cellText('Avg', S.colHdr));
    aoa.push(yrHeader);

    // ── Funds to Complete section header (spans all cols visually) ──────
    const ftcHeaderRow = [cellText('FUNDS TO COMPLETE', S.sectionHdr)];
    years.forEach(() => ftcHeaderRow.push(cellText('', S.sectionHdr)));
    if (holdYrs.length) ftcHeaderRow.push(cellText('', S.sectionHdr));
    aoa.push(ftcHeaderRow);

    // Read selected offer for deposit tranches
    const _lp = window.getPipelineData ? window.getPipelineData() : {};
    const entry = _lp[_current.pipelineId] || _current.pipelineEntry;
    const offers = entry?.offers || [];
    const _offeredPrice = _current.offeredPrice;
    const selOffer = _offeredPrice
      ? offers.find(o => { const n = parseFloat(String(o.price||'').replace(/[^0-9.]/g,'')); return Math.abs(n - _offeredPrice) < 1; })
      : offers[0];
    const deps = (selOffer?.deposits || entry?.terms?.deposits || []).filter(dep => dep.amount);

    const settlementYr = r.settlementYr;
    function fundsRow(label, yr, amt) {
      const row = [cellText(label, S.rowLabelCost)];
      years.forEach(y => {
        if (y.yr === yr) {
          row.push(cellNum(-Math.abs(amt), FMT_DOLLAR, styleColor(S.data, X_RED)));
        } else {
          row.push(cellText('', S.data));
        }
      });
      if (holdYrs.length) row.push(cellText('', S.dataAvg));
      return row;
    }

    if (d.stampDuty)           aoa.push(fundsRow('Stamp Duty',          settlementYr, d.stampDuty));
    if (d.valuationCost)       aoa.push(fundsRow('Valuation',           settlementYr, d.valuationCost));
    if (d.solicitorCost)       aoa.push(fundsRow('Solicitor',           settlementYr, d.solicitorCost));
    if (d.inspections)         aoa.push(fundsRow('Inspections',         settlementYr, d.inspections));
    if (r.commission)          aoa.push(fundsRow('Commission',          settlementYr, r.commission));
    if (r.bankDepositRequired) aoa.push(fundsRow('Equity Contribution', settlementYr, r.bankDepositRequired));

    let cumulativeDays = 0;
    deps.forEach((dep, i) => {
      const amt = parseDepositAmount(dep.amount, d.acquisitionPrice);
      if (isNaN(amt) || !amt || amt <= 0) return;
      const dueDays = parseDueDays(dep.due);
      cumulativeDays += dueDays !== null ? dueDays : 0;
      const dueYear = Math.floor(cumulativeDays / 365);
      const pct = d.acquisitionPrice > 0 ? ((amt / d.acquisitionPrice) * 100).toFixed(1) + '%' : '';
      const dueStr = typeof dep.due === 'number' ? dep.due + ' days' : (dep.due || '');
      const label = 'Deposit ' + (i + 1) + (pct ? ' (' + pct + (dueStr ? ' · ' + dueStr : '') + ')' : '');
      aoa.push(fundsRow(label, dueYear, amt));
    });

    // ── Metrics section ────────────────────────────────────────────────
    const metricsHdr = [cellText('METRICS', S.sectionHdr)];
    years.forEach(() => metricsHdr.push(cellText('', S.sectionHdr)));
    if (holdYrs.length) metricsHdr.push(cellText('', S.sectionHdr));
    aoa.push(metricsHdr);

    // Tint flag: 'signed' = green/red based on sign, 'muted' = muted style, null = standard
    function metricRow(label, valFn, fmt, opts) {
      opts = opts || {};
      const dataStyle = opts.muted ? S.dataMuted : S.data;
      const avgStyle  = opts.muted
        ? Object.assign({}, S.dataAvg, { font: Object.assign({}, S.dataAvg.font, { color: { rgb: X_MUTED } }) })
        : S.dataAvg;
      const row = [cellText(label, S.rowLabel)];
      years.forEach(y => {
        const v = valFn(y);
        if (opts.tint === 'signed') row.push(cellSignedNum(v, fmt, dataStyle));
        else                        row.push(cellNum(v, fmt, dataStyle));
      });
      if (holdYrs.length) {
        let a;
        if (opts.avgFn) a = opts.avgFn();
        else            a = avg(holdYrs.map(valFn).filter(v => v != null && isFinite(v)));
        if (opts.tint === 'signed') row.push(cellSignedNum(a, fmt, avgStyle));
        else                        row.push(cellNum(a, fmt, avgStyle));
      }
      return row;
    }

    aoa.push(metricRow('Net Rent',        y => y.rent, FMT_DOLLAR, { tint: 'signed' }));
    aoa.push(metricRow('Yield',           y => d.acquisitionPrice ? y.rent / d.acquisitionPrice : null, FMT_PCT2,
      { muted: true, avgFn: () => d.acquisitionPrice ? avg(holdYrs.map(y => y.rent)) / d.acquisitionPrice : null }));
    aoa.push(metricRow('Principal (Start)', y => y.principalStart, FMT_DOLLAR, { avgFn: () => null }));
    aoa.push(metricRow('Principal Paid',  y => y.principalPaid, FMT_DOLLAR));
    aoa.push(metricRow('Interest Paid',   y => y.interest,      FMT_DOLLAR));
    aoa.push(metricRow('Principal (End)', y => y.principalEnd, FMT_DOLLAR, { avgFn: () => null }));
    aoa.push(metricRow('Cashflow',        y => y.cashflow, FMT_DOLLAR, { tint: 'signed' }));
    aoa.push(metricRow('CoC (Rolling)',   y => y.cashEquityStart > 0 ? y.coc : null, FMT_PCT2, {
      tint: 'signed', muted: true,
      avgFn: () => { const arr = holdYrs.filter(y => y.cashEquityStart > 0).map(y => y.coc); return arr.length ? avg(arr) : null; },
    }));
    aoa.push(metricRow('ROE',             y => y.cashEquityStart > 0 ? y.roe : null, FMT_PCT2, {
      tint: 'signed', muted: true,
      avgFn: () => { const arr = holdYrs.filter(y => y.cashEquityStart > 0).map(y => y.roe); return arr.length ? avg(arr) : null; },
    }));
    aoa.push(metricRow('Asset Value',     y => y.assetValue, FMT_DOLLAR));
    aoa.push(metricRow('Cost of Funds',   y => y.costOfFunds, FMT_DOLLAR, { muted: true, avgFn: () => null }));
    aoa.push(metricRow('NPV (Asset Val)', y => y.npvAssetValue, FMT_DOLLAR, { tint: 'signed', avgFn: () => null }));

    const ws = aoaToSheet(aoa);
    const cols = [{ wch: 28 }].concat(years.map(() => ({ wch: 14 })));
    if (holdYrs.length) cols.push({ wch: 14 });
    ws['!cols'] = cols;
    // Title spans all columns; height taller
    const totalCols = 1 + years.length + (holdYrs.length ? 1 : 0);
    ws['!merges'] = [
      { s: { r: 0, c: 0 }, e: { r: 0, c: totalCols - 1 } },
      // Section headers (full-width visual band)
      { s: { r: 3, c: 0 }, e: { r: 3, c: totalCols - 1 } }, // FUNDS TO COMPLETE
    ];
    // Find METRICS section row index to merge
    const metricsRowIdx = aoa.findIndex(row => row && row[0] && row[0].v === 'METRICS');
    if (metricsRowIdx > 0) {
      ws['!merges'].push({ s: { r: metricsRowIdx, c: 0 }, e: { r: metricsRowIdx, c: totalCols - 1 } });
    }
    ws['!rows'] = [{ hpt: 26 }]; // title row tall
    // Freeze the header row + the first column
    ws['!freeze'] = { xSplit: 1, ySplit: 3 };
    XLSX.utils.book_append_sheet(wb, ws, 'Cashflow');
  }

  // ── Sheet 3: Inputs ───────────────────────────────────────────────────────
  {
    const aoa = [];
    aoa.push([cellText('Model Inputs', S.title), null, null]);
    aoa.push([]);
    aoa.push([
      cellText('Variable', S.colHdrLeft),
      cellText('Value',    S.colHdr),
      cellText('Unit',     S.colHdrLeft),
    ]);

    function section(title) {
      aoa.push([
        cellText(title.toUpperCase(), S.sectionHdr),
        cellText('', S.sectionHdr),
        cellText('', S.sectionHdr),
      ]);
    }
    function rowD(label, val, fmt, unit) {
      aoa.push([
        cellText(label, S.rowLabel),
        cellNum(val, fmt || FMT_DOLLAR, S.data),
        cellText(unit || '', S.dataMuted),
      ]);
    }

    section('Acquisition & Loan');
    rowD('Acquisition Price',       d.acquisitionPrice, FMT_DOLLAR, '$');
    rowD('LVR',                     d.lvr,              FMT_PCT2,   '%');
    rowD('Interest Rate',           d.interestRate,     FMT_PCT2,   '% p.a.');
    rowD('Deposit %',               d.depositPct,       FMT_PCT2,   '%');
    rowD('Sales Commission %',      d.salesCommissionPct, FMT_PCT2, '%');

    section('Growth & Time');
    rowD('Rental Growth',           d.rentalGrowth,     FMT_PCT2,   '% p.a.');
    rowD('Capital Growth',          d.capitalGrowth,    FMT_PCT2,   '% p.a.');
    rowD('Cost of Capital',         d.costOfCapital,    FMT_PCT2,   '% p.a.');
    rowD('Term of Ownership',       d.termOfOwnership,  FMT_INT,    'yrs');
    rowD('Hold to Revaluation',     d.holdDurationPreReval, FMT_INT,'yrs');
    rowD('Settlement Lag',          d.settlementLag,    FMT_NUM3,   'yrs');
    rowD('Project Duration',        d.projectDuration,  FMT_INT,    'yrs');
    rowD('% Profit → Debt Reduction', d.profitUsedForDebt, FMT_PCT2,'%');
    rowD('Retained Earnings %',     d.retainedEarningsPct, FMT_PCT2,'%');

    section('Purchase Costs');
    rowD('Stamp Duty',              d.stampDuty,        FMT_DOLLAR, '$');
    rowD('Valuation',               d.valuationCost,    FMT_DOLLAR, '$');
    rowD('Solicitor',               d.solicitorCost,    FMT_DOLLAR, '$');
    rowD('Inspections',             d.inspections,      FMT_DOLLAR, '$');

    section('Operating Expenses (annual)');
    rowD('Council',                 d.council,          FMT_DOLLAR, '$');
    rowD('Water',                   d.water,            FMT_DOLLAR, '$');
    rowD('Cleaning',                d.cleaning,         FMT_DOLLAR, '$');
    rowD('Insurance',               d.insurance,        FMT_DOLLAR, '$');
    rowD('Land Tax',                d.landTax,          FMT_DOLLAR, '$');
    rowD('Common Power',            d.commonPower,      FMT_DOLLAR, '$');
    rowD('Fire Services',           d.fireServices,     FMT_DOLLAR, '$');
    rowD('Maintenance',             d.maintenance,      FMT_DOLLAR, '$');
    rowD('Other',                   d.other,            FMT_DOLLAR, '$');
    rowD('Management Fee %',        d.managementFeePct, FMT_PCT2,   '%');
    rowD('Sinking Fund %',          d.sinkingFundPct,   FMT_PCT2,   '%');

    section('Revenue (annual)');
    rowD('Gross Rent',              d.weeklyRent,       FMT_DOLLAR, '$');
    rowD('Other Revenue',           d.revenueOther,     FMT_DOLLAR, '$');

    section('Comparable Inputs');
    rowD('NDA (Acres)',                 d.netDevelopableAreaAcres, FMT_NUM3, 'acres');
    rowD('Comparable Value ($/NDA)',    d.comparableValuePerNDA,   FMT_DOLLAR, '$');
    rowD('Residual Land Val',           d.residualLandVal,         FMT_DOLLAR, '$');
    rowD('Lots',                        d.lots,                    FMT_INT, '');
    rowD('Av Lot Size',                 d.avLotSizeSqm,            FMT_INT, 'sqm');
    rowD('Rate per sqm',                d.ratePerSqm,              FMT_DOLLAR, '$');
    rowD('Profit Margin %',             d.profitMarginPct,         FMT_PCT2, '%');
    rowD('TDC per Lot',                 d.tdcPerLot,               FMT_DOLLAR, '$');
    rowD('Target Yield %',              d.targetYieldPct,          FMT_PCT2, '% p.a.');

    const ws = aoaToSheet(aoa);
    ws['!cols']   = [{ wch: 32 }, { wch: 18 }, { wch: 10 }];
    ws['!merges'] = [{ s: { r: 0, c: 0 }, e: { r: 0, c: 2 } }]; // title across 3 cols
    // Also merge each section header across all 3 cols — find them by content
    aoa.forEach((row, i) => {
      if (row && row[0] && row[0].s === S.sectionHdr) {
        ws['!merges'].push({ s: { r: i, c: 0 }, e: { r: i, c: 2 } });
      }
    });
    ws['!rows'] = [{ hpt: 26 }];
    XLSX.utils.book_append_sheet(wb, ws, 'Inputs');
  }

  // ── Sheet 4: Comparables ──────────────────────────────────────────────────
  {
    const aoa = [];
    aoa.push([cellText('Comparable Value Analysis', S.title), null, null, null]);
    aoa.push([]);
    aoa.push([
      cellText('Method',   S.colHdrLeft),
      cellText('Detail',   S.colHdrLeft),
      cellText('Value',    S.colHdr),
      cellText('Included', S.colHdrLeft),
    ]);

    const methods = [
      ['Method 1: Gross Area',
       `${(d.netDevelopableAreaAcres||0).toFixed(3)} NDA acres × $${(d.comparableValuePerNDA||0).toLocaleString()}/NDA + residual`,
       r.m1, d.includeM1 !== false],
      ['Method 2: 30% of GRV',
       `GRV ${fmtDollar(r.grv)} ÷ 3 · NSA ${(r.nsa||0).toLocaleString()} sqm`,
       r.m2, d.includeM2 !== false],
      ['Method 3: Development Estimate (TDC $/lot)',
       'GRV − TDC − holding cost − interest − profit margin',
       r.m3, d.includeM3 !== false],
      ['Method 5: Derived from Yield',
       `Net Income ${fmtDollar(r.netIncomeYr1)} ÷ ${fmtPct(d.targetYieldPct)} target yield`,
       r.m5, d.includeM5 !== false],
    ];
    methods.forEach(([label, detail, val, included]) => {
      const incStyle = included
        ? S.data
        : styleColor(S.data, X_MUTED);
      aoa.push([
        cellText(label,  S.rowLabel),
        cellText(detail, S.dataMuted),
        cellSignedNum(val, FMT_DOLLAR, S.data),
        cellText(included ? 'Yes' : 'No', incStyle),
      ]);
    });

    aoa.push([]);
    const cmpMean = comparableMean(d, r);
    aoa.push([
      cellText('Mean (included methods only)', styleColor(S.rowLabel, X_ACCENT)),
      cellText('', S.data),
      cellNum(cmpMean, FMT_DOLLAR, Object.assign({}, S.kpiValue, {
        font: { name: 'Calibri', sz: 12, bold: true, color: { rgb: X_ACCENT } },
      })),
      cellText('', S.data),
    ]);
    aoa.push([]);

    aoa.push([cellText('REFERENCE', S.sectionHdr),
              cellText('', S.sectionHdr),
              cellText('', S.sectionHdr),
              cellText('', S.sectionHdr)]);
    aoa.push([cellText('GRV (ex GST)',      S.rowLabel), cellText('', S.data), cellNum(r.grv, FMT_DOLLAR), cellText('', S.data)]);
    aoa.push([cellText('Net Sellable Area', S.rowLabel), cellText('', S.data), cellNum(r.nsa, FMT_INT),    cellText('', S.data)]);
    aoa.push([cellText('Acquisition Price', S.rowLabel), cellText('', S.data), cellNum(d.acquisitionPrice, FMT_DOLLAR), cellText('', S.data)]);

    const ws = aoaToSheet(aoa);
    ws['!cols']   = [{ wch: 42 }, { wch: 56 }, { wch: 18 }, { wch: 10 }];
    ws['!merges'] = [{ s: { r: 0, c: 0 }, e: { r: 0, c: 3 } }];
    // Merge any section header rows across all 4 cols
    aoa.forEach((row, i) => {
      if (row && row[0] && row[0].s === S.sectionHdr && i !== 0) {
        ws['!merges'].push({ s: { r: i, c: 0 }, e: { r: i, c: 3 } });
      }
    });
    ws['!rows'] = [{ hpt: 26 }];
    XLSX.utils.book_append_sheet(wb, ws, 'Comparables');
  }

  // Write file — filename includes property address (sanitised)
  const safeAddr = (propAddr || 'Property').replace(/[\\/:*?"<>|]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 80);
  const filename = `Financial Model - ${safeAddr}.xlsx`;
  XLSX.writeFile(wb, filename, { compression: true, bookType: 'xlsx' });
}

// Convert an aoa where each cell is either null (skip) or a cell-descriptor
// object ({v, t, z, s, ...}) into a SheetJS worksheet, preserving styles.
function aoaToSheet(aoa) {
  const ws = {};
  let maxR = 0, maxC = 0;
  aoa.forEach((row, R) => {
    if (!row || !row.length) return;
    row.forEach((cell, C) => {
      if (cell == null) return;
      const addr = XLSX.utils.encode_cell({ r: R, c: C });
      if (typeof cell === 'object' && 't' in cell) {
        ws[addr] = cell;
      } else {
        ws[addr] = { v: cell, t: typeof cell === 'number' ? 'n' : 's' };
      }
      if (R > maxR) maxR = R;
      if (C > maxC) maxC = C;
    });
  });
  ws['!ref'] = XLSX.utils.encode_range({ s: { r: 0, c: 0 }, e: { r: maxR, c: maxC } });
  return ws;
}

function setExportBtnVisible(visible) {
  const btn = document.getElementById('financeExportBtn');
  if (btn) btn.style.display = visible ? '' : 'none';
}

// ─── Input binding ────────────────────────────────────────────────────────────

function autoSave() {
  if (!_current) return;
  clearTimeout(_saveTimer);
  const statusEl = document.getElementById('finSaveStatus');
  if (statusEl) statusEl.textContent = 'Saving…';
  _saveTimer = setTimeout(async () => {
    await finDbSave(_current.pipelineId, _current.data);
    _allModels[_current.pipelineId] = _current.data;
    const el = document.getElementById('finSaveStatus');
    if (el) {
      el.textContent = 'Saved';
      setTimeout(() => { if (el) el.textContent = ''; }, 2000);
    }
  }, 1500);
}

function bindInputs(r) {
  const container = document.getElementById('financeContent');
  if (!container || !_current) return;

  // Only .fin-editable cells are inputs — .fin-calc-val are display-only
  container.querySelectorAll('.fin-editable').forEach(el => {
    el.addEventListener('click', function () {
      if (this.querySelector('input')) return;
      const key  = this.dataset.key;
      if (!key) return;
      const type = this.closest('.fin-field')?.dataset.type || 'dollar';
      const raw  = _current.data[key];
      const input = document.createElement('input');
      input.className = 'fin-inline-input';
      input.type = 'text';
      if (type === 'pct')      input.value = raw != null ? (raw * 100).toFixed(2) : '';
      else if (type === 'int') input.value = raw != null ? String(raw) : '';
      else if (type === 'num') input.value = raw != null ? String(raw) : '';
      else                     input.value = raw != null ? Math.round(raw) : '';
      this.textContent = '';
      this.appendChild(input);
      input.focus();
      input.select();
      // Tooltip + live formula-mode visual cue (V81.3)
      input.title = 'Tip: start with = for a formula (e.g. =2*400, =(600+800)*2, =120/6)';
      const updateFormulaCue = () => {
        input.classList.toggle('fin-input-formula', input.value.trim().startsWith('='));
      };
      input.addEventListener('input', updateFormulaCue);
      updateFormulaCue();
      const commit = () => {
        const annualFields = ['council','water','cleaning','insurance','landTax',
          'commonPower','fireServices','maintenance','other','weeklyRent','revenueOther'];
        const rawInput = input.value.trim();
        const isFormula = rawInput.startsWith('=');
        let val;
        if (isFormula) {
          // Formula mode — evaluate as a plain number (no /w /m /y interpretation).
          // For pct fields the result is the displayed percent (divided by 100 below).
          val = evalFormula(rawInput);
          if (!isFinite(val)) val = _current.data[key] || 0;
        } else if (annualFields.includes(key)) {
          val = parseAnnual(input.value);
        } else {
          val = parseFloat(input.value.replace(/[^0-9.-]/g, ''));
          if (isNaN(val)) val = _current.data[key] || 0;
        }
        if (type === 'pct') val = val / 100;
        _current.data[key] = val;
        if (key === 'acquisitionPrice') _current.data._state = detectState(_current.address, _current.suburb); // refresh state only
        _current.data.updatedAt = Date.now();
        _allModels[_current.pipelineId] = _current.data;
        renderFinanceView();
        autoSave();
      };
      input.addEventListener('blur', commit);
      input.addEventListener('keydown', e => {
        if (e.key === 'Enter')  input.blur();
        if (e.key === 'Escape') renderFinanceView();
      });
    });
  });

  // Comparable section collapse — state tracked in _comparableOpen, applied after each render
  const compToggle = document.getElementById('finComparableToggle');
  const compBody   = document.getElementById('finComparableBody');
  const compChev   = document.getElementById('finCompChevron');
  if (compToggle && compBody && compChev) {
    // Apply current state
    compBody.style.display = _comparableOpen ? '' : 'none';
    compChev.textContent   = _comparableOpen ? '▼' : '▶';
    // Single listener — safe because bindInputs only runs after a full re-render
    // which rebuilds the DOM, so the element is always fresh (no duplicate listeners)
    compToggle.addEventListener('click', () => {
      _comparableOpen = !_comparableOpen;
      compBody.style.display = _comparableOpen ? '' : 'none';
      compChev.textContent   = _comparableOpen ? '▼' : '▶';
    });
  }

  // Funds to Complete — checkbox toggles inclusion in cashflow
  document.getElementById('finCostsInCashflow')?.addEventListener('change', e => {
    _costsInCashflow = e.target.checked;
    renderFinanceView();
  });

  // Stamp Duty — recalculate from current acquisition price + state
  document.getElementById('finStampRefresh')?.addEventListener('click', e => {
    e.stopPropagation(); // don't trigger the .fin-editable click that opens the input
    if (!_current) return;
    const d = _current.data;
    const recalc = calcStampDuty(d.acquisitionPrice || 0, d._state || 'NSW');
    d.stampDuty = recalc;
    d.updatedAt = Date.now();
    _allModels[_current.pipelineId] = d;
    renderFinanceView();
    autoSave();
  });

  // Funds to Complete — chevron toggles row visibility (don't fire when clicking checkbox)
  document.getElementById('finFundsToggle')?.addEventListener('click', e => {
    e.stopPropagation();
    _sectionCollapsed['fin-funds-complete'] = !_sectionCollapsed['fin-funds-complete'];
    renderFinanceView();
  });

  // Returns legend — collapsible footer
  const legToggle = document.getElementById('finFooterLegendToggle');
  const legBody   = document.getElementById('finFooterLegendBody');
  const legChev   = document.getElementById('finFooterLegendChevron');
  if (legToggle && legBody && legChev) {
    legToggle.addEventListener('click', () => {
      _footerLegendOpen = !_footerLegendOpen;
      legBody.style.display = _footerLegendOpen ? '' : 'none';
      legChev.textContent   = _footerLegendOpen ? '▼' : '▶';
    });
  }

  // Comparable Value — per-method include checkboxes
  document.querySelectorAll('.fin-comp-include-checkbox').forEach(cb => {
    cb.addEventListener('change', () => {
      const key = cb.dataset.includeKey;
      if (!key) return;
      _current.data[key] = cb.checked;
      _current.data.updatedAt = Date.now();
      _allModels[_current.pipelineId] = _current.data;
      renderFinanceView();
      autoSave();
    });
  });

  // Collapsible sidebar sections
  document.querySelectorAll('.fin-section-toggle').forEach(toggle => {
    toggle.addEventListener('click', () => {
      const id = toggle.dataset.section;
      _sectionCollapsed[id] = !_sectionCollapsed[id];
      const body = document.querySelector(`.fin-section-body[data-section="${id}"]`);
      const chev = toggle.querySelector('.fin-section-chevron');
      if (body) body.style.display = _sectionCollapsed[id] ? 'none' : '';
      if (chev) chev.textContent   = _sectionCollapsed[id] ? '▶' : '▼';
    });
  });

  document.getElementById('finChangeProperty')?.addEventListener('click', () => {
    _current = null;
    renderFinanceView();
  });

  // Property address / pipeline ID — click to open kanban modal for this property
  function openInPipeline(e) {
    e.preventDefault();
    if (!_current?.pipelineId) return;
    const id = _current.pipelineId;
    // Hide finance view directly without triggering toggleKanban(false)
    _financeVisible = false;
    document.getElementById('financeView')?.classList.remove('visible');
    document.getElementById('financeNavBtn')?.classList.remove('active');
    // Open pipeline board then card modal
    const alreadyOpen = window.kanbanVisible;
    if (typeof toggleKanban === 'function' && !alreadyOpen) toggleKanban(true);
    setTimeout(() => {
      if (typeof openCardModal === 'function') openCardModal(id);
    }, alreadyOpen ? 0 : 300);
  }
  document.getElementById('finOpenKanban')?.addEventListener('click', openInPipeline);

  // Auto-save — triggered after every input commit with a 1.5s debounce
  // Called from the commit() closure inside the editable input handler above
}

// ─── Init ─────────────────────────────────────────────────────────────────────

async function initFinance() {
  // Guard — only wire DOM listeners once, even if called multiple times
  if (!_financeInitDone) {
    _financeInitDone = true;

    document.getElementById('financeNavBtn')?.addEventListener('click', () => {
      if (_financeVisible) {
        // Nav button is a module toggle — close the whole module, not in-module back
        closeFinanceModule();
      } else {
        // Always open to the property-selector list, not the last viewed deal (V81.3)
        _current = null;
        renderFinanceView();
        toggleFinance(true);
      }
    });

    document.getElementById('financeClose')?.addEventListener('click', () => handleFinanceClose());

    document.getElementById('financeExportBtn')?.addEventListener('click', () => {
      try { exportToExcel(); }
      catch (err) { console.error('[finance export]', err); alert('Excel export failed: ' + (err.message || err)); }
    });
  }

  // Always (re)load saved models — safe to call multiple times
  _allModels = await finDbLoadAll();
}

window.FinanceModule = {
  open:   openFinanceForProperty,
  toggle: toggleFinance,
  init:   initFinance,
  export: exportToExcel,
};

initFinance();
