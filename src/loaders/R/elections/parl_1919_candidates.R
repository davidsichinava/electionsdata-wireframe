#!/usr/bin/env Rscript
# src/loaders/R/elections/parl_1919_candidates.R
# Ingest "src/data/raw/დამფუძნებელი კრება, 1919.xlsx" (sheet "candidates":
# party | order | name | elected) into
#
#   src/data/candidates/parl_1919_pr.csv
#
# "name" is a single Georgian string in historic order: first token is the
# surname, the rest (given name + patronymic, often multi-token) becomes the
# first name. "elected" is yes/no — Assembly membership shifted through the
# term (replacements, additions), so the elected sum won't match the seat
# count exactly; we just trust the column.
# R port of scripts/ingest-parl1919.js — parity-verified byte-identical before
# the node script was retired.
#
# Usage (from repo root):
#   Rscript src/loaders/R/elections/parl_1919_candidates.R           (dry-run → _parl_1919_ingest/)
#   Rscript src/loaders/R/elections/parl_1919_candidates.R --apply   (writes to src/data/candidates/)

source("src/loaders/R/common/schema.R")
source("src/loaders/R/common/io.R")
source("src/loaders/R/common/parties.R")
source("src/loaders/R/common/candidates.R")

APPLY <- "--apply" %in% commandArgs(trailingOnly = TRUE)
OUT_DIR <- if (APPLY) "src/data/candidates" else "src/data/candidates/_parl_1919_ingest"

RAW_XLSX <- "src/data/raw/დამფუძნებელი კრება, 1919.xlsx"
SOURCE <- basename(RAW_XLSX)
ELECTION_YML <- "src/data/config/elections/parliamentary/parl_1919.yml"

resolver <- make_party_resolver(ELECTION_YML)

cand <- read_xlsx_sheet(RAW_XLSX, "candidates")
nm <- split_historic_name(cand$name)

pr_rows <- data.frame(
  election_id = "parl_1919",
  sub_id = "__main__",
  vote_type = "pr",
  party_id = vapply(cand$party, resolver$resolve, character(1), USE.NAMES = FALSE),
  party_label_ka = cand$party,
  party_code = "",
  district_id = "",
  district_name_ka = "",
  list_order = cand$order,
  ballot_number = "",
  first_name = nm$first,
  last_name = nm$last,
  name_ka = cand$name,
  partisanship = "",
  elected = elected_flag(cand$elected),
  source = SOURCE,
  stringsAsFactors = FALSE, check.names = FALSE
)

write_canonical_csv(pr_rows, file.path(OUT_DIR, "parl_1919_pr.csv"), "candidates")

report_unresolved(resolver)

cat(if (APPLY) "\nApplied to src/data/candidates/.\n" else
  sprintf("\nDry run — files in %s. Re-run with --apply.\n", OUT_DIR))
