import ExcelJS from "exceljs";
import {
  WORKBOOK_CREATOR,
  addMetadataSheet,
  buildCsvSheet,
  canonicalCandidatePath,
  readCSV,
  readElection,
  subElections,
  subElectionSheetLabel,
  writeBundle,
} from "./shared.js";

async function generateBundle(election, sub, generatedAt) {
  const isMain = !sub || sub.id === "__main__";
  const files = isMain ? election.files : sub.files;

  const wb = new ExcelJS.Workbook();
  wb.creator = WORKBOOK_CREATOR;
  wb.created = generatedAt;
  wb.modified = generatedAt;

  if (isMain) {
    // PR results: national + selfgov + precincts
    buildCsvSheet(wb, "PR - National + Selfgov", readCSV(files?.pr_results));
    buildCsvSheet(wb, "PR - Selfgov Detail", readCSV(files?.pr_selfgov_results));
    buildCsvSheet(wb, "PR - Precincts", readCSV(files?.pr_precinct_results));

    // Mayor (SMD) results
    buildCsvSheet(wb, "Mayor - Results", readCSV(files?.smd_results));
    buildCsvSheet(wb, "Mayor - Districts", readCSV(files?.smd_district_results));
    buildCsvSheet(wb, "Mayor - Precincts", readCSV(files?.smd_precinct_results));

    // Council SMD
    buildCsvSheet(wb, "Council SMD - Results", readCSV(files?.council_smd_results));
    buildCsvSheet(wb, "Council SMD - Precincts", readCSV(files?.council_smd_precinct_results));

    // Canonical candidate sheets (sourced from adg_2017_candidates_unified.xlsx).
    buildCsvSheet(wb, "Party Lists",            readCSV(canonicalCandidatePath(election, sub, "pr")));
    buildCsvSheet(wb, "Council SMD Candidates", readCSV(canonicalCandidatePath(election, sub, "council_smd")));
    buildCsvSheet(wb, "Mayor Candidates",       readCSV(canonicalCandidatePath(election, sub, "mayor")));
    buildCsvSheet(wb, "Elected Members",        readCSV(canonicalCandidatePath(election, sub, "elected")));
  } else {
    const label = subElectionSheetLabel(sub);
    buildCsvSheet(wb, `Mayor ${label} - Results`, readCSV(files?.smd_results));
    buildCsvSheet(wb, `Mayor ${label} - Precincts`, readCSV(files?.smd_precinct_results));
    buildCsvSheet(wb, `Council ${label} - Results`, readCSV(files?.council_smd_results));
    buildCsvSheet(wb, `Council ${label} - Precincts`, readCSV(files?.council_smd_precinct_results));
  }

  addMetadataSheet(wb, election, sub, generatedAt);
  return writeBundle(wb, election, sub);
}

export async function generateLocal2017Downloads({ generatedAt = new Date() } = {}) {
  const election = readElection("local_2017");
  const results = [];
  for (const sub of subElections(election)) {
    results.push(await generateBundle(election, sub, generatedAt));
  }
  return results;
}
