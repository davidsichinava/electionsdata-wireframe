#!/usr/bin/env Rscript
# Processes raw 2014 local election data into dashboard CSV files.
# Run from project root:
#   Rscript src/loaders/process_local2014.R

suppressPackageStartupMessages({
  library(readxl)
  library(dplyr)
  library(tidyr)
  library(stringr)
  library(yaml)
  library(jsonlite)
  library(sf)
})

RAW_RESULTS <- "src/data/raw/2014 საკრებულო, მერი და გამგებელი პირველი და მეორე ტური.xlsx"
BY2014_OCT <- "src/data/raw/2014 შუალედური.xlsx"
BY2015_MAY <- "src/data/raw/2015 შუალედური მაისი.xlsx"
BY2015_OCT <- "src/data/raw/2015 შუალედური ოქტომბერი საკრებულო.xlsx"
BY2016_MAY <- "src/data/raw/2016 შუალედური მაისი.xlsx"
BY2016_GARDABANI <- "src/data/raw/2016_გარდაბანი_რიგგარეშე.xlsx"
CANDIDATES_FILE <- "src/data/raw/adg_2014_candidates_unified_corrected.xlsx"
ELECTED_FILE <- "src/data/raw/adg_2014_elected_politicians.xlsx"
BY2016_OCT <- list.files("src/data/raw", full.names = TRUE, pattern = "^2016_.*8_.*[.]xlsx$")[[1]]
BY2016_OCT30 <- list.files("src/data/raw", full.names = TRUE, pattern = "^2016_.*30_.*[.]xlsx$")[[1]]
BY2016_OCT_MAYOR <- list.files("src/data/raw", full.names = TRUE, pattern = "^2016_.*[.]xlsx$")
BY2016_OCT_MAYOR <- BY2016_OCT_MAYOR[
  str_detect(basename(BY2016_OCT_MAYOR), "ოქტომბერი") &
    str_detect(basename(BY2016_OCT_MAYOR), "მერი")
][[1]]
PRECINCT_GEO <- "src/data/shp/local2014_precincts.geojson"
PARL2016_PRECINCT_GEO <- "src/data/shp/parl2016_pr_precincts.geojson"
SELFGOV_GEO <- "src/data/shp/selfgov_areas_2014.geojson"
COUNCIL_SMD_GEO <- "src/data/shp/majoritarian_2014_major_id.geojson"
BY2016_OCT_PRECINCT_GEO <- "src/data/shp/local2014_2016_oct_precincts.geojson"
BY2016_OCT30_PRECINCT_GEO <- "src/data/shp/local2014_2016_oct30_precincts.geojson"
BY2016_OCT_MAYOR_PRECINCT_GEO <- "src/data/shp/local2014_2016_oct_mayor_precincts.geojson"

OUT_RESULTS <- "src/data/results"
OUT_CANDIDATES <- "src/data/candidates"
OUT_CANDIDATE_CONFIG <- "src/data/config/candidates/local"
OUT_TURNOUT <- "src/data/turnout"
dir.create(OUT_RESULTS, showWarnings = FALSE, recursive = TRUE)
dir.create(OUT_CANDIDATES, showWarnings = FALSE, recursive = TRUE)
dir.create(OUT_CANDIDATE_CONFIG, showWarnings = FALSE, recursive = TRUE)
dir.create(OUT_TURNOUT, showWarnings = FALSE, recursive = TRUE)

REBUILD_GEO <- tolower(Sys.getenv("REBUILD_LOCAL2014_GEO", unset = "false")) %in% c("1", "true", "yes")

CITY_SPLITS <- c("17" = 171L, "27" = 271L, "32" = 321L, "37" = 371L,
                 "44" = 441L, "60" = 601L, "67" = 671L)
TBILISI_DISTRICTS <- 1:10

PARTY_MAP <- c(
  "1"  = "nonparliamentary_opposition_2014",
  "2"  = "veterans_patriots_2014",
  "3"  = "burjanadze_united_opposition_2014",
  "4"  = "national_democratic_2014",
  "5"  = "unm",
  "6"  = "greens_2014",
  "7"  = "ufali_2014",
  "8"  = "patriots",
  "9"  = "self_governance_people_2014",
  "10" = "peoples_party_2014",
  "11" = "reformers_2014",
  "12" = "our_georgia_2014",
  "13" = "future_georgia_2014",
  "14" = "georgian_party_2014",
  "15" = "peoples_movement_2014",
  "16" = "christian_democrats_2014",
  "17" = "unity_hall_2014",
  "18" = "georgias_way_2014",
  "19" = "freedom_zviads_way_2014",
  "20" = "labour",
  "24" = "peoples_authority_2016",
  "26" = "sakhalkho_party_2014",
  "30" = "kostava_society",
  "33" = "free_democrats",
  "36" = "workers_council_2014",
  "41" = "gd",
  setNames(rep("independent", 12), as.character(42:53))
)

PARTY_MAP_2016 <- PARTY_MAP
PARTY_MAP_2016[c("1", "6", "26", "27")] <- c(
  "burchuladze",
  "republicans_2016",
  "national_forum",
  "free_democrats"
)

PARTY_ALIASES_KA <- c(
  "nonparliamentary_opposition_2014" = "არასაპარლამენტო ოპოზიცია (კახა კუკავა, ფიქრია ჩიხრაძე)",
  "veterans_patriots_2014" = "საქართველოს ძალოვან ვეტერანთა და პატრიოტთა პოლიტიკური მოძრაობა",
  "burjanadze_united_opposition_2014" = "ნინო ბურჯანაძე - ერთიანი ოპოზიცია",
  "national_democratic_2014" = "ეროვნულ-დემოკრატიული პარტია (ედპ)",
  "unm" = "ერთიანი ნაციონალური მოძრაობა",
  "greens_2014" = "გიორგი გაჩეჩილაძე - მწვანეთა პარტია",
  "ufali_2014" = "უფლის სახელით - უფალია ჩვენი სიმართლე",
  "patriots" = "დავით თარხან-მოურავი - საქართველოს პატრიოტთა ალიანსი",
  "self_governance_people_2014" = "თვითმმართველობა ხალხს!",
  "peoples_party_2014" = "ხალხის პარტია",
  "reformers_2014" = "ირაკლი ღლონტი - რეფორმატორები",
  "our_georgia_2014" = "ჩვენი საქართველო",
  "future_georgia_2014" = "მომავალი საქართველო",
  "georgian_party_2014" = "ირაკლი ოქრუაშვილი - ქართული პარტია",
  "peoples_movement_2014" = "სახალხო მოძრაობა",
  "christian_democrats_2014" = "ქრისტიან დემოკრატიული პარტია (ქრისტიან დემოკრატები)",
  "unity_hall_2014" = "ერთიანობის დარბაზი",
  "georgias_way_2014" = "სალომე ზურაბიშვილი - საქართველოს გზა",
  "freedom_zviads_way_2014" = "თავისუფლება - ზვიად გამსახურდიას გზა",
  "labour" = "შალვა ნათელაშვილი - საქართველოს ლეიბორისტული პარტია",
  "sakhalkho_party_2014" = "სახალხო პარტია",
  "kostava_society" = "მერაბ კოსტავას საზოგადოება",
  "workers_council_2014" = "საქართველოს მშრომელთა საბჭო",
  "gd" = "ქართული ოცნება",
  "independent" = "დამოუკიდებელი"
)

round6 <- function(x) floor(x * 1000000 + 0.5) / 1000000

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

cell_int <- function(x) {
  suppressWarnings(as.integer(as.numeric(as.character(x))))
}

pick_int <- function(df, cols) {
  out <- rep(NA_integer_, nrow(df))
  for (col in cols) {
    if (col %in% names(df)) {
      out <- coalesce(out, cell_int(df[[col]]))
    }
  }
  out
}

parse_precinct_id <- function(district, precinct) {
  as.integer(district) * 1000L + as.integer(precinct)
}

parse_major_local <- function(major, district = NA_integer_) {
  text <- cell_chr(major)
  out <- suppressWarnings(as.integer(as.numeric(text)))
  multi_part <- str_detect(text, "^\\d+\\.\\d+\\.")
  if (any(multi_part, na.rm = TRUE)) {
    parts <- str_split_fixed(text[multi_part], "\\.", 3)
    out[multi_part] <- suppressWarnings(as.integer(parts[, 2]))
  }
  has_decimal <- str_detect(text, "\\.")
  decimal_value <- suppressWarnings(as.numeric(text))
  decimal_rows <- has_decimal & !multi_part & !is.na(decimal_value)
  out[decimal_rows] <- as.integer(round((decimal_value[decimal_rows] %% 1) * 100))
  # The May 2016 Ozurgeti candidate sheet stores 60.04 as an Excel-formatted value.
  out[as.integer(district) == 60L & text == "58444"] <- 4L
  out
}

party_id_for_num <- function(num, map = PARTY_MAP) {
  out <- unname(map[as.character(num)])
  out[is.na(out)] <- "unknown_2014"
  out
}

write_csv_utf8 <- function(df, path) {
  write.csv(df, path, row.names = FALSE, fileEncoding = "UTF-8")
  cat("  Written:", path, "\n")
}

write_geo_atomic <- function(x, path) {
  if (!REBUILD_GEO) {
    message("  Skipping GeoJSON write: ", path, " (set REBUILD_LOCAL2014_GEO=true to rebuild)")
    return(invisible(FALSE))
  }
  tmp <- tempfile(fileext = ".geojson")
  on.exit(unlink(tmp), add = TRUE)
  st_write(x, tmp, delete_dsn = TRUE, quiet = TRUE)
  invisible(file.copy(tmp, path, overwrite = TRUE))
}

map_city_selfgov <- function(d) {
  d <- as.integer(d)
  city <- unname(CITY_SPLITS[as.character(d)])
  out <- if_else(!is.na(city), as.integer(city), d)
  if_else(out %in% TBILISI_DISTRICTS, 1L, out)
}

normalize_selfgov_geo <- function() {
  selfgov <- st_read(SELFGOV_GEO, quiet = TRUE)
  props <- st_drop_geometry(selfgov)
  selfgov_id <- pick_int(props, c("selfgov_id", "self_gov_id", "District", "id"))
  selfgov$id <- selfgov_id
  selfgov$district_id <- selfgov_id
  selfgov$selfgov_id <- selfgov_id
  if ("En_Name" %in% names(selfgov)) selfgov$name_en <- as.character(selfgov$En_Name)
  if ("Ka_Name" %in% names(selfgov)) selfgov$name_ka <- as.character(selfgov$Ka_Name)
  write_geo_atomic(selfgov, SELFGOV_GEO)
}

read_precinct_selfgov_lookup <- function() {
  precincts <- st_read(PRECINCT_GEO, quiet = TRUE)
  attrs <- st_drop_geometry(precincts)
  precinct_id <- pick_int(attrs, c("id", "precinct_id", "PrecID"))
  district_id <- coalesce(
    pick_int(attrs, c("district_id", "District")),
    as.integer(floor(precinct_id / 1000L))
  )
  precinct_number <- coalesce(
    pick_int(attrs, c("precinct_number", "Precinct")),
    as.integer(precinct_id %% 1000L)
  )
  selfgov_id <- pick_int(attrs, c("selfgov_id", "self_gov_id", "Mayor"))

  if (all(!is.na(selfgov_id))) {
    return(tibble(
      precinct_id = precinct_id,
      district_id = district_id,
      precinct_number = precinct_number,
      selfgov_id = selfgov_id
    ) %>%
      filter(!is.na(precinct_id)) %>%
      distinct(precinct_id, .keep_all = TRUE))
  }

  selfgov <- st_read(SELFGOV_GEO, quiet = TRUE)

  precincts <- st_make_valid(precincts)
  selfgov <- st_make_valid(selfgov)
  if (st_crs(precincts) != st_crs(selfgov)) {
    selfgov <- st_transform(selfgov, st_crs(precincts))
  }

  pts <- st_point_on_surface(st_geometry(precincts))
  hits <- st_intersects(pts, st_geometry(selfgov))
  hit_codes <- vector("integer", length(hits))

  for (i in seq_along(hits)) {
    raw_d <- district_id[[i]]
    city_code <- unname(CITY_SPLITS[as.character(raw_d)])
    allowed <- if (raw_d %in% TBILISI_DISTRICTS) {
      1L
    } else if (is.na(city_code)) {
      raw_d
    } else {
      c(raw_d, city_code)
    }
    matched <- pick_int(st_drop_geometry(selfgov[hits[[i]], ]), c("selfgov_id", "District", "id"))
    matched <- matched[matched %in% allowed]
    hit_codes[[i]] <- if (length(matched)) matched[[1]] else coalesce(selfgov_id[[i]], map_city_selfgov(raw_d))
  }

  tibble(
    precinct_id = precinct_id,
    district_id = district_id,
    precinct_number = precinct_number,
    selfgov_id = hit_codes
  ) %>%
    filter(!is.na(precinct_id)) %>%
    distinct(precinct_id, .keep_all = TRUE)
}

normalize_precinct_geo <- function(lookup) {
  precincts <- st_read(PRECINCT_GEO, quiet = TRUE)
  council_smd <- st_read(COUNCIL_SMD_GEO, quiet = TRUE)
  precinct_props <- st_drop_geometry(precincts)
  precinct_id <- pick_int(precinct_props, c("id", "precinct_id", "PrecID"))
  district_id <- coalesce(
    pick_int(precinct_props, c("district_id", "District")),
    as.integer(floor(precinct_id / 1000L))
  )
  precinct_number <- coalesce(
    pick_int(precinct_props, c("precinct_number", "Precinct")),
    as.integer(precinct_id %% 1000L)
  )
  precinct_mid <- pick_int(precinct_props, c("maj_id", "major_id", "MID"))

  missing_mid <- which(is.na(precinct_mid))
  if (length(missing_mid)) {
    if (st_crs(precincts) != st_crs(council_smd)) {
      council_smd <- st_transform(council_smd, st_crs(precincts))
    }
    council_props <- st_drop_geometry(council_smd)
    council_major_id <- pick_int(council_props, c("maj_id", "major_id", "MID", "id"))
    council_selfgov_id <- pick_int(council_props, c("selfgov_id", "self_gov_id", "District", "district_id"))

    precinct_pts <- st_point_on_surface(st_geometry(st_make_valid(precincts[missing_mid, ])))
    smd_hits <- st_intersects(precinct_pts, st_geometry(st_make_valid(council_smd)))
    for (j in seq_along(missing_mid)) {
      i <- missing_mid[[j]]
      hit <- smd_hits[[j]]
      if (length(hit)) {
        precinct_mid[[i]] <- council_major_id[[hit[[1]]]]
        next
      }
      same_district <- council_smd[council_selfgov_id == district_id[[i]], ]
      same_major_ids <- council_major_id[council_selfgov_id == district_id[[i]]]
      if (!nrow(same_district)) next
      intersections <- suppressWarnings(st_intersection(
        st_make_valid(same_district),
        st_make_valid(precincts[i, ])
      ))
      if (!nrow(intersections)) next
      areas <- as.numeric(st_area(intersections))
      precinct_mid[[i]] <- as.integer(same_major_ids[[which.max(areas)]])
    }
  }

  precincts <- precincts %>%
    select(-any_of(c("PrecID", "District", "Precinct", "selfgov_id", "self_gov_id", "Mayor", "MID", "major_id", "maj_id", "district_id", "precinct_id", "precinct_number"))) %>%
    mutate(
      id = precinct_id,
      precinct_id = precinct_id,
      PrecID = precinct_id,
      district_id = district_id,
      District = district_id,
      precinct_number = precinct_number,
      Precinct = precinct_number,
      maj_id = precinct_mid,
      MID = precinct_mid,
      major_id = precinct_mid
    ) %>%
    left_join(lookup %>% select(precinct_id, selfgov_id), by = "precinct_id") %>%
    mutate(
      selfgov_id = coalesce(as.integer(selfgov_id), map_city_selfgov(district_id)),
      self_gov_id = selfgov_id,
      Mayor = selfgov_id
    )
  write_geo_atomic(precincts, PRECINCT_GEO)
}

normalize_council_smd_geo <- function() {
  smd <- st_read(COUNCIL_SMD_GEO, quiet = TRUE)
  props <- st_drop_geometry(smd)
  major_id <- pick_int(props, c("maj_id", "major_id", "MID"))
  major_id <- coalesce(major_id, pick_int(props, c("id")))
  selfgov_id <- pick_int(props, c("selfgov_id", "self_gov_id", "District", "district_id"))
  selfgov_id <- coalesce(selfgov_id, as.integer(floor(major_id / 100L)))
  major_local <- coalesce(pick_int(props, c("major", "maj_dcode")), as.integer(major_id %% 100L))
  smd$id <- major_id
  smd$maj_id <- major_id
  smd$MID <- major_id
  smd$major_id <- major_id
  smd$selfgov_id <- selfgov_id
  smd$self_gov_id <- selfgov_id
  smd$district_id <- selfgov_id
  smd$major <- major_local
  if (!"name_en" %in% names(smd)) smd$name_en <- paste0("District ", selfgov_id, " N", major_local)
  if (!"name_ka" %in% names(smd)) smd$name_ka <- paste0("District ", selfgov_id, " N", major_local)
  write_geo_atomic(smd, COUNCIL_SMD_GEO)
}

precinct_selfgov <- read_precinct_selfgov_lookup()
if (REBUILD_GEO) {
  normalize_selfgov_geo()
  normalize_precinct_geo(precinct_selfgov)
  normalize_council_smd_geo()
} else {
  message("Skipping 2014 base GeoJSON normalization; using existing shapefiles.")
}

read_result_sheet <- function(sheet, kind) {
  raw <- read_excel(RAW_RESULTS, sheet = sheet, col_names = FALSE)
  raw <- raw[, colSums(is.na(raw)) < nrow(raw)]
  has_harmonized_ids <- identical(str_to_lower(cell_chr(raw[[1]][[1]])), "id")

  if (kind == "pr") {
    code_row <- raw[1, ]
    data <- raw[-1, ]
    if (has_harmonized_ids) {
      base <- list(id = 1L, selfgov = 2L, major_id = 3L, district = 4L,
                   precinct = 5L, main = 6L, special = 7L, noon = 8L,
                   five = 9L, voted = 10L, received = 11L, party_start = 12L)
    } else {
      base <- list(district = 1L, precinct = 2L, main = 3L, special = 4L,
                   noon = 5L, five = 6L, voted = 7L, received = 8L,
                   party_start = 9L)
    }
  } else if (kind == "major") {
    code_row <- raw[2, ]
    data <- raw[-c(1, 2), ]
    if (has_harmonized_ids) {
      base <- list(id = 1L, selfgov = 2L, major_id = 3L, district = 4L,
                   major = 5L, sub = 6L, precinct = 7L, main = 8L,
                   special = 9L, noon = 10L, five = 11L, voted = 12L,
                   received = 13L, party_start = 14L)
    } else {
      base <- list(district = 1L, major = 2L, sub = 3L, precinct = 4L,
                   main = 5L, special = 6L, noon = 7L, five = 8L,
                   voted = 9L, received = 10L, party_start = 11L)
    }
  } else {
    code_row <- raw[2, ]
    data <- raw[-c(1, 2), ]
    if (has_harmonized_ids) {
      base <- list(id = 1L, selfgov = 2L, major_id = 3L, district = 4L,
                   precinct = 5L, main = 6L, special = 7L, noon = 8L,
                   five = 9L, voted = 10L, received = 11L, party_start = 12L)
    } else {
      base <- list(district = 1L, precinct = 2L, main = 3L, special = 4L,
                   noon = 5L, five = 6L, voted = 7L, received = 8L,
                   party_start = 9L)
    }
  }

  code_vals <- cell_chr(unlist(code_row, use.names = FALSE))
  party_cols <- which(str_detect(code_vals, "^\\d+$|^\\d+\\D"))
  party_cols <- party_cols[party_cols >= base$party_start]
  party_codes <- str_extract(code_vals[party_cols], "^\\d+")

  invalid_col <- which(str_detect(cell_chr(unlist(raw[1, ], use.names = FALSE)), "ბათილი"))
  if (!length(invalid_col)) invalid_col <- ncol(raw)
  invalid_col <- invalid_col[[length(invalid_col)]]

  district <- as.integer(cell_num(data[[base$district]]))
  precinct <- as.integer(cell_num(data[[base$precinct]]))
  keep <- !is.na(district) & district > 0 & !is.na(precinct) & precinct > 0
  raw_precinct_id <- if (!is.null(base$id)) cell_int(data[[base$id]]) else parse_precinct_id(district, precinct)
  raw_selfgov_id <- if (!is.null(base$selfgov)) cell_int(data[[base$selfgov]]) else rep(NA_integer_, length(district))
  raw_major_id <- if (!is.null(base$major_id)) cell_int(data[[base$major_id]]) else rep(NA_integer_, length(district))

  wide <- tibble(
    district_raw = district[keep],
    precinct_number = precinct[keep],
    precinct_id = coalesce(raw_precinct_id[keep], parse_precinct_id(district[keep], precinct[keep])),
    selfgov_id = raw_selfgov_id[keep],
    main_list = as.integer(cell_num(data[[base$main]])[keep]),
    special_list = as.integer(cell_num(data[[base$special]])[keep]),
    voted_noon = as.integer(cell_num(data[[base$noon]])[keep]),
    voted_5pm = as.integer(cell_num(data[[base$five]])[keep]),
    voted = as.integer(cell_num(data[[base$voted]])[keep]),
    ballots_received = as.integer(cell_num(data[[base$received]])[keep]),
    invalid_ballots = as.integer(cell_num(data[[invalid_col]])[keep])
  ) %>%
    mutate(registered = main_list + special_list)

  if (kind == "major") {
    major <- as.integer(cell_num(data[[base$major]])[keep])
    sub <- suppressWarnings(as.integer(as.character(data[[base$sub]][keep])))
    wide <- wide %>%
      mutate(
        major_local = major,
        major_sub = sub,
        major_id = coalesce(raw_major_id[keep], district_raw * 100L + major_local)
      )
  }

  votes <- as_tibble(data[keep, party_cols, drop = FALSE])
  names(votes) <- paste0("vote_", party_codes)

  bind_cols(wide, votes) %>%
    mutate(across(starts_with("vote_"), cell_num)) %>%
    pivot_longer(starts_with("vote_"), names_to = "party_col", values_to = "votes") %>%
    mutate(
      party_num = str_remove(party_col, "^vote_"),
      party_id = party_id_for_num(party_num),
      votes = as.integer(cell_num(votes))
    ) %>%
    select(-party_col)
}

base_totals <- function(df, group_cols) {
  df %>%
    distinct(across(all_of(group_cols)), precinct_id, .keep_all = TRUE) %>%
    group_by(across(all_of(group_cols))) %>%
    summarise(
      registered = sum(registered, na.rm = TRUE),
      voted = sum(voted, na.rm = TRUE),
      voted_noon = sum(voted_noon, na.rm = TRUE),
      voted_5pm = sum(voted_5pm, na.rm = TRUE),
      main_list = sum(main_list, na.rm = TRUE),
      special_list = sum(special_list, na.rm = TRUE),
      invalid_ballots = sum(invalid_ballots, na.rm = TRUE),
      .groups = "drop"
    )
}

summarise_results <- function(df, group_cols, include_party_num = FALSE, include_name = FALSE) {
  vote_group_cols <- c(group_cols, "party_id")
  if (include_party_num) vote_group_cols <- c(vote_group_cols, "party_num")
  if (include_name && "name_ka" %in% names(df)) vote_group_cols <- c(vote_group_cols, "name_ka")

  votes <- df %>%
    group_by(across(all_of(vote_group_cols))) %>%
    summarise(votes = sum(votes, na.rm = TRUE), .groups = "drop")

  totals <- votes %>%
    group_by(across(all_of(group_cols))) %>%
    summarise(totalVotes = sum(votes, na.rm = TRUE), .groups = "drop")

  votes %>%
    left_join(totals, by = group_cols) %>%
    left_join(base_totals(df, group_cols), by = group_cols) %>%
    mutate(
      vote_share = if_else(totalVotes > 0, round6(votes / totalVotes), 0),
      turnout_pct = if_else(registered > 0, round6(voted / registered), 0),
      noon_pct = if_else(registered > 0, round6(voted_noon / registered), 0),
      five_pct = if_else(registered > 0, round6(voted_5pm / registered), 0),
      invalid_pct = if_else(voted > 0, round6(invalid_ballots / voted), 0)
    ) %>%
    select(-totalVotes)
}

add_national <- function(df, id_col = "district_id", id_value = "national", include_party_num = FALSE, include_name = FALSE) {
  national <- df %>%
    mutate(!!id_col := id_value) %>%
    summarise_results(id_col, include_party_num = include_party_num, include_name = include_name)
  bind_rows(national, df)
}

make_precinct_results <- function(df, id_cols, include_party_num = FALSE, include_name = FALSE) {
  out <- df %>%
    group_by(across(all_of(c(id_cols, "precinct_id", "party_id",
                            if (include_party_num) "party_num" else NULL,
                            if (include_name && "name_ka" %in% names(df)) "name_ka" else NULL)))) %>%
    summarise(
      votes = sum(votes, na.rm = TRUE),
      registered = first(registered),
      voted = first(voted),
      voted_noon = first(voted_noon),
      voted_5pm = first(voted_5pm),
      invalid_ballots = first(invalid_ballots),
      .groups = "drop"
    ) %>%
    group_by(across(all_of(c(id_cols, "precinct_id")))) %>%
    mutate(totalVotes = sum(votes, na.rm = TRUE)) %>%
    ungroup() %>%
    mutate(
      vote_share = if_else(totalVotes > 0, round6(votes / totalVotes), 0),
      turnout_pct = if_else(registered > 0, round6(voted / registered), 0),
      noon_pct = if_else(registered > 0, round6(voted_noon / registered), 0),
      five_pct = if_else(registered > 0, round6(voted_5pm / registered), 0),
      invalid_pct = if_else(voted > 0, round6(invalid_ballots / voted), 0)
    ) %>%
    select(-totalVotes)
  out
}

candidate_name <- function(first, last) {
  str_squish(paste(coalesce(as.character(first), ""), coalesce(as.character(last), "")))
}

make_candidate_tables <- function() {
  mayor_raw <- read_excel(CANDIDATES_FILE, sheet = "mayor_gamgebeli")
  mayor <- mayor_raw %>%
    mutate(
      district_raw = coalesce(pick_int(., c("district_code", "district_id")), pick_int(., c("selfgov_id"))),
      candidate_selfgov_id = pick_int(., c("selfgov_id"))
    ) %>%
    transmute(
      election_type = if_else(office_type == "tbilisi_mayor", "mayor", office_type),
      district_raw,
      district_id = coalesce(candidate_selfgov_id, if_else(office_type %in% c("mayor", "tbilisi_mayor"), map_city_selfgov(district_raw), district_raw)),
      party_num = as.character(candidate_number),
      party_id = party_id_for_num(party_num),
      name_ka = candidate_name(first_name, last_name),
      party_name = party_name
    )

  major_raw <- read_excel(CANDIDATES_FILE, sheet = "majoritarian candidates")
  valid_major_ids <- st_read(COUNCIL_SMD_GEO, quiet = TRUE) %>%
    st_drop_geometry() %>%
    pick_int(c("maj_id", "major_id", "MID", "id")) %>%
    na.omit() %>%
    as.integer()
  major <- major_raw %>%
    mutate(
      source_major_id = pick_int(., c("maj_id", "major_id")),
      district_raw = coalesce(pick_int(., c("district_code", "district_id")), as.integer(floor(source_major_id / 100L))),
      major_local = coalesce(as.integer(str_extract(if ("smd_code" %in% names(.)) smd_code else as.character(NA), "(?<=\\.)\\d+$")), source_major_id %% 100L),
      direct_major_id = district_raw * 100L + major_local,
      selfgov_major_id = map_city_selfgov(district_raw) * 100L + major_local,
      major_id = case_when(
        selfgov_major_id %in% valid_major_ids ~ selfgov_major_id,
        direct_major_id %in% valid_major_ids ~ direct_major_id,
        source_major_id %in% valid_major_ids ~ source_major_id,
        !is.na(source_major_id) ~ source_major_id,
        TRUE ~ direct_major_id
      )
    ) %>%
    transmute(
      election_type = "council_smd",
      district_raw,
      district_id = major_id,
      major_id = major_id,
      party_num = as.character(candidate_number),
      party_id = party_id_for_num(party_num),
      name_ka = candidate_name(first_name, last_name),
      party_name = party_name,
      smd_code = if ("smd_code" %in% names(.)) smd_code else as.character(major_id)
    )

  party_list_raw <- read_excel(CANDIDATES_FILE, sheet = "party lists")
  party_lists <- party_list_raw %>%
    mutate(
      district_raw = pick_int(., c("district_code", "district_id", "selfgov_id")),
      district_id = if_else(district_type == "ქალაქის", map_city_selfgov(district_raw), district_raw),
      party_id = party_id_for_num(match_party_number_from_name(party_name))
    ) %>%
    mutate(district_id = coalesce(pick_int(., c("selfgov_id")), district_id)) %>%
    transmute(
      district_id,
      district_type,
      party_id,
      party_name,
      order_id = as.integer(order_id),
      first_name,
      last_name,
      name_ka = candidate_name(first_name, last_name),
      smd_code,
      smd_name
    )

  list(mayor = mayor, major = major, party_lists = party_lists)
}

match_party_number_from_name <- function(name) {
  name <- as.character(name)
  out <- rep(NA_character_, length(name))
  aliases <- PARTY_ALIASES_KA
  for (pid in names(aliases)) {
    nums <- names(PARTY_MAP)[PARTY_MAP == pid]
    if (!length(nums)) next
    out[str_squish(name) == str_squish(aliases[[pid]])] <- nums[[1]]
  }
  out[is.na(out) & str_detect(coalesce(name, ""), "ქართული ოცნება")] <- "41"
  out[is.na(out) & str_detect(coalesce(name, ""), "ნაციონალური")] <- "5"
  out[is.na(out) & str_detect(coalesce(name, ""), "ბურჯანაძე")] <- "3"
  out[is.na(out) & str_detect(coalesce(name, ""), "პატრიოტ|პარტიოტ|პატრიოპ")] <- "8"
  out[is.na(out) & str_detect(coalesce(name, ""), "ლეიბორისტ")] <- "20"
  out[is.na(out) & str_detect(coalesce(name, ""), "ქრისტიან")] <- "16"
  out[is.na(out) & str_detect(coalesce(name, ""), "კუკავა|არასაპარლამენტო|ოპოზიცია")] <- "1"
  out[is.na(out) & str_detect(coalesce(name, ""), "ვეტერან|პოლიტიკური მოძრაობა")] <- "2"
  out[is.na(out) & str_detect(coalesce(name, ""), "თვითმმართველობა")] <- "9"
  out[is.na(out) & str_detect(coalesce(name, ""), "გაჩეჩილაძე|მწვანეთა")] <- "6"
  out[is.na(out) & str_detect(coalesce(name, ""), "სახალხო")] <- "26"
  out[is.na(out) & str_detect(coalesce(name, ""), "ხალხის პარტია")] <- "10"
  out[is.na(out) & str_detect(coalesce(name, ""), "საინიციატივო|დამოუკიდებელი")] <- "42"
  out
}

candidate_tables <- make_candidate_tables()

attach_exec_candidate_names <- function(df, office_type) {
  lookup <- candidate_tables$mayor %>%
    filter(election_type == office_type) %>%
    select(district_id, district_raw, party_num, name_ka) %>%
    distinct(district_id, district_raw, party_num, .keep_all = TRUE)
  if (office_type == "mayor") {
    df %>%
      left_join(lookup %>% select(district_id, party_num, name_ka),
                by = c("selfgov_id" = "district_id", "party_num")) %>%
      mutate(name_ka = coalesce(name_ka, ""))
  } else {
    df %>%
      left_join(lookup %>% select(district_raw, party_num, name_ka),
                by = c("district_raw", "party_num")) %>%
      mutate(name_ka = coalesce(name_ka, ""))
  }
}

attach_major_candidate_names <- function(df) {
  lookup <- candidate_tables$major %>%
    select(major_id, party_num, name_ka) %>%
    distinct(major_id, party_num, .keep_all = TRUE)
  df %>%
    left_join(lookup, by = c("major_id", "party_num")) %>%
    mutate(name_ka = coalesce(name_ka, ""))
}

filter_to_contest_candidates <- function(df, contest_cols) {
  df %>%
    group_by(across(all_of(contest_cols))) %>%
    mutate(.contest_votes = sum(votes, na.rm = TRUE)) %>%
    ungroup() %>%
    filter(.contest_votes > 0) %>%
    select(-.contest_votes)
}

resolve_council_major_id <- function(district, major, precinct_id) {
  direct <- as.integer(district) * 100L + as.integer(major)
  smd <- st_read(COUNCIL_SMD_GEO, quiet = TRUE)
  if (direct %in% as.integer(smd$MID)) return(direct)

  precinct <- st_read(PRECINCT_GEO, quiet = TRUE) %>%
    filter(as.integer(PrecID) == as.integer(precinct_id))
  if (!nrow(precinct)) return(direct)

  smd <- smd %>% filter(as.integer(District) == as.integer(district))
  if (!nrow(smd)) return(direct)
  if (st_crs(precinct) != st_crs(smd)) smd <- st_transform(smd, st_crs(precinct))

  intersections <- st_intersection(st_make_valid(smd), st_make_valid(precinct))
  if (!nrow(intersections)) return(direct)
  areas <- as.numeric(st_area(intersections))
  as.integer(intersections$MID[[which.max(areas)]])
}

read_byelection_candidates <- function(path, sheet) {
  empty <- tibble(
    district_raw = integer(),
    major_local = integer(),
    party_num = character(),
    name_ka = character()
  )
  if (is.null(sheet) || !sheet %in% readxl::excel_sheets(path)) return(empty)
  raw <- read_excel(path, sheet = sheet, col_names = FALSE)
  raw <- raw[, colSums(is.na(raw)) < nrow(raw)]
  if (nrow(raw) < 2 || ncol(raw) < 4) return(empty)

  data <- raw[-1, ]
  if (ncol(raw) >= 7) {
    district_raw <- as.integer(cell_num(data[[1]]))
    return(tibble(
      district_raw = district_raw,
      major_local = parse_major_local(data[[3]], district_raw),
      party_num = cell_chr(data[[4]]),
      name_ka = candidate_name(data[[6]], data[[7]])
    ) %>%
      filter(!is.na(district_raw), !is.na(major_local), !is.na(party_num), name_ka != "") %>%
      distinct(district_raw, major_local, party_num, .keep_all = TRUE))
  }

  party_text <- cell_chr(data[[3]])
  candidate_text <- cell_chr(data[[4]])
  district_raw <- as.integer(cell_num(data[[1]]))
  tibble(
    district_raw = district_raw,
    major_local = parse_major_local(data[[2]], district_raw),
    party_num = coalesce(str_extract(party_text, "^\\d+"), str_extract(candidate_text, "^\\d+")),
    name_ka = str_remove(candidate_text, "^\\d+\\.\\s*")
  ) %>%
    filter(!is.na(district_raw), !is.na(major_local), !is.na(party_num), name_ka != "") %>%
    distinct(district_raw, major_local, party_num, .keep_all = TRUE)
}

make_precinct_geo_lookup <- function(path) {
  props <- st_read(path, quiet = TRUE) %>% st_drop_geometry()
  precinct_id <- pick_int(props, c("id", "precinct_id", "PrecID"))
  source_major_id <- pick_int(props, c("maj_id", "major_id", "MID"))
  district_raw <- coalesce(
    pick_int(props, c("district_raw", "raw_district_id", "District", "district_id")),
    as.integer(floor(precinct_id / 1000L))
  )
  precinct_number <- coalesce(
    pick_int(props, c("precinct_number", "Precinct")),
    as.integer(precinct_id %% 1000L)
  )

  tibble(
    precinct_id = precinct_id,
    source_major_id = source_major_id,
    district_raw = district_raw,
    precinct_number = precinct_number
  ) %>%
    transmute(
      precinct_id = as.integer(precinct_id),
      source_major_id = as.integer(source_major_id),
      district_raw = as.integer(district_raw),
      precinct_number = as.integer(precinct_number),
      precinct_key = paste(source_major_id, district_raw, precinct_number, sep = "."),
      geo_major_id = as.integer(source_major_id)
    ) %>%
    distinct(source_major_id, district_raw, precinct_number, .keep_all = TRUE)
}

read_council_major_ids <- function() {
  st_read(COUNCIL_SMD_GEO, quiet = TRUE) %>%
    st_drop_geometry() %>%
    pick_int(c("maj_id", "major_id", "MID", "id")) %>%
    na.omit() %>%
    as.integer()
}

canonical_council_major_id <- function(district_raw, major_local, geo_major_id, valid_major_ids) {
  direct <- as.integer(district_raw) * 100L + as.integer(major_local)
  selfgov_direct <- map_city_selfgov(district_raw) * 100L + as.integer(major_local)
  geo_major_id <- as.integer(geo_major_id)

  case_when(
    selfgov_direct %in% valid_major_ids ~ selfgov_direct,
    direct %in% valid_major_ids ~ direct,
    geo_major_id %in% valid_major_ids ~ geo_major_id,
    !is.na(geo_major_id) ~ geo_major_id,
    TRUE ~ direct
  )
}

parse_precinct_code <- function(precinct, lookup) {
  text <- cell_chr(precinct)
  parsed <- str_match(text, "^(\\d+)\\.(\\d+)\\.(\\d+)$")
  out <- tibble(
    source_major_id = suppressWarnings(as.integer(parsed[, 2])),
    district_raw = suppressWarnings(as.integer(parsed[, 3])),
    precinct_number = suppressWarnings(as.integer(parsed[, 4]))
  ) %>%
    mutate(precinct_key = if_else(
      !is.na(source_major_id) & !is.na(district_raw) & !is.na(precinct_number),
      paste(source_major_id, district_raw, precinct_number, sep = "."),
      NA_character_
    )) %>%
    left_join(
      lookup %>% select(source_major_id, district_raw, precinct_number, precinct_id),
      by = c("source_major_id", "district_raw", "precinct_number")
    )
  out
}

write_byelection_precinct_geo <- function(df, source_geo, out_geo) {
  if (!nrow(df)) return(invisible(NULL))

  lookup <- df %>%
    distinct(precinct_key, precinct_id, district_raw, precinct_number, major_id, selfgov_id)
  geo <- st_read(source_geo, quiet = TRUE) %>%
    mutate(
      source_major_id = as.integer(MID),
      district_raw = as.integer(district),
      precinct_number = as.integer(precinct),
      precinct_key = paste(source_major_id, district_raw, precinct_number, sep = ".")
    ) %>%
    inner_join(lookup, by = c("precinct_key", "district_raw", "precinct_number")) %>%
    mutate(
      original_mid = source_major_id,
      id = as.integer(precinct_id),
      PrecID = as.integer(precinct_id),
      MID = as.integer(major_id),
      maj_id = as.integer(major_id),
      major_id = as.integer(major_id),
      district_id = as.integer(district_raw),
      raw_district_id = as.integer(district_raw),
      selfgov_id = as.integer(selfgov_id),
      self_gov_id = as.integer(selfgov_id),
      Mayor = as.integer(selfgov_id)
    ) %>%
    select(-source_major_id)

  write_geo_atomic(geo, out_geo)
  invisible(NULL)
}

read_council_smd_byelection <- function(path, candidate_sheet = NULL, party_map = PARTY_MAP,
                                        precinct_geo = PRECINCT_GEO, use_precinct_code = FALSE) {
  if (!file.exists(path)) return(tibble())
  sheets <- setdiff(readxl::excel_sheets(path), candidate_sheet)
  candidate_lookup <- read_byelection_candidates(path, candidate_sheet)
  precinct_lookup <- make_precinct_geo_lookup(precinct_geo)
  precinct_major_lookup <- precinct_lookup %>%
    select(precinct_id, geo_major_id) %>%
    distinct(precinct_id, .keep_all = TRUE)
  valid_major_ids <- read_council_major_ids()
  bind_rows(lapply(sheets, function(sheet) {
    raw <- read_excel(path, sheet = sheet, col_names = FALSE)
    raw <- raw[, colSums(is.na(raw)) < nrow(raw)]
    header_candidates <- apply(raw, 1, function(row) {
      sum(str_detect(cell_chr(unlist(row, use.names = FALSE)), "^(vote_)?\\d+$"))
    })
    header_row <- which(header_candidates >= 2)
    header_row <- if (length(header_row)) header_row[[1]] else 1L
    header <- cell_chr(unlist(raw[header_row, ], use.names = FALSE))
    data <- raw[-seq_len(header_row), ]
    district <- as.integer(cell_num(data[[1]]))
    keep <- !is.na(district) & district > 0
    if (!any(keep)) return(tibble())

    party_cols <- which(str_detect(header, "^(vote_)?\\d+"))
    party_codes <- str_extract(header[party_cols], "\\d+")
    ballots_col <- party_cols[[1]] - 1L
    invalid_col <- which(str_detect(str_to_lower(header), "ბათილი|invalid"))
    if (!length(invalid_col)) invalid_col <- ncol(raw)
    invalid_col <- invalid_col[[1]]

    major_local <- parse_major_local(data[[2]], district)
    if (use_precinct_code) {
      parsed_precinct <- parse_precinct_code(data[[3]], precinct_lookup)
      precinct_number <- parsed_precinct$precinct_number
      precinct_id <- parsed_precinct$precinct_id
      precinct_key <- parsed_precinct$precinct_key
    } else {
      precinct_number <- as.integer(cell_num(data[[3]]))
      precinct_id <- parse_precinct_id(district, precinct_number)
      precinct_key <- rep(NA_character_, length(precinct_number))
    }
    keep <- keep & !is.na(precinct_number) & precinct_number > 0
    wide <- tibble(
      district_raw = district[keep],
      major_local = major_local[keep],
      precinct_number = precinct_number[keep],
      precinct_key = precinct_key[keep],
      main_list = as.integer(cell_num(data[[4]])[keep]),
      special_list = as.integer(cell_num(data[[5]])[keep]),
      voted_noon = as.integer(cell_num(data[[6]])[keep]),
      voted_5pm = as.integer(cell_num(data[[7]])[keep]),
      voted = as.integer(cell_num(data[[8]])[keep]),
      ballots_received = as.integer(cell_num(data[[ballots_col]])[keep]),
      invalid_ballots = as.integer(cell_num(data[[invalid_col]])[keep])
    ) %>%
      mutate(
        registered = main_list + special_list,
        precinct_id = as.integer(precinct_id[keep]),
        selfgov_id = map_city_selfgov(district_raw)
      ) %>%
      left_join(precinct_major_lookup, by = "precinct_id") %>%
      mutate(major_id = canonical_council_major_id(district_raw, major_local, geo_major_id, valid_major_ids)) %>%
      select(-geo_major_id)

    votes <- as_tibble(data[keep, party_cols, drop = FALSE])
    names(votes) <- paste0("vote_", party_codes)

    bind_cols(wide, votes) %>%
      mutate(across(starts_with("vote_"), cell_num)) %>%
      pivot_longer(starts_with("vote_"), names_to = "party_col", values_to = "votes") %>%
      mutate(
        party_num = str_remove(party_col, "^vote_"),
        party_id = party_id_for_num(party_num, party_map),
        votes = as.integer(cell_num(votes))
      ) %>%
      select(-party_col) %>%
      left_join(candidate_lookup, by = c("district_raw", "major_local", "party_num")) %>%
      mutate(name_ka = coalesce(name_ka, "")) %>%
      filter_to_contest_candidates(c("major_id", "party_num"))
  }))
}

read_council_smd_precinct_code_byelection <- function(path, candidate_sheet = NULL,
                                                      party_map = PARTY_MAP,
                                                      precinct_geo = PARL2016_PRECINCT_GEO) {
  if (!file.exists(path)) return(tibble())
  sheets <- setdiff(readxl::excel_sheets(path), candidate_sheet)
  candidate_lookup <- read_byelection_candidates(path, candidate_sheet)
  contest_lookup <- candidate_lookup %>%
    distinct(district_raw, major_local)
  precinct_lookup <- make_precinct_geo_lookup(precinct_geo)
  precinct_major_lookup <- precinct_lookup %>%
    select(precinct_id, geo_major_id) %>%
    distinct(precinct_id, .keep_all = TRUE)
  valid_major_ids <- read_council_major_ids()

  bind_rows(lapply(sheets, function(sheet) {
    raw <- read_excel(path, sheet = sheet, col_names = FALSE)
    raw <- raw[, colSums(is.na(raw)) < nrow(raw)]
    header_candidates <- apply(raw, 1, function(row) {
      sum(str_detect(cell_chr(unlist(row, use.names = FALSE)), "^(vote_)?\\d+$"))
    })
    header_row <- which(header_candidates >= 2)
    header_row <- if (length(header_row)) header_row[[1]] else 1L
    header <- cell_chr(unlist(raw[header_row, ], use.names = FALSE))
    data <- raw[-seq_len(header_row), ]

    district <- as.integer(str_extract(cell_chr(data[[1]]), "^\\s*\\d+"))
    parsed_precinct <- parse_precinct_code(data[[2]], precinct_lookup)
    keep <- !is.na(district) & district > 0 &
      !is.na(parsed_precinct$precinct_number) & parsed_precinct$precinct_number > 0
    if (!any(keep)) return(tibble())

    party_cols <- which(str_detect(header, "^(vote_)?\\d+"))
    party_codes <- str_extract(header[party_cols], "\\d+")
    ballots_col <- party_cols[[1]] - 1L
    invalid_col <- which(str_detect(str_to_lower(header), "ბათილი|invalid"))
    if (!length(invalid_col)) invalid_col <- ncol(raw)
    invalid_col <- invalid_col[[1]]

    wide <- tibble(
      district_raw = district[keep],
      precinct_number = parsed_precinct$precinct_number[keep],
      precinct_key = parsed_precinct$precinct_key[keep],
      main_list = as.integer(cell_num(data[[3]])[keep]),
      special_list = as.integer(cell_num(data[[4]])[keep]),
      voted_noon = as.integer(cell_num(data[[5]])[keep]),
      voted_5pm = as.integer(cell_num(data[[6]])[keep]),
      voted = as.integer(cell_num(data[[7]])[keep]),
      ballots_received = as.integer(cell_num(data[[ballots_col]])[keep]),
      invalid_ballots = as.integer(cell_num(data[[invalid_col]])[keep]),
      precinct_id = as.integer(parsed_precinct$precinct_id[keep])
    ) %>%
      left_join(contest_lookup, by = "district_raw") %>%
      mutate(
        registered = main_list + special_list,
        selfgov_id = map_city_selfgov(district_raw)
      ) %>%
      left_join(precinct_major_lookup, by = "precinct_id") %>%
      mutate(major_id = canonical_council_major_id(district_raw, major_local, geo_major_id, valid_major_ids)) %>%
      select(-geo_major_id)

    votes <- as_tibble(data[keep, party_cols, drop = FALSE])
    names(votes) <- paste0("vote_", party_codes)

    bind_cols(wide, votes) %>%
      mutate(across(starts_with("vote_"), cell_num)) %>%
      pivot_longer(starts_with("vote_"), names_to = "party_col", values_to = "votes") %>%
      mutate(
        party_num = str_remove(party_col, "^vote_"),
        party_id = party_id_for_num(party_num, party_map),
        votes = as.integer(cell_num(votes))
      ) %>%
      select(-party_col) %>%
      left_join(candidate_lookup, by = c("district_raw", "major_local", "party_num")) %>%
      mutate(name_ka = coalesce(name_ka, "")) %>%
      filter_to_contest_candidates(c("major_id", "party_num"))
  }))
}

read_exec_byelection <- function(path) {
  if (!file.exists(path)) return(tibble())
  bind_rows(lapply(readxl::excel_sheets(path), function(sheet) {
    raw <- read_excel(path, sheet = sheet, col_names = FALSE)
    raw <- raw[, colSums(is.na(raw)) < nrow(raw)]
    header <- cell_chr(unlist(raw[1, ], use.names = FALSE))
    data <- raw[-1, ]
    district <- as.integer(cell_num(data[[1]]))
    keep <- !is.na(district) & district > 0
    if (!any(keep)) return(tibble())

    party_cols <- which(str_detect(header, "^\\d+"))
    party_codes <- str_extract(header[party_cols], "^\\d+")
    candidate_names <- str_squish(str_remove(header[party_cols], "^\\d+\\s*"))
    invalid_col <- which(str_detect(str_to_lower(header), "ბათილი|invalid"))
    if (!length(invalid_col)) invalid_col <- ncol(raw)
    invalid_col <- invalid_col[[1]]

    candidate_lookup <- tibble(
      party_num = party_codes,
      name_ka = candidate_names
    )

    wide <- tibble(
      district_raw = district[keep],
      precinct_number = as.integer(cell_num(data[[2]])[keep]),
      attached_precinct = cell_chr(data[[3]])[keep],
      main_list = as.integer(cell_num(data[[4]])[keep]),
      special_list = as.integer(cell_num(data[[5]])[keep]),
      voted_noon = as.integer(cell_num(data[[6]])[keep]),
      voted_5pm = as.integer(cell_num(data[[7]])[keep]),
      voted = as.integer(cell_num(data[[8]])[keep]),
      ballots_received = as.integer(cell_num(data[[9]])[keep]),
      invalid_ballots = as.integer(cell_num(data[[invalid_col]])[keep])
    ) %>%
      mutate(
        registered = main_list + special_list,
        precinct_id = parse_precinct_id(district_raw, precinct_number),
        selfgov_id = map_city_selfgov(district_raw),
        district_id = as.character(selfgov_id),
        round = 1L
      )

    votes <- as_tibble(data[keep, party_cols, drop = FALSE])
    names(votes) <- paste0("vote_", party_codes)

    bind_cols(wide, votes) %>%
      mutate(across(starts_with("vote_"), cell_num)) %>%
      pivot_longer(starts_with("vote_"), names_to = "party_col", values_to = "votes") %>%
      mutate(
        party_num = str_remove(party_col, "^vote_"),
        party_id = party_id_for_num(party_num),
        votes = as.integer(cell_num(votes))
      ) %>%
      select(-party_col) %>%
      left_join(candidate_lookup, by = "party_num") %>%
      mutate(name_ka = coalesce(name_ka, "")) %>%
      filter_to_contest_candidates(c("district_raw", "party_num"))
  }))
}

map_exec_2016_oct_selfgov <- function(district) {
  district <- as.integer(district)
  if_else(district == 67L, 67L, map_city_selfgov(district))
}

read_exec_2016_oct_candidates <- function(path) {
  sheet <- readxl::excel_sheets(path)[[3]]
  raw <- read_excel(path, sheet = sheet, col_names = FALSE)
  raw <- raw[, colSums(is.na(raw)) < nrow(raw)]
  data <- raw[-1, ]

  tibble(
    district_raw = as.integer(cell_num(data[[2]])),
    party_num = cell_chr(data[[4]]),
    name_ka = candidate_name(data[[6]], data[[7]])
  ) %>%
    filter(!is.na(district_raw), district_raw > 0, party_num != "", name_ka != "") %>%
    distinct(district_raw, party_num, .keep_all = TRUE)
}

read_exec_2016_oct_byelection <- function(path, sheet_index, round_num) {
  if (!file.exists(path)) return(tibble())
  candidate_lookup <- read_exec_2016_oct_candidates(path)
  precinct_lookup <- make_precinct_geo_lookup(PARL2016_PRECINCT_GEO)
  sheet <- readxl::excel_sheets(path)[[sheet_index]]
  raw <- read_excel(path, sheet = sheet, col_names = FALSE)
  raw <- raw[, colSums(is.na(raw)) < nrow(raw)]
  header_candidates <- apply(raw, 1, function(row) {
    sum(str_detect(cell_chr(unlist(row, use.names = FALSE)), "^\\d+$"))
  })
  header_row <- which(header_candidates >= 2)
  header_row <- if (length(header_row)) header_row[[1]] else 1L
  header <- cell_chr(unlist(raw[header_row, ], use.names = FALSE))
  data <- raw[-seq_len(header_row), ]

  district_raw <- as.integer(str_extract(cell_chr(data[[1]]), "^\\d+"))
  parsed_precinct <- parse_precinct_code(data[[2]], precinct_lookup)
  keep <- !is.na(district_raw) & district_raw > 0 &
    !is.na(parsed_precinct$precinct_id) &
    !is.na(parsed_precinct$precinct_number) &
    parsed_precinct$precinct_number > 0
  if (!any(keep)) return(tibble())

  party_cols <- which(str_detect(header, "^\\d+$"))
  party_codes <- str_extract(header[party_cols], "^\\d+")
  ballots_col <- party_cols[[1]] - 1L
  invalid_col <- which(str_detect(str_to_lower(header), "áƒ‘áƒáƒ—áƒ˜áƒšáƒ˜|invalid"))
  if (!length(invalid_col)) invalid_col <- ncol(raw)
  invalid_col <- invalid_col[[1]]

  wide <- tibble(
    district_raw = district_raw[keep],
    precinct_id = as.integer(parsed_precinct$precinct_id[keep]),
    precinct_key = parsed_precinct$precinct_key[keep],
    source_major_id = as.integer(parsed_precinct$source_major_id[keep]),
    precinct_number = as.integer(parsed_precinct$precinct_number[keep]),
    main_list = as.integer(cell_num(data[[3]])[keep]),
    special_list = as.integer(cell_num(data[[4]])[keep]),
    voted_noon = as.integer(cell_num(data[[5]])[keep]),
    voted_5pm = as.integer(cell_num(data[[6]])[keep]),
    voted = as.integer(cell_num(data[[7]])[keep]),
    ballots_received = as.integer(cell_num(data[[ballots_col]])[keep]),
    invalid_ballots = as.integer(cell_num(data[[invalid_col]])[keep])
  ) %>%
    mutate(
      registered = main_list + special_list,
      selfgov_id = map_exec_2016_oct_selfgov(district_raw),
      district_id = as.character(selfgov_id),
      round = as.integer(round_num)
    )

  votes <- as_tibble(data[keep, party_cols, drop = FALSE])
  names(votes) <- paste0("vote_", party_codes)

  bind_cols(wide, votes) %>%
    mutate(across(starts_with("vote_"), cell_num)) %>%
    pivot_longer(starts_with("vote_"), names_to = "party_col", values_to = "votes") %>%
    mutate(
      party_num = str_remove(party_col, "^vote_"),
      party_id = party_id_for_num(party_num, PARTY_MAP_2016),
      votes = as.integer(cell_num(votes))
    ) %>%
    select(-party_col) %>%
    left_join(candidate_lookup, by = c("district_raw", "party_num")) %>%
    mutate(name_ka = coalesce(name_ka, "")) %>%
    filter_to_contest_candidates(c("district_raw", "party_num"))
}

write_exec_byelection_precinct_geo <- function(df, source_geo, out_geo) {
  if (!nrow(df)) return(invisible(NULL))

  lookup <- df %>%
    distinct(precinct_key, precinct_id, district_raw, precinct_number, selfgov_id)
  geo <- st_read(source_geo, quiet = TRUE) %>%
    mutate(
      source_major_id = as.integer(MID),
      district_raw = as.integer(district),
      precinct_number = as.integer(precinct),
      precinct_key = paste(source_major_id, district_raw, precinct_number, sep = ".")
    ) %>%
    inner_join(lookup, by = c("precinct_key", "district_raw", "precinct_number")) %>%
    mutate(
      original_mid = source_major_id,
      id = as.integer(precinct_id),
      PrecID = as.integer(precinct_id),
      district_id = as.integer(district_raw),
      raw_district_id = as.integer(district_raw),
      selfgov_id = as.integer(selfgov_id),
      self_gov_id = as.integer(selfgov_id),
      Mayor = as.integer(selfgov_id)
    ) %>%
    select(-source_major_id)

  write_geo_atomic(geo, out_geo)
  invisible(NULL)
}

cat("Reading result sheets...\n")
pr <- read_result_sheet("PROP", "pr") %>%
  left_join(precinct_selfgov %>% select(precinct_id, lookup_selfgov_id = selfgov_id), by = "precinct_id") %>%
  mutate(
    selfgov_id = coalesce(selfgov_id, lookup_selfgov_id, map_city_selfgov(district_raw)),
    district_id = as.character(district_raw)
  ) %>%
  select(-lookup_selfgov_id)

council_smd <- read_result_sheet("MAJOR_ubani", "major") %>%
  left_join(precinct_selfgov %>% select(precinct_id, lookup_selfgov_id = selfgov_id), by = "precinct_id") %>%
  mutate(selfgov_id = coalesce(selfgov_id, lookup_selfgov_id, map_city_selfgov(district_raw))) %>%
  select(-lookup_selfgov_id) %>%
  attach_major_candidate_names() %>%
  filter_to_contest_candidates(c("major_id", "party_num"))

mayor_r1 <- read_result_sheet("MERI_I_TURI", "exec") %>%
  mutate(
    selfgov_id = coalesce(selfgov_id, map_city_selfgov(district_raw)),
    district_id = as.character(selfgov_id),
    round = 1L
  ) %>%
  attach_exec_candidate_names("mayor") %>%
  filter_to_contest_candidates(c("district_raw", "party_num"))

gamg_r1 <- read_result_sheet("GAMG_I_TURI", "exec") %>%
  mutate(
    selfgov_id = coalesce(selfgov_id, district_raw),
    district_id = as.character(selfgov_id),
    round = 1L
  ) %>%
  attach_exec_candidate_names("gamgebeli") %>%
  filter_to_contest_candidates(c("district_raw", "party_num"))

exec_r1 <- bind_rows(mayor_r1, gamg_r1)

mayor_r2 <- read_result_sheet("MERI_II_TURI", "exec") %>%
  mutate(
    selfgov_id = coalesce(selfgov_id, map_city_selfgov(district_raw)),
    district_id = as.character(selfgov_id),
    round = 2L
  ) %>%
  attach_exec_candidate_names("mayor") %>%
  filter_to_contest_candidates(c("district_raw", "party_num"))

gamg_r2 <- read_result_sheet("GAMG_II_TURI", "exec") %>%
  mutate(
    selfgov_id = coalesce(selfgov_id, district_raw),
    district_id = as.character(selfgov_id),
    round = 2L
  ) %>%
  attach_exec_candidate_names("gamgebeli") %>%
  filter_to_contest_candidates(c("district_raw", "party_num"))

exec_r2 <- bind_rows(mayor_r2, gamg_r2)
by2014_oct_council_smd <- read_council_smd_byelection(BY2014_OCT)
by2015_may_council_smd <- read_council_smd_byelection(BY2015_MAY, candidate_sheet = "Candidates")
by2015_oct_council_smd <- read_council_smd_byelection(BY2015_OCT, candidate_sheet = "კანდიდატი")
by2016_may_council_smd <- read_council_smd_byelection(BY2016_MAY, candidate_sheet = "კანდიდატი")
by2016_gardabani_exec <- read_exec_byelection(BY2016_GARDABANI)
by2016_oct_council_smd <- read_council_smd_byelection(
  BY2016_OCT,
  candidate_sheet = readxl::excel_sheets(BY2016_OCT)[[2]],
  party_map = PARTY_MAP_2016,
  precinct_geo = PARL2016_PRECINCT_GEO,
  use_precinct_code = TRUE
)
write_byelection_precinct_geo(by2016_oct_council_smd, PARL2016_PRECINCT_GEO, BY2016_OCT_PRECINCT_GEO)
by2016_oct30_council_smd <- read_council_smd_precinct_code_byelection(
  BY2016_OCT30,
  candidate_sheet = readxl::excel_sheets(BY2016_OCT30)[[2]],
  party_map = PARTY_MAP_2016,
  precinct_geo = PARL2016_PRECINCT_GEO
)
write_byelection_precinct_geo(by2016_oct30_council_smd, PARL2016_PRECINCT_GEO, BY2016_OCT30_PRECINCT_GEO)
by2016_oct_exec <- read_exec_2016_oct_byelection(BY2016_OCT_MAYOR, sheet_index = 1, round_num = 1)
by2016_oct_exec_r2 <- read_exec_2016_oct_byelection(BY2016_OCT_MAYOR, sheet_index = 2, round_num = 2)
write_exec_byelection_precinct_geo(
  bind_rows(by2016_oct_exec, by2016_oct_exec_r2),
  PARL2016_PRECINCT_GEO,
  BY2016_OCT_MAYOR_PRECINCT_GEO
)

cat("Writing result CSVs...\n")
pr_district <- summarise_results(pr, "district_id")
pr_selfgov <- summarise_results(pr %>% mutate(district_id = as.character(selfgov_id)), "district_id")
pr_national <- summarise_results(pr %>% mutate(district_id = "national"), "district_id")
write_csv_utf8(bind_rows(pr_national, pr_district), file.path(OUT_RESULTS, "local2014_pr.csv"))
write_csv_utf8(bind_rows(pr_national, pr_selfgov), file.path(OUT_RESULTS, "local2014_pr_selfgov.csv"))
write_csv_utf8(
  make_precinct_results(pr, c("district_id")) %>%
    select(precinct_id, district_id, party_id, votes, vote_share, registered, voted,
           voted_noon, voted_5pm, turnout_pct, noon_pct, five_pct, invalid_ballots, invalid_pct),
  file.path(OUT_RESULTS, "local2014_pr_precincts.csv")
)

exec_r1_selfgov <- summarise_results(exec_r1, "district_id", include_party_num = TRUE, include_name = TRUE) %>%
  mutate(round = 1L, .after = name_ka)
exec_r1_district <- summarise_results(exec_r1 %>% mutate(district_id = as.character(district_raw)),
                                      "district_id", include_party_num = TRUE, include_name = TRUE) %>%
  mutate(round = 1L, .after = name_ka)
exec_r1_national <- summarise_results(exec_r1 %>% mutate(district_id = "national"), "district_id", include_party_num = TRUE, include_name = TRUE) %>%
  mutate(round = 1L, .after = name_ka)
write_csv_utf8(bind_rows(exec_r1_national, exec_r1_selfgov), file.path(OUT_RESULTS, "local2014_smd.csv"))
write_csv_utf8(exec_r1_district, file.path(OUT_RESULTS, "local2014_smd_districts.csv"))
write_csv_utf8(
  make_precinct_results(exec_r1, c("district_id", "selfgov_id"), include_party_num = TRUE, include_name = TRUE) %>%
    select(precinct_id, selfgov_id, party_id, party_num, name_ka, votes, vote_share, registered, voted,
           voted_noon, voted_5pm, turnout_pct, noon_pct, five_pct, invalid_ballots, invalid_pct),
  file.path(OUT_RESULTS, "local2014_smd_precincts.csv")
)

council_smd_district <- summarise_results(council_smd %>% mutate(district_id = as.character(major_id)),
                                          "district_id", include_name = TRUE) %>%
  mutate(round = 1L, .after = name_ka)
council_smd_national <- summarise_results(council_smd %>% mutate(district_id = "national"),
                                          "district_id", include_name = TRUE) %>%
  mutate(round = 1L, .after = name_ka)
write_csv_utf8(bind_rows(council_smd_national, council_smd_district), file.path(OUT_RESULTS, "local2014_council_smd.csv"))
write_csv_utf8(
  make_precinct_results(council_smd %>% mutate(district_id = as.character(major_id)),
                        c("district_id"), include_name = TRUE) %>%
    select(precinct_id, district_id, party_id, name_ka, votes, vote_share, registered, voted,
           voted_noon, voted_5pm, turnout_pct, noon_pct, five_pct, invalid_ballots, invalid_pct),
  file.path(OUT_RESULTS, "local2014_council_smd_precincts.csv")
)

exec_r2_selfgov <- summarise_results(exec_r2, "district_id", include_party_num = TRUE, include_name = TRUE) %>%
  mutate(round = 2L, .after = name_ka)
exec_r2_district <- summarise_results(exec_r2 %>% mutate(district_id = as.character(district_raw)),
                                      "district_id", include_party_num = TRUE, include_name = TRUE) %>%
  mutate(round = 2L, .after = name_ka)
exec_r2_national <- summarise_results(exec_r2 %>% mutate(district_id = "national"), "district_id", include_party_num = TRUE, include_name = TRUE) %>%
  mutate(round = 2L, .after = name_ka)
write_csv_utf8(bind_rows(exec_r2_national, exec_r2_selfgov), file.path(OUT_RESULTS, "local2014_r2_smd.csv"))
write_csv_utf8(
  make_precinct_results(exec_r2, c("district_id", "selfgov_id"), include_party_num = TRUE, include_name = TRUE) %>%
    select(precinct_id, selfgov_id, party_id, party_num, name_ka, votes, vote_share, registered, voted,
           voted_noon, voted_5pm, turnout_pct, noon_pct, five_pct, invalid_ballots, invalid_pct),
  file.path(OUT_RESULTS, "local2014_r2_smd_precincts.csv")
)

write_exec_byelection <- function(df, stem) {
  if (!nrow(df)) return(invisible(NULL))

  selfgov_results <- summarise_results(
    df,
    "district_id",
    include_party_num = TRUE,
    include_name = TRUE
  ) %>%
    mutate(round = 1L, .after = name_ka)
  national_results <- summarise_results(
    df %>% mutate(district_id = "national"),
    "district_id",
    include_party_num = TRUE,
    include_name = TRUE
  ) %>%
    mutate(round = 1L, .after = name_ka)
  precinct_group_cols <- c("district_id", "selfgov_id")
  if ("district_raw" %in% names(df)) precinct_group_cols <- c(precinct_group_cols, "district_raw")
  if ("precinct_number" %in% names(df)) precinct_group_cols <- c(precinct_group_cols, "precinct_number")
  if ("precinct_key" %in% names(df)) precinct_group_cols <- c(precinct_group_cols, "precinct_key")

  precincts <- make_precinct_results(
    df,
    precinct_group_cols,
    include_party_num = TRUE,
    include_name = TRUE
  ) %>%
    mutate(
      precinct_key = if ("precinct_key" %in% names(.)) coalesce(na_if(precinct_key, ""), as.character(precinct_id)) else as.character(precinct_id),
      raw_district_id = if ("district_raw" %in% names(.)) district_raw else NA_integer_,
      precinct_number = if ("precinct_number" %in% names(.)) precinct_number else NA_integer_
    ) %>%
    select(precinct_id, precinct_key, selfgov_id, raw_district_id, precinct_number,
           party_id, party_num, name_ka, votes, vote_share, registered, voted,
           voted_noon, voted_5pm, turnout_pct, noon_pct, five_pct, invalid_ballots,
           invalid_pct)

  write_csv_utf8(bind_rows(national_results, selfgov_results), file.path(OUT_RESULTS, paste0(stem, "_smd.csv")))
  write_csv_utf8(precincts, file.path(OUT_RESULTS, paste0(stem, "_smd_precincts.csv")))
  invisible(NULL)
}

write_exec_byelection(by2016_gardabani_exec, "local2014_2016_gardabani_byelection")
write_exec_byelection(by2016_oct_exec, "local2014_2016_oct_mayor_byelection")
write_exec_byelection(by2016_oct_exec_r2, "local2014_2016_oct_mayor_byelection_r2")

empty_council_runoff <- council_smd_district[0, ]
write_csv_utf8(empty_council_runoff, file.path(OUT_RESULTS, "local2014_r2_council_smd.csv"))
write_csv_utf8(
  make_precinct_results(council_smd %>% mutate(district_id = as.character(major_id)),
                        c("district_id"), include_name = TRUE)[0, ],
  file.path(OUT_RESULTS, "local2014_r2_council_smd_precincts.csv")
)

write_council_smd_byelection <- function(df, stem) {
  if (!nrow(df)) return(invisible(NULL))

  district_results <- summarise_results(
    df %>% mutate(district_id = as.character(major_id)),
    "district_id",
    include_name = TRUE
  ) %>%
    mutate(round = 1L, .after = name_ka)
  national_results <- summarise_results(
    df %>% mutate(district_id = "national"),
    "district_id",
    include_name = TRUE
  ) %>%
    mutate(round = 1L, .after = name_ka)
  results <- bind_rows(national_results, district_results)

  precinct_group_cols <- c("district_id", "district_raw", "precinct_number", "major_id")
  if ("precinct_key" %in% names(df)) precinct_group_cols <- c(precinct_group_cols, "precinct_key")

  precincts <- make_precinct_results(
    df %>% mutate(district_id = as.character(major_id)),
    precinct_group_cols,
    include_name = TRUE
  ) %>%
    mutate(
      precinct_key = coalesce(na_if(precinct_key, ""), paste(major_id, district_raw, precinct_number, sep = ".")),
      raw_district_id = district_raw
    ) %>%
    select(precinct_id, precinct_key, district_id, raw_district_id, precinct_number,
           party_id, name_ka, votes, vote_share, registered, voted, voted_noon,
           voted_5pm, turnout_pct, noon_pct, five_pct, invalid_ballots, invalid_pct)

  write_csv_utf8(results, file.path(OUT_RESULTS, paste0(stem, "_smd.csv")))
  write_csv_utf8(precincts, file.path(OUT_RESULTS, paste0(stem, "_smd_precincts.csv")))
  write_csv_utf8(results, file.path(OUT_RESULTS, paste0(stem, "_council_smd.csv")))
  write_csv_utf8(precincts, file.path(OUT_RESULTS, paste0(stem, "_council_smd_precincts.csv")))
  invisible(NULL)
}

write_council_smd_byelection(by2014_oct_council_smd, "local2014_2014_oct_byelection")
write_council_smd_byelection(by2015_may_council_smd, "local2014_2015_may_byelection")
write_council_smd_byelection(by2015_oct_council_smd, "local2014_2015_oct_byelection")
write_council_smd_byelection(by2016_may_council_smd, "local2014_2016_may_byelection")
write_council_smd_byelection(by2016_oct_council_smd, "local2014_2016_oct_byelection")
write_council_smd_byelection(by2016_oct30_council_smd, "local2014_2016_oct30_byelection")

cat("Writing turnout CSVs...\n")
turnout_base <- pr %>%
  distinct(precinct_id, district_raw, district_id, selfgov_id, .keep_all = TRUE)

turnout_district <- bind_rows(
  turnout_base %>% mutate(district_id = "national"),
  turnout_base %>% mutate(district_id = as.character(district_raw))
) %>%
  group_by(district_id) %>%
  summarise(
    registered = sum(registered, na.rm = TRUE),
    main_list = sum(main_list, na.rm = TRUE),
    special_list = sum(special_list, na.rm = TRUE),
    voted_noon = sum(voted_noon, na.rm = TRUE),
    voted_5pm = sum(voted_5pm, na.rm = TRUE),
    voted = sum(voted, na.rm = TRUE),
    invalid_ballots = sum(invalid_ballots, na.rm = TRUE),
    turnout_pct = if_else(registered > 0, round6(voted / registered), 0),
    noon_pct = if_else(registered > 0, round6(voted_noon / registered), 0),
    five_pct = if_else(registered > 0, round6(voted_5pm / registered), 0),
    invalid_pct = if_else(voted > 0, round6(invalid_ballots / voted), 0),
    .groups = "drop"
  )

turnout_precinct <- turnout_base %>%
  transmute(
    precinct_id,
    district_id,
    selfgov_id,
    registered,
    main_list,
    special_list,
    voted_noon,
    voted_5pm,
    voted,
    invalid_ballots,
    turnout_pct = if_else(registered > 0, round6(voted / registered), 0),
    noon_pct = if_else(registered > 0, round6(voted_noon / registered), 0),
    five_pct = if_else(registered > 0, round6(voted_5pm / registered), 0),
    invalid_pct = if_else(voted > 0, round6(invalid_ballots / voted), 0)
  )

write_csv_utf8(turnout_district, "src/data/turnout/local2014_turnout.csv")
write_csv_utf8(turnout_precinct, "src/data/turnout/local2014_precincts_turnout.csv")

cat("Writing candidate and elected files...\n")
write_csv_utf8(candidate_tables$party_lists, file.path(OUT_CANDIDATES, "local2014_party_lists.csv"))
write_csv_utf8(candidate_tables$mayor, file.path(OUT_CANDIDATES, "local2014_mayor_gamgebeli_candidates.csv"))
write_csv_utf8(candidate_tables$major, file.path(OUT_CANDIDATES, "local2014_smd_candidates.csv"))

normalize_geo_name <- function(x) {
  x %>%
    as.character() %>%
    str_replace_all("^ქ\\.\\s*", "") %>%
    str_replace_all("მუნიციპალიტეტის$", "") %>%
    str_replace_all("მუნიციპალიტეტი$", "") %>%
    str_replace_all("^[. ]+", "") %>%
    str_squish()
}

selfgov_props <- st_read(SELFGOV_GEO, quiet = TRUE) %>% st_drop_geometry()
selfgov_id_col <- if ("selfgov_id" %in% names(selfgov_props)) "selfgov_id" else if ("District" %in% names(selfgov_props)) "District" else "id"
selfgov_name_col <- if ("Ka_Name" %in% names(selfgov_props)) "Ka_Name" else "name_ka"
selfgov_lookup <- selfgov_props %>%
  transmute(
    selfgov_id = as.integer(.data[[selfgov_id_col]]),
    geo_name = normalize_geo_name(.data[[selfgov_name_col]]),
    is_city = str_detect(.data[[selfgov_name_col]], "^ქ\\.")
  )

extract_local_unit_name <- function(x) {
  out <- as.character(x)
  out <- str_replace(out, "^\\.\\s*", "")
  out <- str_replace(out, "^თვითმმართველი თემის\\s*-?\\s*", "")
  out <- str_replace(out, "^თვითმმართველი ქალაქის\\s*-?\\s*", "")
  out <- str_replace(out, "^ქალაქ\\s+", "")
  out <- str_replace(out, "ის$", "ი")
  normalize_geo_name(out)
}

map_elected_selfgov <- function(local_unit) {
  local_unit <- as.character(local_unit)
  city <- str_detect(local_unit, "თვითმმართველი ქალაქის|^ქალაქ")
  norm <- extract_local_unit_name(local_unit)
  out <- vector("list", length(local_unit))

  for (i in seq_along(local_unit)) {
    if (str_detect(local_unit[[i]], "თბილის")) {
      out[[i]] <- 1L
      next
    }
    if (str_detect(local_unit[[i]], "ზესტაფონ")) {
      out[[i]] <- 51L
      next
    }
    hit <- selfgov_lookup %>%
      filter(geo_name == norm[[i]], is_city == city[[i]])
    if (!nrow(hit)) {
      hit <- selfgov_lookup %>% filter(geo_name == norm[[i]])
    }
    if (!nrow(hit)) {
      pool <- selfgov_lookup %>% filter(is_city == city[[i]])
      if (!nrow(pool)) pool <- selfgov_lookup
      distances <- as.integer(adist(norm[[i]], pool$geo_name))
      best <- which.min(distances)
      if (length(best) && is.finite(distances[[best]]) && distances[[best]] <= 3L) {
        hit <- pool[best, ]
      }
    }
    out[[i]] <- if (nrow(hit)) hit$selfgov_id[[1]] else NA_integer_
  }
  out
}

elected_raw <- read_excel(ELECTED_FILE, sheet = "elected politicians")
elected_selfgov_ids <- pick_int(elected_raw, c("selfgov_id"))
elected <- elected_raw %>%
  mutate(
    party_num = match_party_number_from_name(party_name),
    party_id = party_id_for_num(party_num),
    name_ka = candidate_name(first_name, last_name),
    selfgov_ids = Map(
      function(raw_id, fallback) if (!is.na(raw_id)) raw_id else fallback,
      elected_selfgov_ids,
      map_elected_selfgov(local_governing_unit)
    )
  )
write_csv_utf8(
  elected %>% mutate(selfgov_id = vapply(selfgov_ids, function(x) paste(na.omit(x), collapse = ";"), character(1))) %>% select(-selfgov_ids),
  file.path(OUT_CANDIDATES, "local2014_elected.csv")
)

seat_rows_selfgov <- elected %>%
  select(election_type, party_id, selfgov_ids) %>%
  unnest_longer(selfgov_ids, values_to = "selfgov_id") %>%
  filter(!is.na(selfgov_id)) %>%
  group_by(selfgov_id, party_id) %>%
  summarise(
    seats_pr = sum(election_type == "pr_member", na.rm = TRUE),
    seats_smd = sum(election_type == "smd_member", na.rm = TRUE),
    seats_mayor = sum(election_type %in% c("mayor", "gamgebeli"), na.rm = TRUE),
    .groups = "drop"
  ) %>%
  mutate(selfgov_id = as.character(selfgov_id))

seat_rows_national <- elected %>%
  group_by(party_id) %>%
  summarise(
    seats_pr = sum(election_type == "pr_member", na.rm = TRUE),
    seats_smd = sum(election_type == "smd_member", na.rm = TRUE),
    seats_mayor = sum(election_type %in% c("mayor", "gamgebeli"), na.rm = TRUE),
    .groups = "drop"
  ) %>%
  mutate(selfgov_id = "national", .before = party_id)

write_csv_utf8(bind_rows(seat_rows_national, seat_rows_selfgov), file.path(OUT_RESULTS, "local2014_seats.csv"))

candidate_yaml <- list(
  candidates = c(
    setNames(lapply(seq_len(nrow(candidate_tables$mayor)), function(i) {
      row <- candidate_tables$mayor[i, ]
      list(
        name_ka = row$name_ka,
        election_type = row$election_type,
        selfgov_id = row$district_id,
        party = row$party_id
      )
    }), paste(candidate_tables$mayor$party_id, candidate_tables$mayor$election_type,
              candidate_tables$mayor$district_id, candidate_tables$mayor$party_num, sep = "_")),
    setNames(lapply(seq_len(nrow(candidate_tables$major)), function(i) {
      row <- candidate_tables$major[i, ]
      list(
        name_ka = row$name_ka,
        election_type = "council_smd",
        district_id = row$district_id,
        party = row$party_id
      )
    }), paste(candidate_tables$major$party_id, "council_smd",
              candidate_tables$major$district_id, candidate_tables$major$party_num, sep = "_"))
  )
)
write_yaml(candidate_yaml, file.path(OUT_CANDIDATE_CONFIG, "local_2014.yml"), fileEncoding = "UTF-8")

cat("\nDone.\n")
cat("  PR precinct rows:", nrow(read.csv(file.path(OUT_RESULTS, "local2014_pr_precincts.csv"))), "\n")
cat("  Executive precinct rows:", nrow(read.csv(file.path(OUT_RESULTS, "local2014_smd_precincts.csv"))), "\n")
cat("  Council SMD precinct rows:", nrow(read.csv(file.path(OUT_RESULTS, "local2014_council_smd_precincts.csv"))), "\n")
