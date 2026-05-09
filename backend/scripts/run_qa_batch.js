// scripts/run_qa_batch.js
//
// Run the Q&A pipeline across a list of papers and save all results to disk.
//
// Usage:
//   1. Edit the PAPERS array below with your 18 papers (title + optional year/journal)
//      OR point INPUT_MODE to "abstracts" and supply abstracts directly.
//   2. Run:    node scripts/run_qa_batch.js
//   3. Output: results/qa_batch_<timestamp>.json
//
// Requirements: Node 18+ (has fetch built in). No npm install needed.

import fs from "node:fs";
import path from "node:path";

// =========================================================================
// CONFIG - edit these
// =========================================================================

const API_BASE = "https://wajahathssn-github-io.vercel.app/api";

const EXTRACTION_MODE   = "two_shot";   // "one_shot" or "two_shot"
const ANSWER_PROVIDER   = "openai";     // path-A provider for Q&A pipeline
const PIPELINE_TIMEOUT_MS = 240_000;    // 4 minutes per paper, generous

// Pick your input mode:
//   "lookup"    - looks up each paper by title via Crossref/OpenAlex
//   "abstracts" - you supply the abstract text directly (more reliable)
const INPUT_MODE = "lookup";

// 18-paper list. Fill in the titles you used in your study.
// Year/journal are optional for "lookup" mode and ignored for "abstracts".
const PAPERS = [
  // { id: "P01", title: "...title of paper 1...",  year: 2021, journal: "..." },
  // { id: "P02", title: "...title of paper 2...",  year: 2022, journal: "..." },
  // ...
];

// If INPUT_MODE === "abstracts", paste the abstracts here keyed by id:
const ABSTRACTS = {
  // "P01": "First paper abstract text here...",
  // "P02": "Second paper abstract text here...",
};

// =========================================================================
// SCHEMAS - match what your existing UI sends
// =========================================================================

const ONE_SHOT_INSTRUCTION =
  "Extract mentions of materials and the properties they have which are mentioned in the abstract.";
const TWO_SHOT_INSTRUCTION =
  "Extract mentions of materials and the properties they have which are mentioned in the abstract. Preserve conditions/qualifiers (e.g., under what conditions, in what device/cell, and with what measured values) when present.";

const BASIC_SCHEMA = {
  type: "object",
  properties: {
    items: {
      type: "array",
      items: {
        type: "object",
        properties: {
          material: { type: "string" },
          properties: { type: "array", items: { type: "string" } },
          evidence: { type: "array", items: { type: "string" } }
        },
        required: ["material", "properties"]
      }
    }
  },
  required: ["items"]
};

const CONTEXTUAL_SCHEMA = {
  type: "object",
  properties: {
    items: {
      type: "array",
      items: {
        type: "object",
        properties: {
          material: { type: "string" },
          entity_role: { type: "string" },
          properties: {
            type: "array",
            items: {
              type: "object",
              properties: {
                property: { type: "string" },
                value: { type: "string" },
                unit: { type: "string" },
                qualifier: { type: "string" },
                conditions: { type: "string" },
                applies_to: { type: "string" },
                evidence: { type: "string" }
              },
              required: ["property"]
            }
          },
          evidence: { type: "array", items: { type: "string" } }
        },
        required: ["material", "properties"]
      }
    }
  },
  required: ["items"]
};

const SCHEMA = EXTRACTION_MODE === "one_shot" ? BASIC_SCHEMA : CONTEXTUAL_SCHEMA;
const INSTRUCTION = EXTRACTION_MODE === "one_shot" ? ONE_SHOT_INSTRUCTION : TWO_SHOT_INSTRUCTION;

// =========================================================================
// Helpers
// =========================================================================

async function postWithTimeout(url, body, timeoutMs) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const r = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
      signal: controller.signal
    });
    const text = await r.text();
    clearTimeout(timer);
    try { return { ok: r.ok, status: r.status, data: JSON.parse(text) }; }
    catch { return { ok: r.ok, status: r.status, data: { raw: text } }; }
  } catch (err) {
    clearTimeout(timer);
    return { ok: false, status: 0, data: { error: String(err?.message || err) } };
  }
}

async function extractOne(paper) {
  if (INPUT_MODE === "abstracts") {
    const abstract = ABSTRACTS[paper.id];
    if (!abstract) throw new Error(`No abstract supplied for ${paper.id}`);
    const prompt = `DOCUMENT TEXT:\n${abstract}\n\nTASK:\n${INSTRUCTION}`;
    const r = await postWithTimeout(`${API_BASE}/extract_json`, {
      provider: "openai",
      mode: EXTRACTION_MODE,
      retrieval_mode: "abstract_only",
      prompt,
      schema: SCHEMA
    }, PIPELINE_TIMEOUT_MS);
    return { extraction: r.data, paper_text: abstract };
  }

  // lookup mode
  const r = await postWithTimeout(`${API_BASE}/lookup_extract`, {
    title: paper.title,
    year: paper.year,
    journal: paper.journal,
    provider: "openai",
    mode: EXTRACTION_MODE,
    schema: SCHEMA
  }, PIPELINE_TIMEOUT_MS);
  return { extraction: r.data, paper_text: r.data?.source_text || "" };
}

async function runPipelineOne(kb, paper_text) {
  const r = await postWithTimeout(`${API_BASE}/compare_paths`, {
    kb, paper_text, answer_provider: ANSWER_PROVIDER
  }, PIPELINE_TIMEOUT_MS);
  return r.data;
}

// =========================================================================
// Main
// =========================================================================

async function main() {
  if (PAPERS.length === 0) {
    console.error("No papers configured. Edit PAPERS in this file.");
    process.exit(1);
  }

  const results = [];
  const t0 = Date.now();

  for (let i = 0; i < PAPERS.length; i++) {
    const paper = PAPERS[i];
    const tag = `[${i + 1}/${PAPERS.length}] ${paper.id || paper.title?.slice(0, 50)}`;
    console.log(`\n${tag} - extracting...`);

    let extractRes, kb, paper_text;
    try {
      const out = await extractOne(paper);
      extractRes = out.extraction;
      paper_text = out.paper_text;
      kb = extractRes?.result;
      if (!kb || !Array.isArray(kb.items)) throw new Error("Extraction returned no items");
      console.log(`${tag} - extracted ${kb.items.length} items`);
    } catch (err) {
      console.error(`${tag} - extraction FAILED: ${err.message}`);
      results.push({ paper, stage: "extraction", ok: false, error: String(err?.message || err) });
      continue;
    }

    console.log(`${tag} - running Q&A pipeline (45-90s typical)...`);
    let pipelineRes;
    try {
      pipelineRes = await runPipelineOne(kb, paper_text);
      if (!pipelineRes?.ok) throw new Error(pipelineRes?.error || "pipeline returned not ok");
    } catch (err) {
      console.error(`${tag} - pipeline FAILED: ${err.message}`);
      results.push({
        paper, kb, stage: "pipeline", ok: false,
        error: String(err?.message || err)
      });
      continue;
    }

    const c = pipelineRes.counts || {};
    console.log(`${tag} - done. agree=${c.agree || 0}  disagree=${c.disagree || 0}  kb_silent=${c.kb_silent || 0}  error=${c.error || 0}`);

    results.push({
      paper,
      ok: true,
      extraction: extractRes,
      pipeline: pipelineRes
    });
  }

  // Save
  const outDir = "results";
  fs.mkdirSync(outDir, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const outPath = path.join(outDir, `qa_batch_${EXTRACTION_MODE}_${stamp}.json`);
  fs.writeFileSync(outPath, JSON.stringify({
    config: { EXTRACTION_MODE, ANSWER_PROVIDER, INPUT_MODE, n_papers: PAPERS.length },
    elapsed_seconds: Math.round((Date.now() - t0) / 1000),
    results
  }, null, 2));
  console.log(`\nSaved to ${outPath} (elapsed ${Math.round((Date.now() - t0) / 1000)}s)`);
}

main().catch(err => { console.error(err); process.exit(1); });
