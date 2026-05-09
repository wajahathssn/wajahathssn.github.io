// api/compare_paths.js
//
// End-to-end harness for the Q&A / Logic-system pipeline (Section 3.6 of the
// dissertation). For each question:
//   Path A: ask an LLM to answer using only the JSON KB
//   Path B: rewrite the question to a Prolog query, evaluate against the
//           Prolog fact base derived from the same JSON KB
// then judge whether the two answers agree.
//
// This endpoint chains together the other four endpoints:
//   /api/generate_questions  (optional - if no questions supplied)
//   /api/json_to_prolog      (deterministic translation)
//   /api/answer_from_kb      (Path A)
//   /api/nl_to_prolog_query  (Path B query side - executor not implemented)
//
// Body:
//   { kb: object,                        // candidate_json
//     paper_text:   [optional] string,   // required only if questions not supplied
//     questions:    [optional] array,    // pre-supplied questions
//     answer_provider: [optional] string,// provider used for Path A (default openai)
//     answer_model:    [optional] string }
//
// Returns:
//   { ok: true,
//     questions:        array,
//     prolog_facts:     string,
//     prolog_n:         { n_materials, n_properties, n_evidence },
//     comparisons: [{
//        question, llm_answer, prolog_query, kb_silent, judgement: "agree"|"disagree"|"kb_silent"
//     }, ...]
//   }
//
// Note: this harness does NOT execute the Prolog query - that requires a
// Prolog interpreter (tau-prolog is recommended for serverless deployment).
// The 'judgement' field is computed by a small follow-up LLM call comparing
// the LLM answer to the rewritten Prolog query as a proxy for full execution.

import Ajv from "ajv";

const ajv = new Ajv({ allErrors: true, strict: false });

function setCors(res) {
  res.setHeader("Access-Control-Allow-Origin", "https://wajahathssn.github.io");
  res.setHeader("Access-Control-Allow-Methods", "GET,POST,OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, x-api-key");
  res.setHeader("Vary", "Origin");
}

function safeJsonParse(text) {
  const t = (text || "").trim();
  try { return { ok: true, value: JSON.parse(t) }; } catch {}
  const fenced = t.match(/```(?:json)?\s*([\s\S]*?)\s*```/i);
  if (fenced) {
    try { return { ok: true, value: JSON.parse(fenced[1]) }; } catch {}
  }
  const match = t.match(/(\{[\s\S]*\}|\[[\s\S]*\])/);
  if (match) { try { return { ok: true, value: JSON.parse(match[1]) }; } catch {} }
  return { ok: false };
}

// ----- Provider call (only OpenAI used here for the judge call) -----
async function callOpenAI({ model, system, user }) {
  const key = process.env.OPENAI_API_KEY;
  if (!key) throw new Error("Missing OPENAI_API_KEY on server");
  const r = await fetch("https://api.openai.com/v1/chat/completions", {
    method: "POST",
    headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      model, temperature: 0,
      messages: [{ role: "system", content: system }, { role: "user", content: user }]
    })
  });
  const text = await r.text();
  if (!r.ok) throw new Error(`OpenAI error: ${r.status} ${text}`);
  return JSON.parse(text).choices?.[0]?.message?.content ?? "";
}

// Internal call helpers for the sibling endpoints.
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

// ----- Judge (simple binary agreement) -----
function judgeSystemPrompt() {
  return [
    "You are an answer-comparison judge.",
    "You will receive an LLM natural-language answer and a Prolog query (intended to compute the same answer over a fact base).",
    "Your job: decide whether the LLM answer is consistent with what the Prolog query would return on the SAME fact base.",
    "Return ONLY JSON: {\"judgement\": \"agree\"|\"disagree\"|\"kb_silent\", \"reason\": string}.",
    "Use \"kb_silent\" if the LLM answer says the KB does not contain the information.",
    "Use \"agree\" if the LLM answer matches the entities/values that the Prolog query would bind.",
    "Use \"disagree\" if the LLM answer asserts entities/values that the Prolog query would NOT bind, or vice versa."
  ].join(" ");
}

function getJudgeSchema() {
  return {
    type: "object",
    properties: {
      judgement: { type: "string", enum: ["agree", "disagree", "kb_silent"] },
      reason: { type: "string" }
    },
    required: ["judgement"]
  };
}

async function judgeOne({ question, llm_answer, kb_silent, prolog_query, facts }) {
  if (kb_silent) return { judgement: "kb_silent", reason: "Path A reported that the KB is silent." };

  const system = judgeSystemPrompt();
  const user = JSON.stringify({
    question,
    llm_answer,
    prolog_query,
    fact_base_excerpt: typeof facts === "string" ? facts.slice(0, 3000) : null
  });
  const validate = ajv.compile(getJudgeSchema());
  let raw = "";
  for (let attempt = 1; attempt <= 2; attempt++) {
    raw = await callOpenAI({ model: "gpt-4o", system, user });
    const parsed = safeJsonParse(raw);
    if (!parsed.ok) continue;
    if (validate(parsed.value)) return parsed.value;
  }
  return { judgement: "disagree", reason: "Judge output did not validate; defaulting to disagree." };
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

    // 1. Get questions (either provided or freshly generated)
    let questions = Array.isArray(providedQs) ? providedQs : null;
    if (!questions) {
      if (!paper_text) {
        return res.status(400).json({ error: "Provide either questions[] or paper_text" });
      }
      const qResp = await callSibling(req, "/api/generate_questions", { paper_text });
      questions = (qResp.questions || []).map(q => ({ question: q.question, source_provider: q.provider }));
    }
    const qList = questions.map(q => typeof q === "string" ? q : q.question);

    // 2. Translate JSON KB -> Prolog facts
    const prologResp = await callSibling(req, "/api/json_to_prolog", { kb });
    const facts = prologResp.prolog;

    // 3. Path A: closed-book LLM answers
    const answerResp = await callSibling(req, "/api/answer_from_kb", {
      kb, questions: qList,
      provider: answer_provider || "openai",
      model: answer_model
    });

    // 4. Path B: rewrite each question to a Prolog query
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

    // 5. Judge each pair
    const comparisons = [];
    for (let i = 0; i < qList.length; i++) {
      const a = answerResp.answers[i] || {};
      const q = queryRewrites[i] || {};
      let judgement;
      try {
        judgement = await judgeOne({
          question: qList[i],
          llm_answer: a.answer || "",
          kb_silent: !!a.kb_silent,
          prolog_query: q.query || "",
          facts
        });
      } catch (err) {
        judgement = { judgement: "disagree", reason: String(err?.message || err) };
      }
      comparisons.push({
        question: qList[i],
        llm_answer: a.answer || "",
        llm_confidence: a.confidence || "",
        kb_silent: !!a.kb_silent,
        prolog_query: q.query || "",
        prolog_query_ok: !!q.ok,
        judgement: judgement.judgement,
        reason: judgement.reason
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
