# src/loaders/R/common/schema.R
# Canonical schemas for cleaned election data (REFACTOR_PLAN.md §3.2–3.3).
#
# source() this file — it defines column specs and validators and writes nothing.
# Base R only (no package dependencies) so it stays portable to other projects.
#
# Levels:
#   "district"   — one row per (district, party[, round]) result
#   "precinct"   — one row per (precinct, party[, round]) result
#   "seats"      — council seat allocation per selfgov unit
#   "candidates" — canonical candidate roster (see src/data/candidates/README.md)
#
# Convention: superset columns, ALWAYS present, in this exact order; empty ("")
# where not applicable. The "national" pseudo-row (district_id == "national")
# carries countrywide totals in district-level files.

RESULTS_DISTRICT_COLS <- c(
  "district_id", "party_id", "party_num", "name_ka", "round",
  "votes", "vote_share", "registered", "voted", "voted_noon", "voted_5pm",
  "main_list", "special_list", "invalid_ballots",
  "turnout_pct", "noon_pct", "five_pct", "invalid_pct"
)

# precinct_key ("smd.dd.pp") is load-bearing: election-map.js matches by-election
# precinct rows to geojson features through it (exact-key mode). Empty for
# ordinary elections where precinct_id alone identifies the feature.
RESULTS_PRECINCT_COLS <- c(
  "precinct_id", "precinct_key", "district_id", "selfgov_id", "precinct_number",
  "party_id", "party_num", "name_ka", "round",
  "votes", "vote_share", "registered", "voted", "voted_noon", "voted_5pm",
  "invalid_ballots", "turnout_pct", "noon_pct", "five_pct", "invalid_pct"
)

SEATS_COLS <- c("selfgov_id", "party_id", "seats_pr", "seats_smd", "seats_mayor")

# Mirrors src/data/candidates/README.md (the 16-column canonical roster).
CANDIDATE_COLS <- c(
  "election_id", "sub_id", "vote_type", "party_id", "party_label_ka", "party_code",
  "district_id", "district_name_ka", "list_order", "ballot_number",
  "first_name", "last_name", "name_ka", "partisanship", "elected", "source"
)

#' Classify a results-directory CSV by filename.
#' @param filename path or basename of a CSV under src/data/results/
#' @return "seats", "precinct", or "district"
classify_results_file <- function(filename) {
  base <- tolower(basename(filename))
  if (grepl("_seats\\.csv$", base)) return("seats")
  if (grepl("_precincts?\\.csv$", base)) return("precinct")
  "district"
}

#' Column spec for a schema level.
#' @param level one of "district", "precinct", "seats", "candidates"
#' @return character vector of column names in canonical order
schema_for_level <- function(level) {
  switch(level,
    district   = RESULTS_DISTRICT_COLS,
    precinct   = RESULTS_PRECINCT_COLS,
    seats      = SEATS_COLS,
    candidates = CANDIDATE_COLS,
    stop("Unknown schema level: ", level)
  )
}

#' Validate a header against a level's schema.
#' @param x data.frame or character vector of column names
#' @param level schema level (see schema_for_level)
#' @return list(level, header, missing, extra, order_ok, exact, ok)
#'   - missing/extra: columns absent from / not in the spec
#'   - order_ok: the spec columns that ARE present appear in spec order
#'   - exact: header is identical to the spec (the end goal)
#'   - ok: no missing columns and order_ok (extra columns tolerated, reported)
validate_header <- function(x, level) {
  header <- if (is.data.frame(x)) names(x) else as.character(x)
  spec <- schema_for_level(level)
  missing <- setdiff(spec, header)
  extra <- setdiff(header, spec)
  present_in_file_order <- header[header %in% spec]
  present_in_spec_order <- spec[spec %in% header]
  order_ok <- identical(present_in_file_order, present_in_spec_order)
  exact <- identical(header, spec)
  list(
    level = level, header = header,
    missing = missing, extra = extra,
    order_ok = order_ok, exact = exact,
    ok = length(missing) == 0 && order_ok
  )
}

#' Validate a cleaned results data.frame before writing (header + basic values).
#' Stops with a message listing every violation; invisible(TRUE) when clean.
#' @param df data.frame about to be written
#' @param level "district", "precinct", or "seats"
validate_results <- function(df, level) {
  problems <- character(0)
  h <- validate_header(df, level)
  if (length(h$missing)) problems <- c(problems, paste("missing columns:", paste(h$missing, collapse = ", ")))
  if (length(h$extra))   problems <- c(problems, paste("extra columns:", paste(h$extra, collapse = ", ")))
  if (!h$order_ok)       problems <- c(problems, "column order differs from canonical spec")

  if (nrow(df) > 0 && level %in% c("district", "precinct")) {
    key <- if (level == "district") "district_id" else "precinct_id"
    if (key %in% names(df) && any(is.na(df[[key]]) | df[[key]] == "")) {
      problems <- c(problems, paste0("empty ", key, " in ", sum(is.na(df[[key]]) | df[[key]] == ""), " row(s)"))
    }
    if ("votes" %in% names(df)) {
      v <- suppressWarnings(as.numeric(df$votes))
      if (any(!is.na(v) & v < 0)) problems <- c(problems, "negative votes")
    }
    if ("vote_share" %in% names(df)) {
      s <- suppressWarnings(as.numeric(df$vote_share))
      if (any(!is.na(s) & (s < 0 | s > 1))) problems <- c(problems, "vote_share outside [0, 1] (shares are fractions, not percents)")
    }
  }

  if (length(problems)) {
    stop("validate_results(", level, ") failed:\n  - ", paste(problems, collapse = "\n  - "), call. = FALSE)
  }
  invisible(TRUE)
}

#' Validate a canonical candidate roster data.frame (header + key fields).
#' @param df data.frame about to be written
validate_candidates <- function(df) {
  problems <- character(0)
  h <- validate_header(df, "candidates")
  if (length(h$missing)) problems <- c(problems, paste("missing columns:", paste(h$missing, collapse = ", ")))
  if (length(h$extra))   problems <- c(problems, paste("extra columns:", paste(h$extra, collapse = ", ")))
  if (!h$exact && h$ok)  problems <- c(problems, "column order differs from canonical spec")
  if (nrow(df) > 0) {
    for (col in c("election_id", "vote_type")) {
      if (any(is.na(df[[col]]) | df[[col]] == "")) problems <- c(problems, paste0("empty ", col))
    }
    bad_vt <- setdiff(unique(df$vote_type),
                      c("pr", "smd", "council_smd", "mayor", "gamgebeli", "presidential"))
    if (length(bad_vt)) problems <- c(problems, paste("unknown vote_type:", paste(bad_vt, collapse = ", ")))
  }
  if (length(problems)) {
    stop("validate_candidates() failed:\n  - ", paste(problems, collapse = "\n  - "), call. = FALSE)
  }
  invisible(TRUE)
}
