// scripts/aggregate_qa.js
//
// Read a qa_batch_*.json file, compute aggregate stats and per-paper
// breakdowns, write a CSV ready for inclusion in the dissertation.
//
// Usage:  node scripts/aggregate_qa.js results/qa_batch_two_shot_<timestamp>.json

import fs from "node:fs";

const inputPath = process.argv[2];
if (!inputPath) {
  console.error("Usage: node scripts/aggregate_qa.js <path-to-qa_batch.json>");
  process.exit(1);
}

const data = JSON.parse(fs.readFileSync(inputPath, "utf8"));
const rows = data.results || [];
const ok = rows.filter(r => r.ok);

console.log(`\n=== Q&A pipeline batch summary ===`);
console.log(`Input file: ${inputPath}`);
console.log(`Mode: ${data.config?.EXTRACTION_MODE}, Path-A provider: ${data.config?.ANSWER_PROVIDER}`);
console.log(`Papers attempted: ${rows.length}, succeeded: ${ok.length}\n`);

if (ok.length === 0) { console.log("No successful runs to aggregate."); process.exit(0); }

// =========================================================================
// Aggregate counts
// =========================================================================

const totals = { agree: 0, disagree: 0, kb_silent: 0, error: 0 };
let totalQuestions = 0;

const perPaper = ok.map(r => {
  const c = r.pipeline?.counts || {};
  const agree = c.agree || 0;
  const disagree = c.disagree || 0;
  const kb_silent = c.kb_silent || 0;
  const error = c.error || 0;
  const n = agree + disagree + kb_silent + error;

  totals.agree += agree; totals.disagree += disagree;
  totals.kb_silent += kb_silent; totals.error += error;
  totalQuestions += n;

  // Path-A confabulation: A answers, B has no bindings (i.e. disagree where A non-silent)
  const comparisons = r.pipeline?.comparisons || [];
  const path_a_only = comparisons.filter(x =>
    x.judgement === "disagree" && !x.kb_silent &&
    Array.isArray(x.prolog_bindings) && x.prolog_bindings.length === 0
  ).length;

  // Path-B richer: A says kb_silent but B found bindings
  const path_b_only = comparisons.filter(x =>
    x.kb_silent && Array.isArray(x.prolog_bindings) && x.prolog_bindings.length > 0
  ).length;

  return {
    id: r.paper?.id || "?",
    title_short: (r.paper?.title || "").slice(0, 60),
    n_questions: n,
    agree, disagree, kb_silent, error,
    agree_rate: n ? agree / n : 0,
    disagree_rate: n ? disagree / n : 0,
    kb_silent_rate: n ? kb_silent / n : 0,
    error_rate: n ? error / n : 0,
    path_a_only_answers: path_a_only,
    path_b_only_answers: path_b_only,
    n_kb_items: r.pipeline?.questions ? (r.extraction?.result?.items?.length || 0) : 0,
    n_prolog_facts: (r.pipeline?.prolog_n?.n_properties || 0) + (r.pipeline?.prolog_n?.n_evidence || 0)
  };
});

// =========================================================================
// Print summary
// =========================================================================

const pct = x => (100 * x).toFixed(1) + "%";

console.log("--- Overall ---");
console.log(`Total questions: ${totalQuestions}`);
console.log(`  agree:     ${totals.agree}  (${pct(totals.agree / totalQuestions)})`);
console.log(`  disagree:  ${totals.disagree}  (${pct(totals.disagree / totalQuestions)})`);
console.log(`  kb_silent: ${totals.kb_silent}  (${pct(totals.kb_silent / totalQuestions)})`);
console.log(`  error:     ${totals.error}  (${pct(totals.error / totalQuestions)})`);

const aLeads = perPaper.reduce((s, p) => s + p.path_a_only_answers, 0);
const bLeads = perPaper.reduce((s, p) => s + p.path_b_only_answers, 0);
console.log(`\n--- Path divergence ---`);
console.log(`Path A answered when Path B had no bindings: ${aLeads}`);
console.log(`Path B found bindings when Path A said kb_silent: ${bLeads}`);
console.log(`(A-only count = LLM may have hallucinated OR query was too strict)`);
console.log(`(B-only count = LLM was too cautious; KB had the answer)`);

console.log(`\n--- Per-paper rates ---`);
console.log("id    n   agree   disagree  kb_silent  error   A-only B-only  facts");
for (const p of perPaper) {
  console.log(
    `${p.id.padEnd(5)} ${String(p.n_questions).padStart(2)}  ` +
    `${pct(p.agree_rate).padStart(6)}  ${pct(p.disagree_rate).padStart(7)}   ` +
    `${pct(p.kb_silent_rate).padStart(7)}  ${pct(p.error_rate).padStart(5)}   ` +
    `${String(p.path_a_only_answers).padStart(4)}  ${String(p.path_b_only_answers).padStart(4)}   ` +
    `${String(p.n_prolog_facts).padStart(4)}`
  );
}

// =========================================================================
// Write CSV
// =========================================================================

const csvLines = [
  "id,title_short,n_questions,agree,disagree,kb_silent,error,agree_rate,disagree_rate,kb_silent_rate,error_rate,path_a_only,path_b_only,n_kb_items,n_prolog_facts"
];
for (const p of perPaper) {
  csvLines.push([
    p.id,
    `"${p.title_short.replace(/"/g, '""')}"`,
    p.n_questions, p.agree, p.disagree, p.kb_silent, p.error,
    p.agree_rate.toFixed(3), p.disagree_rate.toFixed(3),
    p.kb_silent_rate.toFixed(3), p.error_rate.toFixed(3),
    p.path_a_only_answers, p.path_b_only_answers,
    p.n_kb_items, p.n_prolog_facts
  ].join(","));
}
const csvPath = inputPath.replace(/\.json$/, ".csv");
fs.writeFileSync(csvPath, csvLines.join("\n"));
console.log(`\nWrote per-paper CSV to ${csvPath}`);

// =========================================================================
// Write headline numbers as a small JSON for the dissertation
// =========================================================================

const headlinePath = inputPath.replace(/\.json$/, ".headline.json");
fs.writeFileSync(headlinePath, JSON.stringify({
  n_papers: ok.length,
  total_questions: totalQuestions,
  totals,
  rates: {
    agree: totals.agree / totalQuestions,
    disagree: totals.disagree / totalQuestions,
    kb_silent: totals.kb_silent / totalQuestions,
    error: totals.error / totalQuestions
  },
  divergence: { path_a_only: aLeads, path_b_only: bLeads },
  config: data.config
}, null, 2));
console.log(`Wrote headline JSON to ${headlinePath}`);
