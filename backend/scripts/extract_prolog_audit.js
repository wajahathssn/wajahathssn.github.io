// scripts/extract_prolog_audit.js
//
// Read a batch JSON, pull every question where Prolog produced bindings,
// write a markdown audit file with the abstract, question, Prolog binding,
// and Path A answer for each. Fill in Y / N / P inline, then run
// tally_audit.js to count them.
//
// Usage:
//   node scripts/extract_prolog_audit.js results/qa_batch_two_shot_openai_<timestamp>.json

import fs from "node:fs";
import path from "node:path";

const inputPath = process.argv[2];
if (!inputPath) {
  console.error("Usage: node scripts/extract_prolog_audit.js <path-to-batch.json>");
  process.exit(1);
}

const data = JSON.parse(fs.readFileSync(inputPath, "utf8"));
const rows = (data.results || []).filter(r => r.ok);

const lines = [];
lines.push(`# Prolog audit — ${data.config?.EXTRACTION_MODE} / ${data.config?.ANSWER_PROVIDER}`);
lines.push("");
lines.push(`Generated from: \`${path.basename(inputPath)}\``);
lines.push("");
lines.push(`## Instructions`);
lines.push("");
lines.push(`For each question below, judge whether **Prolog's binding** is a correct answer to the question given the abstract.`);
lines.push(`Edit the \`**Result:** TODO\` line at the end of each question and replace **TODO** with one of:`);
lines.push("");
lines.push(`- \`Y\` — Prolog's binding is a correct, sensible answer to the question`);
lines.push(`- \`N\` — Prolog's binding is wrong or misleading`);
lines.push(`- \`P\` — partially correct (e.g. one of multiple bindings is right, or it's right but incomplete)`);
lines.push(`- \`X\` — skip (question is malformed or unanswerable)`);
lines.push("");
lines.push(`When you're done, run:`);
lines.push("");
lines.push("```");
lines.push(`node scripts/tally_audit.js ${path.basename(inputPath).replace(/\.json$/, "_PROLOG_AUDIT.md")}`);
lines.push("```");
lines.push("");
lines.push("---");
lines.push("");

let totalQuestions = 0;
let totalWithBindings = 0;

for (const r of rows) {
  const id = r.paper?.id || "?";
  const abstract = r.pipeline?.questions ? null : null;
  const comparisons = r.pipeline?.comparisons || [];

  // Get the abstract from the source_text (we stored paper_text in extractRes)
  // Actually it's in the extraction's source_text, or we need to pull from elsewhere
  // Look at where the script saved it - paper_text was used but not stored.
  // Workaround: get from extraction.source_text if present, else first evidence.
  let abstractText = r.extraction?.source_text || "";
  if (!abstractText && r.kb?.items) {
    // Reconstruct loosely from evidence strings
    const evList = [];
    for (const item of r.kb.items) {
      if (Array.isArray(item.evidence)) evList.push(...item.evidence);
    }
    abstractText = evList.join(" ");
  }

  totalQuestions += comparisons.length;
  const withBindings = comparisons.filter(c => Array.isArray(c.prolog_bindings) && c.prolog_bindings.length > 0);
  if (withBindings.length === 0) continue;

  totalWithBindings += withBindings.length;

  lines.push(`## Paper ${id}`);
  lines.push("");
  if (abstractText) {
    lines.push(`<details><summary><b>Abstract</b> (click to expand)</summary>`);
    lines.push("");
    lines.push(`> ${abstractText.replace(/\n+/g, " ").trim()}`);
    lines.push("");
    lines.push(`</details>`);
    lines.push("");
  } else {
    lines.push(`*Abstract not stored in batch file. Refer to your original ABSTRACTS object for paper ${id}.*`);
    lines.push("");
  }

  for (let i = 0; i < withBindings.length; i++) {
    const c = withBindings[i];
    lines.push(`### ${id}-Q${i + 1}: ${c.question}`);
    lines.push("");
    lines.push(`- **Verdict:** \`${c.judgement}\``);
    lines.push(`- **Prolog query:** \`${c.prolog_query}\``);
    lines.push(`- **Prolog bindings (${c.prolog_bindings.length}):**`);
    for (const b of c.prolog_bindings) {
      lines.push(`  - \`${b}\``);
    }
    lines.push(`- **Path A answer:** ${c.kb_silent ? "_(kb_silent)_" : (c.llm_answer || "_(empty)_")}`);
    lines.push("");
    lines.push(`**Result:** TODO`);
    lines.push("");
    lines.push("---");
    lines.push("");
  }
}

const outPath = inputPath.replace(/\.json$/, "_PROLOG_AUDIT.md");
fs.writeFileSync(outPath, lines.join("\n"));

console.log(`Total questions in batch: ${totalQuestions}`);
console.log(`Questions where Prolog returned bindings: ${totalWithBindings}`);
console.log(`Wrote audit file: ${outPath}`);
console.log("");
console.log(`Open ${outPath} in any markdown editor or even Notepad.`);
console.log(`For each question, replace 'TODO' with Y, N, P, or X.`);
console.log(`Save the file when done.`);
console.log(`Then run: node scripts/tally_audit.js ${outPath}`);
