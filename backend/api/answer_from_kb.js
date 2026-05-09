// api/answer_from_kb.js
//
// Closed-book question answering over a JSON knowledge base.
// The LLM is given ONLY the JSON KB - no source paper - and answers each
// question using only what is in the JSON. If the JSON is silent on the
// answer, the model must reply with "information not in KB".
//
// Body:
//   { kb: object,                 // candidate_json from extract_json
//     questions: [string],        // list of NL questions (or full {question, ...} objects)
//     provider: "openai"|"anthropic"|"gemini"|"deepseek",
//     model:    [optional] string }
//
// Returns:
//   { ok: true, provider, model, answers: [{question, answer, confidence, kb_silent}, ...] }

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

// ----- Provider calls -----
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

// ----- Closed-book QA logic -----
function answerSystemPrompt() {
  return [
    "You are a strict KB question answerer.",
    "You have ONLY the JSON knowledge base provided in the user message.",
    "You do NOT have access to the original paper.",
    "Use ONLY the JSON. Do not use general knowledge or training-data facts.",
    "If the JSON does not contain enough information to answer, you MUST reply with kb_silent=true and answer set to the literal string \"information not in KB\".",
    "Return ONLY JSON. No markdown. No explanation outside the JSON.",
    "Format: {\"answer\": string, \"kb_silent\": boolean, \"supporting_paths\": [string], \"confidence\": \"high\"|\"medium\"|\"low\"}.",
    "supporting_paths is a list of JSON paths into the KB, e.g. [\"items[0].properties[2]\"], that justify the answer."
  ].join(" ");
}

function getAnswerSchema() {
  return {
    type: "object",
    properties: {
      answer: { type: "string" },
      kb_silent: { type: "boolean" },
      supporting_paths: { type: "array", items: { type: "string" } },
      confidence: { type: "string", enum: ["high", "medium", "low"] }
    },
    required: ["answer"]
  };
}

function normalizeAnswer(value) {
  const out = { answer: "", kb_silent: false, supporting_paths: [], confidence: "medium" };
  if (!value || typeof value !== "object") return out;
  if (typeof value.answer === "string") out.answer = value.answer.trim();
  if (typeof value.kb_silent === "boolean") out.kb_silent = value.kb_silent;
  if (Array.isArray(value.supporting_paths)) {
    out.supporting_paths = value.supporting_paths.map(String).filter(Boolean);
  }
  if (typeof value.confidence === "string" && ["high","medium","low"].includes(value.confidence.toLowerCase())) {
    out.confidence = value.confidence.toLowerCase();
  }
  // Guard: if the answer text says "not in KB", force kb_silent=true
  if (out.answer.toLowerCase().includes("information not in kb")) out.kb_silent = true;
  return out;
}

async function answerOne({ provider, model, kb, question, validate }) {
  const system = answerSystemPrompt();
  const user = JSON.stringify({
    knowledge_base: kb,
    question,
    instruction: "Answer using ONLY the knowledge_base. If insufficient, set kb_silent=true."
  });

  let lastRaw = "";
  for (let attempt = 1; attempt <= 2; attempt++) {
    const raw = await callProvider({ provider, model, system, user });
    lastRaw = raw;
    const parsed = safeJsonParse(raw);
    if (!parsed.ok) continue;
    const norm = normalizeAnswer(parsed.value);
    if (validate(norm)) return { ok: true, ...norm };
  }
  return { ok: false, error: "Answerer output did not validate", raw: lastRaw };
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

    const { kb, questions, provider, model } = req.body || {};
    if (!kb || typeof kb !== "object") return res.status(400).json({ error: "Missing kb object" });
    if (!Array.isArray(questions) || questions.length === 0) {
      return res.status(400).json({ error: "Missing questions array" });
    }

    const p = provider || "openai";
    const m = model || defaultModelFor(p);
    const validate = ajv.compile(getAnswerSchema());

    const answers = [];
    for (const q of questions) {
      const qText = typeof q === "string" ? q : (q && q.question) || "";
      if (!qText) { answers.push({ question: "", ok: false, error: "Empty question" }); continue; }
      try {
        const a = await answerOne({ provider: p, model: m, kb, question: qText, validate });
        answers.push({ question: qText, ...a });
      } catch (err) {
        answers.push({ question: qText, ok: false, error: String(err?.message || err) });
      }
    }

    return res.status(200).json({
      ok: true, provider: p, model: m,
      n_questions: answers.length,
      n_kb_silent: answers.filter(a => a.kb_silent).length,
      answers
    });
  } catch (err) {
    return res.status(500).json({ error: String(err?.message || err) });
  }
}
