#!/usr/bin/env Rscript
# scripts/test-districts.R
# Pins the R district-id helpers to the shared R/JS fixtures
# (src/loaders/R/common/districts_fixtures.csv). The JS twin is
# scripts/test-districts.js — run BOTH after touching either implementation.

source("src/loaders/R/common/districts.R")

fx <- read.csv("src/loaders/R/common/districts_fixtures.csv",
               colClasses = "character", fileEncoding = "UTF-8")
failed <- 0L
for (i in seq_len(nrow(fx))) {
  got <- switch(fx$fn[i],
    maj = selfgov_from_maj_id(fx$input[i]),
    raw = selfgov_from_raw_district_id(fx$input[i]),
    dotted = council_maj_id_from_dotted(fx$input[i]),
    stop("unknown fixture fn: ", fx$fn[i])
  )
  if (as.character(got) != fx$expected[i]) {
    failed <- failed + 1L
    cat(sprintf("✗ %s(%s) = %s, expected %s  (%s)\n",
                fx$fn[i], fx$input[i], got, fx$expected[i], fx$note[i]))
  }
}
if (failed > 0L) {
  cat(sprintf("\n%d/%d fixture(s) FAILED\n", failed, nrow(fx)))
  quit(status = 1)
}
cat(sprintf("All %d district-id fixtures passed (R).\n", nrow(fx)))
