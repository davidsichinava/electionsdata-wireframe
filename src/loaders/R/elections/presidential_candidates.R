#!/usr/bin/env Rscript
# src/loaders/R/elections/presidential_candidates.R
# Ingest src/data/raw/presidential_candidates.xlsx (sheet "Candidates") into
# canonical CSVs — one raw workbook covers four presidential elections:
#
#   src/data/candidates/pres_2008_presidential.csv
#   src/data/candidates/pres_2013_presidential.csv
#   src/data/candidates/pres_2018_presidential.csv        (R1)
#   src/data/candidates/pres_2018_r2_presidential.csv     (R2 runoff sub-election)
#   src/data/candidates/pres_2024_indirect_presidential.csv
#
# The party_id column resolves to the CANDIDATE id (per-person id) used by the
# election YAMLs in src/data/config/elections/presidential/, so candidate cards
# on the parties page keep working. The id is inferred from:
#   1. The existing CSV (pres_2008 / pres_2013 — preserves historical ids;
#      note this loader therefore reads its own previous output)
#   2. The YAML's candidates: block (pres_2018, pres_2024_indirect)
#   3. Fallback: the normalized (Georgian) last name
#
# R port of scripts/ingest-presidential.js — parity-verified byte-identical
# before the node script was retired.
#
# Usage (from repo root):
#   Rscript src/loaders/R/elections/presidential_candidates.R           (dry-run → _pres_ingest/)
#   Rscript src/loaders/R/elections/presidential_candidates.R --apply   (writes to src/data/candidates/)

source("src/loaders/R/common/schema.R")
source("src/loaders/R/common/io.R")
source("src/loaders/R/common/candidates.R")

APPLY <- "--apply" %in% commandArgs(trailingOnly = TRUE)
CAND_DIR <- "src/data/candidates"
OUT_DIR <- if (APPLY) CAND_DIR else file.path(CAND_DIR, "_pres_ingest")

RAW_XLSX <- "src/data/raw/presidential_candidates.xlsx"
SOURCE <- basename(RAW_XLSX)
PRES_DIR <- "src/data/config/elections/presidential"

# ── (normalized name → id) maps ─────────────────────────────────────────────

#' Existing-CSV map: preserves historical candidate ids across re-ingests.
existing_id_map <- function(filename) {
  full <- file.path(CAND_DIR, filename)
  if (!file.exists(full)) return(list())
  df <- read_canonical_csv(full)
  m <- as.list(df$party_id)
  names(m) <- norm_name(df$name_ka)
  # JS Map.set semantics: on duplicate names the LAST occurrence wins.
  m[!duplicated(names(m), fromLast = TRUE)]
}

#' YAML candidates: block map (name.ka → id).
yaml_id_map <- function(election_file) {
  doc <- yaml::read_yaml(file.path(PRES_DIR, election_file))
  m <- list()
  for (c in if (is.null(doc$candidates)) list() else doc$candidates) {
    if (!is.null(c$name$ka) && !is.null(c$id)) m[[norm_name(c$name$ka)]] <- c$id
  }
  m
}

id_maps <- list(
  pres_2008 = existing_id_map("pres_2008_presidential.csv"),
  pres_2013 = existing_id_map("pres_2013_presidential.csv"),
  pres_2018 = yaml_id_map("pres_2018.yml"),
  pres_2024_indirect = yaml_id_map("pres_2024_indirect.yml")
)

unmatched <- list()  # election_id → character vector of names
resolve_candidate_id <- function(election_id, full_name, last_name) {
  id <- id_maps[[election_id]][[norm_name(full_name)]]
  if (!is.null(id) && nzchar(id)) return(id)
  if (!full_name %in% unmatched[[election_id]]) {
    unmatched[[election_id]] <<- c(unmatched[[election_id]], full_name)
  }
  norm_name(last_name)  # slug fallback: normalized Georgian last name (stable)
}

# ── "elections" column → output bucket ──────────────────────────────────────

ELECTION_MAP <- list(
  "presidential 2008"    = list(election_id = "pres_2008", sub_id = "__main__",
                                filename = "pres_2008_presidential.csv"),
  "presidential 2013"    = list(election_id = "pres_2013", sub_id = "__main__",
                                filename = "pres_2013_presidential.csv"),
  "presidential 2018_r1" = list(election_id = "pres_2018", sub_id = "__main__",
                                filename = "pres_2018_presidential.csv"),
  "presidential 2018_r2" = list(election_id = "pres_2018", sub_id = "pres_2018_r2",
                                filename = "pres_2018_r2_presidential.csv"),
  "presidential 2024"    = list(election_id = "pres_2024_indirect", sub_id = "__main__",
                                filename = "pres_2024_indirect_presidential.csv")
)

# ── Build canonical rows ────────────────────────────────────────────────────

rows <- read_xlsx_sheet(RAW_XLSX, "Candidates")

meta_of <- lapply(trimws(rows$elections), function(label) {
  m <- ELECTION_MAP[[label]]
  if (is.null(m)) stop("Unknown election label: ", label, call. = FALSE)
  m
})

nm <- split_name(rows$name)
party_id <- mapply(
  function(label, full, last) resolve_candidate_id(ELECTION_MAP[[trimws(label)]]$election_id, full, last),
  rows$elections, rows$name, nm$last,
  USE.NAMES = FALSE
)

canonical <- data.frame(
  election_id = vapply(meta_of, `[[`, character(1), "election_id"),
  sub_id = vapply(meta_of, `[[`, character(1), "sub_id"),
  vote_type = "presidential",
  party_id = party_id,
  party_label_ka = rows$party,
  party_code = rows$code,
  district_id = "",
  district_name_ka = "",
  list_order = "",
  ballot_number = rows$code,
  first_name = nm$first,
  last_name = nm$last,
  name_ka = rows$name,
  partisanship = "",
  elected = elected_flag(rows$elected),
  source = SOURCE,
  stringsAsFactors = FALSE, check.names = FALSE
)

# Write buckets in first-encounter order (matches the node ingest's output order).
filenames <- vapply(meta_of, `[[`, character(1), "filename")
for (fn in unique(filenames)) {
  write_canonical_csv(canonical[filenames == fn, , drop = FALSE],
                      file.path(OUT_DIR, fn), "candidates")
}

if (length(unmatched)) {
  cat("\nCandidates without an existing id (will use slugified last-name as id):\n")
  for (eid in names(unmatched)) {
    cat(sprintf("  %s:\n", eid))
    for (n in unmatched[[eid]]) cat(sprintf("    %s\n", n))
  }
} else {
  cat("\nAll candidates matched against existing ids or YAML candidate registries.\n")
}

cat(if (APPLY) "\nApplied to src/data/candidates/.\n" else
  sprintf("\nDry run — files in %s. Re-run with --apply.\n", OUT_DIR))
