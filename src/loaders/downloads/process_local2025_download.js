#!/usr/bin/env node

import { ensureDownloadsDir } from "./shared.js";
import { generateLocal2025Downloads } from "./local2025.js";

ensureDownloadsDir();

const entries = await generateLocal2025Downloads({ generatedAt: new Date() });
for (const entry of entries) {
  console.log(`Wrote src/data/downloads/${entry.filename}`);
  console.log(`  Sub: ${entry.sub_id} | Size: ${entry.size_bytes} bytes | SHA-256: ${entry.sha}`);
}
