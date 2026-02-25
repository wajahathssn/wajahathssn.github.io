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

  // direct parse
  try {
    return { ok: true, value: JSON.parse(t) };
  } catch {}

  // strip ```json ... ```
  const fenced = t.match(/```(?:json)?\s*([\s\S]*?)\s*```/i);
  if (fenced) {
    try {
      return { ok: true, value: JSON.parse(fenced[1]) };
    } catch {}
  }

  // fallback: first object/array
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

// Review schema used by UI cards
function getReviewSchema() {
  return {
    type: "object",
    properties: {
      correct_count: { type: "integer" },
      incorrect_count: { type: "integer" },
      missing_properties_json: {
        type: "array",
        items: {
          type: "object",
          properties: {
            material: { type: "string" },
            properties: {
              type: "array",
              items: { type: "string" }
            },
            evidence: {
              type: "array",
              items: { type: "string" }
            }
          },
          required: ["material", "properties"]
        }
      },
      notes: {
        type: "array",
        items: { type: "string" }
      }
    },
    required: ["correct_count", "incorrect_count", "missing_properties_json", "notes"]
  };
}

// Normalize whatever the reviewer returned into your UI schema
function normalizeReview(value) {
  const out = {
    correct_count: 0,
    incorrect_count: 0,
    missing_properties_json: [],
    notes: []
  };

  if (!value || typeof value !== "object") return out;

  // counts
  if (Number.isInteger(value.correct_count)) out.correct_count = value.correct_count;
  if (Number.isInteger(value.incorrect_count)) out.incorrect_count = value.incorrect_count;

  // sometimes models nest counts
  if (value.audit_summary && typeof value.audit_summary === "object") {
    if (Number.isInteger(value.audit_summary.correct_observations)) {
      out.correct_count = value.audit_summary.correct_observations;
    }
    if (Number.isInteger(value.audit_summary.incorrect_observations)) {
      out.incorrect_count = value.audit_summary.incorrect_observations;
    }
  }

  // missing properties (preferred)
  if (Array.isArray(value.missing_properties_json)) {
    out.missing_properties_json = value.missing_properties_json;
  }

  // alternate nested shape
  if (
    (!out.missing_properties_json || out.missing_properties_json.length === 0) &&
    value.detailed_audit &&
    Array.isArray(value.detailed_audit.missing_items)
  ) {
    out.missing_properties_json = value.detailed_audit.missing_items.map((x) => ({
      material: String(x?.material ?? ""),
      properties: Array.isArray(x?.properties) ? x.properties.map(String) : [],
      evidence: Array.isArray(x?.evidence) ? x.evidence.map(String) : []
    }));
  }

  // notes can come back as string or array
  if (Array.isArray(value.notes)) {
    out.notes = value.notes.map(String);
  } else if (typeof value.notes === "string" && value.notes.trim()) {
    out.notes = [value.notes.trim()];
  }

  if (typeof value.reviewer_summary === "string" && value.reviewer_summary.trim()) {
    out.notes.unshift(value.reviewer_summary.trim());
  }

  if (Array.isArray(value.validation_notes)) {
    out.notes.push(...value.validation_notes.map(String));
  }

  // sanitize missing items
  out.missing_properties_json = (out.missing_properties_json || [])
    .filter((x) => x && typeof x === "object")
    .map((x) => ({
      material: String(x.material ?? ""),
      properties: Array.isArray(x.properties) ? x.properties.map(String) : [],
      evidence: Array.isArray(x.evidence) ? x.evidence.map(String) : []
    }))
    .filter((x) => x.material || x.properties.length > 0);

  return out;
}

function reviewSystemPrompt() {
  return [
    "You are a strict scientific extraction reviewer.",
    "You will review a candidate JSON extraction against the source text.",
    "Return ONLY valid JSON (no markdown, no code fences, no prose outside JSON).",
    "Do NOT rewrite the candidate extraction.",
    "Your output must contain exactly these top-level fields:",
    "correct_count (integer), incorrect_count (integer), missing_properties_json (array), notes (array of strings).",
    "Count an observation as incorrect only if it is unsupported, misattributed, or contradicted by the source text.",
    "Do not list correct observations individually.",
    "In missing_properties_json, include only additional supported properties missing from the candidate.",
    "Each missing item should contain: material, properties (array of strings), and optional evidence (array of strings).",
    "Keep notes concise."
  ].join(" ");
}

async function runSingleReview({ provider, model, source_text, schema, candidate_json }) {
  const system = reviewSystemPrompt();

  const user = JSON.stringify({
    task: "Review this candidate extraction against the source text.",
    source_text,
    extraction_schema: schema,
    candidate_json,
    expected_output_format: {
      correct_count: 0,
      incorrect_count: 0,
      missing_properties_json: [
        {
          material: "string",
          properties: ["string"],
          evidence: ["string"]
        }
      ],
      notes: ["string"]
    }
  });

  const validate = ajv.compile(getReviewSchema());

  let lastRaw = "";
  for (let attempt = 1; attempt <= 2; attempt++) {
    const raw = await callProvider({ provider, model, system, user });
    lastRaw = raw;

    const parsed = safeJsonParse(raw);
    if (!parsed.ok) continue;

    const normalized = normalizeReview(parsed.value);
    if (validate(normalized)) {
      return { ok: true, review: normalized };
    }
  }

  return {
    ok: false,
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
    if (!Array.isArray(reviewers) || reviewers.length === 0) {
      return res.status(400).json({ error: "Missing reviewers array" });
    }

    const allowed = ["openai", "anthropic", "gemini", "deepseek"];
    const finalReviewers = reviewers.filter((r) => allowed.includes(r));

    if (!finalReviewers.length) {
      return res.status(400).json({ error: "No valid reviewers" });
    }

    const results = {};
    for (const provider of finalReviewers) {
      const model = defaultModelFor(provider);
      try {
        results[provider] = await runSingleReview({
          provider,
          model,
          source_text,
          schema,
          candidate_json
        });
        // include provider/model for UI display
        results[provider].provider = provider;
        results[provider].model = model;
      } catch (err) {
        results[provider] = {
          ok: false,
          provider,
          model,
          error: String(err?.message || err)
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
