// Slim search index for the /candidates page. Excludes the per-cluster
// `appearances` arrays — those live in candidates-details.json (fetched
// lazily on the page). See ./config/candidates-build.js for the heavy lifting.
//
// Compact field names (one letter to shrink the payload):
//   c  = cluster_id
//   f  = first_name
//   l  = last_name
//   p  = latest_party_id (most recent)
//   ps = all party_ids the candidate ran for (most-recent first)
//   pl = election-specific party labels that differ from the global registry
//        — each entry is {i, k?, e?}. A field is omitted when it equals the
//        global registry's name_ka / name_en for that party_id. Page-side
//        code falls back to the registry when a field is missing.
//   y  = latest_year
//   a  = appearance summaries: [{e: election_id, v: vote_type}, …]
//   n  = appearance count
//   v  = non-canonical name variants (only when distinct from "first last")
import { buildCandidates } from "./config/candidates-build.js";

const built = await buildCandidates();

// Lookup so we can drop pl fields that exactly match the registry. ~60% of
// pl.e entries duplicate the registry name_en; stripping them shaves ~1 MB
// off the raw index without losing any election-specific aliasing.
const registry = built.parties ?? {};

// Encode each (e, v) appearance pair as integer indices into top-level
// lookup arrays instead of repeating "local_2014" / "council_smd" 90,000+
// times. Raw size drops by ~1.5 MB; the page-side appearanceLabel() looks
// the strings up by index. Election order matches `built.elections` so we
// don't need a separate lookup.
const electionIndex = new Map(built.elections.map((e, i) => [e.id, i]));
// vote_types appearing anywhere in the appearance summaries
const voteTypeSet = new Set();
for (const c of built.clusters) {
  for (const a of (c.appearances_summary || [])) if (a.v) voteTypeSet.add(a.v);
}
const voteTypes = [...voteTypeSet].sort();
const voteTypeIndex = new Map(voteTypes.map((v, i) => [v, i]));

function encodeAppearance(a) {
  const out = {
    e: electionIndex.get(a.e) ?? -1,
    v: voteTypeIndex.get(a.v) ?? -1
  };
  if (a.d) out.d = a.d;
  return out;
}

const slim = {
  generated_at: built.generated_at,
  elections: built.elections,
  parties: built.parties,
  // New: lookup tables so the page can decode integer-coded appearances.
  vote_types: voteTypes,
  clusters: built.clusters.map(c => {
    const canonical = `${c.first_name} ${c.last_name}`.trim();
    const variants = (c.name_variants || []).filter(v => v && v !== canonical);
    const obj = {
      c: c.cluster_id,
      f: c.first_name,
      l: c.last_name,
      p: c.latest_party_id,
      ps: c.parties,
      y: c.latest_year,
      a: (c.appearances_summary || []).map(encodeAppearance),
      n: c.appearance_count
    };
    if (c.party_labels?.length) {
      const pl = [];
      for (const p of c.party_labels) {
        const reg = registry[p.id];
        const entry = { i: p.id };
        if (p.name_ka && p.name_ka !== reg?.name_ka) entry.k = p.name_ka;
        if (p.name_en && p.name_en !== reg?.name_en) entry.e = p.name_en;
        // Only carry the inline entry if at least one field actually differs
        // from the global registry. Otherwise the page can resolve via the
        // party_id alone.
        if (entry.k !== undefined || entry.e !== undefined) pl.push(entry);
      }
      if (pl.length) obj.pl = pl;
    }
    if (variants.length) obj.v = variants;
    return obj;
  }),
  stats: {
    election_count: built.elections.length,
    cluster_count: built.clusters.length,
    appearance_count: built.appearance_count
  }
};

process.stdout.write(JSON.stringify(slim));
