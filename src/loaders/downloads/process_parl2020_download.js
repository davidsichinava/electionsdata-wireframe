#!/usr/bin/env node

import { ensureDownloadsDir } from "./shared.js";
import { generateParl2020Downloads } from "./parl2020.js";

ensureDownloadsDir();

const entries = await generateParl2020Downloads({ generatedAt: new Date() });
for (const entry of entries) {
  console.log(`Wrote src/data/downloads/${entry.filename}`);
  console.log(`  Sub: ${entry.sub_id} | Size: ${entry.size_bytes} bytes | SHA-256: ${entry.sha}`);
}
