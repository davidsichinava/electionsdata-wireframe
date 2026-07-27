#!/usr/bin/env Rscript
# scripts/validate-canonical.R
# Schema drift report: validates every CSV under src/data/results/ and
# src/data/candidates/ against the canonical schemas in src/loaders/R/common/schema.R.
# Read-only — writes only the report files under reports/.
#
# Run from repo root:
#   Rscript scripts/validate-canonical.R
#
# Outputs:
#   reports/schema-drift.csv       one row per file: level, exact/order/missing/extra
#   reports/schema-signatures.csv  one row per distinct header signature per level
#   console                        per-level conformance rollup

source("src/loaders/R/common/schema.R")
source("src/loaders/R/common/io.R")

RESULTS_DIR    <- "src/data/results"
CANDIDATES_DIR <- "src/data/candidates"
REPORT_DIR     <- "reports"
dir.create(REPORT_DIR, showWarnings = FALSE, recursive = TRUE)

# Canonical candidate rosters are named {election_id}_{slot}.csv where the
# election id contains an underscore before the year (local_2014_pr.csv).
# Everything else in the candidates dir is a legacy artifact of the old R
# loaders (local2014_party_lists.csv, …) slated for retirement.
is_canonical_candidate_file <- function(base) {
  grepl("^[a-z0-9]+_[0-9]{4}(_[a-z0-9]+)*_(pr|smd|council_smd|mayor|gamgebeli|elected)\\.csv$", base)
}

audit_file <- function(path, level) {
  header <- read_csv_header(path)
  if (is.null(header)) {
    return(data.frame(
      file = basename(path), level = level, status = "EMPTY",
      exact = FALSE, order_ok = FALSE, n_missing = NA, n_extra = NA,
      missing = "", extra = "", signature = "",
      stringsAsFactors = FALSE
    ))
  }
  v <- validate_header(header, level)
  status <- if (v$exact) "EXACT" else if (v$ok) "CONFORMANT" else "DRIFT"
  data.frame(
    file = basename(path), level = level, status = status,
    exact = v$exact, order_ok = v$order_ok,
    n_missing = length(v$missing), n_extra = length(v$extra),
    missing = paste(v$missing, collapse = "|"),
    extra = paste(v$extra, collapse = "|"),
    signature = paste(header, collapse = ","),
    stringsAsFactors = FALSE
  )
}

rows <- list()

# ── Results tree ────────────────────────────────────────────────────────────
for (f in sort(list.files(RESULTS_DIR, pattern = "\\.csv$", full.names = TRUE))) {
  rows[[length(rows) + 1]] <- audit_file(f, classify_results_file(f))
}

# ── Candidates tree ─────────────────────────────────────────────────────────
for (f in sort(list.files(CANDIDATES_DIR, pattern = "\\.csv$", full.names = TRUE))) {
  base <- basename(f)
  if (is_canonical_candidate_file(base)) {
    rows[[length(rows) + 1]] <- audit_file(f, "candidates")
  } else {
    header <- read_csv_header(f)
    rows[[length(rows) + 1]] <- data.frame(
      file = base, level = "candidates-legacy", status = "LEGACY",
      exact = FALSE, order_ok = FALSE, n_missing = NA, n_extra = NA,
      missing = "", extra = "",
      signature = if (is.null(header)) "" else paste(header, collapse = ","),
      stringsAsFactors = FALSE
    )
  }
}

report <- do.call(rbind, rows)
write.csv(report, file.path(REPORT_DIR, "schema-drift.csv"),
          row.names = FALSE, fileEncoding = "UTF-8")

# ── Signature rollup ────────────────────────────────────────────────────────
sig <- aggregate(file ~ level + signature, data = report[report$signature != "", ],
                 FUN = function(x) length(x))
names(sig)[names(sig) == "file"] <- "n_files"
examples <- aggregate(file ~ level + signature, data = report[report$signature != "", ],
                      FUN = function(x) paste(head(x, 2), collapse = "; "))
names(examples)[names(examples) == "file"] <- "examples"
sig <- merge(sig, examples, by = c("level", "signature"))
sig <- sig[order(sig$level, -sig$n_files), c("level", "n_files", "examples", "signature")]
write.csv(sig, file.path(REPORT_DIR, "schema-signatures.csv"),
          row.names = FALSE, fileEncoding = "UTF-8")

# ── Console rollup ──────────────────────────────────────────────────────────
cat("── Canonical-schema drift report ──\n\n")
for (lv in unique(report$level)) {
  sub <- report[report$level == lv, ]
  n_sig <- length(unique(sub$signature[sub$signature != ""]))
  cat(sprintf("%-18s %3d files | %2d signatures | EXACT %3d | CONFORMANT %3d | DRIFT %3d | other %d\n",
              lv, nrow(sub), n_sig,
              sum(sub$status == "EXACT"), sum(sub$status == "CONFORMANT"),
              sum(sub$status == "DRIFT"),
              sum(!sub$status %in% c("EXACT", "CONFORMANT", "DRIFT"))))
}

drift <- report[report$status == "DRIFT", ]
if (nrow(drift)) {
  miss_tab <- sort(table(unlist(strsplit(drift$missing[drift$missing != ""], "|", fixed = TRUE))),
                   decreasing = TRUE)
  extra_tab <- sort(table(unlist(strsplit(drift$extra[drift$extra != ""], "|", fixed = TRUE))),
                    decreasing = TRUE)
  cat("\nMost-missing canonical columns:\n")
  for (nm in names(head(miss_tab, 8))) cat(sprintf("  %-18s absent from %d file(s)\n", nm, miss_tab[[nm]]))
  if (length(extra_tab)) {
    cat("Non-canonical extra columns:\n")
    for (nm in names(head(extra_tab, 8))) cat(sprintf("  %-18s present in %d file(s)\n", nm, extra_tab[[nm]]))
  }
}

cat(sprintf("\nReports: %s, %s\n",
            file.path(REPORT_DIR, "schema-drift.csv"),
            file.path(REPORT_DIR, "schema-signatures.csv")))
