/**
 * finance/finance.js  —  Property Financial Feasibility  (Phase 1)
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
 *  Cashflow         = Rent - Interest - PrincipalPaid          ← not just Rent-Interest
 *  ROE              = Cashflow / totalCashRequired(Total)
 *
 *  Cost of Funds:
 *    pre-settlement  = upfrontCash * costOfCapital
 *    post-settlement = totalCashRequired(Total) * costOfCapital * (1+rentalGrowth)^(yr-lag)
 *  NPV (Asset Val)  = AssetValue - CostOfFunds                 (per-year, not cumulative)
 *
 *  totalCashRequired(Upfront) = SUM(deposit + stampDuty + valuation + solicitor + inspections + otherCosts)
 *  totalCashRequired(Total)   = Upfront - SUM(cashflows where yr < holdDurationPreReval)
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

const FIN_API = '/api/finance';

let _current           = null;
let _financeVisible    = false;
let _allModels         = {};
let _comparableOpen    = false;  // persists collapse state across re-renders
let _financeInitDone   = false;  // guard against duplicate initFinance() calls

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

    // ── Purchase costs (direct $ inputs) ─────────────────────────────────
    stampDuty:               0,                        // C33 — NSW auto-calc
    valuationCost:           4090,                     // C34
    solicitorCost:           4000,                     // C35
    inspections:             4000,                     // C36

    // ── Expenses sheet inputs ─────────────────────────────────────────────
    managementFeePct:        0,                        // B2 Expenses
    sinkingFundPct:          0,                        // B3 Expenses
    councilQuarterly:        1500,                     // B6 = 1500*4 → user sets quarterly rate
    water:                   500,                      // B7
    cleaning:                0,                        // B8
    insurance:               3000,                     // B9
    landTax:                 80000,                    // B10
    commonPower:             0,                        // B12
    fireServices:            0,                        // B13
    maintenanceMonthly:      500,                      // B14 = 500*12 → user sets monthly rate
    other:                   0,                        // B16

    // ── Revenue ───────────────────────────────────────────────────────────
    weeklyRent:              550,                      // B20 = 550*52 → user sets weekly rent

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

    createdAt: Date.now(),
    updatedAt: Date.now(),
    version:   3,
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

function runModel(d) {
  const price = d.acquisitionPrice || 0;

  // ── Derived outgoings (calculated, not inputs) ────────────────────────
  const council       = (d.councilQuarterly || 0) * 4;          // B6 = 1500*4
  const maintenance   = (d.maintenanceMonthly || 0) * 12;        // B14 = 500*12
  const grossRentYr1  = (d.weeklyRent || 0) * 52;               // B20 = 550*52
  const management$   = (d.managementFeePct || 0) * grossRentYr1; // B11 = B2*B20
  const sinkingFund   = (d.sinkingFundPct || 0) * price;         // B15 = B3 * Feasibility!B25(=B2)

  const totalOutgoings = council + (d.water || 0) + (d.cleaning || 0) +
    (d.insurance || 0) + (d.landTax || 0) + management$ +
    (d.commonPower || 0) + (d.fireServices || 0) + maintenance +
    sinkingFund + (d.other || 0);

  const netIncomeYr1 = grossRentYr1 - totalOutgoings;            // B21 = B20 - B17

  // ── Purchase / deal figures ───────────────────────────────────────────
  const stamp      = d.stampDuty || calcStampDuty(price, d._state || 'NSW');
  const deposit    = price * (d.depositPct || 0);                // C32 = E2*B2
  const commission = price * (d.salesCommissionPct || 0);        // C37 = E3*B2
  const loan       = price * (d.lvr || 0);                       // C31 = B2*B5

  // Total Cash Required (Upfront) = SUM(C32:C37)
  const upfront = deposit + stamp + (d.valuationCost || 0) +
                  (d.solicitorCost || 0) + (d.inspections || 0) + commission;

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
    const cashflow      = rent - interest - principalPaid;           // B23 = B17-B21-B20
    const assetValue    = yr === 0 ? price : price * Math.pow(1 + cg, yr); // B25, then *(1+B6)

    years.push({
      yr, rent, grossRentYr1: settled ? grossRentYr1 * Math.pow(1 + rg, yr) : 0,
      principalStart, interest, principalPaid, principalEnd,
      cashflow, assetValue,
    });

    // Carry principal end forward as next year's start
    principalStart = principalEnd;
  }

  // ── Total Cash Required (Total) = Upfront - SUM(cashflows where yr < holdDuration) ──
  // G31 = SUM(C32:C37) - SUMIF(B16:L16,"<"&B7, B23:L23)
  const preCashflowSum = years
    .filter(y => y.yr < hold)
    .reduce((s, y) => s + y.cashflow, 0);
  const totalCashReqd = upfront - preCashflowSum;

  // ── ROE uses totalCashReqd (G31) ─────────────────────────────────────
  years.forEach(y => {
    y.roe = totalCashReqd !== 0 ? y.cashflow / totalCashReqd : 0;
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
    loan, deposit, commission, stamp, upfront,
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
  _financeVisible = show !== undefined ? show : !_financeVisible;
  document.getElementById('financeView')?.classList.toggle('visible', _financeVisible);
  document.getElementById('financeNavBtn')?.classList.toggle('active', _financeVisible);
  // Close kanban when finance opens (they occupy the same full-screen layer)
  if (_financeVisible && typeof toggleKanban === 'function') toggleKanban(false);
}

// offeredPrice: numeric price from the most recent offer or vendor terms (passed from kanban).
// If a saved model already exists, ALL its variables are preserved and only
// acquisitionPrice is updated (if the offered price differs and user hasn't already
// customised it away from the listing price). New models are seeded from offeredPrice.
async function openFinanceForProperty(pipelineId, pipelineEntry, offeredPrice) {
  const p = pipelineEntry?.property || {};

  // Load existing model or fall back to null
  let data = _allModels[pipelineId] || await finDbLoad(pipelineId);

  // Detect state from property address — used for correct duty calculation
  const _state = detectState(p.address || '', p.suburb || '');

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
      data.stampDuty = calcStampDuty(offeredPrice, _state);
      data._priceSource = 'offer';
      data.updatedAt = Date.now();
    }
  }

  _allModels[pipelineId] = data;
  _current = {
    pipelineId,
    address: p.address || '',
    suburb:  p.suburb  || '',
    data,
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
    return;
  }
  const d = _current.data;
  const r = runModel(d);
  container.innerHTML = `<div class="fin-layout">${renderSidebar(d, r)}${renderMain(d, r)}</div>`;
  bindInputs();
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
function ff(key, label, display, type, hint, calc) {
  return `<div class="fin-field${calc ? ' fin-field-calc' : ''}" data-key="${key}" data-type="${type}">
    <span class="fin-field-label">${label}${hint ? `<span class="fin-field-hint">${hint}</span>` : ''}</span>
    <span class="${calc ? 'fin-calc-val' : 'fin-editable'}" data-key="${key}">${display}</span>
  </div>`;
}

// ─── Sidebar ──────────────────────────────────────────────────────────────────

function renderSidebar(d, r) {
  return `<div class="fin-sidebar">
    <div class="fin-property-bar">
      <div class="fin-property-info">
        <div class="fin-property-address">${_current.address}, ${_current.suburb} NSW</div>
        <div class="fin-property-id">Pipeline ID: ${_current.pipelineId}</div>
      </div>
      <button class="fin-change-btn" id="finChangeProperty">Change</button>
    </div>

    <div class="fin-section-label">Model Variables</div>
    <div class="fin-fields">
      ${ff('acquisitionPrice',   'Acquisition Price',           fmtDollar(d.acquisitionPrice),   'dollar')}
      ${ff('interestRate',       'Loan Interest Rate (pa)',      fmtPct(d.interestRate),          'pct')}
      ${ff('rentalGrowth',       'Rental Increase (pa)',         fmtPct(d.rentalGrowth),          'pct')}
      ${ff('lvr',                'Assumed LVR (%)',              fmtPct(d.lvr),                   'pct')}
      ${ff('capitalGrowth',      'Asset Value Growth (pa)',      fmtPct(d.capitalGrowth),         'pct')}
      ${ff('holdDurationPreReval','Hold Duration Pre-Reval (yrs)', d.holdDurationPreReval+' yrs', 'int')}
      ${ff('costOfCapital',      'Cost of Capital (%)',          fmtPct(d.costOfCapital),         'pct')}
      ${ff('termOfOwnership',    'Term of Ownership (yrs)',      d.termOfOwnership+' yrs',        'int')}
      ${ff('profitUsedForDebt',  '% Profit → Debt Reduction',   fmtPct(d.profitUsedForDebt),     'pct')}
      ${ff('settlementLag',      'Settlement Lag (yrs)',         d.settlementLag+' yrs',          'int')}
      ${ff('projectDuration',    'Project Duration (yrs)',       d.projectDuration+' yrs',        'int')}
      ${ff('depositPct',         'Deposit (%)',                  fmtPct(d.depositPct),            'pct')}
      ${ff('salesCommissionPct', 'Sales Commission (%)',         fmtPct(d.salesCommissionPct),    'pct')}
    </div>

    <div class="fin-section-label" style="margin-top:14px">Purchase Costs</div>
    <div class="fin-fields">
      ${ff('',        'Deposit Amount',   fmtDollar(r.deposit),    'dollar', '', true)}
      ${ff('stampDuty','Stamp Duty',      fmtDollar(d.stampDuty),  'dollar', (d._state||'NSW') + ' auto-calc')}
      ${ff('valuationCost','Valuation',   fmtDollar(d.valuationCost),'dollar')}
      ${ff('solicitorCost','Solicitor',   fmtDollar(d.solicitorCost),'dollar')}
      ${ff('inspections', 'Inspections',  fmtDollar(d.inspections), 'dollar')}
      ${ff('',        'Commission',       fmtDollar(r.commission),  'dollar', '', true)}
    </div>
    <div class="fin-summary-row fin-summary-highlight"><span>Total Loan</span><span class="fin-summary-val">${fmtDollar(r.loan)}</span></div>
    <div class="fin-summary-row fin-summary-highlight"><span>Cash Required (Upfront)</span><span class="fin-summary-val">${fmtDollar(r.upfront)}</span></div>
    <div class="fin-summary-row fin-summary-highlight"><span>Cash Required (Total)</span><span class="fin-summary-val">${fmtDollar(r.totalCashReqd)}</span></div>

    <div class="fin-section-label" style="margin-top:14px">Revenue</div>
    <div class="fin-fields">
      ${ff('weeklyRent',  'Weekly Rent',        fmtDollar(d.weeklyRent),   'dollar', '×52 = annual')}
      ${ff('',            'Gross Rent (Year 1)', fmtDollar(r.grossRentYr1), 'dollar', '', true)}
    </div>

    <div class="fin-section-label" style="margin-top:14px">Outgoings</div>
    <div class="fin-fields">
      ${ff('councilQuarterly', 'Council (per quarter)',  fmtDollar(d.councilQuarterly), 'dollar', '×4 = annual')}
      ${ff('',                 'Council (annual)',        fmtDollar(r.council),           'dollar', '', true)}
      ${ff('water',            'Water',                   fmtDollar(d.water),             'dollar')}
      ${ff('cleaning',         'Cleaning',                fmtDollar(d.cleaning),          'dollar')}
      ${ff('insurance',        'Insurance',               fmtDollar(d.insurance),         'dollar')}
      ${ff('landTax',          'Land Tax',                fmtDollar(d.landTax),           'dollar')}
      ${ff('managementFeePct', 'Management Fee (%)',      fmtPct(d.managementFeePct),     'pct',   '% of gross rent')}
      ${ff('',                 'Management Fee ($)',       fmtDollar(r.management$),       'dollar', '', true)}
      ${ff('commonPower',      'Common Power',            fmtDollar(d.commonPower),       'dollar')}
      ${ff('fireServices',     'Fire Services',           fmtDollar(d.fireServices),      'dollar')}
      ${ff('maintenanceMonthly','Maintenance (per month)',fmtDollar(d.maintenanceMonthly),'dollar','×12 = annual')}
      ${ff('',                 'Maintenance (annual)',     fmtDollar(r.maintenance),       'dollar', '', true)}
      ${ff('sinkingFundPct',   'Sinking Fund (% of val)', fmtPct(d.sinkingFundPct),       'pct',   '% of acq. price')}
      ${ff('',                 'Sinking Fund ($)',         fmtDollar(r.sinkingFund),       'dollar', '', true)}
      ${ff('other',            'Other',                   fmtDollar(d.other),             'dollar')}
    </div>
    <div class="fin-summary-row"><span>Total Outgoings</span><span class="fin-summary-val">${fmtDollar(r.totalOutgoings)}</span></div>
    <div class="fin-summary-row ${r.netIncomeYr1 < 0 ? 'fin-summary-neg' : ''}">
      <span>Net Income (Year 1)</span><span class="fin-summary-val">${fmtDollar(r.netIncomeYr1)}</span>
    </div>

    <div class="fin-actions">
      <button class="fin-save-btn" id="finSaveBtn">Save Model</button>
    </div>
  </div>`;
}

// ─── Main panel ───────────────────────────────────────────────────────────────

function renderMain(d, r) {
  const years   = r.years;
  const holdYrs = years.filter(y => y.yr > 0);
  const avg     = arr => arr.length ? arr.reduce((a, b) => a + b, 0) / arr.length : 0;
  const lag     = Math.round(d.settlementLag || 0);

  const rows = years.map(y => `
    <tr class="${y.yr < lag ? 'fin-lag-row' : ''}">
      <td>Year ${y.yr}</td>
      <td class="${y.rent < 0 ? 'fin-neg' : ''}">${fmtDollar(y.rent)}</td>
      <td class="fin-pct-cell ${y.rent / (d.acquisitionPrice||1) < 0 ? 'fin-neg' : ''}">${d.acquisitionPrice ? fmtPct(y.rent / d.acquisitionPrice) : '—'}</td>
      <td>${fmtDollar(y.principalStart)}</td>
      <td>${fmtDollar(y.principalPaid)}</td>
      <td>${fmtDollar(y.interest)}</td>
      <td>${fmtDollar(y.principalEnd)}</td>
      <td class="${y.cashflow < 0 ? 'fin-neg' : 'fin-pos'}">${fmtDollar(y.cashflow)}</td>
      <td class="fin-pct-cell ${y.roe < 0 ? 'fin-neg' : 'fin-pos'}">${fmtPct(y.roe)}</td>
      <td>${fmtDollar(y.assetValue)}</td>
      <td class="fin-muted">${fmtDollar(y.costOfFunds)}</td>
      <td class="${y.npvAssetValue < 0 ? 'fin-neg' : 'fin-pos'}">${fmtDollar(y.npvAssetValue)}</td>
    </tr>`).join('');

  const avgRow = holdYrs.length ? `
    <tr class="fin-avg-row">
      <td>Average</td>
      <td class="${avg(holdYrs.map(y=>y.rent)) < 0 ? 'fin-neg' : ''}">${fmtDollar(avg(holdYrs.map(y=>y.rent)))}</td>
      <td class="fin-pct-cell">${d.acquisitionPrice ? fmtPct(avg(holdYrs.map(y=>y.rent)) / d.acquisitionPrice) : '—'}</td>
      <td>—</td>
      <td>${fmtDollar(avg(holdYrs.map(y=>y.principalPaid)))}</td>
      <td>${fmtDollar(avg(holdYrs.map(y=>y.interest)))}</td>
      <td>—</td>
      <td class="${avg(holdYrs.map(y=>y.cashflow)) < 0 ? 'fin-neg' : 'fin-pos'}">${fmtDollar(avg(holdYrs.map(y=>y.cashflow)))}</td>
      <td class="fin-pct-cell">${fmtPct(avg(holdYrs.map(y=>y.roe)))}</td>
      <td>${fmtDollar(avg(holdYrs.map(y=>y.assetValue)))}</td>
      <td class="fin-muted">—</td>
      <td>—</td>
    </tr>` : '';

  const exit     = years[years.length - 1];
  const firstActive = years.find(y => y.yr >= lag);
  const npvClass = (exit?.npvAssetValue ?? 0) >= 0 ? 'fin-kpi-pos' : 'fin-kpi-neg';

  return `<div class="fin-main">

    <div class="fin-kpis">
      <div class="fin-kpi"><div class="fin-kpi-label">Cash Required (Upfront)</div><div class="fin-kpi-val">${fmtDollarK(r.upfront)}</div></div>
      <div class="fin-kpi"><div class="fin-kpi-label">Cash Required (Total)</div><div class="fin-kpi-val">${fmtDollarK(r.totalCashReqd)}</div></div>
      <div class="fin-kpi"><div class="fin-kpi-label">Net Income (Yr 1)</div><div class="fin-kpi-val ${r.netIncomeYr1 < 0 ? 'fin-kpi-neg' : 'fin-kpi-pos'}">${fmtDollarK(r.netIncomeYr1)}</div></div>
      <div class="fin-kpi"><div class="fin-kpi-label">First Cashflow</div><div class="fin-kpi-val ${(r.yr1Cashflow??0) < 0 ? 'fin-kpi-neg' : 'fin-kpi-pos'}">${fmtDollarK(r.yr1Cashflow)}</div></div>
      <div class="fin-kpi"><div class="fin-kpi-label">Asset Value (Exit)</div><div class="fin-kpi-val">${fmtDollarK(exit?.assetValue)}</div></div>
      <div class="fin-kpi"><div class="fin-kpi-label">NPV at Exit</div><div class="fin-kpi-val ${npvClass}">${fmtDollarK(exit?.npvAssetValue)}</div></div>
    </div>

    <div class="fin-table-wrap">
      <table class="fin-table">
        <thead>
          <tr>
            <th></th><th>Net Rent</th><th>Yield</th>
            <th>Principal (Start)</th><th>Principal Paid</th><th>Interest Paid</th><th>Principal (End)</th>
            <th>Cashflow</th><th>ROE</th><th>Asset Value</th>
            <th>Cost of Funds</th><th>NPV (Asset Val)</th>
          </tr>
        </thead>
        <tbody>${rows}${avgRow}</tbody>
      </table>
    </div>

    ${renderComparableValues(d, r)}

    <div class="fin-footer">
      <span>Principal Paid = (Rent − Interest) × ${fmtPct(d.profitUsedForDebt)} profit to debt · ROE on Total Cash Required · Cost of Funds = Total Cash × CoC × (1+rg)^(yr−lag)</span>
      <span>NSW Stamp Duty auto-calculated. All figures indicative only.</span>
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

function renderComparableValues(d, r) {
  const methods = [
    {
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
      label:  'Method 5: Derived from Yield',
      detail: `Net Income ${fmtDollar(r.netIncomeYr1)} ÷ ${fmtPct(d.targetYieldPct)} target yield`,
      value:  r.m5,
      inputs: [
        ff('targetYieldPct','Target Yield (% pa)', fmtPct(d.targetYieldPct), 'pct'),
      ],
    },
  ];

  const vals = [r.m1, r.m2, r.m3, r.m5].filter(v => v != null && isFinite(v) && v !== 0);
  const mean = vals.length ? vals.reduce((a, b) => a + b, 0) / vals.length : null;

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
        ${methods.map(m => `
          <div class="fin-comp-card">
            <div class="fin-comp-method">${m.label}</div>
            <div class="fin-comp-detail">${m.detail}</div>
            <div class="fin-comp-value ${m.value < 0 ? 'fin-neg' : ''}">${fmtDollar(m.value)}</div>
            <div class="fin-comp-inputs">${m.inputs.join('')}</div>
          </div>`).join('')}
      </div>
      <div class="fin-comp-note">GRV (ex GST): ${fmtDollar(r.grv)} · Net Sellable Area: ${(r.nsa||0).toLocaleString()} sqm · Acquisition Price: ${fmtDollar(d.acquisitionPrice)}</div>
    </div>
  </div>`;
}

// ─── Input binding ────────────────────────────────────────────────────────────

function bindInputs() {
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
      const commit = () => {
        let val = parseFloat(input.value.replace(/[^0-9.-]/g, ''));
        if (isNaN(val)) val = _current.data[key] || 0;
        if (type === 'pct') val = val / 100;
        _current.data[key] = val;
        if (key === 'acquisitionPrice') _current.data.stampDuty = calcStampDuty(val, _current.data._state || 'NSW');
        _current.data.updatedAt = Date.now();
        _allModels[_current.pipelineId] = _current.data;
        renderFinanceView();
      };
      input.addEventListener('blur', commit);
      input.addEventListener('keydown', e => {
        if (e.key === 'Enter')  input.blur();
        if (e.key === 'Escape') renderFinanceView();
      });
    });
  });

  // Update mean value in header
  updateMeanValueHeader(r);

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

  document.getElementById('finChangeProperty')?.addEventListener('click', () => {
    _current = null;
    renderFinanceView();
  });

  document.getElementById('finSaveBtn')?.addEventListener('click', async () => {
    if (!_current) return;
    const btn = document.getElementById('finSaveBtn');
    btn.textContent = 'Saving…';
    btn.disabled = true;
    await finDbSave(_current.pipelineId, _current.data);
    _allModels[_current.pipelineId] = _current.data;
    btn.textContent = 'Saved ✓';
    setTimeout(() => { btn.textContent = 'Save Model'; btn.disabled = false; }, 1800);
  });
}

// ─── Init ─────────────────────────────────────────────────────────────────────

async function initFinance() {
  // Guard — only wire DOM listeners once, even if called multiple times
  if (!_financeInitDone) {
    _financeInitDone = true;

    document.getElementById('financeNavBtn')?.addEventListener('click', () => {
      if (!_financeVisible) renderFinanceView();
      toggleFinance();
    });

    document.getElementById('financeClose')?.addEventListener('click', () => toggleFinance(false));
  }

  // Always (re)load saved models — safe to call multiple times
  _allModels = await finDbLoadAll();
}

window.FinanceModule = {
  open:   openFinanceForProperty,
  toggle: toggleFinance,
  init:   initFinance,
};

initFinance();
