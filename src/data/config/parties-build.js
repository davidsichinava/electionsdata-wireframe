// Shared loader for the /parties page. Returns one entry per *lineage*
// (a lineage groups multiple party_ids that share a continuous political
// identity — e.g. `greens` + `greens_geo` collapse into one row).
//
// Consumed by:
//   - src/data/parties-index.json.js     (slim search/browse list)
//   - src/data/parties-details.json.js   (per-lineage appearance arrays)
//
// Inputs:
//   - src/data/config/parties.yml                (canonical registry)
//   - src/data/config/elections/**/*.yml         (party rosters per election)
//   - candidates-build.js output                 (candidate counts + appearances)
//   - src/data/results/*_pr.csv, *_smd.csv …     (national vote shares)
//
// We piggy-back on buildCandidates() so we don't re-parse the 24 candidate
// CSVs and ~5 YAML rosters from scratch. The cost is one extra full pass at
// build time; in dev preview the result is cached per loader.

import { readdirSync, readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { load as yamlLoad } from "js-yaml";
import { csvParse } from "d3-dsv";
import { buildCandidates } from "./candidates-build.js";

const ROOT = "src";
const PARTIES_YML = join(ROOT, "data/config/parties.yml");
const CONFIG_ELECTIONS_DIR = join(ROOT, "data/config/elections");

// ─── helpers ────────────────────────────────────────────────────────────────

function readYaml(path) {
  const text = readFileSync(path, "utf8");
  try { return yamlLoad(text); }
  catch { return yamlLoad(text, { json: true }); }
}

function readCsv(relPath) {
  const abs = join(ROOT, relPath);
  if (!existsSync(abs)) return null;
  return csvParse(readFileSync(abs, "utf8"));
}

function collectYmlFiles(base) {
  const out = [];
  for (const entry of readdirSync(base, { withFileTypes: true })) {
    const full = join(base, entry.name);
    if (entry.isDirectory()) out.push(...collectYmlFiles(full));
    else if (entry.name.endsWith(".yml")) out.push(full);
  }
  return out;
}

function yearFromId(id) {
  const m = String(id).match(/(\d{4})/);
  return m ? Number(m[1]) : null;
}

// Heuristic when explicit `category` is absent. Only four user-facing
// buckets now: party | coalition | historic | (and a few aux buckets that
// don't get their own filter chip — independent | option | other).
function inferCategory(party, electionCount) {
  if (party.type === "bloc" || party.type === "alliance") return "coalition";
  if (party.type === "independent") return "independent";
  if (party.type === "option") return "option";
  if (party.type === "other") return "other";
  if (electionCount === 0) return "other";
  return "party";
}

// ─── load registry + lineage map ────────────────────────────────────────────

const partiesYml = readYaml(PARTIES_YML);
const registry = {};
for (const p of (partiesYml?.parties ?? [])) registry[p.id] = p;

function lineageIdOf(party_id) {
  return registry[party_id]?.lineage ?? party_id;
}

// ─── helper: parse vote_share from PR national row ──────────────────────────

const resultsCache = new Map();
function loadResults(relPath) {
  if (!relPath) return null;
  if (resultsCache.has(relPath)) return resultsCache.get(relPath);
  const rows = readCsv(relPath);
  resultsCache.set(relPath, rows);
  return rows;
}

// Look up the national PR vote share AND total vote count for one party in
// one election. Tries (in order) pr_results, pr_selfgov_results,
// council_pr_results. Returns { share, votes } — either field may be null.
function partyPrResult(election, party_id) {
  const candidates = [
    election.files?.pr_results,
    election.files?.council_pr_results
  ].filter(Boolean);

  for (const path of candidates) {
    const rows = loadResults(path);
    if (!rows) continue;
    // Find national aggregate row(s) for this party. Different schemas:
    // - parl: district_id="national", one row per party
    // - local: pr_results may be per-selfgov, no "national" row — sum.
    const national = rows.find(r => r.party_id === party_id && (r.district_id === "national" || r.district_id === "0"));
    if (national) {
      const share = Number(national.vote_share);
      const votes = Number(national.votes);
      if (Number.isFinite(share) && share > 0) {
        return { share, votes: Number.isFinite(votes) && votes > 0 ? votes : null };
      }
    }
    // Sum-fallback: total votes for this party / total valid PR votes.
    const partyRows = rows.filter(r => r.party_id === party_id && r.district_id !== "national" && r.district_id !== "0");
    if (partyRows.length) {
      const partyVotes = partyRows.reduce((s, r) => s + (Number(r.votes) || 0), 0);
      // Total valid votes across all parties at the same district_ids:
      const districts = new Set(partyRows.map(r => r.district_id));
      const totalRows = rows.filter(r => districts.has(r.district_id) && r.district_id !== "national");
      const totalVotes = totalRows.reduce((s, r) => s + (Number(r.votes) || 0), 0);
      if (totalVotes > 0) {
        return { share: partyVotes / totalVotes, votes: partyVotes };
      }
    }
  }
  return { share: null, votes: null };
}

// Backwards-compatible wrapper (some call sites still want just the share).
function partyPrVoteShare(election, party_id) {
  return partyPrResult(election, party_id).share;
}

// ─── main build ─────────────────────────────────────────────────────────────

export async function buildParties() {
  // Pull the appearance graph from the candidates loader. Each cluster has
  // a list of appearances (election_id, party_id, vote_type, district_id,
  // votes, vote_share, list_order, elected, district_name, …).
  const candidatesData = await buildCandidates();

  // Group appearances by (party_id, election_id) so we can later collapse
  // party_id → lineage_id.
  const electionMeta = new Map(candidatesData.elections.map(e => [e.id, e]));

  // Index appearances by party_id × election_id, accumulating candidate counts.
  // Also keep the most recent candidate name (top of PR list / first elected).
  const partyElectionIndex = new Map(); // key = `${party_id}|${election_id}`
  for (const cluster of candidatesData.clusters) {
    for (const ap of cluster.appearances) {
      if (!ap.party_id) continue;
      const key = `${ap.party_id}|${ap.election_id}`;
      let entry = partyElectionIndex.get(key);
      if (!entry) {
        entry = {
          party_id: ap.party_id,
          election_id: ap.election_id,
          party_label_ka: ap.party_label_ka ?? null,
          party_label_en: ap.party_label_en ?? null,
          candidate_count: 0,
          pr_candidates: 0,
          smd_candidates: 0,
          mayor_candidates: 0,
          elected_count: 0,
          top_pr_candidate: null,  // {name, list_order}
          // Stronghold = district with highest vote_share (SMD) or (PR district share)
          stronghold: null
        };
        partyElectionIndex.set(key, entry);
      }
      entry.candidate_count++;
      if (ap.vote_type === "pr") entry.pr_candidates++;
      else if (ap.vote_type === "smd" || ap.vote_type === "council_smd" || ap.vote_type === "sakrebulo_smd") entry.smd_candidates++;
      else if (ap.vote_type === "mayor" || ap.vote_type === "gamgebeli") entry.mayor_candidates++;
      if (ap.elected) entry.elected_count++;

      // Top PR list candidate: pick the one with the lowest list_order
      if (ap.vote_type === "pr" && ap.list_order != null) {
        const candName = `${cluster.first_name} ${cluster.last_name}`.trim();
        if (!entry.top_pr_candidate || ap.list_order < entry.top_pr_candidate.list_order) {
          entry.top_pr_candidate = { name: candName, list_order: ap.list_order };
        }
      }
      // Stronghold: highest vote_share appearance
      if (ap.vote_share != null && ap.district_name_ka) {
        if (!entry.stronghold || ap.vote_share > entry.stronghold.vote_share) {
          entry.stronghold = {
            district_name_ka: ap.district_name_ka,
            district_name_en: ap.district_name_en ?? null,
            vote_share: ap.vote_share,
            district_id: ap.district_id ?? null
          };
        }
      }
    }
  }

  // Layer election-YAML facts (seats, threshold) on top, and compute national
  // PR vote share by reading the results CSV for each election.
  const electionFiles = collectYmlFiles(CONFIG_ELECTIONS_DIR);
  for (const fpath of electionFiles) {
    const election = readYaml(fpath);
    if (!election?.id) continue;
    for (const p of (election.parties ?? [])) {
      const key = `${p.id}|${election.id}`;
      let entry = partyElectionIndex.get(key);
      if (!entry) {
        // Party listed in election YAML but no candidates in our data — still
        // record the appearance so seats/threshold show up.
        entry = {
          party_id: p.id,
          election_id: election.id,
          party_label_ka: p.alias?.ka ?? null,
          party_label_en: p.alias?.en ?? null,
          candidate_count: 0,
          pr_candidates: 0,
          smd_candidates: 0,
          mayor_candidates: 0,
          elected_count: 0,
          top_pr_candidate: null,
          stronghold: null
        };
        partyElectionIndex.set(key, entry);
      }
      entry.seats_pr = Number(p.seats_pr) || 0;
      entry.seats_smd = Number(p.seats_smd) || 0;
      entry.threshold_status = p.threshold_status ?? null;
      // Honour election-level alias overrides (more authoritative than
      // anything inferred from candidate appearances).
      entry.party_label_ka = p.alias?.ka ?? entry.party_label_ka;
      entry.party_label_en = p.alias?.en ?? entry.party_label_en;
      entry.color_override = p.color ?? null;
      const result = partyPrResult(election, p.id);
      entry.vote_share = result.share;
      entry.votes = result.votes;
    }
  }

  // Build lineage-grouped output. A lineage has many appearances (one per
  // (party_id × election)). We pick the most-recent appearance's name as the
  // lineage display name.
  const byLineage = new Map();
  for (const entry of partiesIterByRecencyDesc(partyElectionIndex, electionMeta)) {
    const lid = lineageIdOf(entry.party_id);
    let lin = byLineage.get(lid);
    if (!lin) {
      lin = {
        lineage_id: lid,
        ids: new Set(),
        // Display fields populated by most-recent appearance
        name_ka: null,
        name_en: null,
        color: null,
        type: null,
        category: null,
        logo: null,
        appearances: [],
        latest_year: -Infinity,
        first_year: Infinity,
        peak_share: 0,
        peak_year: null,
        peak_election: null,
        total_candidates: 0,
        total_elected: 0,
        total_seats: 0,
        total_won: 0
      };
      byLineage.set(lid, lin);
    }
    lin.ids.add(entry.party_id);
    const reg = registry[entry.party_id] ?? {};
    const year = yearFromId(entry.election_id);

    // The display name uses the most-recent registered identity for this
    // lineage; if the lineage_id itself is registered, prefer that.
    const lineageReg = registry[lid];
    if (lineageReg) {
      lin.name_ka = lineageReg.name?.ka ?? lin.name_ka;
      lin.name_en = lineageReg.name?.en ?? lin.name_en;
      lin.color = lineageReg.color ?? lin.color;
      lin.type = lineageReg.type ?? lin.type;
      lin.category = lineageReg.category ?? lin.category;
      lin.logo = lineageReg.logo ?? lin.logo;
    }
    // Fall back to most-recent party_id's registry entry if lineage_id isn't
    // registered (rare; only if someone uses a lineage value that's not also a
    // party_id).
    if (!lin.name_ka || !lin.name_en) {
      lin.name_ka = lin.name_ka ?? reg.name?.ka ?? entry.party_label_ka ?? entry.party_id;
      lin.name_en = lin.name_en ?? reg.name?.en ?? entry.party_label_en ?? entry.party_id;
      lin.color = lin.color ?? reg.color ?? null;
      lin.type = lin.type ?? reg.type ?? "party";
    }

    // `won` = best estimate of seats/positions secured by this party in this
    // election. YAML `seats_pr + seats_smd` is authoritative when present
    // (parliamentary/Adjara); local YAMLs lack it, so the candidate-level
    // elected_count (from per-election elected.csv) is the fallback. Take
    // max() so neither source under-counts the other.
    const seatsYaml = (entry.seats_pr ?? 0) + (entry.seats_smd ?? 0);
    const won = Math.max(seatsYaml, entry.elected_count ?? 0);

    // Append the appearance.
    lin.appearances.push({
      election_id: entry.election_id,
      year,
      party_id: entry.party_id,
      party_label_ka: entry.party_label_ka,
      party_label_en: entry.party_label_en,
      seats_pr: entry.seats_pr ?? 0,
      seats_smd: entry.seats_smd ?? 0,
      won,
      threshold_status: entry.threshold_status ?? null,
      vote_share: entry.vote_share ?? null,
      votes: entry.votes ?? null,
      candidate_count: entry.candidate_count ?? 0,
      pr_candidates: entry.pr_candidates ?? 0,
      smd_candidates: entry.smd_candidates ?? 0,
      mayor_candidates: entry.mayor_candidates ?? 0,
      elected_count: entry.elected_count ?? 0,
      top_pr_candidate: entry.top_pr_candidate,
      stronghold: entry.stronghold,
      color_override: entry.color_override ?? null
    });

    if (year != null) {
      lin.latest_year = Math.max(lin.latest_year, year);
      lin.first_year = Math.min(lin.first_year, year);
    }
    if (entry.vote_share != null && entry.vote_share > lin.peak_share) {
      lin.peak_share = entry.vote_share;
      lin.peak_year = year;
      lin.peak_election = entry.election_id;
    }
    lin.total_candidates += entry.candidate_count ?? 0;
    lin.total_elected += entry.elected_count ?? 0;
    lin.total_seats += (entry.seats_pr ?? 0) + (entry.seats_smd ?? 0);
    lin.total_won += won;
  }

  // Finalise lineage records.
  const registeredIds = new Set(Object.keys(registry));
  const lineagesAll = [...byLineage.values()].map(l => {
    const ids = [...l.ids];
    const appearances = l.appearances.sort((a, b) => (b.year ?? 0) - (a.year ?? 0));
    // Distinct election_ids this lineage participated in. Exposed to the
    // /parties page so it can honour a `?election=<id>` deep-link from
    // /elections, filtering the lineage list to "participating groups only".
    const electionIds = [...new Set(appearances.map(a => a.election_id).filter(Boolean))];
    const electionCount = electionIds.length;
    const category = l.category ?? inferCategory({ type: l.type, id: l.lineage_id }, electionCount);
    // Vote share time series for sparklines (year → max share across appearances
    // in that year, e.g. picks the PR share over SMD-aggregate fallback).
    const sharesByYear = new Map();
    for (const a of appearances) {
      if (a.year == null || a.vote_share == null) continue;
      const prev = sharesByYear.get(a.year);
      if (prev == null || a.vote_share > prev) sharesByYear.set(a.year, a.vote_share);
    }
    const vote_share_series = [...sharesByYear.entries()]
      .sort((a, b) => a[0] - b[0])
      .map(([y, s]) => [y, s]);

    return {
      lineage_id: l.lineage_id,
      ids,
      name_ka: l.name_ka,
      name_en: l.name_en,
      color: l.color,
      type: l.type,
      category,
      logo: l.logo,
      election_ids: electionIds,
      election_count: electionCount,
      candidate_count: l.total_candidates,
      elected_count: l.total_elected,
      seat_count: l.total_seats,
      won_count: l.total_won,
      first_year: l.first_year === Infinity ? null : l.first_year,
      last_year: l.latest_year === -Infinity ? null : l.latest_year,
      peak_share: l.peak_share || null,
      peak_year: l.peak_year,
      peak_election: l.peak_election,
      vote_share_series,
      appearances
    };
  });

  // Noise filter — by-election ballot-position pseudo-parties (ids like
  // `parl2012_2015_*_42`, `mtatsminda_2019_9`, `zugdidi_2018_*`) and lone
  // presidential candidate "initiative groups" (lowercase-name ids that are
  // really one person) clutter the list. Keep a lineage only if its id is
  // registered in parties.yml OR it has enough candidates to be a real
  // political vehicle (≥ 5).
  const lineages = lineagesAll.filter(l =>
    registeredIds.has(l.lineage_id) || (l.candidate_count ?? 0) >= 5
  );

  // Sort by peak PR vote share descending. Ties broken by total candidates
  // (i.e. bigger party fielded more people), then by name.
  lineages.sort((a, b) => {
    const pa = a.peak_share ?? 0;
    const pb = b.peak_share ?? 0;
    if (pb !== pa) return pb - pa;
    if ((b.candidate_count ?? 0) !== (a.candidate_count ?? 0)) return (b.candidate_count ?? 0) - (a.candidate_count ?? 0);
    return (a.name_en ?? "").localeCompare(b.name_en ?? "", "en");
  });

  return {
    generated_at: new Date().toISOString(),
    elections: candidatesData.elections,
    lineages
  };
}

// Iterate the index in election-recency-desc order so display names get the
// freshest values when a lineage spans multiple ids.
function partiesIterByRecencyDesc(idx, electionMeta) {
  const list = [...idx.values()];
  list.sort((a, b) => {
    const ya = electionMeta.get(a.election_id)?.year ?? 0;
    const yb = electionMeta.get(b.election_id)?.year ?? 0;
    return yb - ya;
  });
  return list;
}
