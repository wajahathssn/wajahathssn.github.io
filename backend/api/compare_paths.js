// api/compare_paths.js
//
// End-to-end harness for the Q&A / Logic-system pipeline (Section 3.6).
// For each question:
//   Path A: ask an LLM to answer using only the JSON KB
//   Path B: rewrite the question to a Prolog query, EXECUTE it against the
//           Prolog fact base derived from the same JSON KB
// then deterministically compare the two answers.
//
// Body:
//   { kb: object,
//     paper_text: string,
//     [optional] questions: array,
//     [optional] answer_provider: string,
//     [optional] answer_model: string }
//
// Returns:
//   { ok: true,
//     n_questions, counts,
//     questions, prolog_facts, prolog_n,
//     comparisons: [{
//       question, llm_answer, llm_confidence, kb_silent,
//       prolog_query, prolog_query_ok,
//       prolog_bindings: [string],   // actual answers from Prolog
//       prolog_error: string|null,
//       judgement: "agree"|"disagree"|"kb_silent"|"error",
//       reason: string
//     }, ...]
//   }
//
// Requires: tau-prolog (added to package.json)

import pkg from "tau-prolog";
const pl = pkg.default ?? pkg;

function setCors(res) {
  res.setHeader("Access-Control-Allow-Origin", "https://wajahathssn.github.io");
  res.setHeader("Access-Control-Allow-Methods", "GET,POST,OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, x-api-key");
  res.setHeader("Vary", "Origin");
}

// ----- Sibling-endpoint helpers -----
function originFromReq(req) {
  const proto = req.headers["x-forwarded-proto"] || "https";
  const host = req.headers["x-forwarded-host"] || req.headers.host;
  return `${proto}://${host}`;
}

async function callSibling(req, path, body) {
  const url = `${originFromReq(req)}${path}`;
  const headers = { "Content-Type": "application/json" };
  if (process.env.API_AUTH_KEY) headers["x-api-key"] = process.env.API_AUTH_KEY;
  const r = await fetch(url, { method: "POST", headers, body: JSON.stringify(body) });
  const text = await r.text();
  if (!r.ok) throw new Error(`${path} ${r.status}: ${text}`);
  return JSON.parse(text);
}

// ----- Run a Prolog query against a fact base -----
//
// Returns: { ok: bool, bindings: [string], error?: string, warning?: string }
function runPrologQuery(facts, query, { maxAnswers = 25, timeoutMs = 5000 } = {}) {
  return new Promise((resolve) => {
    let done = false;
    const finish = (out) => { if (!done) { done = true; clearTimeout(timer); resolve(out); } };
    const timer = setTimeout(
      () => finish({ ok: false, error: "Prolog timeout", bindings: [] }),
      timeoutMs
    );

    try {
      // 1000-step inference limit per call (tau-prolog tunable)
      const session = pl.create(1000);

      session.consult(facts, {
        success: () => {
          // strip leading "?- " if the LLM included it; ensure trailing period
          let cleanQuery = String(query || "").trim().replace(/^\?-\s*/, "");
          if (!cleanQuery) return finish({ ok: false, error: "Empty query", bindings: [] });
          if (!cleanQuery.endsWith(".")) cleanQuery += ".";

          session.query(cleanQuery, {
            success: () => {
              const bindings = [];
              const collect = () => {
                if (bindings.length >= maxAnswers) {
                  return finish({ ok: true, bindings, warning: "max answers reached" });
                }
                session.answer({
                  success: (answer) => {
                    if (answer === false || answer === null) {
                      return finish({ ok: true, bindings });
                    }
                    bindings.push(pl.format_answer(answer));
                    collect();
                  },
                  fail: () => finish({ ok: true, bindings }),
                  error: (err) => finish({ ok: false, error: pl.format_error(err), bindings }),
                  limit: () => finish({ ok: true, bindings, warning: "step limit reached" })
                });
              };
              collect();
            },
            error: (err) => finish({ ok: false, error: pl.format_error(err), bindings: [] })
          });
        },
        error: (err) => finish({ ok: false, error: pl.format_error(err), bindings: [] })
      });
    } catch (err) {
      finish({ ok: false, error: String(err?.message || err), bindings: [] });
    }
  });
}

// ----- Parse tau-prolog answer strings -----
//
// "V = '3.2'"            -> ["3.2"]
// "V = '3.2', U = 'eV'"  -> ["3.2", "eV"]
// "true"                 -> ["true"]
// "false"                -> []
function extractValuesFromBinding(bindingStr) {
  if (!bindingStr) return [];
  let s = String(bindingStr).trim().replace(/[;.]\s*$/, "").trim();
  if (!s) return [];
  if (/^(true|yes)$/i.test(s)) return ["true"];
  if (/^(false|no)$/i.test(s)) return [];

  // split on commas not inside single-quoted atoms
  const parts = [];
  let cur = "", inQuote = false, prev = "";
  for (const ch of s) {
    if (ch === "'" && prev !== "\\") inQuote = !inQuote;
    if (ch === "," && !inQuote) { parts.push(cur); cur = ""; }
    else cur += ch;
    prev = ch;
  }
  if (cur.trim()) parts.push(cur);

  const values = [];
  for (const p of parts) {
    const m = p.trim().match(/^([A-Z_]\w*)\s*=\s*(.+)$/);
    if (!m) continue;
    let v = m[2].trim();
    if (v.startsWith("'") && v.endsWith("'") && v.length >= 2) {
      v = v.slice(1, -1).replace(/''/g, "'");
    }
    if (v) values.push(v);
  }
  return values;
}

// ----- Deterministic A/B comparator -----
function compareAB({ llm_answer, kb_silent, prolog_result }) {
  if (kb_silent) {
    return {
      judgement: "kb_silent",
      reason: "Path A reported the KB does not contain the answer."
    };
  }
  if (!prolog_result || !prolog_result.ok) {
    return {
      judgement: "error",
      reason: `Prolog error: ${prolog_result?.error || "unknown"}`
    };
  }

  const bindings = prolog_result.bindings || [];
  if (bindings.length === 0) {
    return {
      judgement: "disagree",
      reason: "Path B found no bindings (Prolog says no answer); Path A gave one."
    };
  }

  // Pull bound values out of all bindings
  const allValues = [];
  for (const b of bindings) allValues.push(...extractValuesFromBinding(b));

  // Yes/no queries: a "true" binding plus any Path-A answer counts as agree
  if (allValues.length === 1 && allValues[0] === "true") {
    return { judgement: "agree", reason: "Prolog confirmed (true); Path A also gave an answer." };
  }
  if (allValues.length === 0) {
    return { judgement: "disagree", reason: "Could not extract values from Prolog bindings." };
  }

  const aText = String(llm_answer || "").toLowerCase().replace(/\s+/g, " ").trim();

  for (const v of allValues) {
    const vNorm = String(v).toLowerCase().replace(/\s+/g, " ").trim();
    if (!vNorm) continue;
    if (aText.includes(vNorm)) {
      return { judgement: "agree", reason: `Path A's answer contains Prolog value "${v}".` };
    }
    // multi-word fallback: every key token of the value (>=3 chars) must appear in A
    const tokens = vNorm.split(/[\s_\-]+/).filter(t => t.length >= 3);
    if (tokens.length >= 1 && tokens.every(t => aText.includes(t))) {
      return {
        judgement: "agree",
        reason: `Path A's answer contains all key tokens from Prolog value "${v}".`
      };
    }
  }

  const preview = allValues.slice(0, 3).join(", ");
  return {
    judgement: "disagree",
    reason: `Path B bindings [${preview}] not found in Path A's answer.`
  };
}

// ----- Handler -----
export default async function handler(req, res) {
  setCors(res);
  if (req.method === "OPTIONS") return res.status(204).end();
  if (req.method !== "POST") return res.status(405).json({ error: "Use POST" });

  try {
    const required = process.env.API_AUTH_KEY;
    if (required) {
      const got = req.headers["x-api-key"];
      if (got !== required) return res.status(401).json({ error: "Unauthorized" });
    }

    const { kb, paper_text, questions: providedQs, answer_provider, answer_model } = req.body || {};
    if (!kb || typeof kb !== "object") {
      return res.status(400).json({ error: "Missing kb object" });
    }

    // 1. Get questions (provided, or freshly generated)
    let questions = Array.isArray(providedQs) ? providedQs : null;
    if (!questions) {
      if (!paper_text) {
        return res.status(400).json({ error: "Provide either questions[] or paper_text" });
      }
      const qResp = await callSibling(req, "/api/generate_questions", { paper_text });
      questions = (qResp.questions || []).map(q => ({
        question: q.question, source_provider: q.provider
      }));
    }
    const qList = questions.map(q => typeof q === "string" ? q : q.question);

    // 2. Translate JSON KB -> Prolog facts (deterministic)
    const prologResp = await callSibling(req, "/api/json_to_prolog", { kb });
    const facts = prologResp.prolog;

    // 3. Path A: closed-book LLM answers
    const answerResp = await callSibling(req, "/api/answer_from_kb", {
      kb, questions: qList,
      provider: answer_provider || "openai",
      model: answer_model
    });

    // 4. Path B: rewrite each question into a Prolog query
    const queryRewrites = [];
    for (const q of qList) {
      try {
        const r = await callSibling(req, "/api/nl_to_prolog_query", {
          question: q, facts, provider: "openai"
        });
        queryRewrites.push({ ok: true, query: r.prolog_query, rationale: r.rationale });
      } catch (err) {
        queryRewrites.push({ ok: false, error: String(err?.message || err) });
      }
    }

    // 5. Path B: ACTUALLY EXECUTE each Prolog query
    const prologResults = [];
    for (const q of queryRewrites) {
      if (!q.ok) {
        prologResults.push({ ok: false, error: q.error || "no query", bindings: [] });
        continue;
      }
      const result = await runPrologQuery(facts, q.query);
      prologResults.push(result);
    }

    // 6. Deterministic comparator (no LLM judge)
    const comparisons = [];
    for (let i = 0; i < qList.length; i++) {
      const a = answerResp.answers[i] || {};
      const q = queryRewrites[i] || {};
      const pr = prologResults[i] || {};

      const judged = compareAB({
        llm_answer: a.answer || "",
        kb_silent: !!a.kb_silent,
        prolog_result: pr
      });

      comparisons.push({
        question: qList[i],
        llm_answer: a.answer || "",
        llm_confidence: a.confidence || "",
        kb_silent: !!a.kb_silent,
        prolog_query: q.query || "",
        prolog_query_ok: !!q.ok,
        prolog_bindings: pr.bindings || [],
        prolog_error: pr.ok ? null : (pr.error || null),
        judgement: judged.judgement,
        reason: judged.reason
      });
    }

    const counts = comparisons.reduce((acc, c) => {
      acc[c.judgement] = (acc[c.judgement] || 0) + 1; return acc;
    }, {});

    return res.status(200).json({
      ok: true,
      n_questions: qList.length,
      counts,
      questions,
      prolog_facts: facts,
      prolog_n: {
        n_materials: prologResp.n_materials,
        n_properties: prologResp.n_properties,
        n_evidence: prologResp.n_evidence
      },
      comparisons
    });
  } catch (err) {
    return res.status(500).json({ error: String(err?.message || err) });
  }
}
