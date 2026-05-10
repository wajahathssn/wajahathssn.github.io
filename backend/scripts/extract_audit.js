// scripts/extract_audit.js
//
// Read a batch JSON, write a markdown audit file that lets you score BOTH
// Path A (closed-book LLM answer) and Path B (Prolog binding) for every
// question where at least one path produced an answer.
//
// Usage:
//   node scripts/extract_audit.js results/qa_batch_two_shot_openai_<timestamp>.json

import fs from "node:fs";
import path from "node:path";

const inputPath = process.argv[2];
if (!inputPath) {
  console.error("Usage: node scripts/extract_audit.js <path-to-batch.json>");
  process.exit(1);
}

const data = JSON.parse(fs.readFileSync(inputPath, "utf8"));
const rows = (data.results || []).filter(r => r.ok);

const lines = [];
lines.push(`# Audit — ${data.config?.EXTRACTION_MODE} / ${data.config?.ANSWER_PROVIDER}`);
lines.push("");
lines.push(`Generated from: \`${path.basename(inputPath)}\``);
lines.push("");
lines.push(`## Instructions`);
lines.push("");
lines.push(`For each question, judge **both paths independently** against the abstract:`);
lines.push("");
lines.push(`- **Path A** = closed-book LLM answer (free-text)`);
lines.push(`- **Path B** = Prolog binding (structured)`);
lines.push("");
lines.push(`Replace each \`TODO\` marker with one of:`);
lines.push("");
lines.push(`- \`Y\` — correct answer to the question given the abstract`);
lines.push(`- \`N\` — wrong, misleading, or hallucinated`);
lines.push(`- \`P\` — partially correct`);
lines.push(`- \`-\` — path didn't produce an answer (e.g. A said "not in KB", or B returned no bindings)`);
lines.push(`- \`X\` — skip (malformed question or unanswerable from abstract)`);
lines.push("");
lines.push(`Score the two paths independently — Path A can be Y while Path B is N, and vice versa.`);
lines.push(`Note: \`-\` is NOT counted in precision; it just records "this path didn't try."`);
lines.push("");
lines.push(`When done, run:`);
lines.push("");
lines.push("```");
lines.push(`node scripts/tally_audit.js ${path.basename(inputPath).replace(/\.json$/, "_AUDIT.md")}`);
lines.push("```");
lines.push("");
lines.push("---");
lines.push("");

let totalQuestions = 0;
let totalIncluded = 0;

for (const r of rows) {
  const id = r.paper?.id || "?";
  const comparisons = r.pipeline?.comparisons || [];
  let abstractText = r.extraction?.source_text || "";
  if (!abstractText && r.kb?.items) {
    const evList = [];
    for (const item of r.kb.items) {
      if (Array.isArray(item.evidence)) evList.push(...item.evidence);
    }
    abstractText = evList.join(" ");
  }

  totalQuestions += comparisons.length;

  // Include questions where at least one path produced an answer
  const included = comparisons.filter(c => {
    const aAnswered = !c.kb_silent && c.llm_answer && String(c.llm_answer).trim().length > 0;
    const bAnswered = Array.isArray(c.prolog_bindings) && c.prolog_bindings.length > 0;
    return aAnswered || bAnswered;
  });

  if (included.length === 0) continue;
  totalIncluded += included.length;

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
    lines.push(`*Abstract not stored in batch file. Refer to your ABSTRACTS object for paper ${id}.*`);
    lines.push("");
  }

  for (let i = 0; i < included.length; i++) {
    const c = included[i];
    const aAnswered = !c.kb_silent && c.llm_answer && String(c.llm_answer).trim().length > 0;
    const bAnswered = Array.isArray(c.prolog_bindings) && c.prolog_bindings.length > 0;

    lines.push(`### ${id}-Q${i + 1}: ${c.question}`);
    lines.push("");
    lines.push(`Auto-verdict: \`${c.judgement}\``);
    lines.push("");
    lines.push(`**Path A (LLM):** ${aAnswered ? c.llm_answer : "_(kb_silent — did not answer)_"}`);
    lines.push("");
    lines.push(`**Path B (Prolog):**`);
    lines.push(`- Query: \`${c.prolog_query || "(no query)"}\``);
    if (bAnswered) {
      lines.push(`- Bindings:`);
      for (const b of c.prolog_bindings) lines.push(`  - \`${b}\``);
    } else {
      lines.push(`- _(no bindings — did not answer)_`);
    }
    lines.push("");
    lines.push(`**Score Path A:** ${aAnswered ? "TODO_A" : "-"}`);
    lines.push(`**Score Path B:** ${bAnswered ? "TODO_B" : "-"}`);
    lines.push("");
    lines.push("---");
    lines.push("");
  }
}

const outPath = inputPath.replace(/\.json$/, "_AUDIT.md");
fs.writeFileSync(outPath, lines.join("\n"));

console.log(`Total questions in batch: ${totalQuestions}`);
console.log(`Questions where at least one path answered: ${totalIncluded}`);
console.log(`Wrote audit file: ${outPath}`);
console.log("");
console.log(`Open ${outPath} in any text editor.`);
console.log(`For each question, replace 'TODO_A' and 'TODO_B' with Y / N / P / X.`);
console.log(`Save when done, then run:`);
console.log(`  node scripts/tally_audit.js ${outPath}`);
