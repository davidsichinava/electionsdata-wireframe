#!/usr/bin/env Rscript
# src/loaders/R/elections/adj_2024_candidates.R
# Ingest src/data/raw/adjara_2024_party_lists_unified.xlsx into canonical CSVs:
#
#   src/data/candidates/adj_2024_pr.csv       (sheet "candidates")
#   src/data/candidates/adj_2024_elected.csv  (sheet "elected members")
#
# adj_2024 is PR-only (no SMD). R port of scripts/ingest-adj2024.js —
# parity-verified byte-identical against the node output before the node
# script was retired.
#
# Usage (from repo root):
#   Rscript src/loaders/R/elections/adj_2024_candidates.R           (dry-run → _adj_2024_ingest/)
#   Rscript src/loaders/R/elections/adj_2024_candidates.R --apply   (writes to src/data/candidates/)

source("src/loaders/R/common/schema.R")
source("src/loaders/R/common/io.R")
source("src/loaders/R/common/parties.R")
source("src/loaders/R/common/candidates.R")

APPLY <- "--apply" %in% commandArgs(trailingOnly = TRUE)
OUT_DIR <- if (APPLY) "src/data/candidates" else "src/data/candidates/_adj_2024_ingest"

RAW_XLSX <- "src/data/raw/adjara_2024_party_lists_unified.xlsx"
SOURCE <- basename(RAW_XLSX)
ELECTION_YML <- "src/data/config/elections/adjara/adj_2024.yml"

resolver <- make_party_resolver(ELECTION_YML)

#' full_name when present, else "first last" (skipping empty parts).
name_ka_of <- function(df) {
  full <- col_or_blank(df, "full_name")
  fallback <- join_name(col_or_blank(df, "first_name"), col_or_blank(df, "last_name"))
  ifelse(nzchar(full), full, fallback)
}

#' Map one sheet to canonical candidate rows (adj_2024 is PR-only).
#' @param df sheet data.frame from read_xlsx_sheet()
#' @param elected "" for the roster, "TRUE" for elected members
canonical_rows <- function(df, elected) {
  data.frame(
    election_id = "adj_2024",
    sub_id = "__main__",
    vote_type = "pr",
    party_id = vapply(df$party_name, resolver$resolve, character(1), USE.NAMES = FALSE),
    party_label_ka = df$party_name,
    party_code = col_or_blank(df, "party_number"),
    district_id = "",
    district_name_ka = "",
    list_order = col_or_blank(df, "list_order_id"),
    ballot_number = "",
    first_name = col_or_blank(df, "first_name"),
    last_name = col_or_blank(df, "last_name"),
    name_ka = name_ka_of(df),
    partisanship = "",
    elected = elected,
    source = SOURCE,
    stringsAsFactors = FALSE, check.names = FALSE
  )
}

pr_rows <- canonical_rows(read_xlsx_sheet(RAW_XLSX, "candidates"), elected = "")
elected_rows <- canonical_rows(read_xlsx_sheet(RAW_XLSX, "elected members"), elected = "TRUE")

write_canonical_csv(pr_rows, file.path(OUT_DIR, "adj_2024_pr.csv"), "candidates")
write_canonical_csv(elected_rows, file.path(OUT_DIR, "adj_2024_elected.csv"), "candidates")

report_unresolved(resolver)

cat(if (APPLY) "\nApplied to src/data/candidates/.\n" else
  sprintf("\nDry run — files in %s. Re-run with --apply.\n", OUT_DIR))
