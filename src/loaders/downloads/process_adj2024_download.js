#!/usr/bin/env node

import { ensureDownloadsDir } from "./shared.js";
import { generateAdj2024Downloads } from "./adj2024.js";

ensureDownloadsDir();

const entries = await generateAdj2024Downloads({ generatedAt: new Date() });
for (const entry of entries) {
  console.log(`Wrote src/data/downloads/${entry.filename}`);
  console.log(`  Sub: ${entry.sub_id} | Size: ${entry.size_bytes} bytes | SHA-256: ${entry.sha}`);
}
