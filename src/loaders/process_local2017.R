# process_local2017.R
# Processes raw 2017 Georgian local election files into dashboard CSV/YAML files.
# Run from project root:
#   Rscript src/loaders/process_local2017.R
#
# Source files:
#   src/data/raw/2017  საკრებულო, მერი I ტური.xlsx   (Round 1 results)
#   src/data/raw/2017 მერი II ტური.xlsx               (Round 2 mayor runoffs)
#   src/data/raw/adg_2017_candidates_unified.xlsx      (Candidate lists)
#
# Column structure (2017):
#   All sheets have alternating vote / "%" column pairs for parties.
#   "%" columns are automatically skipped (don't start with a digit).
#
#   Non-majoritarian (PR / Mayor):
#     1: district_label (merged), 2: district (numeric id),
#     3: precinct_code, 4: main_list, 5: special_list,
#     6: voted_noon, 7: voted_5pm, 8: voted, 9: ballots_received,
#     10+: party cols (alternating vote / %), ..., -2: valid, -1: invalid
#
#   Majoritarian:
#     1: district_label (merged), 2: district (numeric id),
#     3: major_label, 4: major_local, 5: precinct_code,
#     6: main_list, 7: special_list, 8: voted_noon, 9: voted_5pm,
#     10: voted, 11: ballots_received,
#     12+: party cols (alternating vote / %), ..., -2: valid, -1: invalid
#
#   Mayor R1 is split across two sheets:
#     "მერი ქალაქი I ტური"  — city self-governing units
#     "მერი თემი I ტური"    — community self-governing units
#   Mayor R2 has one sheet: "მერი II ტური"
#
#   No Sakrebulo majoritarian runoffs in 2017 (mayors only).
#
# Initiative groups:
#   Candidates running under "საინიციატივო ჯგუფი" (initiative group) are mapped
#   to the `initiative_group` party_id. Their ballot numbers are detected
#   dynamically from the candidates file. Multiple initiative-group candidates
#   in the same district each get a unique YAML entry. Mayoral outputs also keep
#   party_num so candidate names can be shown while colors still aggregate under
#   `initiative_group`.

suppressPackageStartupMessages({
  library(readxl)
  library(dplyr)
  library(tidyr)
  library(stringr)
  library(yaml)
  library(jsonlite)
})

# ── Paths ──────────────────────────────────────────────────────────────────
EXCEL_R1   <- "src/data/raw/2017  საკრებულო, მერი I ტური.xlsx"
EXCEL_R2   <- "src/data/raw/2017 მერი II ტური.xlsx"
BY2018_ZUGDIDI_67_27 <- "src/data/raw/2018 შუალდეური 67.27.xlsx"
BY2019_LOCAL <- "src/data/raw/2019 შუალედური, მერის რიგგარეშე.xlsx"
BY2019_OCT_COUNCIL <- "src/data/raw/2019.27.10 საკრებულოს შუალედური.xlsx"
BY2020_LOCAL <- "src/data/raw/2020 საკრებულო, მერი.xlsx"
BY2020_MAYOR_R2 <- "src/data/raw/2020 მერი მეორე ტური.xlsx"
CANDS_PATH <- "src/data/raw/adg_2017_candidates_unified.xlsx"
PRECINCT_GEO <- "src/data/shp/local2017_precincts.geojson"
OUT_RESULTS <- "src/data/results"
OUT_CANDS   <- "src/data/config/candidates/local"
dir.create(OUT_RESULTS, showWarnings = FALSE, recursive = TRUE)
dir.create(OUT_CANDS,   showWarnings = FALSE, recursive = TRUE)

# ── Static party ballot-number → party_id map ──────────────────────────────
# Numbers come from the PR sheet column headers.
# Initiative-group ballot numbers are added dynamically below.
PARTY_MAP_STATIC <- c(
  "1"  = "burchuladze",               # მოძრ. სახელმწ. ხალხისთვის
  "2"  = "european_georgia",          # ბაქრაძე, უგულავა – ევრ. საქ.
  "3"  = "burjanadze_democratic",     # ლ.ლ., კ.კ. – დემ. მოძ.–თავ. საქ.
  "5"  = "unm",                       # ერთიანი ნაციონ. მოძ.
  "6"  = "republicans_2016",          # რესპ. პარტია
  "7"  = "mechiauri",                 # თ. მეჭიაური ერთ. საქ.
  "8"  = "patriots",                  # დ.თ-მ., ი.ი. – პატრ. ალ.
  "9"  = "left_alliance",             # მემარცხ. ალიანსი
  "10" = "labour",                    # შ.ნ. – ლეიბ. პარტ.
  "11" = "national_democrats",        # ეროვნ. დემ. მოძ.
  "14" = "unity_development",         # საქ. ერთ. განვ. პარტ.
  "15" = "workers_socialist",         # მშრ. სოც. პარტ.
  "17" = "georgia_2016",              # საქართველო
  "18" = "traditionalists",           # ტრადიციონ.
  "20" = "construction_movement_2017",
  "23" = "new_christian_democrats",   # ახ. ქრ.-დემ.
  "27" = "vashadze_2017",             # გ. ვაშაძე – ერთობა ახ. საქ.
  "28" = "zviads_way",                # ზვ. გზა-უფ. სახ.
  "31" = "freedom_gamsakhurdia",      # თავ. – ზვ. გ. გზა
  "34" = "mamuli_ena",                # მამ. ორდ. „სამშობლო"
  "37" = "communist_stalinist",       # სოც. საქ. – კომ.
  "38" = "peoples_unity_2017",
  "39" = "progressive_democratic_2017",
  "41" = "gd"                         # ქართ. ოცნება
)

# ── Dynamically extend PARTY_MAP with initiative-group ballot numbers ──────
# Reads candidate ballot numbers whose endorsing_party contains "საინიციატივო ჯგუფი".
# Any such ballot that is not already in PARTY_MAP_STATIC gets mapped to
# `initiative_group`, so their votes aggregate together in results.
cat("Building dynamic party map from candidates file...\n")

raw_mayor_candidates <- read_excel(CANDS_PATH, sheet = "mayoral candidates")
raw_major_candidates <- read_excel(CANDS_PATH, sheet = "majoritarian candidates")

.tmp_ballots <- bind_rows(
  raw_mayor_candidates %>% transmute(candidate_number, endorsing_party),
  raw_major_candidates %>% transmute(candidate_number, endorsing_party)
) %>%
  mutate(candidate_number = if_else(
    suppressWarnings(as.integer(candidate_number)) >= 100L,
    suppressWarnings(as.integer(candidate_number)) %% 100L,
    suppressWarnings(as.integer(candidate_number))
  )) %>%
  filter(str_detect(coalesce(as.character(endorsing_party), ""), "საინიციატივო ჯგუფი")) %>%
  pull(candidate_number) %>%
  unique() %>%
  na.omit() %>%
  as.character()

# Only add those not already covered by named parties
.new_ballots <- setdiff(.tmp_ballots, names(PARTY_MAP_STATIC))
cat("  Initiative-group ballot numbers:", length(.new_ballots), "\n")

PARTY_MAP <- c(
  PARTY_MAP_STATIC,
  setNames(rep("initiative_group", length(.new_ballots)), .new_ballots)
)
rm(.tmp_ballots, .new_ballots)

# ── Helpers ────────────────────────────────────────────────────────────────
to_selfgov   <- function(d) as.integer(ifelse(!is.na(d) & d >= 1L & d <= 10L, 1L, d))
to_major_id  <- function(d, major, local = 0L) {
  base <- ifelse(!is.na(d) & d >= 1L & d <= 10L, 99L, as.integer(d))
  local <- ifelse(is.na(local), 0L, as.integer(local))
  as.integer(base * 10000L + as.integer(major) * 100L + local)
}

normalise_mid <- function(mid) {
  out <- suppressWarnings(as.integer(round(as.numeric(mid))))
  out_chr <- as.character(out)
  tbilisi_short <- !is.na(out) & nchar(out_chr) == 5L & stringr::str_starts(out_chr, "99")
  out[tbilisi_short] <- as.integer(paste0("99", stringr::str_pad(stringr::str_sub(out_chr[tbilisi_short], 3L), 4L, pad = "0")))
  out
}

normalise_candidate_number <- function(x) {
  out <- suppressWarnings(as.integer(x))
  out <- if_else(!is.na(out) & out >= 100L, out %% 100L, out)
  out
}

initiative_candidate_party_id <- function(major_id, party_num) {
  paste0("initiative_", major_id, "_", party_num)
}

local2017_smd_party_id <- function(party_id, major_id, party_num) {
  if_else(
    party_id == "initiative_group" & !is.na(major_id) & !is.na(party_num),
    initiative_candidate_party_id(major_id, party_num),
    party_id
  )
}

col_or_na <- function(df, name) {
  if (name %in% names(df)) df[[name]] else NA
}

value_or_na <- function(x) {
  if (is.null(x) || length(x) == 0L) NA_real_ else suppressWarnings(as.numeric(x[[1]]))
}

read_precinct_join_lookup <- function(path) {
  geo <- jsonlite::fromJSON(path, simplifyVector = FALSE)
  props <- lapply(geo$features, `[[`, "properties")
  tibble(
    precinct_id = as.integer(round(vapply(props, function(p) value_or_na(p$id), numeric(1)))),
    precinct_number = as.integer(round(vapply(props, function(p) value_or_na(p$Precinct), numeric(1)))),
    district_id_geo = as.integer(round(vapply(props, function(p) value_or_na(p$District), numeric(1)))),
    selfgov_id_geo = as.integer(round(vapply(props, function(p) value_or_na(p$Mayor), numeric(1)))),
    MID = normalise_mid(vapply(props, function(p) value_or_na(p$MID), numeric(1)))
  ) %>%
    mutate(precinct_id = coalesce(
      precinct_id,
      as.integer(round(vapply(props, function(p) value_or_na(p$PrecID), numeric(1))))
    )) %>%
    mutate(selfgov_id_geo = if_else(selfgov_id_geo == 99L, 1L, selfgov_id_geo)) %>%
    distinct(precinct_id, .keep_all = TRUE)
}

precinct_join_lookup <- read_precinct_join_lookup(PRECINCT_GEO)

parse_precinct_id <- function(code, district = NA_integer_) {
  # Two formats exist in 2017 files:
  #   "DD.SSS"  — e.g. "29.001" (R1 sheets): district * 1000 + sequential
  #   plain int — e.g. 1, 2, 3  (R2 sheet) : use district column * 1000 + sequential
  code_str <- as.character(code)
  has_dot  <- str_detect(code_str, "\\.")
  parts    <- str_split_fixed(code_str, fixed("."), 2)
  from_dot <- as.integer(parts[, 1]) * 1000L + suppressWarnings(as.integer(parts[, 2]))
  from_int <- as.integer(district)   * 1000L + suppressWarnings(as.integer(code_str))
  dplyr::if_else(has_dot, from_dot, from_int)
}

write_csv_utf8 <- function(df, path) {
  write.csv(df, path, row.names = FALSE, fileEncoding = "UTF-8")
  cat("  Written:", path, "\n")
}

# ── Core sheet reader ──────────────────────────────────────────────────────
cell_chr <- function(x) {
  out <- as.character(x)
  out[is.na(out)] <- ""
  str_squish(out)
}

cell_num <- function(x) {
  out <- suppressWarnings(as.numeric(as.character(x)))
  out[is.na(out)] <- 0
  out
}

read_sheet_long <- function(excel_path, sheet_name, has_major) {
  df <- read_excel(excel_path, sheet = sheet_name, col_names = TRUE)
  df <- df[, colSums(is.na(df)) < nrow(df)]

  # Normalise column order: ensure col 1 = district label (text), col 2 = district id (numeric).
  # Some files (e.g. R2 mayor) have them swapped: col 1 = numeric id, col 2 = name.
  if (is.numeric(df[[1]]) && !is.numeric(df[[2]])) {
    df <- df[, c(2L, 1L, seq_len(ncol(df))[-c(1L, 2L)])]
  }

  is_party_col <- str_detect(names(df), "^\\d+")
  party_cols   <- names(df)[is_party_col]

  if (has_major) {
    names(df)[1:11] <- c("district_label", "district", "major_label", "major_local",
                         "precinct_code", "main_list", "special_list",
                         "voted_noon", "voted_5pm", "voted", "ballots_received")
  } else {
    names(df)[1:9]  <- c("district_label", "district", "precinct_code",
                         "main_list", "special_list",
                         "voted_noon", "voted_5pm", "voted", "ballots_received")
  }

  for (i in seq_along(names(df))) {
    if (str_detect(names(df)[i], "ნამდვ")) names(df)[i] <- "valid_ballots"
    if (str_detect(names(df)[i], "ბათ"))   names(df)[i] <- "invalid_ballots"
  }

  is_party_col2 <- str_detect(names(df), "^\\d+")
  party_cols2   <- names(df)[is_party_col2]

  keep <- c("district", "precinct_code", "main_list", "special_list",
            "voted_noon", "voted_5pm", "voted", "invalid_ballots",
            if (has_major) c("major_label", "major_local") else NULL,
            party_cols2)

  df_sub <- df %>%
    select(all_of(keep)) %>%
    filter(!is.na(district), !is.na(precinct_code)) %>%
    mutate(
      district        = as.integer(district),
      selfgov_id      = to_selfgov(district),
      precinct_id     = parse_precinct_id(precinct_code, district),
    ) %>%
    filter(!is.na(precinct_id), !is.na(district)) %>%
    mutate(
      registered      = as.integer(coalesce(main_list, 0)) +
                        as.integer(coalesce(special_list, 0)),
      main_list       = as.integer(coalesce(main_list, 0)),
      special_list    = as.integer(coalesce(special_list, 0)),
      voted_noon      = as.integer(coalesce(voted_noon, 0)),
      voted_5pm       = as.integer(coalesce(voted_5pm, 0)),
      voted           = as.integer(voted),
      invalid_ballots = as.integer(coalesce(invalid_ballots, 0))
    )

  if (has_major) {
    df_sub <- df_sub %>%
      mutate(
        major_label = as.integer(major_label),
        major_local = as.integer(major_local),
        major_id_fallback = to_major_id(district, major_label, major_local)
      ) %>%
      left_join(
        precinct_join_lookup %>% select(precinct_id, MID),
        by = "precinct_id"
      ) %>%
      mutate(
        major_id = coalesce(MID, major_id_fallback)
      ) %>%
      select(-MID, -major_id_fallback)
  }

  out <- df_sub %>%
    pivot_longer(cols = all_of(party_cols2), names_to = "party_col", values_to = "votes") %>%
    mutate(
      party_num = str_extract(party_col, "^\\d+"),
      party_id  = PARTY_MAP[party_num],
      votes     = as.integer(coalesce(votes, 0L))
    )

  if (has_major) {
    out <- out %>%
      mutate(party_id = local2017_smd_party_id(party_id, major_id, party_num))
  }

  out %>% filter(!is.na(party_id))
}

# ── District-level aggregation helpers ────────────────────────────────────
summarise_to_level <- function(df_long, group_var, vote_vars = "party_id") {
  turnout_raw <- df_long %>%
    distinct(across(all_of(c(group_var, "precinct_id"))),
             registered, main_list, special_list,
             voted_noon, voted_5pm, voted, invalid_ballots)

  turnout_agg <- turnout_raw %>%
    group_by(across(all_of(group_var))) %>%
    summarise(
      registered      = sum(registered,      na.rm = TRUE),
      main_list       = sum(main_list,       na.rm = TRUE),
      special_list    = sum(special_list,    na.rm = TRUE),
      voted           = sum(voted,           na.rm = TRUE),
      voted_noon      = sum(voted_noon,      na.rm = TRUE),
      voted_5pm       = sum(voted_5pm,       na.rm = TRUE),
      invalid_ballots = sum(invalid_ballots, na.rm = TRUE),
      .groups = "drop"
    ) %>%
    mutate(
      turnout_pct = round(voted / registered,      6),
      noon_pct    = round(voted_noon / registered, 6),
      five_pct    = round(voted_5pm / registered,  6),
      invalid_pct = round(invalid_ballots / voted, 6)
    )

  party_agg <- df_long %>%
    group_by(across(all_of(c(group_var, vote_vars)))) %>%
    summarise(votes = sum(votes, na.rm = TRUE), .groups = "drop")

  valid_totals <- party_agg %>%
    group_by(across(all_of(group_var))) %>%
    summarise(total_valid = sum(votes), .groups = "drop")

  party_agg %>%
    left_join(valid_totals, by = group_var) %>%
    left_join(turnout_agg,  by = group_var) %>%
    mutate(vote_share = round(votes / total_valid, 6)) %>%
    rename(district_id = all_of(group_var)) %>%
    select(district_id, all_of(vote_vars), votes, vote_share,
           registered, voted, voted_noon, voted_5pm,
           main_list, special_list, turnout_pct, noon_pct, five_pct,
           invalid_ballots, invalid_pct)
}

add_national <- function(df) {
  df <- df %>% mutate(district_id = as.character(district_id))

  turn_nat <- df %>%
    distinct(district_id, .keep_all = TRUE) %>%
    summarise(
      registered      = sum(registered,      na.rm = TRUE),
      voted           = sum(voted,           na.rm = TRUE),
      voted_noon      = sum(voted_noon,      na.rm = TRUE),
      voted_5pm       = sum(voted_5pm,       na.rm = TRUE),
      main_list       = sum(main_list,       na.rm = TRUE),
      special_list    = sum(special_list,    na.rm = TRUE),
      invalid_ballots = sum(invalid_ballots, na.rm = TRUE)
    ) %>%
    mutate(
      turnout_pct = round(voted / registered, 6),
      noon_pct    = round(voted_noon / registered, 6),
      five_pct    = round(voted_5pm / registered, 6),
      invalid_pct = round(invalid_ballots / voted, 6)
    )

  votes_nat <- df %>%
    group_by(party_id) %>%
    summarise(votes = sum(votes), .groups = "drop")

  nat_rows <- votes_nat %>%
    mutate(
      district_id     = "national",
      vote_share      = round(votes / sum(votes), 6),
      registered      = turn_nat$registered,
      voted           = turn_nat$voted,
      voted_noon      = turn_nat$voted_noon,
      voted_5pm       = turn_nat$voted_5pm,
      main_list       = turn_nat$main_list,
      special_list    = turn_nat$special_list,
      turnout_pct     = turn_nat$turnout_pct,
      noon_pct        = turn_nat$noon_pct,
      five_pct        = turn_nat$five_pct,
      invalid_ballots = turn_nat$invalid_ballots,
      invalid_pct     = turn_nat$invalid_pct
    )

  extra_cols <- setdiff(names(df), names(nat_rows))
  for (col in extra_cols) nat_rows[[col]] <- NA_character_

  bind_rows(nat_rows[names(df)], df)
}

summarise_mayor_results <- function(df_long, group_var, candidate_lookup) {
  lookup <- candidate_lookup %>%
    mutate(
      selfgov_id = as.character(selfgov_id),
      party_num = as.character(party_num)
    )

  local_rows <- summarise_to_level(df_long, group_var, c("party_num", "party_id")) %>%
    filter(votes > 0) %>%
    mutate(
      district_id = as.character(district_id),
      party_num = as.character(party_num)
    ) %>%
    left_join(lookup, by = c("district_id" = "selfgov_id", "party_id", "party_num")) %>%
    mutate(name_ka = coalesce(name_ka, ""))

  national_rows <- summarise_to_level(df_long, group_var) %>%
    filter(votes > 0) %>%
    add_national() %>%
    filter(district_id == "national") %>%
    mutate(party_num = "", name_ka = "")

  bind_rows(national_rows, local_rows) %>%
    select(district_id, party_id, party_num, name_ka, votes, vote_share,
           registered, voted, voted_noon, voted_5pm,
           main_list, special_list, turnout_pct, noon_pct, five_pct,
           invalid_ballots, invalid_pct)
}

summarise_mayor_precincts <- function(df_long, candidate_lookup) {
  lookup <- candidate_lookup %>%
    mutate(
      selfgov_id = as.integer(selfgov_id),
      party_num = as.character(party_num)
    )

  df_long %>%
    group_by(precinct_id, selfgov_id, party_num, party_id) %>%
    summarise(
      votes           = sum(votes, na.rm = TRUE),
      registered      = first(registered),
      voted           = first(voted),
      voted_noon      = first(voted_noon),
      voted_5pm       = first(voted_5pm),
      invalid_ballots = first(invalid_ballots),
      .groups = "drop"
    ) %>%
    filter(votes > 0) %>%
    group_by(precinct_id) %>%
    mutate(vote_share = round(votes / sum(votes), 6)) %>%
    ungroup() %>%
    mutate(
      party_num = as.character(party_num),
      turnout_pct = round(voted / registered, 6),
      noon_pct    = round(voted_noon / registered, 6),
      five_pct    = round(voted_5pm / registered, 6),
      invalid_pct = round(invalid_ballots / voted, 6)
    ) %>%
    left_join(lookup, by = c("selfgov_id", "party_id", "party_num")) %>%
    mutate(name_ka = coalesce(name_ka, "")) %>%
    select(precinct_id, selfgov_id, party_id, party_num, name_ka, votes, vote_share,
           registered, voted, voted_noon, voted_5pm,
           turnout_pct, noon_pct, five_pct, invalid_ballots, invalid_pct)
}

# ── Party-name → party_id (for candidates file, uses Georgian text) ────────
party_id_from_name <- function(name_vec) {
  n <- str_replace_all(name_vec, "[„“”\"]", "")
  n <- str_replace_all(n, "^საარჩევნო ბლოკი\\s*", "")
  n <- str_trim(n)
  case_when(
    str_detect(n, "საინიციატივო\\s+ჯგ")              ~ "initiative_group",
    str_detect(n, "ქართული ოცნება")              ~ "gd",
    str_detect(n, "ერთიანი ნაციონალური")          ~ "unm",
    str_detect(n, "ბაქრაძე")                      ~ "european_georgia",
    str_detect(n, "პატრიოტთა ალიანსი")            ~ "patriots",
    str_detect(n, "ლეიბორისტული")                 ~ "labour",
    str_detect(n, "რესპუბლიკური")                 ~ "republicans_2016",
    str_detect(n, "მეჭიაური")                     ~ "mechiauri",
    str_detect(n, "ლორთქიფანიძე")                 ~ "burjanadze_democratic",
    str_detect(n, "ეროვნულ.?დემოკრ")              ~ "national_democrats",
    str_detect(n, "ახალი ქრისტიან")               ~ "new_christian_democrats",
    str_detect(n, "შენების")                      ~ "construction_movement_2017",
    str_detect(n, "ვაშაძე")                       ~ "vashadze_2017",
    str_detect(n, "ტრადიციონალისტები")            ~ "traditionalists",
    str_detect(n, "პროგრ.*დემოკრ")                ~ "progressive_democratic_2017",
    str_detect(n, "სახალხო.*ხალხ")                ~ "peoples_unity_2017",
    str_detect(n, "ზვიადის გზა")                  ~ "zviads_way",
    str_detect(n, "გამსახურდიას გზა")              ~ "freedom_gamsakhurdia",
    str_detect(n, "მემარცხენე ალიანსი")           ~ "left_alliance",
    str_detect(n, "მამულიშვილთა")                 ~ "mamuli_ena",
    str_detect(n, "სოციალისტური საქართველო")      ~ "communist_stalinist",
    str_detect(n, "მშრომელთა სოციალ")             ~ "workers_socialist",
    str_detect(n, "ერთობისა და განვ")              ~ "unity_development",
    str_detect(n, "სახელმწიფო ხალხ")              ~ "burchuladze",
    str_detect(n, "კოსტავა")                      ~ "kostava_society",
    str_detect(n, "^საქართველო$")                 ~ "georgia_2016",
    str_detect(n, "საინიციატივო ჯგ")              ~ "initiative_group",
    TRUE                                           ~ NA_character_
  )
}

# ════════════════════════════════════════════════════════════════════════════
# 1. CANDIDATES YAML
# ════════════════════════════════════════════════════════════════════════════
cat("Building candidate YAML...\n")

# ── 1a. Mayor candidates ───────────────────────────────────────────────────
df_mc <- raw_mayor_candidates
names(df_mc) <- c("district_number", "district_name", "candidate_number",
                  "endorsing_party", "name", "last_name", "source_page", "source_pdf")

df_mc <- df_mc %>%
  mutate(
    district_number  = suppressWarnings(as.integer(district_number)),
    candidate_number = as.integer(candidate_number),
    district_number  = if_else(
      is.na(district_number) & str_detect(coalesce(district_name, ""), "თბილის"),
      1L, district_number
    ),
    selfgov_id = to_selfgov(district_number),
    party_id   = party_id_from_name(as.character(endorsing_party)),
    name_ka    = paste(str_trim(coalesce(name, "")), str_trim(coalesce(last_name, "")))
  ) %>%
  filter(!is.na(party_id), !is.na(selfgov_id))

# For regular parties: keep one candidate per (selfgov_id, party_id).
# For initiative groups: keep ALL candidates (each is a different person);
# their ballot number makes the YAML key unique.
mc_regular <- df_mc %>%
  filter(party_id != "initiative_group") %>%
  arrange(selfgov_id, party_id) %>%
  distinct(selfgov_id, party_id, .keep_all = TRUE) %>%
  mutate(yaml_key = paste0(party_id, "_mayor_", selfgov_id))

mc_indie <- df_mc %>%
  filter(party_id == "initiative_group") %>%
  arrange(selfgov_id, candidate_number) %>%
  mutate(yaml_key = paste0("initiative_", candidate_number, "_mayor_", selfgov_id))

mc <- bind_rows(mc_regular, mc_indie) %>% arrange(selfgov_id, yaml_key)

cat("  Mayor candidates — named parties:", nrow(mc_regular),
    "| initiative groups:", nrow(mc_indie), "\n")

# ── 1b. Majoritarian candidates ────────────────────────────────────────────
df_majc <- tibble(
  record_id = col_or_na(raw_major_candidates, "record_id"),
  MID = col_or_na(raw_major_candidates, "MID"),
  self_gov_id = col_or_na(raw_major_candidates, "self_gov_id"),
  district_number = col_or_na(raw_major_candidates, "district_number"),
  district_name = col_or_na(raw_major_candidates, "district_name"),
  majoritarian_district = col_or_na(raw_major_candidates, "majoritarian_district"),
  majoritarian_subdistrict = col_or_na(raw_major_candidates, "majoritarian_subdistrict"),
  candidate_number = col_or_na(raw_major_candidates, "candidate_number"),
  endorsing_party = col_or_na(raw_major_candidates, "endorsing_party"),
  name = col_or_na(raw_major_candidates, "name"),
  last_name = col_or_na(raw_major_candidates, "last_name"),
  source_page = col_or_na(raw_major_candidates, "source_page"),
  source_pdf = col_or_na(raw_major_candidates, "source_pdf")
)

df_majc <- df_majc %>%
  mutate(
    district_number      = suppressWarnings(as.integer(district_number)),
    majoritarian_district = suppressWarnings(as.integer(majoritarian_district)),
    majoritarian_subdistrict = suppressWarnings(as.integer(majoritarian_subdistrict)),
    candidate_number     = normalise_candidate_number(candidate_number),
    MID         = normalise_mid(MID),
    selfgov_id  = coalesce(suppressWarnings(as.integer(self_gov_id)), to_selfgov(district_number)),
    major_id    = coalesce(MID, to_major_id(district_number, majoritarian_district, majoritarian_subdistrict)),
    party_id_base = party_id_from_name(as.character(endorsing_party)),
    party_num   = as.character(candidate_number),
    party_id_base = coalesce(party_id_base, unname(PARTY_MAP[party_num])),
    party_id    = local2017_smd_party_id(party_id_base, major_id, party_num),
    name_ka     = paste(str_trim(coalesce(name, "")), str_trim(coalesce(last_name, "")))
  ) %>%
  filter(!is.na(party_id_base), !is.na(party_id), !is.na(major_id))

majc_regular <- df_majc %>%
  filter(party_id_base != "initiative_group") %>%
  arrange(major_id, party_id) %>%
  distinct(major_id, party_id, .keep_all = TRUE) %>%
  mutate(yaml_key = paste0(party_id, "_maj_", major_id))

majc_indie <- df_majc %>%
  filter(party_id_base == "initiative_group") %>%
  arrange(major_id, candidate_number) %>%
  mutate(yaml_key = paste0("initiative_", candidate_number, "_maj_", major_id))

majc <- bind_rows(majc_regular, majc_indie) %>% arrange(major_id, yaml_key)

cat("  Majoritarian candidates — named parties:", nrow(majc_regular),
    "| initiative groups:", nrow(majc_indie), "\n")

# ── 1c. Write YAML ─────────────────────────────────────────────────────────
mayor_yaml <- lapply(seq_len(nrow(mc)), function(i) {
  r   <- mc[i, ]
  pid <- r$party_id
  sg  <- r$selfgov_id
  setNames(list(list(
    name_ka       = r$name_ka,
    election_type = "mayor",
    selfgov_id    = as.integer(sg),
    party         = pid
  )), r$yaml_key)
})

maj_yaml <- lapply(seq_len(nrow(majc)), function(i) {
  r   <- majc[i, ]
  pid <- r$party_id
  setNames(list(list(
    name_ka               = r$name_ka,
    election_type         = "sakrebulo_smd",
    selfgov_id            = as.integer(r$selfgov_id),
    electoral_district_id = as.integer(r$district_number),
    major_id              = as.integer(r$major_id),
    party                 = pid
  )), r$yaml_key)
})

out_cands <- file.path(OUT_CANDS, "local_2017.yml")
write_yaml(
  list(candidates = c(do.call(c, mayor_yaml), do.call(c, maj_yaml))),
  out_cands,
  unicode = TRUE
)
cat("  Written:", out_cands, "\n")

# Lookup tables reused by results sections
mc_lookup   <- mc %>%
                        mutate(party_num = as.character(candidate_number)) %>%
                        select(selfgov_id, party_id, party_num, name_ka)
majc_lookup <- majc %>% filter(party_id != "initiative_group") %>%
                        mutate(party_num = as.character(candidate_number)) %>%
                        select(major_id, party_id, party_num, name_ka)

# ════════════════════════════════════════════════════════════════════════════
# 2. PROPORTIONAL (Sakrebulo PR) — Round 1 only
# ════════════════════════════════════════════════════════════════════════════
cat("Processing PR results...\n")
pr_long <- read_sheet_long(EXCEL_R1, "პროპორციული", has_major = FALSE)

pr_district <- summarise_to_level(pr_long, "district") %>% add_national()
write_csv_utf8(pr_district, file.path(OUT_RESULTS, "local2017_pr.csv"))

pr_selfgov <- summarise_to_level(pr_long, "selfgov_id") %>% add_national()
write_csv_utf8(pr_selfgov, file.path(OUT_RESULTS, "local2017_pr_selfgov.csv"))

pr_prec <- pr_long %>%
  group_by(precinct_id, district, party_id) %>%
  summarise(
    votes           = sum(votes, na.rm = TRUE),
    registered      = first(registered),
    voted           = first(voted),
    voted_noon      = first(voted_noon),
    voted_5pm       = first(voted_5pm),
    invalid_ballots = first(invalid_ballots),
    .groups = "drop"
  ) %>%
  group_by(precinct_id) %>%
  mutate(vote_share = round(votes / sum(votes), 6)) %>%
  ungroup() %>%
  mutate(
    turnout_pct = round(voted / registered, 6),
    noon_pct    = round(voted_noon / registered, 6),
    five_pct    = round(voted_5pm / registered, 6),
    invalid_pct = round(invalid_ballots / voted, 6)
  ) %>%
  rename(district_id = district) %>%
  select(precinct_id, district_id, party_id, votes, vote_share,
         registered, voted, voted_noon, voted_5pm,
         turnout_pct, noon_pct, five_pct, invalid_ballots, invalid_pct)
write_csv_utf8(pr_prec, file.path(OUT_RESULTS, "local2017_pr_precincts.csv"))

# ════════════════════════════════════════════════════════════════════════════
# 3. MAYOR (SMD) — merge city + community R1; apply R2 runoffs
# ════════════════════════════════════════════════════════════════════════════
cat("Processing mayoral results...\n")

smd_city_long <- read_sheet_long(EXCEL_R1, "მერი ქალაქი I ტური", has_major = FALSE)
smd_comm_long <- read_sheet_long(EXCEL_R1, "მერი თემი I ტური",   has_major = FALSE)
smd_r1_long   <- bind_rows(smd_city_long, smd_comm_long)
smd_r2_long   <- read_sheet_long(EXCEL_R2, "მერი II ტური",       has_major = FALSE)

runoff_selfgovs <- unique(smd_r2_long$selfgov_id)
cat("  Mayor runoff self-gov IDs:", paste(sort(runoff_selfgovs), collapse = ", "), "\n")

smd_final_long <- bind_rows(
  smd_r1_long %>% filter(!selfgov_id %in% runoff_selfgovs),
  smd_r2_long
)

smd_dist <- summarise_mayor_results(smd_final_long, "selfgov_id", mc_lookup) %>%
  mutate(
    round   = if_else(
      !is.na(suppressWarnings(as.integer(district_id))) &
        suppressWarnings(as.integer(district_id)) %in% runoff_selfgovs,
      2L, 1L
    )
  ) %>%
  select(district_id, party_id, party_num, name_ka, round, votes, vote_share,
         registered, voted, voted_noon, voted_5pm,
         main_list, special_list, turnout_pct, noon_pct, five_pct,
         invalid_ballots, invalid_pct)
write_csv_utf8(smd_dist, file.path(OUT_RESULTS, "local2017_smd.csv"))

# Expand Tbilisi (selfgov_id=1) across CEC districts 1–10
tbilisi_exp <- smd_dist %>%
  filter(district_id == "1") %>%
  crossing(tibble(new_did = as.character(2:10))) %>%
  mutate(district_id = new_did) %>%
  select(-new_did)

smd_districts <- smd_dist %>%
  filter(district_id != "national") %>%
  bind_rows(tbilisi_exp) %>%
  bind_rows(filter(smd_dist, district_id == "national")) %>%
  arrange(district_id, party_id)
write_csv_utf8(smd_districts, file.path(OUT_RESULTS, "local2017_smd_districts.csv"))

smd_prec <- summarise_mayor_precincts(smd_final_long, mc_lookup)
write_csv_utf8(smd_prec, file.path(OUT_RESULTS, "local2017_smd_precincts.csv"))

# ── Mayor R2 sub-election ─────────────────────────────────────────────────
smd_r2_dist <- summarise_mayor_results(smd_r2_long, "selfgov_id", mc_lookup) %>%
  select(district_id, party_id, party_num, name_ka, votes, vote_share,
         registered, voted, voted_noon, voted_5pm,
         main_list, special_list, turnout_pct, noon_pct, five_pct,
         invalid_ballots, invalid_pct)
write_csv_utf8(smd_r2_dist, file.path(OUT_RESULTS, "local2017_r2_smd.csv"))

smd_r2_prec <- summarise_mayor_precincts(smd_r2_long, mc_lookup)
write_csv_utf8(smd_r2_prec, file.path(OUT_RESULTS, "local2017_r2_smd_precincts.csv"))

smd_r2_tbilisi <- smd_r2_dist %>%
  filter(district_id == "1") %>%
  crossing(tibble(new_did = as.character(2:10))) %>%
  mutate(district_id = new_did) %>%
  select(-new_did)
smd_r2_districts <- smd_r2_dist %>%
  filter(district_id != "national") %>%
  bind_rows(smd_r2_tbilisi) %>%
  bind_rows(filter(smd_r2_dist, district_id == "national")) %>%
  arrange(district_id, party_id)
write_csv_utf8(smd_r2_districts, file.path(OUT_RESULTS, "local2017_r2_smd_districts.csv"))

# Stubs — no majoritarian runoffs in 2017
stub_cols <- c("district_id", "party_id", "name_ka", "votes", "vote_share",
               "registered", "voted", "voted_noon", "voted_5pm",
               "main_list", "special_list", "turnout_pct", "noon_pct", "five_pct",
               "invalid_ballots", "invalid_pct")
stub_prec_cols <- c("precinct_id", "district_id", "party_id", "votes", "vote_share",
                    "registered", "voted", "voted_noon", "voted_5pm",
                    "turnout_pct", "noon_pct", "five_pct", "invalid_ballots", "invalid_pct")

write_csv_utf8(setNames(as.data.frame(matrix(nrow=0, ncol=length(stub_cols))), stub_cols),
               file.path(OUT_RESULTS, "local2017_r2_council_smd.csv"))
write_csv_utf8(setNames(as.data.frame(matrix(nrow=0, ncol=length(stub_prec_cols))), stub_prec_cols),
               file.path(OUT_RESULTS, "local2017_r2_council_smd_precincts.csv"))

# ════════════════════════════════════════════════════════════════════════════
# 4. MAJORITARIAN (Sakrebulo SMD) — Round 1 only
# ════════════════════════════════════════════════════════════════════════════
cat("Processing majoritarian results...\n")

maj_long <- read_sheet_long(EXCEL_R1, "მაჟორიტარული", has_major = TRUE)

turn_maj <- maj_long %>%
  distinct(major_id, precinct_id, .keep_all = TRUE) %>%
  group_by(major_id) %>%
  summarise(
    registered      = sum(registered,      na.rm = TRUE),
    main_list       = sum(main_list,       na.rm = TRUE),
    special_list    = sum(special_list,    na.rm = TRUE),
    voted           = sum(voted,           na.rm = TRUE),
    voted_noon      = sum(voted_noon,      na.rm = TRUE),
    voted_5pm       = sum(voted_5pm,       na.rm = TRUE),
    invalid_ballots = sum(invalid_ballots, na.rm = TRUE),
    .groups = "drop"
  ) %>%
  mutate(
    turnout_pct = round(voted / registered, 6),
    noon_pct    = round(voted_noon / registered, 6),
    five_pct    = round(voted_5pm / registered, 6),
    invalid_pct = round(invalid_ballots / voted, 6)
  )

party_maj <- maj_long %>%
  group_by(major_id, party_id, party_num) %>%
  summarise(votes = sum(votes, na.rm = TRUE), .groups = "drop") %>%
  filter(votes > 0)

valid_maj <- party_maj %>%
  group_by(major_id) %>%
  summarise(total_valid = sum(votes), .groups = "drop")

maj_dist <- party_maj %>%
  left_join(valid_maj,    by = "major_id") %>%
  left_join(turn_maj,     by = "major_id") %>%
  mutate(vote_share = round(votes / total_valid, 6)) %>%
  left_join(majc_lookup,  by = c("major_id", "party_id", "party_num")) %>%
  mutate(name_ka = coalesce(name_ka, ""), round = 1L) %>%
  rename(district_id = major_id) %>%
  select(district_id, party_id, name_ka, round, votes, vote_share,
         registered, voted, voted_noon, voted_5pm,
         main_list, special_list, turnout_pct, noon_pct, five_pct,
         invalid_ballots, invalid_pct)

turn_nat_maj <- turn_maj %>%
  summarise(across(c(registered, voted, voted_noon, voted_5pm,
                     main_list, special_list, invalid_ballots), sum)) %>%
  mutate(
    turnout_pct = round(voted / registered, 6),
    noon_pct    = round(voted_noon / registered, 6),
    five_pct    = round(voted_5pm / registered, 6),
    invalid_pct = round(invalid_ballots / voted, 6)
  )

nat_maj <- party_maj %>%
  group_by(party_id) %>%
  summarise(votes = sum(votes), .groups = "drop") %>%
  mutate(
    district_id     = "national",
    name_ka         = "",
    round           = 1L,
    vote_share      = round(votes / sum(votes), 6),
    registered      = turn_nat_maj$registered,
    voted           = turn_nat_maj$voted,
    voted_noon      = turn_nat_maj$voted_noon,
    voted_5pm       = turn_nat_maj$voted_5pm,
    main_list       = turn_nat_maj$main_list,
    special_list    = turn_nat_maj$special_list,
    turnout_pct     = turn_nat_maj$turnout_pct,
    noon_pct        = turn_nat_maj$noon_pct,
    five_pct        = turn_nat_maj$five_pct,
    invalid_ballots = turn_nat_maj$invalid_ballots,
    invalid_pct     = turn_nat_maj$invalid_pct
  ) %>%
  select(names(maj_dist))

maj_dist      <- maj_dist %>% mutate(district_id = as.character(district_id))
maj_final_out <- bind_rows(nat_maj, maj_dist)
write_csv_utf8(maj_final_out, file.path(OUT_RESULTS, "local2017_council_smd.csv"))

maj_prec <- maj_long %>%
  group_by(precinct_id, major_id, party_id, party_num) %>%
  summarise(
    votes           = sum(votes, na.rm = TRUE),
    registered      = first(registered),
    voted           = first(voted),
    voted_noon      = first(voted_noon),
    voted_5pm       = first(voted_5pm),
    invalid_ballots = first(invalid_ballots),
    .groups = "drop"
  ) %>%
  filter(votes > 0) %>%
  group_by(precinct_id, major_id) %>%
  mutate(vote_share = round(votes / sum(votes), 6)) %>%
  ungroup() %>%
  mutate(
    turnout_pct = round(voted / registered, 6),
    noon_pct    = round(voted_noon / registered, 6),
    five_pct    = round(voted_5pm / registered, 6),
    invalid_pct = round(invalid_ballots / voted, 6)
  ) %>%
  rename(district_id = major_id) %>%
  select(precinct_id, district_id, party_id, votes, vote_share,
         registered, voted, voted_noon, voted_5pm,
         turnout_pct, noon_pct, five_pct, invalid_ballots, invalid_pct)
write_csv_utf8(maj_prec, file.path(OUT_RESULTS, "local2017_council_smd_precincts.csv"))

# ── Zugdidi Sakrebulo SMD 27 by-election, 13 May 2018 ─────────────────────
cat("Processing Zugdidi 2018 Sakrebulo SMD by-election...\n")

read_zugdidi_2018_council_smd <- function(path) {
  raw <- read_excel(path, sheet = "maJoritaeuli", col_names = FALSE, .name_repair = "minimal")
  headers <- cell_chr(unlist(raw[1, ], use.names = FALSE))
  body <- raw[-1, , drop = FALSE]

  candidate_cols <- which(str_detect(headers, "^\\d+\\s+"))
  candidate_meta <- tibble(
    candidate_col = candidate_cols,
    party_num = str_extract(headers[candidate_cols], "^\\d+"),
    name_ka = str_squish(str_remove(headers[candidate_cols], "^\\d+\\s+")),
    party_id = paste0("zugdidi_2018_", party_num)
  )

  base <- tibble(
    row_id = seq_len(nrow(body)),
    electoral_district = cell_chr(body[[1]]),
    major_label = as.integer(cell_num(body[[2]])),
    precinct_code = cell_chr(body[[3]]),
    main_list = as.integer(cell_num(body[[4]])),
    special_list = as.integer(cell_num(body[[5]])),
    voted_noon = as.integer(cell_num(body[[6]])),
    voted_5pm = as.integer(cell_num(body[[7]])),
    voted = as.integer(cell_num(body[[8]])),
    ballots_received = as.integer(cell_num(body[[10]])),
    valid_ballots = as.integer(cell_num(body[[17]])),
    invalid_ballots = as.integer(cell_num(body[[18]]))
  ) %>%
    filter(str_detect(precinct_code, "^\\d+\\.\\d+\\.\\d+$")) %>%
    mutate(
      code_part_1 = as.integer(str_split_fixed(precinct_code, fixed("."), 3)[, 1]),
      district = as.integer(str_split_fixed(precinct_code, fixed("."), 3)[, 2]),
      precinct_number = as.integer(str_split_fixed(precinct_code, fixed("."), 3)[, 3]),
      selfgov_id = to_selfgov(district),
      major_id = to_major_id(district, major_label),
      precinct_id = district * 1000L + precinct_number,
      precinct_key = paste(major_id, district, precinct_number, sep = "."),
      registered = main_list + special_list
    )

  vote_wide <- base
  for (i in seq_len(nrow(candidate_meta))) {
    vote_wide[[candidate_meta$party_id[[i]]]] <-
      as.integer(cell_num(body[[candidate_meta$candidate_col[[i]]]][base$row_id]))
  }

  vote_wide %>%
    pivot_longer(
      cols = all_of(candidate_meta$party_id),
      names_to = "party_id",
      values_to = "votes"
    ) %>%
    left_join(candidate_meta %>% select(party_id, party_num, name_ka), by = "party_id") %>%
    mutate(
      votes = as.integer(coalesce(votes, 0L)),
      turnout_pct = round(voted / registered, 6),
      noon_pct = round(voted_noon / registered, 6),
      five_pct = round(voted_5pm / registered, 6),
      invalid_pct = round(invalid_ballots / voted, 6)
    )
}

zugdidi_2018_long <- read_zugdidi_2018_council_smd(BY2018_ZUGDIDI_67_27)

zugdidi_2018_turn <- zugdidi_2018_long %>%
  distinct(major_id, precinct_id, .keep_all = TRUE) %>%
  group_by(major_id) %>%
  summarise(
    registered = sum(registered, na.rm = TRUE),
    main_list = sum(main_list, na.rm = TRUE),
    special_list = sum(special_list, na.rm = TRUE),
    voted = sum(voted, na.rm = TRUE),
    voted_noon = sum(voted_noon, na.rm = TRUE),
    voted_5pm = sum(voted_5pm, na.rm = TRUE),
    invalid_ballots = sum(invalid_ballots, na.rm = TRUE),
    .groups = "drop"
  ) %>%
  mutate(
    turnout_pct = round(voted / registered, 6),
    noon_pct = round(voted_noon / registered, 6),
    five_pct = round(voted_5pm / registered, 6),
    invalid_pct = round(invalid_ballots / voted, 6)
  )

zugdidi_2018_party <- zugdidi_2018_long %>%
  group_by(major_id, party_id, name_ka) %>%
  summarise(votes = sum(votes, na.rm = TRUE), .groups = "drop") %>%
  filter(votes > 0)

zugdidi_2018_valid <- zugdidi_2018_party %>%
  group_by(major_id) %>%
  summarise(total_valid = sum(votes), .groups = "drop")

zugdidi_2018_dist <- zugdidi_2018_party %>%
  left_join(zugdidi_2018_valid, by = "major_id") %>%
  left_join(zugdidi_2018_turn, by = "major_id") %>%
  mutate(
    district_id = as.character(major_id),
    round = 1L,
    vote_share = round(votes / total_valid, 6)
  ) %>%
  select(district_id, party_id, name_ka, round, votes, vote_share,
         registered, voted, voted_noon, voted_5pm,
         main_list, special_list, turnout_pct, noon_pct, five_pct,
         invalid_ballots, invalid_pct)

zugdidi_2018_turn_nat <- zugdidi_2018_turn %>%
  summarise(across(c(registered, voted, voted_noon, voted_5pm,
                     main_list, special_list, invalid_ballots), sum)) %>%
  mutate(
    turnout_pct = round(voted / registered, 6),
    noon_pct = round(voted_noon / registered, 6),
    five_pct = round(voted_5pm / registered, 6),
    invalid_pct = round(invalid_ballots / voted, 6)
  )

zugdidi_2018_nat <- zugdidi_2018_party %>%
  group_by(party_id, name_ka) %>%
  summarise(votes = sum(votes), .groups = "drop") %>%
  mutate(
    district_id = "national",
    round = 1L,
    vote_share = round(votes / sum(votes), 6),
    registered = zugdidi_2018_turn_nat$registered,
    voted = zugdidi_2018_turn_nat$voted,
    voted_noon = zugdidi_2018_turn_nat$voted_noon,
    voted_5pm = zugdidi_2018_turn_nat$voted_5pm,
    main_list = zugdidi_2018_turn_nat$main_list,
    special_list = zugdidi_2018_turn_nat$special_list,
    turnout_pct = zugdidi_2018_turn_nat$turnout_pct,
    noon_pct = zugdidi_2018_turn_nat$noon_pct,
    five_pct = zugdidi_2018_turn_nat$five_pct,
    invalid_ballots = zugdidi_2018_turn_nat$invalid_ballots,
    invalid_pct = zugdidi_2018_turn_nat$invalid_pct
  ) %>%
  select(names(zugdidi_2018_dist))

write_csv_utf8(
  bind_rows(zugdidi_2018_nat, zugdidi_2018_dist),
  file.path(OUT_RESULTS, "local2017_zugdidi_2018_council_smd.csv")
)

zugdidi_2018_prec <- zugdidi_2018_long %>%
  filter(votes > 0) %>%
  group_by(precinct_id, major_id, party_id, name_ka) %>%
  summarise(
    votes = sum(votes, na.rm = TRUE),
    precinct_key = first(precinct_key),
    raw_district_id = first(district),
    precinct_number = first(precinct_number),
    registered = first(registered),
    voted = first(voted),
    voted_noon = first(voted_noon),
    voted_5pm = first(voted_5pm),
    invalid_ballots = first(invalid_ballots),
    .groups = "drop"
  ) %>%
  group_by(precinct_id, major_id) %>%
  mutate(vote_share = round(votes / sum(votes), 6)) %>%
  ungroup() %>%
  mutate(
    district_id = as.character(major_id),
    turnout_pct = round(voted / registered, 6),
    noon_pct = round(voted_noon / registered, 6),
    five_pct = round(voted_5pm / registered, 6),
    invalid_pct = round(invalid_ballots / voted, 6)
  ) %>%
  select(precinct_id, precinct_key, district_id, raw_district_id, precinct_number,
         party_id, name_ka, votes, vote_share, registered, voted, voted_noon, voted_5pm,
         turnout_pct, noon_pct, five_pct, invalid_ballots, invalid_pct)

write_csv_utf8(
  zugdidi_2018_prec,
  file.path(OUT_RESULTS, "local2017_zugdidi_2018_council_smd_precincts.csv")
)

write_csv_utf8(smd_dist[0, ], file.path(OUT_RESULTS, "local2017_zugdidi_2018_smd.csv"))
write_csv_utf8(smd_prec[0, ], file.path(OUT_RESULTS, "local2017_zugdidi_2018_smd_precincts.csv"))

# ── Local by-elections, 19 May 2019: mayors + Sakrebulo SMDs ──────────────
cat("Processing 2019 local by-elections...\n")

party_id_from_2019_label <- function(label) {
  n <- str_squish(str_replace_all(coalesce(label, ""), "[„“\"]", ""))
  case_when(
    str_detect(n, "სახელმწიფო ხალხ") ~ "burchuladze",
    str_detect(n, "ევროპული საქართველო") ~ "european_georgia",
    str_detect(n, "ქრისტიან-დემოკრატიული მოძრაობა") ~ "peoples_movement_2020",
    str_detect(n, "ერთიანი ნაციონალური") ~ "unm",
    str_detect(n, "პატრიოტთა ალიანს") ~ "patriots",
    str_detect(n, "მოძრაობა\\s+თავისუფალი საქართველოსთვის") ~ "free_georgia_movement",
    str_detect(n, "თავისუფალი საქართველო") ~ "free_georgia",
    str_detect(n, "^საქართველო$") ~ "georgia_2016",
    str_detect(n, "ახალი ქრისტიან") ~ "new_christian_democrats",
    str_detect(n, "სოციალური სამართლიანობის") ~ "social_justice_2020",
    str_detect(n, "ახალი საქართველო") ~ "vashadze_2017",
    str_detect(n, "ზვიად გამსახურდიას გზა") ~ "freedom_gamsakhurdia",
    str_detect(n, "ძალოვან ვეტერან") ~ "veterans",
    str_detect(n, "ეროვნულ-დემოკრატ") ~ "national_democrats",
    str_detect(n, "ქრისტიან-კო.?სერვატორ") ~ "conservatives",
    str_detect(n, "ლეიბორისტ") ~ "labour",
    str_detect(n, "ლელო") ~ "lelo",
    str_detect(n, "ტრიბუნა") ~ "tribuna",
    str_detect(n, "აღმაშენებელი") ~ "agmashenebeli",
    str_detect(n, "ქართული ოცნება") ~ "gd",
    str_detect(n, "საინიციატივო ჯგუფ") ~ "initiative_group",
    TRUE ~ NA_character_
  )
}

normalise_2019_sakrebulo_key <- function(key) {
  dplyr::recode(
    as.character(key),
    "56.01" = "56.02",
    "58.01" = "57.03",
    "59.04" = "58.04",
    "60.01" = "60.03",
    .default = as.character(key)
  )
}

read_2019_candidate_lookup <- function(path) {
  read_excel(path, sheet = "Candidate", col_names = TRUE) %>%
    rename(election_type = Elections, source_key = District, candidate_text = Name) %>%
    mutate(
      election_type = str_squish(as.character(election_type)),
      source_key = str_squish(as.character(source_key)),
      candidate_text = str_squish(as.character(candidate_text)),
      party_num = str_match(candidate_text, "N\\s*(\\d+)")[, 2],
      name_ka = str_squish(str_split_fixed(candidate_text, "\\s+–\\s+", 2)[, 1]),
      party_label = candidate_text %>%
        str_remove("^.*?\\s+–\\s+") %>%
        str_remove("\\s+–?\\s*N\\s*\\d+.*$") %>%
        str_squish(),
      result_key = if_else(
        election_type == "Sakrebulo SMD",
        normalise_2019_sakrebulo_key(source_key),
        source_key
      ),
      party_num = if_else(
        election_type == "Sakrebulo SMD" & result_key == "60.03" & party_num == "28",
        "38",
        party_num
      ),
      party_id = party_id_from_2019_label(party_label)
    ) %>%
    filter(!is.na(party_num), !is.na(party_id)) %>%
    distinct(election_type, result_key, party_num, .keep_all = TRUE)
}

candidate_2019 <- read_2019_candidate_lookup(BY2019_LOCAL)

read_2019_mayor_long <- function(path, candidate_lookup) {
  raw <- read_excel(path, sheet = "მერი", col_names = FALSE, .name_repair = "minimal")
  headers <- cell_chr(unlist(raw[1, ], use.names = FALSE))
  body <- raw[-1, , drop = FALSE]
  candidate_cols <- which(str_detect(headers, "^\\d+$"))

  base <- tibble(
    row_id = seq_len(nrow(body)),
    district = as.integer(cell_num(body[[1]])),
    precinct_number = as.integer(cell_num(body[[2]])),
    main_list = as.integer(cell_num(body[[3]])),
    special_list = as.integer(cell_num(body[[4]])),
    voted_noon = as.integer(cell_num(body[[5]])),
    voted_5pm = as.integer(cell_num(body[[6]])),
    voted = as.integer(cell_num(body[[7]])),
    ballots_received = as.integer(cell_num(body[[9]])),
    valid_ballots = as.integer(cell_num(body[[29]])),
    invalid_ballots = as.integer(cell_num(body[[30]]))
  ) %>%
    filter(!is.na(district), !is.na(precinct_number), district > 0, precinct_number > 0) %>%
    mutate(
      selfgov_id = to_selfgov(district),
      precinct_id = district * 1000L + precinct_number,
      registered = main_list + special_list
    )

  vote_wide <- base
  for (col in candidate_cols) {
    vote_wide[[headers[[col]]]] <- as.integer(cell_num(body[[col]][base$row_id]))
  }

  lookup <- candidate_lookup %>%
    filter(election_type == "Mayor") %>%
    mutate(selfgov_id = as.integer(result_key)) %>%
    select(selfgov_id, party_num, party_id, name_ka)

  vote_wide %>%
    pivot_longer(cols = all_of(headers[candidate_cols]), names_to = "party_num", values_to = "votes") %>%
    mutate(party_num = as.character(party_num), votes = as.integer(coalesce(votes, 0L))) %>%
    left_join(lookup, by = c("selfgov_id", "party_num")) %>%
    mutate(
      party_id = coalesce(party_id, paste0("local2019_mayor_", selfgov_id, "_", party_num)),
      name_ka = coalesce(name_ka, ""),
      turnout_pct = round(voted / registered, 6),
      noon_pct = round(voted_noon / registered, 6),
      five_pct = round(voted_5pm / registered, 6),
      invalid_pct = round(invalid_ballots / voted, 6)
    )
}

read_2019_council_long <- function(path, candidate_lookup) {
  raw <- read_excel(path, sheet = "საკრებულო", col_names = FALSE, .name_repair = "minimal")
  headers <- cell_chr(unlist(raw[1, ], use.names = FALSE))
  body <- raw[-1, , drop = FALSE]
  candidate_cols <- which(str_detect(headers, "^\\d+$"))

  base <- tibble(
    row_id = seq_len(nrow(body)),
    district = as.integer(cell_num(body[[1]])),
    major_label = as.integer(cell_num(body[[2]])),
    precinct_raw = cell_chr(body[[3]]),
    precinct_number = as.integer(cell_num(body[[3]])),
    main_list = as.integer(cell_num(body[[4]])),
    special_list = as.integer(cell_num(body[[5]])),
    voted_noon = as.integer(cell_num(body[[6]])),
    voted_5pm = as.integer(cell_num(body[[7]])),
    voted = as.integer(cell_num(body[[8]])),
    ballots_received = as.integer(cell_num(body[[10]])),
    valid_ballots = as.integer(cell_num(body[[28]])),
    invalid_ballots = as.integer(cell_num(body[[29]]))
  ) %>%
    filter(!is.na(district), !is.na(major_label), !is.na(precinct_number), precinct_raw != "ჯამი") %>%
    mutate(
      result_key = paste0(district, ".", str_pad(major_label, 2, pad = "0")),
      selfgov_id = to_selfgov(district),
      precinct_id = district * 1000L + precinct_number,
      registered = main_list + special_list,
      major_id_fallback = to_major_id(district, major_label)
    ) %>%
    left_join(
      precinct_join_lookup %>% select(precinct_id, MID),
      by = "precinct_id"
    ) %>%
    mutate(
      major_id = coalesce(MID, major_id_fallback),
      precinct_key = paste(major_id, district, precinct_number, sep = ".")
    ) %>%
    select(-MID, -major_id_fallback)

  vote_wide <- base
  for (col in candidate_cols) {
    vote_wide[[headers[[col]]]] <- as.integer(cell_num(body[[col]][base$row_id]))
  }

  lookup <- candidate_lookup %>%
    filter(election_type == "Sakrebulo SMD") %>%
    select(result_key, party_num, party_id, name_ka)

  vote_wide %>%
    pivot_longer(cols = all_of(headers[candidate_cols]), names_to = "party_num", values_to = "votes") %>%
    mutate(party_num = as.character(party_num), votes = as.integer(coalesce(votes, 0L))) %>%
    left_join(lookup, by = c("result_key", "party_num")) %>%
    mutate(
      party_id = coalesce(party_id, paste0("local2019_council_", result_key, "_", party_num)),
      name_ka = coalesce(name_ka, ""),
      turnout_pct = round(voted / registered, 6),
      noon_pct = round(voted_noon / registered, 6),
      five_pct = round(voted_5pm / registered, 6),
      invalid_pct = round(invalid_ballots / voted, 6)
    )
}

summarise_2019_mayor_dist <- function(df_long) {
  turn <- df_long %>%
    distinct(selfgov_id, precinct_id, .keep_all = TRUE) %>%
    group_by(selfgov_id) %>%
    summarise(
      registered = sum(registered, na.rm = TRUE),
      main_list = sum(main_list, na.rm = TRUE),
      special_list = sum(special_list, na.rm = TRUE),
      voted = sum(voted, na.rm = TRUE),
      voted_noon = sum(voted_noon, na.rm = TRUE),
      voted_5pm = sum(voted_5pm, na.rm = TRUE),
      invalid_ballots = sum(invalid_ballots, na.rm = TRUE),
      .groups = "drop"
    ) %>%
    mutate(
      turnout_pct = round(voted / registered, 6),
      noon_pct = round(voted_noon / registered, 6),
      five_pct = round(voted_5pm / registered, 6),
      invalid_pct = round(invalid_ballots / voted, 6)
    )

  party <- df_long %>%
    group_by(selfgov_id, party_id, party_num, name_ka) %>%
    summarise(votes = sum(votes, na.rm = TRUE), .groups = "drop") %>%
    filter(votes > 0)

  valid <- party %>%
    group_by(selfgov_id) %>%
    summarise(total_valid = sum(votes), .groups = "drop")

  local <- party %>%
    left_join(valid, by = "selfgov_id") %>%
    left_join(turn, by = "selfgov_id") %>%
    mutate(
      district_id = as.character(selfgov_id),
      round = 1L,
      vote_share = round(votes / total_valid, 6)
    ) %>%
    select(district_id, party_id, party_num, name_ka, round, votes, vote_share,
           registered, voted, voted_noon, voted_5pm,
           main_list, special_list, turnout_pct, noon_pct, five_pct,
           invalid_ballots, invalid_pct)

  turn_nat <- turn %>%
    summarise(across(c(registered, voted, voted_noon, voted_5pm,
                       main_list, special_list, invalid_ballots), sum)) %>%
    mutate(
      turnout_pct = round(voted / registered, 6),
      noon_pct = round(voted_noon / registered, 6),
      five_pct = round(voted_5pm / registered, 6),
      invalid_pct = round(invalid_ballots / voted, 6)
    )

  national <- party %>%
    group_by(party_id) %>%
    summarise(votes = sum(votes), .groups = "drop") %>%
    mutate(
      district_id = "national",
      party_num = "",
      name_ka = "",
      round = 1L,
      vote_share = round(votes / sum(votes), 6),
      registered = turn_nat$registered,
      voted = turn_nat$voted,
      voted_noon = turn_nat$voted_noon,
      voted_5pm = turn_nat$voted_5pm,
      main_list = turn_nat$main_list,
      special_list = turn_nat$special_list,
      turnout_pct = turn_nat$turnout_pct,
      noon_pct = turn_nat$noon_pct,
      five_pct = turn_nat$five_pct,
      invalid_ballots = turn_nat$invalid_ballots,
      invalid_pct = turn_nat$invalid_pct
    ) %>%
    select(names(local))

  bind_rows(national, local)
}

summarise_2019_mayor_prec <- function(df_long) {
  df_long %>%
    filter(votes > 0) %>%
    group_by(precinct_id, selfgov_id, party_id, party_num, name_ka) %>%
    summarise(
      votes = sum(votes, na.rm = TRUE),
      registered = first(registered),
      voted = first(voted),
      voted_noon = first(voted_noon),
      voted_5pm = first(voted_5pm),
      invalid_ballots = first(invalid_ballots),
      .groups = "drop"
    ) %>%
    group_by(precinct_id) %>%
    mutate(vote_share = round(votes / sum(votes), 6)) %>%
    ungroup() %>%
    mutate(
      turnout_pct = round(voted / registered, 6),
      noon_pct = round(voted_noon / registered, 6),
      five_pct = round(voted_5pm / registered, 6),
      invalid_pct = round(invalid_ballots / voted, 6)
    ) %>%
    select(precinct_id, selfgov_id, party_id, party_num, name_ka, votes, vote_share,
           registered, voted, voted_noon, voted_5pm,
           turnout_pct, noon_pct, five_pct, invalid_ballots, invalid_pct)
}

summarise_2019_council_dist <- function(df_long) {
  turn <- df_long %>%
    distinct(major_id, precinct_id, .keep_all = TRUE) %>%
    group_by(major_id) %>%
    summarise(
      registered = sum(registered, na.rm = TRUE),
      main_list = sum(main_list, na.rm = TRUE),
      special_list = sum(special_list, na.rm = TRUE),
      voted = sum(voted, na.rm = TRUE),
      voted_noon = sum(voted_noon, na.rm = TRUE),
      voted_5pm = sum(voted_5pm, na.rm = TRUE),
      invalid_ballots = sum(invalid_ballots, na.rm = TRUE),
      .groups = "drop"
    ) %>%
    mutate(
      turnout_pct = round(voted / registered, 6),
      noon_pct = round(voted_noon / registered, 6),
      five_pct = round(voted_5pm / registered, 6),
      invalid_pct = round(invalid_ballots / voted, 6)
    )

  party <- df_long %>%
    group_by(major_id, party_id, name_ka) %>%
    summarise(votes = sum(votes, na.rm = TRUE), .groups = "drop") %>%
    filter(votes > 0)

  valid <- party %>%
    group_by(major_id) %>%
    summarise(total_valid = sum(votes), .groups = "drop")

  local <- party %>%
    left_join(valid, by = "major_id") %>%
    left_join(turn, by = "major_id") %>%
    mutate(
      district_id = as.character(major_id),
      round = 1L,
      vote_share = round(votes / total_valid, 6)
    ) %>%
    select(district_id, party_id, name_ka, round, votes, vote_share,
           registered, voted, voted_noon, voted_5pm,
           main_list, special_list, turnout_pct, noon_pct, five_pct,
           invalid_ballots, invalid_pct)

  turn_nat <- turn %>%
    summarise(across(c(registered, voted, voted_noon, voted_5pm,
                       main_list, special_list, invalid_ballots), sum)) %>%
    mutate(
      turnout_pct = round(voted / registered, 6),
      noon_pct = round(voted_noon / registered, 6),
      five_pct = round(voted_5pm / registered, 6),
      invalid_pct = round(invalid_ballots / voted, 6)
    )

  national <- party %>%
    group_by(party_id) %>%
    summarise(votes = sum(votes), .groups = "drop") %>%
    mutate(
      district_id = "national",
      name_ka = "",
      round = 1L,
      vote_share = round(votes / sum(votes), 6),
      registered = turn_nat$registered,
      voted = turn_nat$voted,
      voted_noon = turn_nat$voted_noon,
      voted_5pm = turn_nat$voted_5pm,
      main_list = turn_nat$main_list,
      special_list = turn_nat$special_list,
      turnout_pct = turn_nat$turnout_pct,
      noon_pct = turn_nat$noon_pct,
      five_pct = turn_nat$five_pct,
      invalid_ballots = turn_nat$invalid_ballots,
      invalid_pct = turn_nat$invalid_pct
    ) %>%
    select(names(local))

  bind_rows(national, local)
}

summarise_2019_council_prec <- function(df_long) {
  df_long %>%
    filter(votes > 0) %>%
    group_by(precinct_id, major_id, party_id, name_ka) %>%
    summarise(
      votes = sum(votes, na.rm = TRUE),
      precinct_key = first(precinct_key),
      raw_district_id = first(district),
      precinct_number = first(precinct_number),
      registered = first(registered),
      voted = first(voted),
      voted_noon = first(voted_noon),
      voted_5pm = first(voted_5pm),
      invalid_ballots = first(invalid_ballots),
      .groups = "drop"
    ) %>%
    group_by(precinct_id, major_id) %>%
    mutate(vote_share = round(votes / sum(votes), 6)) %>%
    ungroup() %>%
    mutate(
      district_id = as.character(major_id),
      turnout_pct = round(voted / registered, 6),
      noon_pct = round(voted_noon / registered, 6),
      five_pct = round(voted_5pm / registered, 6),
      invalid_pct = round(invalid_ballots / voted, 6)
    ) %>%
    select(precinct_id, precinct_key, district_id, raw_district_id, precinct_number,
           party_id, name_ka, votes, vote_share, registered, voted, voted_noon, voted_5pm,
           turnout_pct, noon_pct, five_pct, invalid_ballots, invalid_pct)
}

local2019_mayor_long <- read_2019_mayor_long(BY2019_LOCAL, candidate_2019)
local2019_council_long <- read_2019_council_long(BY2019_LOCAL, candidate_2019)

write_csv_utf8(
  summarise_2019_mayor_dist(local2019_mayor_long),
  file.path(OUT_RESULTS, "local2017_2019_byelections_smd.csv")
)
write_csv_utf8(
  summarise_2019_mayor_prec(local2019_mayor_long),
  file.path(OUT_RESULTS, "local2017_2019_byelections_smd_precincts.csv")
)
write_csv_utf8(
  summarise_2019_council_dist(local2019_council_long),
  file.path(OUT_RESULTS, "local2017_2019_byelections_council_smd.csv")
)
write_csv_utf8(
  summarise_2019_council_prec(local2019_council_long),
  file.path(OUT_RESULTS, "local2017_2019_byelections_council_smd_precincts.csv")
)

# ── Sakrebulo SMD by-elections, 27 October 2019 ────────────────────────────
cat("Processing October 2019 Sakrebulo SMD by-elections...\n")

read_2019_oct_candidate_lookup <- function(path) {
  read_excel(path, sheet = "Candidates", col_names = TRUE) %>%
    rename(election_type = Elections, result_key = District, name_ka = Name, party_text = Party) %>%
    mutate(
      result_key = str_squish(as.character(result_key)),
      name_ka = str_squish(as.character(name_ka)),
      party_text = str_squish(as.character(party_text)),
      party_num = str_extract(party_text, "^\\d+"),
      party_label = str_squish(str_remove(party_text, "^\\d+\\s+")),
      party_id = party_id_from_2019_label(party_label)
    ) %>%
    filter(!is.na(party_num), !is.na(party_id)) %>%
    select(result_key, party_num, party_id, name_ka) %>%
    distinct(result_key, party_num, .keep_all = TRUE)
}

read_2019_oct_council_long <- function(path, candidate_lookup) {
  raw <- read_excel(path, sheet = "შედეგები", col_names = FALSE, .name_repair = "minimal")
  headers <- cell_chr(unlist(raw[1, ], use.names = FALSE))
  body <- raw[-1, , drop = FALSE]
  candidate_cols <- which(str_detect(headers, "^\\d+$"))

  base <- tibble(
    row_id = seq_len(nrow(body)),
    district = as.integer(cell_num(body[[1]])),
    district_name = cell_chr(body[[2]]),
    major_label = as.integer(cell_num(body[[3]])),
    precinct_raw = cell_chr(body[[4]]),
    precinct_number = as.integer(cell_num(body[[4]])),
    main_list = as.integer(cell_num(body[[5]])),
    special_list = as.integer(cell_num(body[[6]])),
    voted_noon = as.integer(cell_num(body[[7]])),
    voted_5pm = as.integer(cell_num(body[[8]])),
    voted = as.integer(cell_num(body[[9]])),
    ballots_received = as.integer(cell_num(body[[11]])),
    invalid_ballots = as.integer(cell_num(body[[18]])),
    valid_ballots = as.integer(cell_num(body[[20]]))
  ) %>%
    filter(!is.na(district), !is.na(major_label), !is.na(precinct_number), precinct_raw != "ჯამი") %>%
    mutate(
      result_key = paste0(district, ".", str_pad(major_label, 2, pad = "0")),
      selfgov_id = to_selfgov(district),
      precinct_id = district * 1000L + precinct_number,
      registered = main_list + special_list,
      major_id_fallback = to_major_id(district, major_label)
    ) %>%
    left_join(
      precinct_join_lookup %>% select(precinct_id, MID),
      by = "precinct_id"
    ) %>%
    mutate(
      major_id = coalesce(MID, major_id_fallback),
      precinct_key = paste(major_id, district, precinct_number, sep = ".")
    ) %>%
    select(-MID, -major_id_fallback)

  vote_wide <- base
  for (col in candidate_cols) {
    vote_wide[[headers[[col]]]] <- as.integer(cell_num(body[[col]][base$row_id]))
  }

  vote_wide %>%
    pivot_longer(cols = all_of(headers[candidate_cols]), names_to = "party_num", values_to = "votes") %>%
    mutate(party_num = as.character(party_num), votes = as.integer(coalesce(votes, 0L))) %>%
    left_join(candidate_lookup, by = c("result_key", "party_num")) %>%
    mutate(
      party_id = coalesce(party_id, paste0("local2019_oct_council_", result_key, "_", party_num)),
      name_ka = coalesce(name_ka, ""),
      turnout_pct = round(voted / registered, 6),
      noon_pct = round(voted_noon / registered, 6),
      five_pct = round(voted_5pm / registered, 6),
      invalid_pct = round(invalid_ballots / voted, 6)
    )
}

candidate_2019_oct <- read_2019_oct_candidate_lookup(BY2019_OCT_COUNCIL)
local2019_oct_council_long <- read_2019_oct_council_long(BY2019_OCT_COUNCIL, candidate_2019_oct)

write_csv_utf8(
  summarise_2019_council_dist(local2019_oct_council_long),
  file.path(OUT_RESULTS, "local2017_2019_oct_byelections_council_smd.csv")
)
write_csv_utf8(
  summarise_2019_council_prec(local2019_oct_council_long),
  file.path(OUT_RESULTS, "local2017_2019_oct_byelections_council_smd_precincts.csv")
)
write_csv_utf8(smd_dist[0, ], file.path(OUT_RESULTS, "local2017_2019_oct_byelections_smd.csv"))
write_csv_utf8(smd_prec[0, ], file.path(OUT_RESULTS, "local2017_2019_oct_byelections_smd_precincts.csv"))

# ── Local by-elections, 31 October 2020: mayors + Sakrebulo SMDs ──────────
cat("Processing 2020 local by-elections...\n")

precinct_number_from_code <- function(code) {
  suppressWarnings(as.integer(str_split_fixed(cell_chr(code), fixed("."), 3)[, 3]))
}

read_2020_mayor_candidates <- function(path) {
  raw <- read_excel(path, sheet = "Mayoral candidates", col_names = FALSE, .name_repair = "minimal")
  body <- raw[-1, , drop = FALSE]
  tibble(
    selfgov_id = as.integer(cell_num(body[[1]])),
    party_num = as.character(as.integer(cell_num(body[[3]]))),
    party_label = cell_chr(body[[4]]),
    name_ka = str_squish(paste(cell_chr(body[[5]]), cell_chr(body[[6]])))
  ) %>%
    mutate(party_id = party_id_from_2019_label(party_label)) %>%
    filter(!is.na(selfgov_id), !is.na(party_num), !is.na(party_id)) %>%
    distinct(selfgov_id, party_num, .keep_all = TRUE)
}

read_2020_council_candidates <- function(path) {
  raw <- read_excel(path, sheet = "Sakrebulo candidates", col_names = FALSE, .name_repair = "minimal")
  body <- raw[-1, , drop = FALSE]
  tibble(
    district = as.integer(cell_num(body[[1]])),
    major_label = as.integer(cell_num(body[[3]])),
    party_num = as.character(as.integer(cell_num(body[[4]]))),
    party_label = cell_chr(body[[5]]),
    name_ka = str_squish(paste(cell_chr(body[[6]]), cell_chr(body[[7]])))
  ) %>%
    mutate(
      result_key = paste0(district, ".", str_pad(major_label, 2, pad = "0")),
      party_id = party_id_from_2019_label(party_label)
    ) %>%
    filter(!is.na(district), !is.na(major_label), !is.na(party_num), !is.na(party_id)) %>%
    distinct(result_key, party_num, .keep_all = TRUE) %>%
    select(result_key, party_num, party_id, name_ka)
}

read_2020_mayor_long <- function(path, sheet_name, candidate_lookup) {
  raw <- read_excel(path, sheet = sheet_name, col_names = FALSE, .name_repair = "minimal")
  headers <- cell_chr(unlist(raw[1, ], use.names = FALSE))
  body <- raw[-1, , drop = FALSE]
  candidate_cols <- which(str_detect(headers, "^\\d+"))

  valid_col <- if (sheet_name == "მერი მეორე ტური") 11L else 19L
  invalid_col <- if (sheet_name == "მერი მეორე ტური") 12L else 20L

  base <- tibble(
    row_id = seq_len(nrow(body)),
    district = as.integer(cell_num(body[[1]])),
    precinct_code = cell_chr(body[[2]]),
    precinct_number = precinct_number_from_code(body[[2]]),
    main_list = as.integer(cell_num(body[[3]])),
    special_list = as.integer(cell_num(body[[4]])),
    voted_noon = as.integer(cell_num(body[[5]])),
    voted_5pm = as.integer(cell_num(body[[6]])),
    voted = as.integer(cell_num(body[[7]])),
    ballots_received = as.integer(cell_num(body[[8]])),
    valid_ballots = as.integer(cell_num(body[[valid_col]])),
    invalid_ballots = as.integer(cell_num(body[[invalid_col]]))
  ) %>%
    filter(!is.na(district), !is.na(precinct_number), precinct_code != "ჯამი") %>%
    mutate(
      selfgov_id = to_selfgov(district),
      precinct_id = district * 1000L + precinct_number,
      registered = main_list + special_list
    )

  vote_wide <- base
  for (col in candidate_cols) {
    party_num <- str_extract(headers[[col]], "^\\d+")
    vote_wide[[party_num]] <- as.integer(cell_num(body[[col]][base$row_id]))
  }

  lookup <- candidate_lookup %>%
    mutate(selfgov_id = as.integer(selfgov_id), party_num = as.character(party_num)) %>%
    select(selfgov_id, party_num, party_id, name_ka)

  vote_cols <- unique(str_extract(headers[candidate_cols], "^\\d+"))
  vote_wide %>%
    pivot_longer(cols = all_of(vote_cols), names_to = "party_num", values_to = "votes") %>%
    mutate(party_num = as.character(party_num), votes = as.integer(coalesce(votes, 0L))) %>%
    left_join(lookup, by = c("selfgov_id", "party_num")) %>%
    mutate(
      party_id = coalesce(party_id, paste0("local2020_mayor_", selfgov_id, "_", party_num)),
      name_ka = coalesce(name_ka, ""),
      turnout_pct = round(voted / registered, 6),
      noon_pct = round(voted_noon / registered, 6),
      five_pct = round(voted_5pm / registered, 6),
      invalid_pct = round(invalid_ballots / voted, 6)
    )
}

read_2020_council_long <- function(path, candidate_lookup) {
  raw <- read_excel(path, sheet = "საკრებულო", col_names = FALSE, .name_repair = "minimal")
  headers <- cell_chr(unlist(raw[1, ], use.names = FALSE))
  body <- raw[-1, , drop = FALSE]
  candidate_cols <- which(str_detect(headers, "^\\d+$"))

  base <- tibble(
    row_id = seq_len(nrow(body)),
    district = as.integer(cell_num(body[[1]])),
    precinct_code = cell_chr(body[[2]]),
    precinct_number = precinct_number_from_code(body[[2]]),
    main_list = as.integer(cell_num(body[[3]])),
    special_list = as.integer(cell_num(body[[4]])),
    voted_noon = as.integer(cell_num(body[[5]])),
    voted_5pm = as.integer(cell_num(body[[6]])),
    voted = as.integer(cell_num(body[[7]])),
    ballots_received = as.integer(cell_num(body[[8]])),
    valid_ballots = as.integer(cell_num(body[[16]])),
    invalid_ballots = as.integer(cell_num(body[[17]])),
    major_label = as.integer(cell_num(body[[18]]))
  ) %>%
    filter(!is.na(district), !is.na(major_label), !is.na(precinct_number), precinct_code != "ჯამი") %>%
    mutate(
      result_key = paste0(district, ".", str_pad(major_label, 2, pad = "0")),
      selfgov_id = to_selfgov(district),
      precinct_id = district * 1000L + precinct_number,
      registered = main_list + special_list,
      major_id_fallback = to_major_id(district, major_label)
    ) %>%
    left_join(
      precinct_join_lookup %>% select(precinct_id, MID),
      by = "precinct_id"
    ) %>%
    mutate(
      major_id = coalesce(MID, major_id_fallback),
      precinct_key = paste(major_id, district, precinct_number, sep = ".")
    ) %>%
    select(-MID, -major_id_fallback)

  vote_wide <- base
  for (col in candidate_cols) {
    vote_wide[[headers[[col]]]] <- as.integer(cell_num(body[[col]][base$row_id]))
  }

  lookup <- candidate_lookup %>%
    select(result_key, party_num, party_id, name_ka)

  vote_wide %>%
    pivot_longer(cols = all_of(headers[candidate_cols]), names_to = "party_num", values_to = "votes") %>%
    mutate(party_num = as.character(party_num), votes = as.integer(coalesce(votes, 0L))) %>%
    left_join(lookup, by = c("result_key", "party_num")) %>%
    mutate(
      party_id = coalesce(party_id, paste0("local2020_council_", result_key, "_", party_num)),
      name_ka = coalesce(name_ka, ""),
      turnout_pct = round(voted / registered, 6),
      noon_pct = round(voted_noon / registered, 6),
      five_pct = round(voted_5pm / registered, 6),
      invalid_pct = round(invalid_ballots / voted, 6)
    )
}

candidate_2020_mayor <- read_2020_mayor_candidates(BY2020_LOCAL)
candidate_2020_council <- read_2020_council_candidates(BY2020_LOCAL)
local2020_mayor_long <- read_2020_mayor_long(BY2020_LOCAL, "მერი", candidate_2020_mayor)
local2020_council_long <- read_2020_council_long(BY2020_LOCAL, candidate_2020_council)
local2020_mayor_r2_long <- read_2020_mayor_long(BY2020_MAYOR_R2, "მერი მეორე ტური", candidate_2020_mayor)

write_csv_utf8(
  summarise_2019_mayor_dist(local2020_mayor_long),
  file.path(OUT_RESULTS, "local2017_2020_byelections_smd.csv")
)
write_csv_utf8(
  summarise_2019_mayor_prec(local2020_mayor_long),
  file.path(OUT_RESULTS, "local2017_2020_byelections_smd_precincts.csv")
)
write_csv_utf8(
  summarise_2019_council_dist(local2020_council_long),
  file.path(OUT_RESULTS, "local2017_2020_byelections_council_smd.csv")
)
write_csv_utf8(
  summarise_2019_council_prec(local2020_council_long),
  file.path(OUT_RESULTS, "local2017_2020_byelections_council_smd_precincts.csv")
)

write_csv_utf8(
  summarise_2019_mayor_dist(local2020_mayor_r2_long) %>% mutate(round = 2L),
  file.path(OUT_RESULTS, "local2017_2020_byelections_smd_runoff.csv")
)
write_csv_utf8(
  summarise_2019_mayor_prec(local2020_mayor_r2_long),
  file.path(OUT_RESULTS, "local2017_2020_byelections_smd_runoff_precincts.csv")
)
write_csv_utf8(maj_dist[0, ], file.path(OUT_RESULTS, "local2017_2020_byelections_council_smd_runoff.csv"))
write_csv_utf8(maj_prec[0, ], file.path(OUT_RESULTS, "local2017_2020_byelections_council_smd_runoff_precincts.csv"))

# ════════════════════════════════════════════════════════════════════════════
# 5. SEATS from elected politicians list
# ════════════════════════════════════════════════════════════════════════════
cat("Processing seat composition from elected politicians list...\n")

normalise_selfgov_key <- function(x) {
  x <- str_squish(as.character(x))
  x <- str_remove(x, "^თვითმმართველი\\s+ქალაქის\\s*-\\s*")
  # A couple of Georgian genitive forms do not reduce to the same stem by
  # suffix stripping alone; normalise them before joining to district names.
  x <- dplyr::recode(
    x,
    "ყვარლის" = "ყვარელ",
    "გარდაბნის" = "გარდაბან",
    .default = x
  )
  str_replace(x, "(ის|ოს|ს)$", "")
}

strip_final_vowel <- function(x) str_replace(x, "[აეიოუ]$", "")

infer_elected_party <- function(party_num, presenter) {
  mapped <- unname(PARTY_MAP[party_num])
  dplyr::case_when(
    !is.na(mapped) ~ mapped,
    str_detect(coalesce(presenter, ""), "ქართული ოცნება") ~ "gd",
    str_detect(coalesce(presenter, ""), "დამოუკიდებელი") ~ "independent",
    is.na(party_num) ~ "independent",
    TRUE ~ "initiative_group"
  )
}

raw_pr_candidates <- read_excel(CANDS_PATH, sheet = "PR candidates")
raw_elected <- read_excel(CANDS_PATH, sheet = "elected politicians")

selfgov_lookup <- raw_pr_candidates %>%
  transmute(
    selfgov_id = suppressWarnings(as.integer(district_number)),
    district_name = as.character(district_name)
  ) %>%
  distinct() %>%
  mutate(
    selfgov_id = if_else(district_name == "თბილისი", 1L, selfgov_id),
    selfgov_id = to_selfgov(selfgov_id),
    key_base = normalise_selfgov_key(district_name),
    key_stem = strip_final_vowel(key_base)
  ) %>%
  pivot_longer(c(key_base, key_stem), values_to = "selfgov_key") %>%
  filter(!is.na(selfgov_id), !is.na(selfgov_key), selfgov_key != "") %>%
  distinct(selfgov_key, .keep_all = TRUE) %>%
  select(selfgov_key, selfgov_id)

elected <- raw_elected %>%
  transmute(
    vote_type = str_to_lower(str_squish(as.character(election_type))),
    selfgov_key = normalise_selfgov_key(local_governing_unit),
    party_num = as.character(suppressWarnings(as.integer(party_number))),
    presenter = as.character(presenter_or_party)
  ) %>%
  left_join(selfgov_lookup, by = "selfgov_key") %>%
  mutate(party_id = infer_elected_party(party_num, presenter)) %>%
  filter(vote_type %in% c("pr", "smd", "mayor"), !is.na(selfgov_id), !is.na(party_id))

if (nrow(elected) != nrow(raw_elected)) {
  cat("  Warning: mapped elected rows:", nrow(elected), "of", nrow(raw_elected), "\n")
}

seats_pr <- elected %>%
  filter(vote_type == "pr") %>%
  group_by(selfgov_id, party_id) %>%
  summarise(seats_pr = n(), .groups = "drop")

seats_smd <- elected %>%
  filter(vote_type == "smd") %>%
  group_by(selfgov_id, party_id) %>%
  summarise(seats_smd = n(), .groups = "drop")

seats_mayor <- elected %>%
  filter(vote_type == "mayor") %>%
  group_by(selfgov_id, party_id) %>%
  summarise(seats_mayor = n(), .groups = "drop")

seats_by_unit <- seats_pr %>%
  full_join(seats_smd, by = c("selfgov_id", "party_id")) %>%
  full_join(seats_mayor, by = c("selfgov_id", "party_id")) %>%
  mutate(
    seats_pr = as.integer(coalesce(seats_pr, 0L)),
    seats_smd = as.integer(coalesce(seats_smd, 0L)),
    seats_mayor = as.integer(coalesce(seats_mayor, 0L)),
    selfgov_id = as.character(selfgov_id)
  )

seats_national <- seats_by_unit %>%
  group_by(party_id) %>%
  summarise(
    seats_pr = sum(seats_pr),
    seats_smd = sum(seats_smd),
    seats_mayor = sum(seats_mayor),
    .groups = "drop"
  ) %>%
  mutate(selfgov_id = "national") %>%
  select(selfgov_id, party_id, seats_pr, seats_smd, seats_mayor)

seats_final <- bind_rows(seats_national, seats_by_unit) %>%
  select(selfgov_id, party_id, seats_pr, seats_smd, seats_mayor)

write_csv_utf8(seats_final, file.path(OUT_RESULTS, "local2017_seats.csv"))
cat("  Total PR seats:", sum(seats_national$seats_pr), "\n")
cat("  Total SMD seats:", sum(seats_national$seats_smd), "\n")
cat("  Total Mayor seats:", sum(seats_national$seats_mayor), "\n")

cat("\nDone!\n")
