# MASAFIOS reference data assessment for ZONAR

## Purpose and separation

This document records a structural assessment of two supplied workbooks and the separate MASAFIOS dashboard repository. It is an internal engineering mapping, not a client case study and not a data import. ZONAR remains a reusable, tenant-isolated product. Do not copy client-identifying content, raw records, employee information, customer/site names, credentials, or the MASAFIOS dashboard into public ZONAR assets.

The three assets have different roles:

- **Cancelled Order report Dec - May 2026.xlsx** — transactional order-line and cancellation evidence, plus a small separate invoice extract.
- **Master data file.xlsx** — operational planning, fleet, cost, sales-volume, route and workforce reference data.
- **MASAFIOS repository** — dashboard/workflow reference and fixed discovery findings. It is not a live API or a substitute for source records.

## Workbook A: order and cancellation evidence

The order sheet `2_1780921000_order` contains 42,826 data rows (42,827 including its header) and 32 columns. It is line-level data: an order number can appear on multiple rows because an order can contain multiple item codes. Never treat each row as a distinct order.

Important field groups:

| Domain | Supplied fields | ZONAR treatment |
|---|---|---|
| Order identity | Order Number, Customer LPO, Order Type | Preserve source identifiers; establish tenant-scoped canonical order key |
| Customer/site | Site Code, Site Name, Customer Source, Delivery Channel | Treat names as sensitive; use stable source IDs and governed dimensions |
| Routing | Region, Route Code, Driver, Delivery Category | Normalise region/route; driver identity is restricted personal data |
| Timing | Order Date, Order Time, Booking Time, Delivery Date, Desired Delivery Date, Allocation Date | Preserve source timezone/precision; distinguish event time from ingestion time |
| Status | Order Status, Cancel Reason, Pending cancel report, Canceled By | Map to controlled status/reason taxonomy without losing raw source values |
| Product/quantity | Item Code, Order Quantity, Item Uom | Preserve decimal quantities and unit of measure |
| Financials | Unit Price, Discount amount, Tax, Net Amount, Gross Amount | Parse as decimal currency values; never use binary floating point for persisted money |
| Lineage | Source, Web Source, Department | Retain source-system provenance and mapping version |

The separate `Sheet2` contains 2,201 cancellation records with date, region, dispatch state, driver name/ID, site code/tradename, order number, channel, quantity and status. `Sheet4` and `Sheet5` are regional summary/pivot views; they are validation aids, not independent transactional facts.

The separate `Sheet1` invoice extract contains only 18 rows and dates in 2024–2025. It is not a matching invoice ledger for the Dec–May 2026 order population. Do not use it to claim order-to-invoice reconciliation for that period.

### Required order ingestion rules

1. Stage each source file immutably with tenant ID, source file ID, checksum, upload time, source period and mapping version.
2. Preserve original row number and raw source fields in restricted source storage.
3. Build a canonical order header by grouping line rows on a validated order key; preserve item lines separately.
4. Detect duplicate line rows, repeated order IDs, conflicting header attributes and inconsistent dates. Do not silently deduplicate.
5. Validate that line quantities and line values aggregate consistently with any supplied order-level totals.
6. Keep cancellation timing categories and cancellation reasons separate; a cancelled order is not automatically a financial loss.
7. Calculate exposure only from an approved value basis and mark it as estimated, confirmed, or recovered with explicit evidence.

## Workbook B: operational master and planning data

The workbook includes the following material domains:

- Fleet and vehicle planning: `VEH FY 26` through `VEH FY 31`, `Summary`, vehicle requirements and fleet records.
- Fleet operating costs: `Opex`, including vehicle classes, annual mileage assumptions and maintenance cost categories.
- Capital planning: `Capex`, including projected vehicle purchases, capex per vehicle, depreciation and usable-life assumptions.
- Sales and volume plans: `AOP`, `AOP 27`–`AOP 31`, `Projection-Sales`, `Breakup`, `HOD & VS`, `Pressellers`, `Overall AOP Chanda`.
- Route/channel detail: `Chandan Raw Data` (23,186 rows; month, channel, region, route, category, route type, volume and NR2).
- Workforce planning: `HC Proposal` and related headcount/role planning sheets.
- Cost and actuals: `3 Months Data`, `Cost Impact`, `Summary - External Cost`, `Peak Incentive`.

### Sensitivity classification

- **Restricted personal data:** employee names, employee IDs, designations and driver names/IDs in workforce/incentive/dispatch records. Exclude from any demo or public dataset. Apply least-privilege access, retention controls and pseudonymisation where processing is approved.
- **Confidential commercial data:** GL/accounting dimensions, salary and people costs, vendor/haulier costs, incentives, fleet capex/opex, customer/site names, route volumes and sales projections. Keep within the authorised tenant and approved purpose.
- **Planning assumptions:** AOP, future-year vehicle requirements, sales projections, capex and forecast volumes. Store as forecast/planned values, with plan version and effective period; never combine them with actuals without explicit labels.
- **Operational actuals:** source-dated cost and volume observations. Retain source date and data lineage; do not assume every sheet is actual or complete.

## Data model and reconciliation boundaries

The workbooks support several analytical domains, but they do not establish a complete, common transaction-level key across all domains.

| Domain | Candidate natural keys | What can be validated now | What remains unproven |
|---|---|---|---|
| Order lines | Order Number + source row/line identity; Item Code | Order-line counts, order grouping, quantities, statuses, date and value quality | Delivery completion unless a matching delivery ledger is supplied |
| Cancellations | Order Number + cancellation event/source row | Cancellation counts and quantities; regional and dispatch-state analysis | Causal loss, avoidability, recovered revenue |
| Invoices | Invoice Number | Basic invoice extract structure | Reliable join to the 2026 order population; invoice line/order linkage |
| Route volumes | Month + region + route + channel + category + route type | Aggregated volume and NR2 trends | Order-level attribution without shared route/date keys and documented grain |
| Fleet | Region/depot + vehicle class + plan year | Planned vs recorded fleet comparison where definitions align | Vehicle-level utilisation/telemetry without fleet IDs and trip data |
| Cost | GL + cost centre + period + cost category | Period/category cost analysis where row grain and date columns are confirmed | Causal allocation to individual orders/routes without allocation rules |
| Workforce | Employee ID + effective date | Restricted headcount/incentive analysis | Public or tenant-wide exposure; individual data is not suitable for dashboard demo |

Do not infer that a shared region, month or order number proves a valid relationship. Each relationship requires documented grain, key uniqueness, null/duplicate profiling and reconciliation controls.

## MASAFIOS dashboard reference

MASAFIOS provides useful operational concepts for ZONAR: exception-led views, depot/region context, fleet planning, cancelled-order exposure, operational work queues and executive summaries. The repository dashboard is a static walkthrough with hardcoded discovery values and illustrative elements; it has no connected operational API or live GPS feed. Reuse patterns only after implementing them against ZONAR's server-side, tenant-scoped APIs. Never reuse client-specific figures, labels, names, maps or screenshots in public product assets without explicit approval and anonymisation review.

## Next engineering increments

1. **Source profiling contract:** implement a server-side profile result with row/line grain, header normalisation, null/duplicate counts, date ranges, numeric parse failures, candidate keys and sensitivity classification.
2. **Canonical order model:** persist order headers and item lines separately; retain source row lineage and mapping version.
3. **Cancellation analytics:** create reproducible metrics for unique cancelled orders, cancelled line quantity, timing bucket, reason, dispatch state and value basis. Expose estimated exposure separately from confirmed loss.
4. **Reference dimensions:** normalise region, route, channel, category, depot and vehicle class with source-to-canonical mapping tables.
5. **Planning vs actuals:** persist forecast/plan versions separately from actual observations; show period, scenario and source on every metric.
6. **Durable event generation:** emit deduplicated, tenant-scoped operational events from validated exceptions and save immutable metric snapshots.
7. **Asynchronous processing:** move beyond the temporary 2 MB / 10,000-row synchronous profile path before production-scale workbook or CSV ingestion.

## Explicit release restrictions

- This assessment does not import the workbooks into ZONAR or create a live customer feed.
- Do not upload raw Masafi files to public GitHub, public object storage, public demos or model-training datasets.
- Do not expose employee, driver, customer, site, route or commercially sensitive financial details outside the authorised tenant.
- Do not call a cancellation amount a loss or a recovery without a defined and auditable calculation.
- Do not claim order-to-invoice-to-delivery reconciliation until the matching source ledgers, keys and period coverage are validated.
