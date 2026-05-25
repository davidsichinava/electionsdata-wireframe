// Slim search/browse index for the /parties page. Drops the per-lineage
// `appearances` array (lives in parties-details.json, lazy-fetched on first
// row expansion). Each lineage carries enough fields to render the master row
// and the small sparkline.
import { buildParties } from "./config/parties-build.js";

const built = await buildParties();

const slim = {
  generated_at: built.generated_at,
  elections: built.elections,
  lineages: built.lineages.map(l => ({
    id:               l.lineage_id,
    ids:              l.ids,
    name_ka:          l.name_ka,
    name_en:          l.name_en,
    color:            l.color,
    type:             l.type,
    category:         l.category,
    logo:             l.logo,
    election_ids:     l.election_ids,
    election_count:   l.election_count,
    candidate_count:  l.candidate_count,
    elected_count:    l.elected_count,
    seat_count:       l.seat_count,
    won_count:        l.won_count,
    first_year:       l.first_year,
    last_year:        l.last_year,
    peak_share:       l.peak_share,
    peak_year:        l.peak_year,
    peak_election:    l.peak_election,
    vote_share_series: l.vote_share_series
  })),
  stats: {
    lineage_count: built.lineages.length,
    election_count: built.elections.length
  }
};

process.stdout.write(JSON.stringify(slim));
