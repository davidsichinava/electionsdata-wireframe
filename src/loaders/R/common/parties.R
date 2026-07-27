# src/loaders/R/common/parties.R
# Party-label → party_id resolver, shared by every *_candidates.R loader.
# Port of the resolver that was copy-pasted across scripts/ingest-*.js.
#
# Resolution order (unchanged from the node version):
#   1. The election YAML's parties[] — alias.ka and the global registry name.ka
#      for each listed id (election-specific labels win).
#   2. The whole global registry (src/data/config/parties.yml) name.ka.
# Matching is on normalized labels (lowercase, letters+digits only, ური→ული),
# accepting exact or substring matches either way; longest match wins, exact
# match gets a large bonus, first hit wins ties.
#
# Needs the `yaml` package (already used by all existing loaders); everything
# else is base R.

#' Normalize a Georgian party label for fuzzy matching.
#' @param s character scalar (NA-safe)
#' @return lowercase string with only letters/digits, ური endings → ული
norm_party_label <- function(s) {
  x <- if (is.null(s) || is.na(s)) "" else as.character(s)
  x <- tolower(x)
  x <- gsub("[^\\p{L}\\p{N}]+", "", x, perl = TRUE)
  gsub("ური", "ული", x, fixed = TRUE)
}

#' Best-matching party id for a label among (id, name_ka) pairs.
#' @param label raw party label from a source file
#' @param pairs list of c(id, name_ka) in priority order
#' @return party id string, or NULL when nothing matches
best_match_from_pairs <- function(label, pairs) {
  norm <- norm_party_label(label)
  if (!nzchar(norm)) return(NULL)
  best_pid <- NULL
  best_score <- -Inf
  for (pr in pairs) {
    nk <- norm_party_label(pr[[2]])
    if (!nzchar(nk)) next
    if (!(norm == nk || grepl(nk, norm, fixed = TRUE) || grepl(norm, nk, fixed = TRUE))) next
    score <- nchar(nk) + if (norm == nk) 1000L else 0L
    if (score > best_score) {
      best_score <- score
      best_pid <- pr[[1]]
    }
  }
  best_pid
}

#' Build a party resolver bound to one election.
#' @param election_yml path to the election's YAML (its parties[] gives tier-1 aliases)
#' @param parties_yml path to the global party registry
#' @return list(resolve = function(label) id-or-"", unresolved = function() named counts)
#' @examples
#'   resolver <- make_party_resolver("src/data/config/elections/adjara/adj_2024.yml")
#'   resolver$resolve("„ქართული ოცნება“")   # → "gd"
#'   resolver$unresolved()                    # labels that never matched, with counts
make_party_resolver <- function(election_yml,
                                parties_yml = "src/data/config/parties.yml") {
  registry <- yaml::read_yaml(parties_yml)$parties
  if (is.null(registry)) registry <- list()
  ids <- vapply(registry, function(p) {
    if (!is.character(p$id)) {
      stop("Party id parsed as ", class(p$id), " (", format(p$id), ") in ", parties_yml,
           " — YAML-boolean-like ids (yes/no/on/off/true/false) must be quoted.",
           call. = FALSE)
    }
    p$id
  }, character(1))
  reg_by_id <- stats::setNames(registry, ids)

  edoc <- yaml::read_yaml(election_yml)

  tier1 <- list()
  for (p in if (is.null(edoc$parties)) list() else edoc$parties) {
    if (!is.null(p$alias$ka)) tier1[[length(tier1) + 1]] <- c(p$id, p$alias$ka)
    reg_name <- reg_by_id[[p$id]]$name$ka
    if (!is.null(reg_name)) tier1[[length(tier1) + 1]] <- c(p$id, reg_name)
  }
  tier2 <- list()
  for (p in registry) {
    if (!is.null(p$name$ka)) tier2[[length(tier2) + 1]] <- c(p$id, p$name$ka)
  }

  unresolved <- new.env(parent = emptyenv())

  resolve <- function(label) {
    if (is.null(label) || is.na(label) || !nzchar(label)) return("")
    hit <- best_match_from_pairs(label, tier1)
    if (is.null(hit)) hit <- best_match_from_pairs(label, tier2)
    if (is.null(hit)) {
      key <- as.character(label)
      unresolved[[key]] <- (if (is.null(unresolved[[key]])) 0L else unresolved[[key]]) + 1L
      return("")
    }
    hit
  }

  list(
    resolve = resolve,
    unresolved = function() {
      keys <- ls(unresolved)
      stats::setNames(vapply(keys, function(k) unresolved[[k]], integer(1)), keys)
    }
  )
}

#' Is a raw party label actually an initiative group / independent candidacy?
#' (Those get party_id = "" instead of being fuzzy-matched to a party.)
#' Port of isInitiative() from the local-election node ingests: explicit
#' "საინიციატივო ჯგუფი…" / bare "დამოუკიდებელი", or a bare comma-separated
#' name list (3+ commas, no curly-quote-wrapped party name).
#' @param label raw label
#' @return TRUE/FALSE
is_initiative_label <- function(label) {
  if (is.null(label) || is.na(label) || !nzchar(label)) return(FALSE)
  if (grepl("^\\s*საინიციატივო\\s+ჯგუფი", label)) return(TRUE)
  if (grepl("^\\s*დამოუკიდებელი\\s*$", label)) return(TRUE)
  commas <- lengths(regmatches(label, gregexpr(",", label, fixed = TRUE)))
  if (commas >= 3 && !grepl("[„\"]", label)) return(TRUE)
  FALSE
}

#' Print the standard unresolved-labels report (same text as the node ingests).
#' @param resolver a make_party_resolver() result
report_unresolved <- function(resolver) {
  u <- resolver$unresolved()
  if (length(u) == 0) {
    cat("\nAll party labels resolved against the registry.\n")
  } else {
    cat(sprintf("\n%d unresolved party labels:\n", length(u)))
    for (i in order(-u)) cat(sprintf("  [%d] %s\n", u[[i]], names(u)[[i]]))
  }
  invisible(u)
}
