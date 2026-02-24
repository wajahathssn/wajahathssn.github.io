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
  try {
    return { ok: true, value: JSON.parse(t) };
  } catch {}
  const match = t.match(/(\{[\s\S]*\}|\[[\s\S]*\])/);
  if (match) {
    try {
      return { ok: true, value: JSON.parse(match[1]) };
    } catch {}
  }
  return { ok: false };
}

async function callOpenAI({ model, system, user }) {
  const key = process.env.OPENAI_API_KEY;
  if (!key) throw new Error("Missing OPENAI_API_KEY on server");

  const r = await fetch("https://api.openai.com/v1/chat/completions", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${key}`,
      "Content-Type": "application/json"
    },
    body: JSON.stringify({
      model,
      temperature: 0,
      messages: [
        { role: "system", content: system },
        { role: "user", content: user }
      ]
    })
  });

  const text = await r.text();
  if (!r.ok) throw new Error(`OpenAI error: ${r.status} ${text}`);
  const data = JSON.parse(text);
  return data.choices?.[0]?.message?.content ?? "";
}

async function callDeepSeek({ model, system, user }) {
  const key = process.env.DEEPSEEK_API_KEY;
  if (!key) throw new Error("Missing DEEPSEEK_API_KEY on server");

  const r = await fetch("https://api.deepseek.com/chat/completions", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${key}`,
      "Content-Type": "application/json"
    },
    body: JSON.stringify({
      model,
      temperature: 0,
      messages: [
        { role: "system", content: system },
        { role: "user", content: user }
      ]
    })
  });

  const text = await r.text();
  if (!r.ok) throw new Error(`DeepSeek error: ${r.status} ${text}`);
  const data = JSON.parse(text);
  return data.choices?.[0]?.message?.content ?? "";
}

async function callAnthropic({ model, system, user }) {
  const key = process.env.ANTHROPIC_API_KEY;
  if (!key) throw new Error("Missing ANTHROPIC_API_KEY on server");

  const r = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "x-api-key": key,
      "anthropic-version": "2023-06-01",
      "content-type": "application/json"
    },
    body: JSON.stringify({
      model,
      max_tokens: 3000,
      temperature: 0,
      system,
      messages: [{ role: "user", content: user }]
    })
  });

  const text = await r.text();
  if (!r.ok) throw new Error(`Anthropic error: ${r.status} ${text}`);
  const data = JSON.parse(text);
  return data.content?.map((b) => b.text).join("") ?? "";
}

async function callGemini({ model, system, user }) {
  const key = process.env.GEMINI_API_KEY;
  if (!key) throw new Error("Missing GEMINI_API_KEY on server");

  const url = `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent?key=${encodeURIComponent(key)}`;

  const r = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      contents: [
        {
          role: "user",
          parts: [{ text: `${system}\n\n${user}` }]
        }
      ],
      generationConfig: { temperature: 0 }
    })
  });

  const text = await r.text();
  if (!r.ok) throw new Error(`Gemini error: ${r.status} ${text}`);
  const data = JSON.parse(text);
  return data.candidates?.[0]?.content?.parts?.map((p) => p.text).join("") ?? "";
}

async function callProvider({ provider, model, system, user }) {
  switch (provider) {
    case "openai":
      return callOpenAI({ model, system, user });
    case "deepseek":
      return callDeepSeek({ model, system, user });
    case "anthropic":
      return callAnthropic({ model, system, user });
    case "gemini":
      return callGemini({ model, system, user });
    default:
      throw new Error(`Unknown provider: ${provider}`);
  }
}

function defaultModelFor(provider) {
  return (
    provider === "openai" ? "gpt-4o" :
    provider === "anthropic" ? "claude-sonnet-4-5-20250929" :
    provider === "gemini" ? "gemini-3-pro-preview" :
    provider === "deepseek" ? "deepseek-chat" :
    "gpt-4o"
  );
}

function reviewSchema() {
  return {
    type: "object",
    properties: {
      reviewer_summary: { type: "string" },
      correct_observations_count: { type: "integer" },
      incorrect_observations_count: { type: "integer" },
      correct_observations: {
        type: "array",
        items: { type: "string" }
      },
      incorrect_observations: {
        type: "array",
        items: { type: "string" }
      },
      missing_observations: {
        type: "array",
        items: { type: "string" }
      },
      additional_notes: {
        type: "array",
        items: { type: "string" }
      }
    },
    required: [
      "correct_observations_count",
      "incorrect_observations_count",
      "correct_observations",
      "incorrect_observations",
      "missing_observations"
    ]
  };
}

function reviewSystemPrompt() {
  return [
    "You are a scientific extraction reviewer.",
    "You will be given: source text, a target JSON schema, and a candidate extraction JSON.",
    "Audit the candidate extraction against the source text.",
    "Return ONLY valid JSON, no markdown, no extra text.",
    "Be strict and evidence-grounded.",
    "Count correct and incorrect observations.",
    "List missing observations that should be included.",
    "Do not invent claims not supported by the source text."
  ].join(" ");
}

async function runReviewer({ reviewerProvider, sourceText, schema, candidateJson }) {
  const model = defaultModelFor(reviewerProvider);
  const reviewerSchema = reviewSchema();
  const validate = ajv.compile(reviewerSchema);

  const system = reviewSystemPrompt();
  const user = JSON.stringify({
    source_text: sourceText,
    target_extraction_schema: schema,
    candidate_json: candidateJson,
    task: "Review the candidate extraction and report correct/incorrect/missing observations."
  });

  let lastRaw = "";
  for (let attempt = 1; attempt <= 2; attempt++) {
    const raw = await callProvider({
      provider: reviewerProvider,
      model,
      system,
      user
    });
    lastRaw = raw;

    const parsed = safeJsonParse(raw);
    if (!parsed.ok) continue;

    if (validate(parsed.value)) {
      return {
        ok: true,
        provider: reviewerProvider,
        model,
        review: parsed.value
      };
    }
  }

  return {
    ok: false,
    provider: reviewerProvider,
    model,
    error: "Reviewer output did not validate",
    raw: lastRaw
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

    const { source_text, schema, candidate_json, reviewers } = req.body || {};

    if (!source_text || typeof source_text !== "string") {
      return res.status(400).json({ error: "Missing source_text string" });
    }
    if (!schema || typeof schema !== "object") {
      return res.status(400).json({ error: "Missing schema object" });
    }
    if (!candidate_json || typeof candidate_json !== "object") {
      return res.status(400).json({ error: "Missing candidate_json object" });
    }

    const reviewerList = Array.isArray(reviewers) && reviewers.length
      ? reviewers
      : ["anthropic", "gemini", "deepseek"];

    const results = {};
    for (const reviewerProvider of reviewerList) {
      // skip if key missing for that provider
      if (
        (reviewerProvider === "anthropic" && !process.env.ANTHROPIC_API_KEY) ||
        (reviewerProvider === "gemini" && !process.env.GEMINI_API_KEY) ||
        (reviewerProvider === "deepseek" && !process.env.DEEPSEEK_API_KEY) ||
        (reviewerProvider === "openai" && !process.env.OPENAI_API_KEY)
      ) {
        results[reviewerProvider] = {
          ok: false,
          error: `Missing API key for ${reviewerProvider}`
        };
        continue;
      }

      try {
        results[reviewerProvider] = await runReviewer({
          reviewerProvider,
          sourceText: source_text,
          schema,
          candidateJson: candidate_json
        });
      } catch (e) {
        results[reviewerProvider] = {
          ok: false,
          error: String(e?.message || e)
        };
      }
    }

    return res.status(200).json({
      ok: true,
      reviewers: results
    });
  } catch (err) {
    return res.status(500).json({ error: String(err?.message || err) });
  }
}
