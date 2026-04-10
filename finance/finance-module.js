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

const FIN_API = '/api/finance-api';

let _current           = null;
let _financeVisible    = false;
let _allModels         = {};
let _comparableOpen    = false;  // persists collapse state across re-renders
let _financeInitDone   = false;  // guard against duplicate initFinance() calls
let _saveTimer         = null;   // debounce timer for auto-save
let _costsInCashflow   = true;   // whether Funds to Complete costs are included in cashflow

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

  // Cash Required (Upfront) = all FTC items EXCEPT commission and equity contribution
  const upfront = purchaseCosts - commission - bankDepositRequired;

  // Cash Required (Settlement) = commission + equity contribution
  const cashAtSettlement = commission + bankDepositRequired;

  // Total Purchase Costs = all FTC items (deposits + purchase costs)
  const purchaseCosts = Object.values(_ftcByYear).reduce((s, v) => s + v, 0);

  // Legacy upfrontCosts / settlementCosts for compatibility
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
    const cashflow      = rent - interest - principalPaid;           // B23 = B17-B21-B20
    // _costsAdjustment applied below after years array is built
    const assetValue    = yr === 0 ? price : price * Math.pow(1 + cg, yr); // B25, then *(1+B6)

    years.push({
      yr, rent, grossRentYr1: settled ? grossRentYr1 * Math.pow(1 + rg, yr) : 0,
      principalStart, interest, principalPaid, principalEnd,
      cashflow, assetValue,
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
  const preCashflowSum = years
    .filter(y => y.yr < hold)
    .reduce((s, y) => s + y.cashflow, 0);
  const totalCashReqd = upfront + cashAtSettlement - preCashflowSum;

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
      data.stampDuty = calcStampDuty(offeredPrice, _state);
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
    return;
  }
  const d = _current.data;
  const r = runModel(d);
  container.innerHTML = `<div class="fin-layout">${renderSidebar(d, r)}${renderMain(d, r)}</div>`;
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
function ff(key, label, display, type, hint, calc) {
  return `<div class="fin-field${calc ? ' fin-field-calc' : ''}" data-key="${key}" data-type="${type}">
    <span class="fin-field-label">${label}${hint ? `<span class="fin-field-hint">${hint}</span>` : ''}</span>
    <span class="${calc ? 'fin-calc-val' : 'fin-editable'}" data-key="${key}">${display}</span>
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
        ${ff('stampDuty',        'Stamp Duty',          fmtDollar(d.stampDuty),          'dollar', (d._state||'NSW') + ' transfer duty')}
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
      label: 'ROE',
      rows: years.map(y => `<td class="fin-pct-cell ${y.roe < 0 ? 'fin-neg' : 'fin-pos'}">${fmtPct(y.roe)}</td>`),
      avg: fmtPct(avg(holdYrs.map(y => y.roe))),
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
      <div class="fin-kpi fin-kpi-mean"><div class="fin-kpi-label">Comparable Value</div><div class="fin-kpi-val" id="finKpiMeanVal">${(() => { const vals=[r.m1,r.m2,r.m3,r.m5].filter(v=>v!=null&&isFinite(v)&&v!==0); return vals.length ? fmtDollarK(vals.reduce((a,b)=>a+b,0)/vals.length) : '—'; })()}</div></div>
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

    <div class="fin-footer">
      <span>Principal Paid = (Rent − Interest) × ${fmtPct(d.profitUsedForDebt)} profit to debt · ROE on Total Cash Required · Cost of Funds = Total Cash × CoC × (1+rg)^(yr−lag)</span>
      <span>Transfer duty auto-calculated (${d._state||'NSW'} rates, 1 July 2025). All figures indicative only.</span>
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
      const commit = () => {
        const annualFields = ['council','water','cleaning','insurance','landTax',
          'commonPower','fireServices','maintenance','other','weeklyRent','revenueOther'];
        let val;
        if (annualFields.includes(key)) {
          val = parseAnnual(input.value);
        } else {
          val = parseFloat(input.value.replace(/[^0-9.-]/g, ''));
          if (isNaN(val)) val = _current.data[key] || 0;
        }
        if (type === 'pct') val = val / 100;
        _current.data[key] = val;
        if (key === 'acquisitionPrice') _current.data.stampDuty = calcStampDuty(val, _current.data._state || 'NSW');
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

  // Funds to Complete — chevron toggles row visibility (don't fire when clicking checkbox)
  document.getElementById('finFundsToggle')?.addEventListener('click', e => {
    e.stopPropagation();
    _sectionCollapsed['fin-funds-complete'] = !_sectionCollapsed['fin-funds-complete'];
    renderFinanceView();
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
