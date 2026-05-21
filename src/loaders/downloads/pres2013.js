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

  buildCsvSheet(wb, "Results - Districts", readCSV(files?.pr_results));
  buildCsvSheet(wb, "Results - Precincts", readCSV(files?.pr_precinct_results));
  buildCsvSheet(wb, "Turnout - Districts", readCSV(election.turnout?.file));
  buildCsvSheet(wb, "Turnout - Precincts", readCSV(election.turnout?.precinct_file));
  buildCsvSheet(wb, "Candidates",      readCSV(canonicalCandidatePath(election, sub, "presidential")));
  buildCsvSheet(wb, "Elected Members", readCSV(canonicalCandidatePath(election, sub, "elected")));

  addMetadataSheet(wb, election, sub, generatedAt);
  return writeBundle(wb, election, sub);
}

export async function generatePres2013Downloads({ generatedAt = new Date() } = {}) {
  const election = readElection("pres_2013");
  const results = [];
  for (const sub of subElections(election)) {
    results.push(await generateBundle(election, sub, generatedAt));
  }
  return results;
}
