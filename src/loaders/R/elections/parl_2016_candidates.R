#!/usr/bin/env Rscript
# src/loaders/R/elections/parl_2016_candidates.R
# Ingest src/data/raw/party_lists_2016_georgia_unified.xlsx into canonical CSVs:
#
#   src/data/candidates/parl_2016_pr.csv        (sheet "PR lists")
#   src/data/candidates/parl_2016_smd.csv       (sheet "Majoritarians")
#   src/data/candidates/parl_2016_elected.csv   (sheet "Elected", 150 winners)
#
# R port of scripts/ingest-parl2016.js — parity-verified byte-identical before
# the node script was retired. SMD/elected use the PREFIX-ONLY initiative check
# ("საინიციატივო ჯგუფი…"), kept as-is for parity.
#
# Usage (from repo root):
#   Rscript src/loaders/R/elections/parl_2016_candidates.R           (dry-run → _parl_2016_ingest/)
#   Rscript src/loaders/R/elections/parl_2016_candidates.R --apply   (writes to src/data/candidates/)

source("src/loaders/R/common/schema.R")
source("src/loaders/R/common/io.R")
source("src/loaders/R/common/parties.R")
source("src/loaders/R/common/candidates.R")

APPLY <- "--apply" %in% commandArgs(trailingOnly = TRUE)
OUT_DIR <- if (APPLY) "src/data/candidates" else "src/data/candidates/_parl_2016_ingest"

RAW_XLSX <- "src/data/raw/party_lists_2016_georgia_unified.xlsx"
SOURCE <- basename(RAW_XLSX)
ELECTION_YML <- "src/data/config/elections/parliamentary/parl_2016.yml"

resolver <- make_party_resolver(ELECTION_YML)

is_initiative_prefix <- function(label) grepl("^\\s*საინიციატივო\\s+ჯგუფი", label)

resolve_or_blank <- function(labels, skip = rep(FALSE, length(labels))) {
  vapply(seq_along(labels), function(i) {
    if (skip[[i]]) "" else resolver$resolve(labels[[i]])
  }, character(1))
}

# ─── PR list candidates ─────────────────────────────────────────────────────

pr <- read_xlsx_sheet(RAW_XLSX, "PR lists")
pr_rows <- data.frame(
  election_id = "parl_2016",
  sub_id = "__main__",
  vote_type = "pr",
  party_id = resolve_or_blank(pr$party_name),
  party_label_ka = pr$party_name,
  party_code = pr$party_number,
  district_id = "",
  district_name_ka = "",
  list_order = pr$order_id,
  ballot_number = "",
  first_name = pr$name,
  last_name = pr$last_name,
  name_ka = join_name(pr$name, pr$last_name),
  partisanship = col_or_blank(pr, "partisanship"),
  elected = "",
  source = SOURCE,
  stringsAsFactors = FALSE, check.names = FALSE
)

# ─── SMD candidates ─────────────────────────────────────────────────────────
# Initiative groups ("საინიციატივო ჯგუფი - …") are independents; keep the
# literal label but don't resolve a party_id.

smd <- read_xlsx_sheet(RAW_XLSX, "Majoritarians")
smd_init <- is_initiative_prefix(smd$endorsing_party)
smd_rows <- data.frame(
  election_id = "parl_2016",
  sub_id = "__main__",
  vote_type = "smd",
  party_id = resolve_or_blank(smd$endorsing_party, skip = smd_init),
  party_label_ka = smd$endorsing_party,
  party_code = "",
  district_id = smd$majoritarian_district_id,
  district_name_ka = smd$district_commission_name,
  list_order = "",
  ballot_number = smd$candidate_number,
  first_name = smd$name,
  last_name = smd$last_name,
  name_ka = join_name(smd$name, smd$last_name),
  partisanship = "",
  elected = "",
  source = SOURCE,
  stringsAsFactors = FALSE, check.names = FALSE
)

# ─── Elected (150 winners) ──────────────────────────────────────────────────

el <- read_xlsx_sheet(RAW_XLSX, "Elected")
el_is_pr <- tolower(el$election_type) == "pr"
el_label <- ifelse(el_is_pr, el$party_name,
                   ifelse(nzchar(el$endorsing_party), el$endorsing_party, el$party_name))
el_init <- is_initiative_prefix(el_label)
elected_rows <- data.frame(
  election_id = "parl_2016",
  sub_id = "__main__",
  vote_type = ifelse(el_is_pr, "pr", "smd"),
  party_id = resolve_or_blank(el_label, skip = el_init),
  party_label_ka = el_label,
  party_code = ifelse(el_is_pr, el$party_number, ""),
  district_id = ifelse(el_is_pr, "", el$majoritarian_district_id),
  district_name_ka = ifelse(el_is_pr, "", el$district_commission_name),
  list_order = ifelse(el_is_pr, el$party_list_order_id, ""),
  ballot_number = ifelse(el_is_pr, "", el$candidate_number),
  first_name = el$first_name,
  last_name = el$last_name,
  name_ka = join_name(el$first_name, el$last_name),
  partisanship = "",
  elected = "TRUE",
  source = SOURCE,
  stringsAsFactors = FALSE, check.names = FALSE
)

# ─── Write ──────────────────────────────────────────────────────────────────

write_canonical_csv(pr_rows, file.path(OUT_DIR, "parl_2016_pr.csv"), "candidates")
write_canonical_csv(smd_rows, file.path(OUT_DIR, "parl_2016_smd.csv"), "candidates")
write_canonical_csv(elected_rows, file.path(OUT_DIR, "parl_2016_elected.csv"), "candidates")

report_unresolved(resolver)

cat(if (APPLY) "\nApplied to src/data/candidates/.\n" else
  sprintf("\nDry run — files in %s. Re-run with --apply.\n", OUT_DIR))
