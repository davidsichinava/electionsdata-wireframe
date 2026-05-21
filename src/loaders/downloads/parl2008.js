import ExcelJS from "exceljs";
import {
  WORKBOOK_CREATOR,
  addMetadataSheet,
  buildCsvSheet,
  canonicalCandidatePath,
  readCSV,
  readElection,
  subElections,
  writeBundle,
} from "./shared.js";

async function generateBundle(election, sub, generatedAt) {
  const isMain = !sub || sub.id === "__main__";
  const files = isMain ? election.files : sub.files;

  const wb = new ExcelJS.Workbook();
  wb.creator = WORKBOOK_CREATOR;
  wb.created = generatedAt;
  wb.modified = generatedAt;

  buildCsvSheet(wb, "PR - Districts", readCSV(files?.pr_results));
  buildCsvSheet(wb, "PR - Precincts", readCSV(files?.pr_precinct_results));
  buildCsvSheet(wb, "SMD - Districts", readCSV(files?.smd_results));
  buildCsvSheet(wb, "SMD - Precincts", readCSV(files?.smd_precinct_results));
  buildCsvSheet(wb, "Turnout - Districts", readCSV(election.turnout?.file));
  buildCsvSheet(wb, "Turnout - Precincts", readCSV(election.turnout?.precinct_file));
  // Candidate sheets now sourced from canonical CSVs (one per slot). See
  // src/data/candidates/README.md for the schema.
  buildCsvSheet(wb, "Party Lists",        readCSV(canonicalCandidatePath(election, sub, "pr")));
  buildCsvSheet(wb, "SMD Candidates",     readCSV(canonicalCandidatePath(election, sub, "smd")));
  buildCsvSheet(wb, "Elected Members",    readCSV(canonicalCandidatePath(election, sub, "elected")));
  buildCsvSheet(wb, "Annulled Precincts", readCSV(files?.annulled_precincts));

  addMetadataSheet(wb, election, sub, generatedAt);
  return writeBundle(wb, election, sub);
}

export async function generateParl2008Downloads({ generatedAt = new Date() } = {}) {
  const election = readElection("parl_2008");
  const results = [];
  for (const sub of subElections(election)) {
    results.push(await generateBundle(election, sub, generatedAt));
  }
  return results;
}
