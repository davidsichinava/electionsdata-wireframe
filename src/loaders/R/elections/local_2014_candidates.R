#!/usr/bin/env Rscript
# src/loaders/R/elections/local_2014_candidates.R
# Ingest the corrected 2014 local-election XLSX files into canonical CSVs:
#
#   adg_2014_candidates_unified_corrected.xlsx → pr / council_smd / mayor / gamgebeli
#   adg_2014_elected_politicians.xlsx          → elected
#
# Output:
#   src/data/candidates/local_2014_pr.csv
#   src/data/candidates/local_2014_council_smd.csv
#   src/data/candidates/local_2014_mayor.csv
#   src/data/candidates/local_2014_gamgebeli.csv
#   src/data/candidates/local_2014_elected.csv
#
# Council-majoritarian district ids are recomposed as selfgov_id*100 + seat
# (see src/loaders/R/common/districts.R for why the raw maj_id "hundreds" part
# can't be trusted — Tbilisi and the carved-out towns encode it differently).
#
# R port of scripts/ingest-local2014.js — parity-verified byte-identical before
# the node script was retired.
#
# Usage (from repo root):
#   Rscript src/loaders/R/elections/local_2014_candidates.R           (dry-run → _local_2014_ingest/)
#   Rscript src/loaders/R/elections/local_2014_candidates.R --apply   (writes to src/data/candidates/)

source("src/loaders/R/common/schema.R")
source("src/loaders/R/common/io.R")
source("src/loaders/R/common/parties.R")
source("src/loaders/R/common/candidates.R")

APPLY <- "--apply" %in% commandArgs(trailingOnly = TRUE)
OUT_DIR <- if (APPLY) "src/data/candidates" else "src/data/candidates/_local_2014_ingest"

RAW_CANDIDATES <- "src/data/raw/adg_2014_candidates_unified_corrected.xlsx"
RAW_ELECTED <- "src/data/raw/adg_2014_elected_politicians.xlsx"
CANDIDATES_SOURCE <- basename(RAW_CANDIDATES)
ELECTED_SOURCE <- basename(RAW_ELECTED)
ELECTION_YML <- "src/data/config/elections/local/local_2014.yml"

resolver <- make_party_resolver(ELECTION_YML)

party_id_of <- function(labels) {
  vapply(labels, function(l) {
    if (is_initiative_label(l)) "" else resolver$resolve(l)
  }, character(1), USE.NAMES = FALSE)
}

#' Canonical council maj_id = selfgov*100 + (maj %% 100), replicating the node
#' guard exactly: JS Number("") is 0 (finite), so blank cells behave as 0;
#' only non-numeric garbage falls back to the raw maj_id string.
council_maj_id_2014 <- function(selfgov_id, maj_id) {
  s <- suppressWarnings(as.numeric(ifelse(trimws(selfgov_id) == "", "0", selfgov_id)))
  m <- suppressWarnings(as.numeric(ifelse(trimws(maj_id) == "", "0", maj_id)))
  ifelse(is.na(s) | is.na(m),
         as.character(maj_id),
         as.character(as.integer(s) * 100L + as.integer(m) %% 100L))
}

pr <- read_xlsx_sheet(RAW_CANDIDATES, "party lists")
smd <- read_xlsx_sheet(RAW_CANDIDATES, "majoritarian candidates")
mg <- read_xlsx_sheet(RAW_CANDIDATES, "mayor_gamgebeli")
el <- read_xlsx_sheet(RAW_ELECTED, "elected politicians")

# selfgov_id → district_name lookup from the mayor_gamgebeli sheet (the PR
# sheet stores district_code as a bare numeric selfgov id). FIRST occurrence
# wins (the node ingest checked `!map.has(key)` before setting).
sg_ok <- nzchar(mg$selfgov_id) & nzchar(mg$district_name)
selfgov_name <- as.list(mg$district_name[sg_ok])
names(selfgov_name) <- mg$selfgov_id[sg_ok]
selfgov_name <- selfgov_name[!duplicated(names(selfgov_name))]

# ─── PR-per-selfgov candidates ──────────────────────────────────────────────
# District name: lookup by selfgov_id; fall back to the PR sheet's own
# district_code when it happens to be a name rather than a numeric code
# (Tbilisi rows ship as "თბილისი" rather than "1").

pr_lookup_name <- vapply(pr$selfgov_id, function(s) {
  v <- selfgov_name[[s]]
  if (is.null(v)) "" else v
}, character(1), USE.NAMES = FALSE)
pr_fallback <- ifelse(grepl("^\\d+$", pr$district_code), "", pr$district_code)

pr_rows <- data.frame(
  election_id = "local_2014",
  sub_id = "__main__",
  vote_type = "pr",
  party_id = party_id_of(pr$party_name),
  party_label_ka = pr$party_name,
  party_code = "",
  district_id = pr$selfgov_id,
  district_name_ka = ifelse(nzchar(pr_lookup_name), pr_lookup_name, pr_fallback),
  list_order = pr$order_id,
  ballot_number = "",
  first_name = pr$first_name,
  last_name = pr$last_name,
  name_ka = join_name(pr$first_name, pr$last_name),
  partisanship = "",
  elected = "",
  source = CANDIDATES_SOURCE,
  stringsAsFactors = FALSE, check.names = FALSE
)

# ─── Council SMD candidates ─────────────────────────────────────────────────

smd_rows <- data.frame(
  election_id = "local_2014",
  sub_id = "__main__",
  vote_type = "council_smd",
  party_id = party_id_of(smd$party_name),
  party_label_ka = smd$party_name,
  party_code = "",
  district_id = council_maj_id_2014(smd$selfgov_id, smd$maj_id),
  district_name_ka = smd$district_name,
  list_order = "",
  ballot_number = smd$candidate_number,
  first_name = smd$first_name,
  last_name = smd$last_name,
  name_ka = join_name(smd$first_name, smd$last_name),
  partisanship = "",
  elected = "",
  source = CANDIDATES_SOURCE,
  stringsAsFactors = FALSE, check.names = FALSE
)

# ─── Mayor + Gamgebeli candidates (split by office_type) ────────────────────

mg_is_mayor <- mg$office_type %in% c("mayor", "tbilisi_mayor")
mg_rows <- data.frame(
  election_id = "local_2014",
  sub_id = "__main__",
  vote_type = ifelse(mg_is_mayor, "mayor", "gamgebeli"),
  party_id = party_id_of(mg$party_name),
  party_label_ka = mg$party_name,
  party_code = "",
  district_id = mg$selfgov_id,
  district_name_ka = mg$district_name,
  list_order = "",
  ballot_number = mg$candidate_number,
  first_name = mg$first_name,
  last_name = mg$last_name,
  name_ka = join_name(mg$first_name, mg$last_name),
  partisanship = "",
  elected = "",
  source = CANDIDATES_SOURCE,
  stringsAsFactors = FALSE, check.names = FALSE
)

# ─── Elected (winners) ──────────────────────────────────────────────────────
# election_type: pr_member / smd_member / mayor / gamgebeli (else kept as-is).
# Rounds 1 and 2 (runoffs) are all written into the main file — the dashboard
# merges by (election_id, sub_id, vote_type, name).

et <- tolower(el$election_type)
el_vote_type <- ifelse(et == "pr_member", "pr",
                ifelse(et == "smd_member", "council_smd",
                ifelse(et == "mayor", "mayor",
                ifelse(et == "gamgebeli", "gamgebeli", et))))

elected_rows <- data.frame(
  election_id = "local_2014",
  sub_id = "__main__",
  vote_type = el_vote_type,
  party_id = party_id_of(el$party_name),
  party_label_ka = el$party_name,
  party_code = "",
  district_id = ifelse(el_vote_type == "council_smd",
                       council_maj_id_2014(el$selfgov_id, el$maj_id),
                       el$selfgov_id),
  district_name_ka = el$local_governing_unit,
  list_order = "",
  ballot_number = el$candidate_number,
  first_name = el$first_name,
  last_name = el$last_name,
  name_ka = join_name(el$first_name, el$last_name),
  partisanship = "",
  elected = "TRUE",
  source = ELECTED_SOURCE,
  stringsAsFactors = FALSE, check.names = FALSE
)

# ─── Write ──────────────────────────────────────────────────────────────────

write_canonical_csv(pr_rows, file.path(OUT_DIR, "local_2014_pr.csv"), "candidates")
write_canonical_csv(smd_rows, file.path(OUT_DIR, "local_2014_council_smd.csv"), "candidates")
write_canonical_csv(mg_rows[mg_is_mayor, , drop = FALSE], file.path(OUT_DIR, "local_2014_mayor.csv"), "candidates")
write_canonical_csv(mg_rows[!mg_is_mayor, , drop = FALSE], file.path(OUT_DIR, "local_2014_gamgebeli.csv"), "candidates")
write_canonical_csv(elected_rows, file.path(OUT_DIR, "local_2014_elected.csv"), "candidates")

report_unresolved(resolver)

cat(if (APPLY) "\nApplied to src/data/candidates/.\n" else
  sprintf("\nDry run — files in %s. Re-run with --apply.\n", OUT_DIR))
