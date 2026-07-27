#!/usr/bin/env Rscript
# src/loaders/R/elections/local_2021_candidates.R
# Ingest src/data/raw/adg_2021_candidates_unified.xlsx into canonical CSVs:
#
#   src/data/candidates/local_2021_pr.csv          (sheet "party lists")
#   src/data/candidates/local_2021_council_smd.csv (sheet "majoritarian candidates")
#   src/data/candidates/local_2021_mayor.csv       (sheet "mayoral candidates")
#   src/data/candidates/local_2021_elected.csv     (sheet "elected" — Georgian headers)
#
# R port of scripts/ingest-local2021.js — parity-verified byte-identical before
# the node script was retired, THEN (REFACTOR_PLAN B5-family, 2026-07-04)
# council_smd district ids were normalized: the XLSX stores the seat number
# per selfgov ("majoritarian_district_code" 1, 2, …) while the council shape
# (majoritarian_2021_major_id.geojson) keys districts as
# major_id = district_code*100 + seat (Mtatsminda seat 1 → 101). Composed here;
# previously every 2021 council candidate failed the geo join.
#
# Usage (from repo root):
#   Rscript src/loaders/R/elections/local_2021_candidates.R           (dry-run → _local_2021_ingest/)
#   Rscript src/loaders/R/elections/local_2021_candidates.R --apply   (writes to src/data/candidates/)

source("src/loaders/R/common/schema.R")
source("src/loaders/R/common/io.R")
source("src/loaders/R/common/parties.R")
source("src/loaders/R/common/candidates.R")
source("src/loaders/R/common/districts.R")

APPLY <- "--apply" %in% commandArgs(trailingOnly = TRUE)
OUT_DIR <- if (APPLY) "src/data/candidates" else "src/data/candidates/_local_2021_ingest"

RAW_XLSX <- "src/data/raw/adg_2021_candidates_unified.xlsx"
SOURCE <- basename(RAW_XLSX)
ELECTION_YML <- "src/data/config/elections/local/local_2021.yml"

resolver <- make_party_resolver(ELECTION_YML)

party_id_of <- function(labels) {
  vapply(labels, function(l) {
    if (is_initiative_label(l)) "" else resolver$resolve(l)
  }, character(1), USE.NAMES = FALSE)
}

#' full_name when present, else "first last".
name_or_full <- function(df) {
  full <- col_or_blank(df, "full_name")
  ifelse(nzchar(full), full, join_name(df$first_name, df$last_name))
}

pr <- read_xlsx_sheet(RAW_XLSX, "party lists")
smd <- read_xlsx_sheet(RAW_XLSX, "majoritarian candidates")
mayor <- read_xlsx_sheet(RAW_XLSX, "mayoral candidates")
el <- read_xlsx_sheet(RAW_XLSX, "elected")

# ─── PR-per-selfgov candidates ──────────────────────────────────────────────

pr_rows <- data.frame(
  election_id = "local_2021",
  sub_id = "__main__",
  vote_type = "pr",
  party_id = party_id_of(pr$party_name),
  party_label_ka = pr$party_name,
  party_code = pr$party_number,
  district_id = pr$district_code,
  district_name_ka = pr$district_name,
  list_order = pr$list_order_id,
  ballot_number = "",
  first_name = pr$first_name,
  last_name = pr$last_name,
  name_ka = name_or_full(pr),
  partisanship = col_or_blank(pr, "partisanship"),
  elected = "",
  source = SOURCE,
  stringsAsFactors = FALSE, check.names = FALSE
)

# ─── Council SMD candidates ─────────────────────────────────────────────────

smd_rows <- data.frame(
  election_id = "local_2021",
  sub_id = "__main__",
  vote_type = "council_smd",
  party_id = party_id_of(smd$endorser),
  party_label_ka = smd$endorser,
  party_code = "",
  district_id = council_maj_id(selfgov_from_raw_district_id(smd$district_code), smd$majoritarian_district_code),
  district_name_ka = smd$district_name,
  list_order = "",
  ballot_number = smd$candidate_number,
  first_name = smd$first_name,
  last_name = smd$last_name,
  name_ka = name_or_full(smd),
  partisanship = "",
  elected = "",
  source = SOURCE,
  stringsAsFactors = FALSE, check.names = FALSE
)

# ─── Mayor candidates ───────────────────────────────────────────────────────

mayor_rows <- data.frame(
  election_id = "local_2021",
  sub_id = "__main__",
  vote_type = "mayor",
  party_id = party_id_of(mayor$endorser),
  party_label_ka = mayor$endorser,
  party_code = "",
  district_id = mayor$district_code,
  district_name_ka = mayor$district_name,
  list_order = "",
  ballot_number = mayor$candidate_number,
  first_name = mayor$first_name,
  last_name = mayor$last_name,
  name_ka = name_or_full(mayor),
  partisanship = "",
  elected = "",
  source = SOURCE,
  stringsAsFactors = FALSE, check.names = FALSE
)

# ─── Elected (winners) — Georgian-keyed columns ─────────────────────────────
#   "არჩევნების ტიპი"    → election_type (pr / smd / mayor)
#   "ოლქის ნომერი"       → district_code (selfgov_id)
#   "ოლქის  დასახელება"  → district_name (double space in source!)
#   "მაჟორიტარული ოლქი" → majoritarian_district_code
#   "რიგითი ნომერი…"      → list_order (pr) / ballot_number (smd)
#   "სახელი" / "გვარი"    → first / last name
#   "წარმდგენი"           → endorser (party label)
#   "პარტიულობა"          → partisanship

COL_TYPE     <- "არჩევნების ტიპი"
COL_DCODE    <- "ოლქის ნომერი"
COL_DNAME    <- "ოლქის  დასახელება"   # double-space in source
COL_MAJOR    <- "მაჟორიტარული ოლქი"
COL_ORDER    <- "რიგითი ნომერი პარტიულ სიაში (pr) ან კანდიდატის ნომერი ბიულეტენზე (smd)"
COL_FIRST    <- "სახელი"
COL_LAST     <- "გვარი"
COL_ENDORSER <- "წარმდგენი"
COL_PARTISAN <- "პარტიულობა"

et <- tolower(el[[COL_TYPE]])
el_vote_type <- ifelse(et == "pr", "pr", ifelse(et == "mayor", "mayor", "council_smd"))

# Canonical council district id: Tbilisi raion codes (1–10) collapse to
# selfgov 1 before composing selfgov*100 + seat; "" when either part is blank.
el_maj <- suppressWarnings(
  council_maj_id(selfgov_from_raw_district_id(el[[COL_DCODE]]), el[[COL_MAJOR]])
)
el_maj_chr <- ifelse(is.na(el_maj), "", as.character(el_maj))

elected_rows <- data.frame(
  election_id = "local_2021",
  sub_id = "__main__",
  vote_type = el_vote_type,
  party_id = party_id_of(el[[COL_ENDORSER]]),
  party_label_ka = el[[COL_ENDORSER]],
  party_code = "",
  district_id = ifelse(el_vote_type == "council_smd", el_maj_chr, el[[COL_DCODE]]),
  district_name_ka = el[[COL_DNAME]],
  list_order = ifelse(el_vote_type == "pr", el[[COL_ORDER]], ""),
  ballot_number = ifelse(el_vote_type != "pr", el[[COL_ORDER]], ""),
  first_name = el[[COL_FIRST]],
  last_name = el[[COL_LAST]],
  name_ka = join_name(el[[COL_FIRST]], el[[COL_LAST]]),
  partisanship = el[[COL_PARTISAN]],
  elected = "TRUE",
  source = SOURCE,
  stringsAsFactors = FALSE, check.names = FALSE
)

# ─── Write ──────────────────────────────────────────────────────────────────

write_canonical_csv(pr_rows, file.path(OUT_DIR, "local_2021_pr.csv"), "candidates")
write_canonical_csv(smd_rows, file.path(OUT_DIR, "local_2021_council_smd.csv"), "candidates")
write_canonical_csv(mayor_rows, file.path(OUT_DIR, "local_2021_mayor.csv"), "candidates")
write_canonical_csv(elected_rows, file.path(OUT_DIR, "local_2021_elected.csv"), "candidates")

report_unresolved(resolver)

cat(if (APPLY) "\nApplied to src/data/candidates/.\n" else
  sprintf("\nDry run — files in %s. Re-run with --apply.\n", OUT_DIR))
