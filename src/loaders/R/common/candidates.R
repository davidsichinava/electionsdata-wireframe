# src/loaders/R/common/candidates.R
# Small helpers shared by every *_candidates.R loader. Base R only.

#' Column from df, or a blank ("") vector when the sheet lacks it.
#' @param df data.frame
#' @param name column name
#' @return character vector of nrow(df)
col_or_blank <- function(df, name) {
  if (name %in% names(df)) df[[name]] else rep("", nrow(df))
}

#' Normalize a person name for matching: lowercase, letters+digits only.
#' (Unlike norm_party_label() this does NOT apply the ური→ული ending fold.)
#' @param s character scalar or vector
#' @return normalized string(s)
norm_name <- function(s) {
  x <- tolower(ifelse(is.na(s), "", as.character(s)))
  gsub("[^\\p{L}\\p{N}]+", "", x, perl = TRUE)
}

#' Split a modern "first … last" name: first token → first_name, rest → last_name.
#' @param full character vector
#' @return list(first =, last =)
split_name <- function(full) {
  t <- trimws(ifelse(is.na(full), "", full))
  i <- regexpr(" ", t, fixed = TRUE)
  first <- ifelse(i < 0, "", substr(t, 1, i - 1))
  last <- ifelse(i < 0, t, trimws(substring(t, i + 1)))
  list(first = first, last = last)
}

#' Split a historic "last first …" name (1919 style): first token → last_name,
#' rest → first_name.
#' @param full character vector
#' @return list(first =, last =)
split_historic_name <- function(full) {
  t <- trimws(ifelse(is.na(full), "", full))
  i <- regexpr(" ", t, fixed = TRUE)
  last <- ifelse(i < 0, t, substr(t, 1, i - 1))
  first <- ifelse(i < 0, "", trimws(substring(t, i + 1)))
  list(first = first, last = last)
}

#' Join first/last into a display name, skipping empty parts.
#' @param first,last character vectors
#' @return character vector
join_name <- function(first, last) {
  trimws(paste(ifelse(is.na(first), "", first), ifelse(is.na(last), "", last)))
}

#' Normalize a raw elected column: yes/true → "TRUE", no/false → "FALSE", else "".
#' @param v character vector
#' @return character vector of "TRUE"/"FALSE"/""
elected_flag <- function(v) {
  x <- tolower(trimws(ifelse(is.na(v), "", v)))
  ifelse(x %in% c("yes", "true"), "TRUE", ifelse(x %in% c("no", "false"), "FALSE", ""))
}
