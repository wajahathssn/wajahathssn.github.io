// api/nl_to_prolog_query.js
//
// Rewrite a natural-language question into a single Prolog query against the
// schema produced by /api/json_to_prolog. Does NOT execute the query - only
// produces it.
//
// Body:
//   { question: string,
//     [optional] facts:    string,            // the Prolog fact base, used for grounding
//     [optional] provider: "openai"|...,
//     [optional] model:    string }
//
// Returns:
//   { ok: true, provider, model,
//     prolog_query: string,
//     expected_bindings: [string],
//     rationale: string }

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

// ----- Provider calls (same wrappers as elsewhere) -----
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

async function callDeepSeek({ model, system, user }) {
  const key = process.env.DEEPSEEK_API_KEY;
  if (!key) throw new Error("Missing DEEPSEEK_API_KEY on server");
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
  if (!key) throw new Error("Missing ANTHROPIC_API_KEY on server");
  const r = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "x-api-key": key, "anthropic-version": "2023-06-01", "content-type": "application/json"
    },
    body: JSON.stringify({
      model, max_tokens: 1500, temperature: 0, system,
      messages: [{ role: "user", content: user }]
    })
  });
  const text = await r.text();
  if (!r.ok) throw new Error(`Anthropic error: ${r.status} ${text}`);
  return JSON.parse(text).content?.map(b => b.text).join("") ?? "";
}

async function callGemini({ model, system, user }) {
  const key = process.env.GEMINI_API_KEY;
  if (!key) throw new Error("Missing GEMINI_API_KEY on server");
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
    case "openai":   return callOpenAI({ model, system, user });
    case "deepseek": return callDeepSeek({ model, system, user });
    case "anthropic":return callAnthropic({ model, system, user });
    case "gemini":   return callGemini({ model, system, user });
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

// ----- Rewriter logic -----
function rewriterSystemPrompt() {
  return [
    "You are a Prolog query writer.",
    "You will receive a natural-language question and (optionally) a Prolog fact base.",
    "The fact base uses this schema:",
    "  material(M).",
    "  role(M, Role).",
    "  property(M, Prop, Value, Unit, Qualifier, Conditions, AppliesTo).",
    "  evidence(M, Prop, Snippet).",
    "  item_evidence(M, Snippet).",
    "Constants are quoted atoms (single-quoted). Variables start with a capital letter.",
    "Write a single conjunctive query that answers the question.",
    "Variables should expose the bindings the user cares about (e.g. ?- material(M), property(M, 'conductivity', V, _, _, _, _).).",
    "Return ONLY JSON. No markdown.",
    "Format: {\"prolog_query\": string, \"expected_bindings\": [string], \"rationale\": string}.",
    "Do NOT execute the query - return only the query text."
  ].join(" ");
}

function getQuerySchema() {
  return {
    type: "object",
    properties: {
      prolog_query:      { type: "string" },
      expected_bindings: { type: "array", items: { type: "string" } },
      rationale:         { type: "string" }
    },
    required: ["prolog_query"]
  };
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

    const { question, facts, provider, model } = req.body || {};
    if (!question || typeof question !== "string") {
      return res.status(400).json({ error: "Missing question string" });
    }

    const p = provider || "openai";
    const m = model || defaultModelFor(p);
    const validate = ajv.compile(getQuerySchema());

    const user = JSON.stringify({
      question,
      fact_base: typeof facts === "string" ? facts.slice(0, 4000) : null
    });

    let lastRaw = "";
    for (let attempt = 1; attempt <= 2; attempt++) {
      const raw = await callProvider({ provider: p, model: m, system: rewriterSystemPrompt(), user });
      lastRaw = raw;
      const parsed = safeJsonParse(raw);
      if (!parsed.ok) continue;
      if (!validate(parsed.value)) continue;
      const out = parsed.value;
      return res.status(200).json({
        ok: true, provider: p, model: m,
        prolog_query: String(out.prolog_query || "").trim(),
        expected_bindings: Array.isArray(out.expected_bindings) ? out.expected_bindings.map(String) : [],
        rationale: String(out.rationale || "")
      });
    }

    return res.status(422).json({
      ok: false, provider: p, model: m,
      error: "Rewriter output did not validate", raw: lastRaw
    });
  } catch (err) {
    return res.status(500).json({ error: String(err?.message || err) });
  }
}
