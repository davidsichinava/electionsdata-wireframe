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

// pres_2024_indirect was elected by an electoral college, not a popular vote.
// The bundle therefore carries only the candidate / elected sheet plus
// metadata; there are no precinct-level results.

async function generateBundle(election, sub, generatedAt) {
  const wb = new ExcelJS.Workbook();
  wb.creator = WORKBOOK_CREATOR;
  wb.created = generatedAt;
  wb.modified = generatedAt;

  buildCsvSheet(wb, "Candidates", readCSV(canonicalCandidatePath(election, sub, "presidential")));

  addMetadataSheet(wb, election, sub, generatedAt);
  return writeBundle(wb, election, sub);
}

export async function generatePres2024IndirectDownloads({ generatedAt = new Date() } = {}) {
  const election = readElection("pres_2024_indirect");
  const results = [];
  for (const sub of subElections(election)) {
    results.push(await generateBundle(election, sub, generatedAt));
  }
  return results;
}
