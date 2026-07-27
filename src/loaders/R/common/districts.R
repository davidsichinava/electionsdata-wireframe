# src/loaders/R/common/districts.R
# District / selfgov ID encoders — the ONE place these rules live (REFACTOR_PLAN §3.4).
# Base R only.
#
# Encoding primer (hard-won; see memory notes and the 2014/2017 fixes):
#   - Council (sakrebulo) majoritarian district ids in the geojson are
#       maj_id = self_gov_id * 100 + seat_within_selfgov
#     e.g. Tbilisi (selfgov 1) seat 7 → 107; Telavi rural (17) seat 2 → 1702;
#     Telavi town (171) seat 2 → 17102.
#   - Tbilisi is selfgov 1. Raw sources sometimes encode its raions (1–10) as
#     separate "districts" — those all belong to selfgov 1.
#   - 2014-reform carved-out towns get their own 3-digit selfgov ids
#     (Telavi 171, Mtskheta 271, Gori 321, Akhaltsikhe 371, Ambrolauri 441,
#     Ozurgeti 601, Zugdidi 671). NEVER auto-map a rural id to its town
#     (17 → 171): when the source has an explicit selfgov_id column, trust it —
#     auto-mapping stole rural seats 1–5 in the 2014 data.
#   - Some raw files write majoritarian codes as dotted strings ("01.01").

#' Compose a canonical council-majoritarian district id.
#' @param selfgov_id self-governing unit id (Tbilisi = 1; towns = 3-digit)
#' @param seat seat number within the selfgov (1-based)
#' @return integer maj_id = selfgov_id * 100 + seat
council_maj_id <- function(selfgov_id, seat) {
  as.integer(selfgov_id) * 100L + as.integer(seat)
}

#' Recompose a canonical maj_id from a raw source maj_id whose "hundreds" part
#' is unreliable, keeping only its seat (last two digits).
#' @param selfgov_id trusted selfgov id (e.g. an explicit XLSX column)
#' @param raw_maj_id source maj_id of any width (101, 1701, 17101, …)
#' @return integer selfgov_id * 100 + (raw_maj_id %% 100)
council_maj_id_from_raw <- function(selfgov_id, raw_maj_id) {
  as.integer(selfgov_id) * 100L + as.integer(raw_maj_id) %% 100L
}

#' Parent selfgov id of a council-majoritarian district id.
#' Three encodings coexist in the results CSVs:
#'   3–4 digits  selfgov*100 + seat                  1702   → 17
#'   5 digits    town-selfgov(3-digit)*100 + seat    17102  → 171  (2014 towns)
#'   6 digits    selfgov*10000 + district*100 + seat 110701 → 11   (2017 vintage)
#' So divide by 10000 only for 6-digit ids, else by 100. Tbilisi raion codes
#' (1–10) and the legacy 99 prefix collapse to selfgov 1.
#' Mirrors councilSelfgovIdFromMajorId() in src/components/election-utils.js —
#' both are pinned by districts_fixtures.csv (run scripts/test-districts.js
#' and scripts/test-districts.R after touching either).
#' @param maj_id district id (integer-like)
#' @return integer selfgov id
selfgov_from_maj_id <- function(maj_id) {
  n <- as.integer(maj_id)
  s <- ifelse(n >= 100000L, n %/% 10000L, n %/% 100L)
  ifelse(s == 99L | (s >= 1L & s <= 10L), 1L, s)
}

#' Selfgov id of a RAW electoral/exec district number (already selfgov-scale:
#' PR electoral districts, mayor/gamgebeli districts): Tbilisi raions 1–10
#' collapse to selfgov 1, everything else is identity. Mirrors
#' selfgovIdFromRawDistrictId() in election-utils.js (same fixtures).
#' @param district_id raw district number (integer-like)
#' @return integer selfgov id
selfgov_from_raw_district_id <- function(district_id) {
  n <- as.integer(district_id)
  ifelse(n >= 1L & n <= 10L, 1L, n)
}

#' Parse a dotted majoritarian code into a canonical maj_id.
#' Dots are removed and the digits read as one integer, which matches the
#' selfgov*100+seat encoding because the seat part is zero-padded to 2 digits:
#' "01.01" → 101 (selfgov 1, seat 1); "60.04" → 6004 (selfgov 60, seat 4).
#' NOTE: does NOT collapse Tbilisi raion prefixes — for 2021/2025-style codes
#' where the first component is a raion (1–10), use council_maj_id_from_dotted().
#' @param code character vector of codes like "01.01"
#' @return integer vector
parse_dotted_code <- function(code) {
  as.integer(gsub("\\.", "", as.character(code)))
}

#' Canonical council maj_id from a dotted "district.seat" code where the first
#' component may be a Tbilisi RAION (Mtatsminda 1 … Gldani 10). The council
#' shapes key all of Tbilisi as selfgov 1 with city-wide seat numbers, so the
#' raion part collapses to 1: "02.02" (Vake seat 2) → 102, "01.01" → 101,
#' "63.01" → 6301. Codes without a dot are read as already-canonical ids.
#' @param code character vector like "02.02"
#' @return integer vector
council_maj_id_from_dotted <- function(code) {
  t <- trimws(as.character(code))
  sg <- suppressWarnings(as.integer(sub("\\..*$", "", t)))
  seat <- suppressWarnings(as.integer(sub("^.*\\.", "", t)))
  ifelse(grepl("\\.", t),
         council_maj_id(selfgov_from_raw_district_id(sg), seat),
         suppressWarnings(as.integer(t)))
}
