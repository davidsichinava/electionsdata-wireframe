#!/usr/bin/env Rscript
# src/loaders/R/elections/parl_2020_candidates.R
# Ingest src/data/raw/party_lists_2020_georgia_unified.xlsx into canonical CSVs:
#
#   src/data/candidates/parl_2020_pr.csv        (sheet "PR lists")
#   src/data/candidates/parl_2020_smd.csv       (sheet "Majoritarians")
#   src/data/candidates/parl_2020_elected.csv   (sheet "Elected")
#
# R port of scripts/ingest-parl2020.js — parity-verified byte-identical before
# the node script was retired. Note: SMD/elected use a PREFIX-ONLY initiative
# check ("საინიციატივო ჯგუფი…"), narrower than is_initiative_label(); kept
# as-is for parity.
#
# Usage (from repo root):
#   Rscript src/loaders/R/elections/parl_2020_candidates.R           (dry-run → _parl_2020_ingest/)
#   Rscript src/loaders/R/elections/parl_2020_candidates.R --apply   (writes to src/data/candidates/)

source("src/loaders/R/common/schema.R")
source("src/loaders/R/common/io.R")
source("src/loaders/R/common/parties.R")
source("src/loaders/R/common/candidates.R")

APPLY <- "--apply" %in% commandArgs(trailingOnly = TRUE)
OUT_DIR <- if (APPLY) "src/data/candidates" else "src/data/candidates/_parl_2020_ingest"

RAW_XLSX <- "src/data/raw/party_lists_2020_georgia_unified.xlsx"
SOURCE <- basename(RAW_XLSX)
ELECTION_YML <- "src/data/config/elections/parliamentary/parl_2020.yml"

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
  election_id = "parl_2020",
  sub_id = "__main__",
  vote_type = "pr",
  party_id = resolve_or_blank(pr[["Party Name"]]),
  party_label_ka = pr[["Party Name"]],
  party_code = pr[["Party Number"]],
  district_id = "",
  district_name_ka = "",
  list_order = pr[["Order ID"]],
  ballot_number = "",
  first_name = pr[["Name"]],
  last_name = pr[["Last Name"]],
  name_ka = join_name(pr[["Name"]], pr[["Last Name"]]),
  partisanship = col_or_blank(pr, "Partisanship"),
  elected = "",
  source = SOURCE,
  stringsAsFactors = FALSE, check.names = FALSE
)

# ─── SMD candidates ─────────────────────────────────────────────────────────

smd <- read_xlsx_sheet(RAW_XLSX, "Majoritarians")
smd_init <- is_initiative_prefix(smd[["Endorsing party"]])
smd_rows <- data.frame(
  election_id = "parl_2020",
  sub_id = "__main__",
  vote_type = "smd",
  party_id = resolve_or_blank(smd[["Endorsing party"]], skip = smd_init),
  party_label_ka = smd[["Endorsing party"]],
  party_code = "",
  district_id = smd[["District ID"]],
  district_name_ka = "",
  list_order = "",
  ballot_number = smd[["Candidate number"]],
  first_name = smd[["Name"]],
  last_name = smd[["Last Name"]],
  name_ka = join_name(smd[["Name"]], smd[["Last Name"]]),
  partisanship = "",
  elected = "",
  source = SOURCE,
  stringsAsFactors = FALSE, check.names = FALSE
)

# ─── Elected (winners) ──────────────────────────────────────────────────────

el <- read_xlsx_sheet(RAW_XLSX, "Elected")
el_is_pr <- tolower(el$election_type) == "pr"
# PR winners carry party_name; SMD winners carry endorsing_party (fall back to
# party_name when blank).
el_label <- ifelse(el_is_pr, el$party_name,
                   ifelse(nzchar(el$endorsing_party), el$endorsing_party, el$party_name))
el_init <- is_initiative_prefix(el_label)
elected_rows <- data.frame(
  election_id = "parl_2020",
  sub_id = "__main__",
  vote_type = ifelse(el_is_pr, "pr", "smd"),
  party_id = resolve_or_blank(el_label, skip = el_init),
  party_label_ka = el_label,
  party_code = ifelse(el_is_pr, el$party_number, ""),
  district_id = ifelse(el_is_pr, "", el$majoritarian_district_id),
  district_name_ka = "",
  list_order = ifelse(el_is_pr, el$party_list_order_id, ""),
  ballot_number = ifelse(el_is_pr, "", el$candidate_number),
  first_name = el$first_name,
  last_name = el$last_name,
  name_ka = join_name(el$first_name, el$last_name),
  partisanship = col_or_blank(el, "partisanship"),
  elected = "TRUE",
  source = SOURCE,
  stringsAsFactors = FALSE, check.names = FALSE
)

# ─── Write ──────────────────────────────────────────────────────────────────

write_canonical_csv(pr_rows, file.path(OUT_DIR, "parl_2020_pr.csv"), "candidates")
write_canonical_csv(smd_rows, file.path(OUT_DIR, "parl_2020_smd.csv"), "candidates")
write_canonical_csv(elected_rows, file.path(OUT_DIR, "parl_2020_elected.csv"), "candidates")

report_unresolved(resolver)

cat(if (APPLY) "\nApplied to src/data/candidates/.\n" else
  sprintf("\nDry run — files in %s. Re-run with --apply.\n", OUT_DIR))
