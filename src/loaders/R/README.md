# R cleaning layer

All raw→CSV data cleaning for the dashboard lives here, in pure base-R-friendly
scripts (project decision, 2026-07 — see `REFACTOR_PLAN.md` §2–3). Node remains
only for Observable build loaders (`src/data/*.json.js`) and the XLSX download
generators (`src/loaders/downloads/`).

```
src/loaders/R/
  common/            shared helpers — source() these, they define functions only
    schema.R         canonical column specs + validate_results()/validate_candidates()
    io.R             read_xlsx_sheet(), write_canonical_csv() (UTF-8, d3-style quoting),
                     read_canonical_csv(), read_csv_header()
    districts.R      selfgov / majoritarian-district ID encoders (the ONE copy)
    parties.R        party-label → party_id resolver, is_initiative_label(),
                     report_unresolved()
    turnout.R        (planned) shared vote_share / turnout-pct computations
  elections/         one pair of entry points per election:
    {election_id}_results.R      raw → results + turnout CSVs (migration pending)
    {election_id}_candidates.R   raw → candidate + elected CSVs
                     ✔ ALL candidate ingests are R (2026-07): adj_2008, adj_2024,
                       parl_1919, parl_2016, parl_2020, local_2014, local_2021,
                       local_2025, presidential (covers pres_2008/2013/2018/2024i).
                       Each was verified byte-identical against its retired node
                       twin before deletion.
```

Legacy layout during migration: the 18 `src/loaders/process_*.R` scripts are the
current results loaders (being migrated here), and `scripts/ingest-*.js` are the
node candidate ingests (being ported to `_candidates.R` with parity checks).

## Canonical schemas

Defined once in `common/schema.R`:

- **district results** — `district_id, party_id, party_num, name_ka, round, votes,
  vote_share, registered, voted, voted_noon, voted_5pm, main_list, special_list,
  invalid_ballots, turnout_pct, noon_pct, five_pct, invalid_pct`
- **precinct results** — `precinct_id, precinct_key, district_id, selfgov_id,
  precinct_number, party_id, party_num, name_ka, round, votes, vote_share,
  registered, voted, voted_noon, voted_5pm, invalid_ballots, turnout_pct,
  noon_pct, five_pct, invalid_pct`
- **seats** — `selfgov_id, party_id, seats_pr, seats_smd, seats_mayor`
- **candidates** — the 16 columns of `src/data/candidates/README.md`

Rules: all columns always present (empty string when N/A), fixed order,
`vote_share`/`*_pct` are 0–1 fractions, `district_id == "national"` is the
countrywide pseudo-row, council majoritarian ids are `selfgov_id*100 + seat`.

## Adding a new election (target workflow)

1. Drop raw files in `src/data/raw/`.
2. Create `elections/{election_id}_results.R` and `elections/{election_id}_candidates.R`;
   start from the most similar existing election. Each script begins:
   ```r
   source("src/loaders/R/common/schema.R")
   source("src/loaders/R/common/io.R")
   source("src/loaders/R/common/districts.R")
   ```
   and writes every output through `write_canonical_csv(df, path, level)` —
   which validates, pads, orders, and writes UTF-8, so schema drift is impossible.
3. Add the election YAML under `src/data/config/elections/` (templates in
   `election_data_schema/`).
4. Run `Rscript scripts/validate-canonical.R` — the drift report must stay clean.
5. `npm run build` and spot-check the dashboard.

## Gotchas

- **YAML booleans:** R's `yaml` package speaks YAML 1.1 — an unquoted `id: yes`
  or `id: no` becomes `TRUE`/`FALSE` (node's js-yaml keeps them strings). Always
  quote boolean-like ids in the config YAMLs; `make_party_resolver()` errors
  loudly if one slips through.
- **Parity checking a port:** `write_canonical_csv()` reproduces d3-dsv's
  minimal quoting and omits the trailing newline, so a faithful port of a node
  ingest produces a byte-identical file — compare with `sha256sum`, not eyeballs.

## Checks

```bash
Rscript scripts/validate-canonical.R   # schema drift report → reports/schema-drift.csv
```

Baseline (2026-07-03, before migration): district 0/92 exact (16 signatures),
precinct 0/77 exact (20 signatures), seats 5/5 ✓, canonical candidates 45/45 ✓,
11 legacy candidate files to retire. Target: every row EXACT, signatures = 1 per level.
