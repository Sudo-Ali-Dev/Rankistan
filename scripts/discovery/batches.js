// The batch -> range table: which accounts each hourly batch searches, and so which rows it owns.
//
// Batch `i` runs in Asia/Karachi hour `i` and searches accounts created in its range, once with
// `location:pakistan` and once with its city twin (locations.js). A row on the board belongs to
// the batch whose range holds its `created_at`: run-all.js re-derives `batch_index` from this
// table on every load, so the table can be changed without stranding anyone in a batch that no
// longer searches for them.
//
// The ranges were cut by measured size, not by hand. Until 2026-10-13 they were tuned to stay under
// GitHub's 1,000-result search cap; scripts/discovery/ lifted that cap, and the last batch, which
// held every account from 2025 on, grew to 3,724 candidates - about 4,250 REST calls against an
// allowance of 5,000 an hour, and an hourly run that took most of the hour. `measured` is each
// range's candidate count (main search plus city twin) on 2026-10-13, 34,854 in all. They were
// split by scripts/discovery/rebalance.js to minimise the spread, within 1,640, with the newest
// batch held to 60% of that so it can absorb the accounts that join each month.
// Re-run rebalance.js when a batch's count drifts far from the others.

export const BASE_QUERY = 'location:pakistan type:user repos:>3 followers:>1';

export const BATCH_RANGES = Object.freeze([
  { from: '2000-01-01', to: '2014-12-31', label: 'PK 2000-Dec2014', measured: 1529 },
  { from: '2015-01-01', to: '2016-08-31', label: 'PK Jan2015-Aug2016', measured: 1496 },
  { from: '2016-09-01', to: '2017-10-31', label: 'PK Sep2016-Oct2017', measured: 1571 },
  { from: '2017-11-01', to: '2018-09-30', label: 'PK Nov2017-Sep2018', measured: 1484 },
  { from: '2018-10-01', to: '2019-05-31', label: 'PK Oct2018-May2019', measured: 1470 },
  { from: '2019-06-01', to: '2019-11-30', label: 'PK Jun2019-Nov2019', measured: 1536 },
  { from: '2019-12-01', to: '2020-05-31', label: 'PK Dec2019-May2020', measured: 1619 },
  { from: '2020-06-01', to: '2020-11-30', label: 'PK Jun2020-Nov2020', measured: 1608 },
  { from: '2020-12-01', to: '2021-04-30', label: 'PK Dec2020-Apr2021', measured: 1500 },
  { from: '2021-05-01', to: '2021-09-30', label: 'PK May2021-Sep2021', measured: 1401 },
  { from: '2021-10-01', to: '2022-01-31', label: 'PK Oct2021-Jan2022', measured: 1338 },
  { from: '2022-02-01', to: '2022-05-31', label: 'PK Feb2022-May2022', measured: 1331 },
  { from: '2022-06-01', to: '2022-09-30', label: 'PK Jun2022-Sep2022', measured: 1640 },
  { from: '2022-10-01', to: '2022-12-31', label: 'PK Oct2022-Dec2022', measured: 1240 },
  { from: '2023-01-01', to: '2023-03-31', label: 'PK Jan2023-Mar2023', measured: 1374 },
  { from: '2023-04-01', to: '2023-07-31', label: 'PK Apr2023-Jul2023', measured: 1524 },
  { from: '2023-08-01', to: '2023-10-31', label: 'PK Aug2023-Oct2023', measured: 1421 },
  { from: '2023-11-01', to: '2024-01-31', label: 'PK Nov2023-Jan2024', measured: 1425 },
  { from: '2024-02-01', to: '2024-04-30', label: 'PK Feb2024-Apr2024', measured: 1593 },
  { from: '2024-05-01', to: '2024-08-31', label: 'PK May2024-Aug2024', measured: 1581 },
  { from: '2024-09-01', to: '2024-12-31', label: 'PK Sep2024-Dec2024', measured: 1449 },
  { from: '2025-01-01', to: '2025-05-31', label: 'PK Jan2025-May2025', measured: 1333 },
  { from: '2025-06-01', to: '2025-11-30', label: 'PK Jun2025-Nov2025', measured: 1476 },
  { from: '2025-12-01', to: '2099-12-31', label: 'PK Dec2025+', measured: 915 }
]);

export const SEARCH_BATCHES = Object.freeze(
  BATCH_RANGES.map(({ from, to, label }) =>
    Object.freeze({ label, q: `${BASE_QUERY} created:${from}..${to}` })
  )
);
