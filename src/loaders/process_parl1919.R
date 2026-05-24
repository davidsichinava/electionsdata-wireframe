#!/usr/bin/env Rscript
# src/loaders/process_parl1919.R
#
# Processes the 1919 Georgian Constituent Assembly election.
# Run from project root: Rscript src/loaders/process_parl1919.R
#
# Input:
#   src/data/raw/დამფუძნებელი კრება, 1919.xlsx  (sheet: "source")
#
# Output:
#   src/data/results/parl1919_pr.csv
#     district_id, party_id, votes, vote_share, registered, voted, invalid_ballots

suppressPackageStartupMessages({
  library(readxl)
  library(readr)
  library(dplyr)
  library(tidyr)
})

# Force fixed (non-scientific) notation; readr::write_csv otherwise emits
# small values like 0.000865 as "8.65e-4", which parses identically but
# churns needless git diffs against the existing Python-generated CSVs.
options(scipen = 100)

RAW_FILE <- "src/data/raw/დამფუძნებელი კრება, 1919.xlsx"
OUT_FILE <- "src/data/results/parl1919_pr.csv"

# ── Georgian party name → canonical party_id ────────────────────────────────
PARTY_MAP <- c(
  "საქართველოს სოციალ-დემოკრატიული მუშათა პარტია"                  = "social_democrats_1919",
  "საქართველოს ეროვნულ-დემოკრატიული პარტია"                         = "national_democrats_1919",
  "საქართველოს სოციალისტ-რევოლუციონერთა პარტია"                     = "sr_1919",
  "„დაშნაკცუთიუნ“"                                                   = "dashnaks",
  "საქართველოს სოციალისტ-ფედერალისტთა პარტია"                        = "federalists_1919",
  "მუსლიმთა ეროვნული საბჭო"                                          = "muslim_1919",
  "საქართველოს რადიკალ-დემოკრატთა პარტია"                            = "raddem_1919",
  "საქართველოს ეროვნული პარტია"                                      = "natparty_1919",
  "მემარცხენე სოციალისტ-ფედერალისტთა მაშვრალთა პარტია"                = "left_federalists_1919",
  "შოთა რუსთაველის ჯგუფი"                                             = "rustaveli_1919",
  "დამოუკიდებელთა (უპარტიო) კავშირი"                                  = "indie_1919",
  "ბორჩალოს მაზრის მცხოვრებ მუსულმანთა ჯგუფი"                         = "borchalo_1919",
  "რუსეთის სოციალ-დემოკრატთა მუშათა პარტია"                           = "sdwpr_1919",
  "ესთეტიური ლიგა პატრიოტებისა"                                       = "aesth_1919",
  "საქართველოს ელინთა დემოკრატიული ჯგუფი"                             = "hellenic_1919",
  "აფხაზეთის ნაციონალური პარტია"                                      = "abkh_1919"
)

# ── Read ────────────────────────────────────────────────────────────────────
df <- read_excel(RAW_FILE, sheet = "source")
message(sprintf("Loaded %d rows from Excel", nrow(df)))

# ── XLSX (Settype, name_ka) → geojson `id` lookup ───────────────────────────
# The XLSX's `OID` column is a row index that does NOT correspond to the
# polygon `id` in src/data/shp/parl1919_pr.geojson. Each (Settype, name_ka)
# row in the source maps to exactly one polygon there; we hard-code that
# mapping rather than do name-matching at runtime so the join is auditable.
# Two name forms exist per location: an "Urban" point (the city proper) and
# a "Mazra" polygon (the county). Tbilisi appears in the geojson under the
# historic Russian-Imperial spelling "ტფილისი"; the XLSX uses modern "თბილისი".
DISTRICT_MAP <- tibble::tribble(
  ~settype, ~name_ka,            ~district_id,
  # Mazras (counties / okrugs)
  "Mazra",  "ახალციხე",            6,
  "Mazra",  "ახალქალაქი",          4,
  "Mazra",  "ბორჩალო",             7,
  "Mazra",  "თბილისი",            15,
  "Mazra",  "გორი",                9,
  "Mazra",  "დუშეთი",             11,
  "Mazra",  "თიანეთი",            18,
  "Mazra",  "სიღნაღი",            26,
  "Mazra",  "თელავი",             17,
  "Mazra",  "ოზურგეთი",           22,
  "Mazra",  "შორაპანი",           33,
  "Mazra",  "ქუთაისი",            31,
  "Mazra",  "რაჭა",               23,
  "Mazra",  "ლეჩხუმი",            20,
  "Mazra",  "ახალსენაკი",          2,
  "Mazra",  "ზუგდიდი",            13,
  "Mazra",  "სოხუმის ოლქი",       27,
  # Urban centres
  "Urban",  "ახალციხე",            5,
  "Urban",  "დუშეთი",             10,
  "Urban",  "თბილისი",            14,
  "Urban",  "სიღნაღი",            25,
  "Urban",  "თელავი",             16,
  "Urban",  "გორი",                8,
  "Urban",  "ოზურგეთი",           21,
  "Urban",  "ახალქალაქი",          3,
  "Urban",  "ყვირილა",            32,
  "Urban",  "ჭიათურა",            34,
  "Urban",  "სამტრედია",          24,
  "Urban",  "ახალსენაკი",          1,
  "Urban",  "ხონი",               36,
  "Urban",  "ზუგდიდი",            12,
  "Urban",  "ლანჩხუთი",           19,
  "Urban",  "ფოთი",               29,
  "Urban",  "ქუთაისი",            30,
  "Urban",  "სურამი",             28,
  "Urban",  "ხაშური",             35
)

# Join the lookup; warn loudly if any source row failed to match.
df <- df |> left_join(DISTRICT_MAP, by = c("Settype" = "settype", "name_ka" = "name_ka"))
unmatched <- df |> dplyr::filter(is.na(district_id)) |> dplyr::select(OID, Settype, name_ka)
if (nrow(unmatched) > 0) {
  warning(
    "Source rows without a geojson district_id mapping:\n  ",
    paste(sprintf("OID=%s Settype=%s name_ka=%s", unmatched$OID, unmatched$Settype, unmatched$name_ka),
          collapse = "\n  ")
  )
}

party_cols <- names(PARTY_MAP)
missing    <- setdiff(party_cols, names(df))
if (length(missing) > 0) {
  warning("Missing party columns:\n  ", paste(missing, collapse = "\n  "))
}

# ── Transform ───────────────────────────────────────────────────────────────
# Coerce party vote columns to integer (NA → 0)
df <- df |>
  mutate(across(all_of(party_cols), ~ as.integer(replace_na(.x, 0))))

df_long <- df |>
  select(district_id, total_voters, votes, valid_votes, all_of(party_cols)) |>
  pivot_longer(
    cols      = all_of(party_cols),
    names_to  = "party_ka",
    values_to = "party_votes"
  ) |>
  mutate(
    party_id        = PARTY_MAP[party_ka],
    vote_share      = if_else(valid_votes == 0, 0, round(party_votes / valid_votes, 6)),
    invalid_ballots = as.integer(votes - valid_votes)
  ) |>
  # Capture `voted` before reusing the `votes` name for party_votes
  rename(voted = votes) |>
  transmute(
    district_id,
    party_id,
    votes       = party_votes,
    vote_share,
    registered  = total_voters,
    voted,
    invalid_ballots
  ) |>
  arrange(district_id, desc(votes))

# ── Write ───────────────────────────────────────────────────────────────────
dir.create(dirname(OUT_FILE), showWarnings = FALSE, recursive = TRUE)
# readr's serializer ignores scipen — force fixed notation by pre-converting
# double columns to character (integer-valued doubles still print as "9573").
# For fractional columns, preserve "0.0" rather than "0" for exact zeros so
# the output matches the prior pandas-generated CSV byte-for-byte.
fmt_frac <- function(x) {
  out <- as.character(x)
  out[!is.na(x) & x == 0] <- "0.0"
  out
}
df_long |>
  mutate(vote_share = fmt_frac(vote_share)) |>
  mutate(across(where(is.double), as.character)) |>
  write_csv(OUT_FILE)
message(sprintf("Wrote %d rows to %s", nrow(df_long), OUT_FILE))
