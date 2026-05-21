# Candidate data — canonical schema

This directory is the **single source of truth** for candidate and elected-member
data across every election in the archive. Each file is a flat CSV with a fixed
schema. The candidates pipeline (`src/data/config/candidates-build.js`) reads
only files matching the conventions in this document; it does not read YAMLs,
XLSXs, or any per-election special paths.

If you need to add or correct a candidate, edit the canonical CSV(s) in this
folder directly. Original archival sources live under `src/data/raw/` and are
treated as backups — they are not read by the loader.

## Filename convention

```
src/data/candidates/{election_id}_{slot}.csv
```

* `{election_id}` matches the `id` field of the election YAML in
  `src/data/config/elections/**/*.yml`, e.g. `parl_2008`, `local_2014`,
  `adj_2020`, `pres_2013`.
* `{slot}` is one of the slot keys listed in **Slots** below.
* Sub-elections (by-elections, runoffs) get their **own** files using the
  sub-election id from the parent YAML's `sub_elections` block, e.g.
  `parl_2012_2015_byelection_smd.csv`, `local_2014_r2_elected.csv`.

The loader auto-discovers every `{election_id}_{slot}.csv` in this folder.
Election YAMLs do not need to reference candidate files; the only valid YAML
override is `files.candidate_overrides.{slot}: <relative-path>` when the file
deliberately lives somewhere else (rare).

## Slots

Each slot is a single `vote_type` worth of candidates in one election. One CSV
per slot per (sub-)election.

| Slot key | `vote_type` written into the file | Used for |
|---|---|---|
| `pr` | `pr` | PR / party-list candidates (parliamentary, adjara, local sakrebulo) |
| `smd` | `smd` | Single-member-district / majoritarian candidates |
| `council_smd` | `council_smd` | Sakrebulo (local council) SMD candidates — alias for the local-elections variant |
| `mayor` | `mayor` | Mayoral candidates (local) |
| `gamgebeli` | `gamgebeli` | Gamgebeli (rural executive) candidates (local 2010, 2014) |
| `presidential` | `presidential` | Presidential candidates |
| `elected` | mixed — preserves the candidate's original `vote_type` | Members who actually won, across all slots, with `elected: TRUE` |

`council_smd` and `smd` coexist for local elections because the source data
uses different terminology across years (`council_smd` in local 2014 YAMLs,
`sakrebulo_smd` in local 2017+, `smd` in some result CSVs). The loader treats
them as equivalent for grouping purposes; pick whichever matches the source.

## Schema (16 columns)

Every CSV in this folder uses **all sixteen columns** in this order. Columns
not relevant to a given row stay empty (no quotes, no NA).

| # | Column | Type | Meaning |
|---|---|---|---|
| 1 | `election_id` | string | Matches the parent election YAML's `id`. Required. |
| 2 | `sub_id` | string | `__main__` for main-election candidates; otherwise the sub-election id (e.g. `parl_2012_2015_byelection`). Required. |
| 3 | `vote_type` | enum | `pr` / `smd` / `council_smd` / `mayor` / `gamgebeli` / `presidential`. Required. |
| 4 | `party_id` | string | Canonical party id from `src/data/config/parties.yml`. Empty when the registry has no entry for this ballot label. |
| 5 | `party_label_ka` | string | Georgian party label exactly as it appeared on the ballot for this election. Always populated when the candidate ran on any party ticket. Empty only for true independents with no presenting group. |
| 6 | `party_code` | integer | The ballot number assigned to the party in this election (e.g. UNM was #5 in 2008 and #41 in 2024). Useful when merging across files where only the number is recorded. Empty if unknown. |
| 7 | `district_id` | string | SMD district number, council district `major_id`, selfgov_id (for PR-per-selfgov), or empty for nationwide PR. Stored as string so it survives leading zeros. |
| 8 | `district_name_ka` | string | Human-readable district name in Georgian. Optional — the loader can fall back to a GeoJSON lookup when this is empty. |
| 9 | `list_order` | integer | 1-based position in the PR list. Empty for non-PR rows. |
| 10 | `ballot_number` | integer | Per-candidate ballot number when the source records one separately from `party_code` (some local SMD files). Empty otherwise. |
| 11 | `first_name` | string | First name (Georgian). |
| 12 | `last_name` | string | Last name (Georgian). |
| 13 | `name_ka` | string | Full display name. Usually `first_name + " " + last_name`; preserve the source's exact form when it differs. |
| 14 | `partisanship` | string | Free-text sub-party / faction inside a coalition list. Empty for solo-party candidates. |
| 15 | `elected` | enum | `TRUE` / `FALSE` / empty (unknown). Filled for `elected.csv` files; usually empty in pure candidate-roster files. |
| 16 | `source` | string | Source filename or URL inside `src/data/raw/` or the issuing institution. Helps trace provenance. |

CSV is **comma-separated, UTF-8, no BOM, LF newlines**. Quote values that
contain commas or quotes. Empty cells are empty (no `NA`, no `null`).

## Sample rows

### `parl_2008_pr.csv`

```csv
election_id,sub_id,vote_type,party_id,party_label_ka,party_code,district_id,district_name_ka,list_order,ballot_number,first_name,last_name,name_ka,partisanship,elected,source
parl_2008,__main__,pr,unm,"ერთიანი ნაციონალური მოძრაობა — გამარჯვებული საქართველოსთვის",5,,,1,,კახაბერ,ანჯაფარიძე,კახაბერ ანჯაფარიძე,,TRUE,tsesko_parl2008_lists.pdf
parl_2008,__main__,pr,labour,"საქართველოს ლეიბორისტული პარტია",16,,,1,,შალვა,ნათელაშვილი,შალვა ნათელაშვილი,,TRUE,tsesko_parl2008_lists.pdf
```

### `parl_2008_smd.csv`

```csv
election_id,sub_id,vote_type,party_id,party_label_ka,party_code,district_id,district_name_ka,list_order,ballot_number,first_name,last_name,name_ka,partisanship,elected,source
parl_2008,__main__,smd,republicans_2008,"საქართველოს რესპუბლიკური პარტია",2,1,მთაწმინდა,,2,ივლიანე,ხაინდრავა,ივლიანე ხაინდრავა,,FALSE,tsesko_parl2008_smd.pdf
```

### `local_2014_mayor.csv`

```csv
election_id,sub_id,vote_type,party_id,party_label_ka,party_code,district_id,district_name_ka,list_order,ballot_number,first_name,last_name,name_ka,partisanship,elected,source
local_2014,__main__,mayor,gd,"ქართული ოცნება",41,1,თბილისი,,,დავით,ნარმანია,დავით ნარმანია,,TRUE,SakrebuloMembers2014.pdf
```

### `local_2014_gamgebeli.csv`

```csv
election_id,sub_id,vote_type,party_id,party_label_ka,party_code,district_id,district_name_ka,list_order,ballot_number,first_name,last_name,name_ka,partisanship,elected,source
local_2014,__main__,gamgebeli,nonparliamentary_opposition_2014,"არასაპარლამენტო ოპოზიცია (კახა კუკავა, ფიქრია ჩიხრაძე)",1,11,საგარეჯო,,1,ივანე,დემეტრაშვილი,ივანე დემეტრაშვილი,,FALSE,SakrebuloMembers2014.pdf
```

### `local_2014_elected.csv`

```csv
election_id,sub_id,vote_type,party_id,party_label_ka,party_code,district_id,district_name_ka,list_order,ballot_number,first_name,last_name,name_ka,partisanship,elected,source
local_2014,__main__,mayor,gd,"ქართული ოცნება",41,63,აბაშა,,,მამუკა,კვიტაშვილი,მამუკა კვიტაშვილი,,TRUE,SakrebuloMembers2014.pdf
local_2014,__main__,pr,unm,"ერთიანი ნაციონალური მოძრაობა",5,63,აბაშა,1,,თამაზ,ზაქაიძე,თამაზ ზაქაიძე,,TRUE,SakrebuloMembers2014.pdf
local_2014,__main__,council_smd,gd,"ქართული ოცნება",41,101,მთაწმინდა,,1,გიორგი,ბერია,გიორგი ბერია,,TRUE,SakrebuloMembers2014.pdf
```

Note how `_elected.csv` mixes vote_types — one file per election listing every
winner with their original `vote_type` preserved.

### `pres_2013_presidential.csv`

```csv
election_id,sub_id,vote_type,party_id,party_label_ka,party_code,district_id,district_name_ka,list_order,ballot_number,first_name,last_name,name_ka,partisanship,elected,source
pres_2013,__main__,presidential,gd,"ქართული ოცნება — დემოკრატიული საქართველო",41,,,,,გიორგი,მარგველაშვილი,გიორგი მარგველაშვილი,,TRUE,tsesko_pres2013.pdf
pres_2013,__main__,presidential,unm,"ერთიანი ნაციონალური მოძრაობა",5,,,,,დავით,ბაქრაძე,დავით ბაქრაძე,,FALSE,tsesko_pres2013.pdf
```

### `parl_2012_2015_byelection_smd.csv` (sub-election)

```csv
election_id,sub_id,vote_type,party_id,party_label_ka,party_code,district_id,district_name_ka,list_order,ballot_number,first_name,last_name,name_ka,partisanship,elected,source
parl_2012,parl_2012_2015_byelection,smd,gd,"ქართული ოცნება",41,11,საგარეჯო,,1,ვახტანგ,გომელაური,ვახტანგ გომელაური,,TRUE,tsesko_2015_byelection.pdf
```

## Conventions

### Empty vs unknown
* **Empty** cell — the field doesn't apply (e.g. `list_order` on an SMD row).
* `elected: ""` — outcome is genuinely unknown (data hasn't been compiled).
* `elected: FALSE` — confirmed loser. Use this when you have the full elected
  list so the loader can distinguish "ran and lost" from "outcome unknown".
* `party_id: ""` — registry has no canonical id for this ballot label. Means
  the loader will not be able to color-link this row with other appearances of
  the same party. Add a registry entry in `parties.yml` to fix.

### Coalitions
For multi-party blocs (e.g. UNM-led "Unity — National Movement" in 2024):
* Put the bloc's canonical id in `party_id` (e.g. `unity`).
* Put the bloc's ballot label in `party_label_ka`.
* Put the constituent party's name in `partisanship` (e.g.
  `მპგ „ერთიანი ნაციონალური მოძრაობა"`).
* `party_code` is the bloc's ballot number, not the constituent's.

### District ids
* Parliamentary SMD — TSESKO's numeric district code.
* Sakrebulo SMD — `major_id` (e.g. `101` = Mtatsminda 2025; `4311` = Oni 2025).
* Mayor / gamgebeli — `selfgov_id` (the self-governing-unit identifier).
* PR-per-selfgov — `selfgov_id`. For nationwide PR (parliamentary, presidential)
  leave `district_id` empty.

### Sources
Use the original document filename when the source is in `src/data/raw/`
(e.g. `adg_2017_candidates_unified.xlsx`). Otherwise paste a URL or the issuing
institution's reference (CEC FOIA request id, OSCE final report id, etc.).
Source-tracing is what makes corrections possible later — never leave this
column blank for a brand-new row.

## Loader contract

`src/data/config/candidates-build.js` walks every election YAML, then for each
sub-election (including `__main__`) tries to find these files:

```
src/data/candidates/{election_id}_pr.csv
src/data/candidates/{election_id}_smd.csv
src/data/candidates/{election_id}_council_smd.csv
src/data/candidates/{election_id}_mayor.csv
src/data/candidates/{election_id}_gamgebeli.csv
src/data/candidates/{election_id}_presidential.csv
src/data/candidates/{election_id}_elected.csv
```

…and similarly with the sub-election id when `sub_id !== __main__`. Each file
is opened (if it exists), every row is asserted against the 16-column schema,
and rows are emitted into the unified appearance graph consumed by the
candidates and parties pages.

That's all. No fallbacks. No special cases. No XLSX or YAML reading from inside
the loader. Adding a new election is "drop a properly-formatted CSV in this
folder" — no code changes.

## Migration notes (historical)

This canonical layout replaced a fragmented setup with three competing sources:
hand-curated CSVs in `src/data/candidates/`, YAML rosters in
`src/data/config/candidates/local/`, and raw XLSXs in `src/data/raw/`. The
one-off migration script `scripts/migrate-candidates.js` extracted rows from
each legacy source into this format. The legacy CSVs and the
`data/config/candidates/local/*.yml` rosters were deleted after parity-check.

The raw XLSX/CSV files in `src/data/raw/` are kept as archival originals.
Re-extracting from them is only necessary if you find a row in this folder
that disagrees with the source — in which case correct the canonical CSV
directly and note the discrepancy in `src/data/raw/README.md`.
