// scripts/tally_audit.js
//
// Read a filled-in audit markdown file and report Prolog precision.
//
// Usage:
//   node scripts/tally_audit.js results/qa_batch_two_shot_openai_<timestamp>_PROLOG_AUDIT.md

import fs from "node:fs";

const inputPath = process.argv[2];
if (!inputPath) {
  console.error("Usage: node scripts/tally_audit.js <path-to-audit.md>");
  process.exit(1);
}

const text = fs.readFileSync(inputPath, "utf8");

const counts = { Y: 0, N: 0, P: 0, X: 0, TODO: 0 };
const lines = text.split(/\r?\n/);
for (const line of lines) {
  const m = line.match(/^\*\*Result:\*\*\s*(\S+)/i);
  if (!m) continue;
  const v = m[1].trim().toUpperCase();
  if (counts[v] !== undefined) counts[v]++;
  else counts.TODO++; // unknown markers count as not-yet-judged
}

const judged = counts.Y + counts.N + counts.P;
const total = judged + counts.TODO + counts.X;

console.log(`\n=== Prolog audit tally ===`);
console.log(`File: ${inputPath}\n`);
console.log(`Total questions:    ${total}`);
console.log(`  Y (correct):      ${counts.Y}`);
console.log(`  N (incorrect):    ${counts.N}`);
console.log(`  P (partial):      ${counts.P}`);
console.log(`  X (skipped):      ${counts.X}`);
console.log(`  TODO (unjudged):  ${counts.TODO}`);

if (judged > 0) {
  const strict = counts.Y / judged;
  const lenient = (counts.Y + counts.P) / judged;
  console.log(`\n--- Prolog precision ---`);
  console.log(`Strict   (Y / [Y+N+P]):       ${(100 * strict).toFixed(1)}%   (${counts.Y}/${judged})`);
  console.log(`Lenient  ([Y+P] / [Y+N+P]):   ${(100 * lenient).toFixed(1)}%   (${counts.Y + counts.P}/${judged})`);
} else {
  console.log(`\nNo questions have been judged yet. Edit the file and replace 'TODO' with Y/N/P/X.`);
}
