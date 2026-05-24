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

// parl_1919 is PR-only (Constituent Assembly), no SMD, no precincts.

async function generateBundle(election, sub, generatedAt) {
  const isMain = !sub || sub.id === "__main__";
  const files = isMain ? election.files : sub.files;

  const wb = new ExcelJS.Workbook();
  wb.creator = WORKBOOK_CREATOR;
  wb.created = generatedAt;
  wb.modified = generatedAt;

  buildCsvSheet(wb, "Results - Districts", readCSV(files?.pr_results));
  buildCsvSheet(wb, "Candidates",          readCSV(canonicalCandidatePath(election, sub, "pr")));

  addMetadataSheet(wb, election, sub, generatedAt);
  return writeBundle(wb, election, sub);
}

export async function generateParl1919Downloads({ generatedAt = new Date() } = {}) {
  const election = readElection("parl_1919");
  const results = [];
  for (const sub of subElections(election)) {
    results.push(await generateBundle(election, sub, generatedAt));
  }
  return results;
}
