# src/loaders/R/common/io.R
# Canonical CSV read/write for the cleaning layer. Base R only.
#
# Every loader writes through write_canonical_csv(): it pads missing canonical
# columns with "", reorders to the spec, validates, and writes UTF-8 — so a file
# that reaches disk is by construction schema-conformant.

# schema.R must be sourced first (schema_for_level, validate_*).

#' Read a canonical CSV as character columns (no type guessing).
#' @param path CSV path
#' @return data.frame with check.names = FALSE; empty data.frame if file has no rows
read_canonical_csv <- function(path) {
  read.csv(path, fileEncoding = "UTF-8", check.names = FALSE,
           colClasses = "character", na.strings = NULL)
}

#' Pad + reorder a data.frame to a level's canonical columns.
#' Extra (non-spec) columns cause an error — the schema is the contract.
#' @param df data.frame
#' @param level schema level
#' @return data.frame with exactly the canonical columns in canonical order
conform_to_schema <- function(df, level) {
  spec <- schema_for_level(level)
  extra <- setdiff(names(df), spec)
  if (length(extra)) {
    stop("conform_to_schema(", level, "): unexpected column(s): ",
         paste(extra, collapse = ", "),
         "\nDrop or rename them in the loader; the canonical schema is closed.",
         call. = FALSE)
  }
  for (col in setdiff(spec, names(df))) df[[col]] <- ""
  df[, spec, drop = FALSE]
}

#' Format a data.frame as CSV text exactly like d3-dsv's csvFormat():
#' a field is quoted only when it contains `"`, `,`, CR or LF (internal quotes
#' doubled); rows joined with "\n"; NO trailing newline. Matching d3 byte-for-
#' byte lets ported loaders be parity-checked against node output by file hash.
#' @param df data.frame (cells are written as character)
#' @return single CSV string
format_csv_d3 <- function(df) {
  fmt_cell <- function(v) {
    v <- ifelse(is.na(v), "", as.character(v))
    needs <- grepl('["",\n\r]', v) | grepl('"', v, fixed = TRUE)
    v[needs] <- paste0('"', gsub('"', '""', v[needs], fixed = TRUE), '"')
    v
  }
  header <- paste(fmt_cell(names(df)), collapse = ",")
  if (nrow(df) == 0) return(header)
  cols <- lapply(df, fmt_cell)
  body <- do.call(paste, c(cols, sep = ","))
  paste(c(header, body), collapse = "\n")
}

#' Write a cleaned data.frame as a canonical CSV (validate → conform → write).
#' Output is UTF-8, minimal-quoted (d3-compatible), no trailing newline.
#' @param df data.frame
#' @param path output CSV path
#' @param level "district", "precinct", "seats", or "candidates"
#' @return invisible(path); prints "  Written: <path> (<n> rows)"
write_canonical_csv <- function(df, path, level) {
  df <- conform_to_schema(df, level)
  if (level == "candidates") validate_candidates(df) else validate_results(df, level)
  dir.create(dirname(path), showWarnings = FALSE, recursive = TRUE)
  con <- file(path, "wb")   # binary: keep "\n" endings on Windows
  on.exit(close(con))
  writeBin(charToRaw(enc2utf8(format_csv_d3(df))), con)
  cat("  Written:", path, sprintf("(%d rows)\n", nrow(df)))
  invisible(path)
}

#' Read one XLSX sheet as an all-character data.frame (header = row 1),
#' trimmed, NA → "", fully-empty rows dropped — mirroring how the node
#' ingests read sheets via exceljs. Requires the readxl package.
#' @param path XLSX path
#' @param sheet sheet name
#' @return data.frame of character columns (check.names = FALSE)
read_xlsx_sheet <- function(path, sheet) {
  if (!requireNamespace("readxl", quietly = TRUE)) {
    stop("read_xlsx_sheet() needs the 'readxl' package: install.packages(\"readxl\")")
  }
  df <- readxl::read_excel(path, sheet = sheet, col_types = "text")
  df <- as.data.frame(df, check.names = FALSE, stringsAsFactors = FALSE)
  for (i in seq_along(df)) {
    v <- ifelse(is.na(df[[i]]), "", df[[i]])
    # exceljs normalizes in-cell line breaks to "\n"; readxl keeps the raw
    # "\r\n" — normalize so multi-line cells round-trip identically.
    v <- gsub("\r\n?", "\n", v)
    df[[i]] <- trimws(v)
  }
  df[rowSums(df != "") > 0, , drop = FALSE]
}

#' Read just the header (column names) of a CSV, cheaply and robustly.
#' Handles a UTF-8 BOM and fully-quoted headers. NULL for empty files.
#' @param path CSV path
#' @return character vector of column names, or NULL
read_csv_header <- function(path) {
  line <- tryCatch(readLines(path, n = 1L, encoding = "UTF-8", warn = FALSE),
                   error = function(e) character(0))
  if (!length(line) || !nzchar(line)) return(NULL)
  line <- sub("^\ufeff", "", line)  # strip UTF-8 BOM if present
  cols <- strsplit(line, ",", fixed = TRUE)[[1]]
  trimws(gsub('^"|"$', "", cols))
}
