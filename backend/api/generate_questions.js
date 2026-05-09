// api/generate_questions.js
//
// Sequential question generation: each provider in turn sees the questions
// already produced by earlier providers and is asked to add 2 new ones.
// Returns 8 questions total (4 providers x 2 questions each).
//
// Body:
//   { paper_text: string }    // abstract or full paper
//   [optional] sequence: ["openai","anthropic","gemini","deepseek"]
//
// Returns:
//   { ok: true, questions: [{provider, model, question, facet, rationale}, ...] }

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
  const m = t.match(/(\{[\s\S]*\}|\[[\s\S]*\])/);
  if (m) { try { return { ok: true, value: JSON.parse(m[1]) }; } catch {} }
  return { ok: false };
}

// ----- Provider calls (same as your existing endpoints) -----
async function callOpenAI({ model, system, user }) {
  const key = process.env.OPENAI_API_KEY;
  if (!key) throw new Error("Missing OPENAI_API_KEY");
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

async function callDeepSeek({ model, system, user }) {
  const key = process.env.DEEPSEEK_API_KEY;
  if (!key) throw new Error("Missing DEEPSEEK_API_KEY");
  const r = await fetch("https://api.deepseek.com/chat/completions", {
    method: "POST",
    headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      model, temperature: 0,
      messages: [{ role: "system", content: system }, { role: "user", content: user }]
    })
  });
  const text = await r.text();
  if (!r.ok) throw new Error(`DeepSeek error: ${r.status} ${text}`);
  return JSON.parse(text).choices?.[0]?.message?.content ?? "";
}

async function callAnthropic({ model, system, user }) {
  const key = process.env.ANTHROPIC_API_KEY;
  if (!key) throw new Error("Missing ANTHROPIC_API_KEY");
  const r = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "x-api-key": key, "anthropic-version": "2023-06-01", "content-type": "application/json"
    },
    body: JSON.stringify({
      model, max_tokens: 2000, temperature: 0, system,
      messages: [{ role: "user", content: user }]
    })
  });
  const text = await r.text();
  if (!r.ok) throw new Error(`Anthropic error: ${r.status} ${text}`);
  return JSON.parse(text).content?.map(b => b.text).join("") ?? "";
}

async function callGemini({ model, system, user }) {
  const key = process.env.GEMINI_API_KEY;
  if (!key) throw new Error("Missing GEMINI_API_KEY");
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent?key=${encodeURIComponent(key)}`;
  for (let attempt = 0; attempt < 4; attempt++) {
    const r = await fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        contents: [{ role: "user", parts: [{ text: `${system}\n\n${user}` }] }],
        generationConfig: { temperature: 0 }
      })
    });
    const text = await r.text();
    if (r.ok) {
      return JSON.parse(text).candidates?.[0]?.content?.parts?.map(p => p.text).join("") ?? "";
    }
    if ((r.status === 503 || r.status === 429 || r.status >= 500) && attempt < 3) {
      await new Promise(res => setTimeout(res, 2000 * Math.pow(2, attempt)));
      continue;
    }
    throw new Error(`Gemini error: ${r.status} ${text}`);
  }
  throw new Error("Gemini error: retries exhausted");
}

async function callProvider({ provider, model, system, user }) {
  switch (provider) {
    case "openai": return callOpenAI({ model, system, user });
    case "deepseek": return callDeepSeek({ model, system, user });
    case "anthropic": return callAnthropic({ model, system, user });
    case "gemini": return callGemini({ model, system, user });
    default: throw new Error(`Unknown provider: ${provider}`);
  }
}

function defaultModelFor(provider) {
  return (
    provider === "openai" ? "gpt-4o" :
    provider === "anthropic" ? "claude-sonnet-4-5-20250929" :
    provider === "gemini" ? "gemini-3-pro-preview" :
    provider === "deepseek" ? "deepseek-chat" : "gpt-4o"
  );
}

// ----- Question generation logic -----
function generationSystemPrompt() {
  return [
    "You are a scientific question generator.",
    "Read the paper text and the prior questions list provided in the user message.",
    "Generate exactly 2 NEW questions that:",
    "(a) are answerable from a structured JSON knowledge base of materials, properties, conditions and values,",
    "(b) test DIFFERENT facets - choose from: material_identity, performance_value, operating_condition, mechanism, comparison, limitation,",
    "(c) do NOT duplicate or paraphrase any of the prior questions provided.",
    "Return ONLY JSON with this exact structure:",
    "{\"questions\": [{\"question\": \"...\", \"facet\": \"...\", \"rationale\": \"...\"}, {\"question\": \"...\", \"facet\": \"...\", \"rationale\": \"...\"}]}",
    "No markdown. No explanation. Exactly 2 questions."
  ].join(" ");
}

function getQuestionSchema() {
  return {
    type: "object",
    properties: {
      questions: {
        type: "array",
        minItems: 2, maxItems: 2,
        items: {
          type: "object",
          properties: {
            question: { type: "string" },
            facet: { type: "string" },
            rationale: { type: "string" }
          },
          required: ["question"]
        }
      }
    },
    required: ["questions"]
  };
}

// Light dedup: lowercased word overlap > 0.7 -> reject
function isDuplicate(q, pool, threshold = 0.7) {
  const norm = s => String(s || "").toLowerCase()
    .replace(/[^a-z0-9\s]/g, " ").split(/\s+/).filter(Boolean);
  const A = new Set(norm(q));
  for (const prior of pool) {
    const B = new Set(norm(prior.question));
    if (!A.size || !B.size) continue;
    let inter = 0;
    for (const x of A) if (B.has(x)) inter++;
    const overlap = inter / Math.min(A.size, B.size);
    if (overlap >= threshold) return true;
  }
  return false;
}

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

    const { paper_text, sequence } = req.body || {};
    if (!paper_text || typeof paper_text !== "string") {
      return res.status(400).json({ error: "Missing paper_text string" });
    }

    const seq = Array.isArray(sequence) && sequence.length > 0
      ? sequence
      : ["openai", "anthropic", "gemini", "deepseek"];

    const validate = ajv.compile(getQuestionSchema());
    const pool = [];
    const errors = [];

    for (const provider of seq) {
      const model = defaultModelFor(provider);
      const user = JSON.stringify({
        paper_text,
        prior_questions: pool.map(q => q.question),
        instruction: pool.length === 0
          ? "No prior questions yet. Generate 2 fresh questions covering different facets."
          : `Prior questions are listed. Generate 2 NEW questions covering facets not yet covered.`
      });

      try {
        let added = 0;
        for (let attempt = 0; attempt < 2 && added < 2; attempt++) {
          const raw = await callProvider({
            provider, model, system: generationSystemPrompt(), user
          });
          const parsed = safeJsonParse(raw);
          if (!parsed.ok) continue;
          if (!validate(parsed.value)) continue;
          for (const q of parsed.value.questions) {
            if (added >= 2) break;
            if (isDuplicate(q.question, pool)) continue;
            pool.push({
              provider, model,
              question: q.question,
              facet: q.facet || "unspecified",
              rationale: q.rationale || ""
            });
            added++;
          }
        }
        if (added < 2) {
          errors.push({ provider, error: `Only added ${added}/2 unique questions` });
        }
      } catch (err) {
        errors.push({ provider, error: String(err?.message || err) });
      }
    }

    return res.status(200).json({
      ok: true,
      sequence: seq,
      n_questions: pool.length,
      questions: pool,
      errors: errors.length ? errors : undefined
    });
  } catch (err) {
    return res.status(500).json({ error: String(err?.message || err) });
  }
}
