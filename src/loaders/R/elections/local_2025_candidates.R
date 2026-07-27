#!/usr/bin/env Rscript
# src/loaders/R/elections/local_2025_candidates.R
# Ingest src/data/raw/adg_2025_candidates_unified.xlsx into canonical CSVs:
#
#   src/data/candidates/local_2025_pr.csv          (sheet "party lists")
#   src/data/candidates/local_2025_council_smd.csv (sheet "majoritarian candidates")
#   src/data/candidates/local_2025_mayor.csv       (sheet "mayoral candidates")
#   src/data/candidates/local_2025_elected.csv     (sheet "elected")
#
# R port of scripts/ingest-local2025.js — parity-verified byte-identical before
# the node script was retired, THEN (REFACTOR_PLAN B5, 2026-07-04) council_smd
# district ids were normalized: the XLSX writes dotted codes ("01.01") while
# the council shape (majoritarian_2025_major_id.geojson) keys districts as
# major_id = selfgov*100 + seat, so dotted codes are parsed to canonical ints
# (01.01 → 101). Without this every 2025 council candidate failed the geo join.
#
# Usage (from repo root):
#   Rscript src/loaders/R/elections/local_2025_candidates.R           (dry-run → _local_2025_ingest/)
#   Rscript src/loaders/R/elections/local_2025_candidates.R --apply   (writes to src/data/candidates/)

source("src/loaders/R/common/schema.R")
source("src/loaders/R/common/io.R")
source("src/loaders/R/common/parties.R")
source("src/loaders/R/common/candidates.R")
source("src/loaders/R/common/districts.R")

APPLY <- "--apply" %in% commandArgs(trailingOnly = TRUE)
OUT_DIR <- if (APPLY) "src/data/candidates" else "src/data/candidates/_local_2025_ingest"

RAW_XLSX <- "src/data/raw/adg_2025_candidates_unified.xlsx"
SOURCE <- basename(RAW_XLSX)
ELECTION_YML <- "src/data/config/elections/local/local_2025.yml"

resolver <- make_party_resolver(ELECTION_YML)

#' party_id: "" for initiative groups / independents, else fuzzy-resolved.
party_id_of <- function(labels) {
  vapply(labels, function(l) {
    if (is_initiative_label(l)) "" else resolver$resolve(l)
  }, character(1), USE.NAMES = FALSE)
}

mayor <- read_xlsx_sheet(RAW_XLSX, "mayoral candidates")
smd <- read_xlsx_sheet(RAW_XLSX, "majoritarian candidates")
pr <- read_xlsx_sheet(RAW_XLSX, "party lists")
el <- read_xlsx_sheet(RAW_XLSX, "elected")

# selfgov_id ← local_governing_unit lookup from the mayor sheet, to fill
# district_id on elected mayor/PR rows that only carry the unit name.
# (JS Map.set semantics: last occurrence wins.)
sg_keys <- trimws(mayor$district_name)
sg_ok <- nzchar(sg_keys) & nzchar(mayor$district_code)
selfgov_by_name <- as.list(mayor$district_code[sg_ok])
names(selfgov_by_name) <- sg_keys[sg_ok]
selfgov_by_name <- selfgov_by_name[!duplicated(names(selfgov_by_name), fromLast = TRUE)]

# ─── PR-per-selfgov candidates ──────────────────────────────────────────────

pr_rows <- data.frame(
  election_id = "local_2025",
  sub_id = "__main__",
  vote_type = "pr",
  party_id = party_id_of(pr$party_name),
  party_label_ka = pr$party_name,
  party_code = pr$party_number,
  district_id = pr$district_code,
  district_name_ka = pr$district_name,
  list_order = pr$order_id,
  ballot_number = "",
  first_name = pr$first_name,
  last_name = pr$last_name,
  name_ka = join_name(pr$first_name, pr$last_name),
  partisanship = "",
  elected = "",
  source = SOURCE,
  stringsAsFactors = FALSE, check.names = FALSE
)

# ─── Council SMD (Sakrebulo majoritarian) candidates ────────────────────────

smd_rows <- data.frame(
  election_id = "local_2025",
  sub_id = "__main__",
  vote_type = "council_smd",
  party_id = party_id_of(smd$party_name),
  party_label_ka = smd$party_name,
  party_code = "",
  district_id = council_maj_id_from_dotted(smd$majoritarian_district_code),
  district_name_ka = smd$district_name,
  list_order = "",
  ballot_number = smd$candidate_number,
  first_name = smd$first_name,
  last_name = smd$last_name,
  name_ka = join_name(smd$first_name, smd$last_name),
  partisanship = "",
  elected = "",
  source = SOURCE,
  stringsAsFactors = FALSE, check.names = FALSE
)

# ─── Mayor candidates ───────────────────────────────────────────────────────

mayor_rows <- data.frame(
  election_id = "local_2025",
  sub_id = "__main__",
  vote_type = "mayor",
  party_id = party_id_of(mayor$party_name),
  party_label_ka = mayor$party_name,
  party_code = "",
  district_id = mayor$district_code,
  district_name_ka = mayor$district_name,
  list_order = "",
  ballot_number = mayor$candidate_number,
  first_name = mayor$first_name,
  last_name = mayor$last_name,
  name_ka = join_name(mayor$first_name, mayor$last_name),
  partisanship = "",
  elected = "",
  source = SOURCE,
  stringsAsFactors = FALSE, check.names = FALSE
)

# ─── Elected (winners) ──────────────────────────────────────────────────────
# election_type: "pr", "mayor", anything else → council_smd.
# District id: council_smd → majoritarian_district_code; pr/mayor → selfgov id
# looked up by local_governing_unit name.

et <- tolower(el$election_type)
el_vote_type <- ifelse(et == "pr", "pr", ifelse(et == "mayor", "mayor", "council_smd"))
el_maj_code <- col_or_blank(el, "majoritarian_district_code")
el_district <- vapply(seq_len(nrow(el)), function(i) {
  if (el_vote_type[[i]] == "council_smd") {
    code <- el_maj_code[[i]]
    if (!nzchar(code)) return("")
    return(as.character(council_maj_id_from_dotted(code)))
  }
  unit <- trimws(el$local_governing_unit[[i]])
  if (!nzchar(unit)) return("")
  v <- selfgov_by_name[[unit]]
  if (is.null(v)) "" else v
}, character(1))
el_full <- col_or_blank(el, "full_name")

elected_rows <- data.frame(
  election_id = "local_2025",
  sub_id = "__main__",
  vote_type = el_vote_type,
  party_id = party_id_of(el$party_name),
  party_label_ka = el$party_name,
  party_code = ifelse(el_vote_type == "pr", col_or_blank(el, "party_number"), ""),
  district_id = el_district,
  district_name_ka = col_or_blank(el, "local_governing_unit"),
  list_order = ifelse(el_vote_type == "pr", col_or_blank(el, "list_order_id"), ""),
  ballot_number = "",
  first_name = el$first_name,
  last_name = el$last_name,
  name_ka = ifelse(nzchar(el_full), el_full, join_name(el$first_name, el$last_name)),
  partisanship = "",
  elected = "TRUE",
  source = SOURCE,
  stringsAsFactors = FALSE, check.names = FALSE
)

# ─── Write ──────────────────────────────────────────────────────────────────

write_canonical_csv(pr_rows, file.path(OUT_DIR, "local_2025_pr.csv"), "candidates")
write_canonical_csv(smd_rows, file.path(OUT_DIR, "local_2025_council_smd.csv"), "candidates")
write_canonical_csv(mayor_rows, file.path(OUT_DIR, "local_2025_mayor.csv"), "candidates")
write_canonical_csv(elected_rows, file.path(OUT_DIR, "local_2025_elected.csv"), "candidates")

report_unresolved(resolver)

cat(if (APPLY) "\nApplied to src/data/candidates/.\n" else
  sprintf("\nDry run — files in %s. Re-run with --apply.\n", OUT_DIR))
