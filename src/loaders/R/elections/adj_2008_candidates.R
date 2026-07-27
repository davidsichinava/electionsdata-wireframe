#!/usr/bin/env Rscript
# src/loaders/R/elections/adj_2008_candidates.R
# Ingest the "elected" sheet of src/data/raw/adjara_2008_results.xlsx into
#
#   src/data/candidates/adj_2008_elected.csv
#
# The PR and SMD candidate rosters for adj_2008 already exist (sourced from
# adjara_2008_candidates.xlsx earlier); this loader only adds the winners.
# R port of scripts/ingest-adj2008.js — parity-verified byte-identical before
# the node script was retired.
#
# Usage (from repo root):
#   Rscript src/loaders/R/elections/adj_2008_candidates.R           (dry-run → _adj_2008_ingest/)
#   Rscript src/loaders/R/elections/adj_2008_candidates.R --apply   (writes to src/data/candidates/)

source("src/loaders/R/common/schema.R")
source("src/loaders/R/common/io.R")
source("src/loaders/R/common/parties.R")

APPLY <- "--apply" %in% commandArgs(trailingOnly = TRUE)
OUT_DIR <- if (APPLY) "src/data/candidates" else "src/data/candidates/_adj_2008_ingest"

RAW_XLSX <- "src/data/raw/adjara_2008_results.xlsx"
SOURCE <- basename(RAW_XLSX)
ELECTION_YML <- "src/data/config/elections/adjara/adj_2008.yml"

resolver <- make_party_resolver(ELECTION_YML)

el <- read_xlsx_sheet(RAW_XLSX, "elected")

# system == "pr" → pr; anything else (SMD variants, blanks) → smd.
vote_type <- ifelse(tolower(el$system) == "pr", "pr", "smd")
is_smd <- vote_type == "smd"

elected_rows <- data.frame(
  election_id = "adj_2008",
  sub_id = "__main__",
  vote_type = vote_type,
  party_id = vapply(el$party, resolver$resolve, character(1), USE.NAMES = FALSE),
  party_label_ka = el$party,
  party_code = "",
  district_id = ifelse(is_smd, el$district_code, ""),
  district_name_ka = ifelse(is_smd, el$district_name, ""),
  list_order = "",
  ballot_number = "",
  first_name = el$first_name,
  last_name = el$last_name,
  name_ka = trimws(paste(el$first_name, el$last_name)),
  partisanship = "",
  elected = "TRUE",
  source = SOURCE,
  stringsAsFactors = FALSE, check.names = FALSE
)

write_canonical_csv(elected_rows, file.path(OUT_DIR, "adj_2008_elected.csv"), "candidates")

report_unresolved(resolver)

cat(if (APPLY) "\nApplied to src/data/candidates/.\n" else
  sprintf("\nDry run — files in %s. Re-run with --apply.\n", OUT_DIR))
