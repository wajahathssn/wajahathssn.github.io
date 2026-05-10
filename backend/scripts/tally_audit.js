// scripts/tally_audit.js
//
// Read a filled-in audit markdown file and report precision for BOTH
// Path A (LLM closed-book) and Path B (Prolog), independently and jointly.
//
// Usage:
//   node scripts/tally_audit.js results/qa_batch_two_shot_openai_<timestamp>_AUDIT.md

import fs from "node:fs";

const inputPath = process.argv[2];
if (!inputPath) {
  console.error("Usage: node scripts/tally_audit.js <path-to-audit.md>");
  process.exit(1);
}

const text = fs.readFileSync(inputPath, "utf8");

const empty = () => ({ Y: 0, N: 0, P: 0, X: 0, "-": 0, TODO: 0 });
const a = empty();
const b = empty();
const joint = []; // { aMark, bMark } per question

const lines = text.split(/\r?\n/);

let pendingA = null;

for (const line of lines) {
  const mA = line.match(/^\*\*Score Path A:\*\*\s*(\S+)/i);
  const mB = line.match(/^\*\*Score Path B:\*\*\s*(\S+)/i);
  if (mA) {
    let v = mA[1].trim().toUpperCase();
    if (v.startsWith("TODO")) v = "TODO";
    if (a[v] === undefined) v = "TODO";
    a[v]++;
    pendingA = v;
  } else if (mB) {
    let v = mB[1].trim().toUpperCase();
    if (v.startsWith("TODO")) v = "TODO";
    if (b[v] === undefined) v = "TODO";
    b[v]++;
    if (pendingA !== null) {
      joint.push({ aMark: pendingA, bMark: v });
      pendingA = null;
    }
  }
}

function precision(c, label) {
  const judged = c.Y + c.N + c.P;
  if (judged === 0) return null;
  return {
    label,
    judged,
    Y: c.Y, N: c.N, P: c.P, X: c.X, dash: c["-"], TODO: c.TODO,
    strict: c.Y / judged,
    lenient: (c.Y + c.P) / judged
  };
}

const aRes = precision(a, "Path A (LLM)");
const bRes = precision(b, "Path B (Prolog)");

const pct = x => (100 * x).toFixed(1) + "%";

console.log(`\n=== Audit tally ===`);
console.log(`File: ${inputPath}`);
console.log(`Questions in audit: ${joint.length}\n`);

for (const r of [aRes, bRes]) {
  if (!r) continue;
  console.log(`--- ${r.label} ---`);
  console.log(`  Y=${r.Y}  N=${r.N}  P=${r.P}  X=${r.X}  -=${r.dash}  TODO=${r.TODO}`);
  console.log(`  Strict precision  (Y / [Y+N+P]):       ${pct(r.strict)}   (${r.Y}/${r.judged})`);
  console.log(`  Lenient precision ([Y+P] / [Y+N+P]):   ${pct(r.lenient)}   (${r.Y + r.P}/${r.judged})`);
  console.log("");
}

// Joint comparison: how often were both judged, and how often did they agree on correctness?
const bothJudged = joint.filter(j =>
  ["Y", "N", "P"].includes(j.aMark) && ["Y", "N", "P"].includes(j.bMark)
);
if (bothJudged.length > 0) {
  const bothCorrect = bothJudged.filter(j => j.aMark === "Y" && j.bMark === "Y").length;
  const aOnlyCorrect = bothJudged.filter(j => j.aMark === "Y" && j.bMark === "N").length;
  const bOnlyCorrect = bothJudged.filter(j => j.aMark === "N" && j.bMark === "Y").length;
  const bothWrong = bothJudged.filter(j => j.aMark === "N" && j.bMark === "N").length;
  console.log(`--- Joint cases (both paths produced an answer) ---`);
  console.log(`  Both correct:       ${bothCorrect}`);
  console.log(`  A correct, B wrong: ${aOnlyCorrect}`);
  console.log(`  B correct, A wrong: ${bOnlyCorrect}`);
  console.log(`  Both wrong:         ${bothWrong}`);
  console.log(`  Other (P/X mixed):  ${bothJudged.length - bothCorrect - aOnlyCorrect - bOnlyCorrect - bothWrong}`);
  console.log("");
}

// One-path-only counts (the other path didn't try, marked '-')
const aOnlyAnswered = joint.filter(j =>
  ["Y", "N", "P"].includes(j.aMark) && j.bMark === "-"
);
const bOnlyAnswered = joint.filter(j =>
  ["Y", "N", "P"].includes(j.bMark) && j.aMark === "-"
);
if (aOnlyAnswered.length || bOnlyAnswered.length) {
  console.log(`--- One-path-only cases ---`);
  if (aOnlyAnswered.length) {
    const correct = aOnlyAnswered.filter(j => j.aMark === "Y").length;
    console.log(`  A answered alone: ${aOnlyAnswered.length} (${correct} correct, ${pct(correct / aOnlyAnswered.length)})`);
  }
  if (bOnlyAnswered.length) {
    const correct = bOnlyAnswered.filter(j => j.bMark === "Y").length;
    console.log(`  B answered alone: ${bOnlyAnswered.length} (${correct} correct, ${pct(correct / bOnlyAnswered.length)})`);
  }
}
