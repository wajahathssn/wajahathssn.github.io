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

  const noFence = t
    .replace(/^```(?:json)?\s*/i, "")
    .replace(/\s*```$/i, "")
    .trim();

  try {
    return { ok: true, value: JSON.parse(noFence) };
  } catch {}

  const match = noFence.match(/(\{[\s\S]*\}|\[[\s\S]*\])/);
  if (match) {
    try {
      return { ok: true, value: JSON.parse(match[1]) };
    } catch {}
  }

  return { ok: false };
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
      contents: [{
        role: "user",
        parts: [{ text: `${system}\n\n${user}` }]
      }],
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

function reviewSchema() {
  return {
    type: "object",
    properties: {
      reviewer_summary: { type: "string" },
      correct_count: { type: "integer" },
      incorrect_count: { type: "integer" },
      missing_properties_json: {
        type: "array",
        items: {
          type: "object",
          properties: {
            material: { type: "string" },
            property: { type: "string" },
            value: { type: "string" },
            unit: { type: "string" },
            qualifier: { type: "string" },
            conditions: { type: "string" },
            evidence: { type: "string" },
            note: { type: "string" }
          },
          required: ["material", "property"]
        }
      },
      notes: {
        type: "array",
        items: { type: "string" }
      }
    },
    required: ["correct_count", "incorrect_count", "missing_properties_json"]
  };
}

function reviewSystemPrompt() {
  return [
    "You are a scientific extraction reviewer.",
    "You will be given source text, a target schema, and a candidate extraction JSON.",
    "Audit the candidate extraction against the source text.",
    "Return ONLY valid JSON. No markdown. No extra text.",
    "Use EXACTLY this top-level shape:",
    "{ reviewer_summary, correct_count, incorrect_count, missing_properties_json, notes }",
    "",
    "Rules:",
    "- correct_count: integer count of correct extracted property observations.",
    "- incorrect_count: integer count of incorrect extracted property observations.",
    "- missing_properties_json: array of missing properties that should be added, as structured JSON objects.",
    "- notes: optional short notes.",
    "- Be strict and evidence-grounded.",
    "- Do not invent claims not supported by the source text."
  ].join(" ");
}

function normalizeReviewShape(parsed) {
  // Already in simplified target format
  if (
    parsed &&
    typeof parsed === "object" &&
    Number.isInteger(parsed.correct_count) &&
    Number.isInteger(parsed.incorrect_count) &&
    Array.isArray(parsed.missing_properties_json)
  ) {
    return {
      reviewer_summary: parsed.reviewer_summary || "",
      correct_count: parsed.correct_count,
      incorrect_count: parsed.incorrect_count,
      missing_properties_json: parsed.missing_properties_json,
      notes: Array.isArray(parsed.notes) ? parsed.notes.map(String) : []
    };
  }

  // Previous custom format
  if (
    parsed &&
    typeof parsed === "object" &&
    Number.isInteger(parsed.correct_observations_count) &&
    Number.isInteger(parsed.incorrect_observations_count)
  ) {
    let missing = [];

    if (Array.isArray(parsed.additional_properties_json)) {
      missing = parsed.additional_properties_json;
    } else if (Array.isArray(parsed.missing_observations)) {
      missing = parsed.missing_observations.map((x) => ({
        material: "",
        property: String(x),
        note: "Mapped from legacy missing format"
      }));
    }

    return {
      reviewer_summary: parsed.reviewer_summary || "",
      correct_count: parsed.correct_observations_count,
      incorrect_count: parsed.incorrect_observations_count,
      missing_properties_json: missing,
      notes: Array.isArray(parsed.additional_notes)
        ? parsed.additional_notes.map(String)
        : []
    };
  }

  // Claude nested audit format
  if (parsed && typeof parsed === "object" && parsed.audit_summary && parsed.detailed_audit) {
    const correctItems = Array.isArray(parsed.detailed_audit.correct_items)
      ? parsed.detailed_audit.correct_items
      : [];
    const incorrectItems = Array.isArray(parsed.detailed_audit.incorrect_items)
      ? parsed.detailed_audit.incorrect_items
      : [];
    const missingItems = Array.isArray(parsed.detailed_audit.missing_items)
      ? parsed.detailed_audit.missing_items
      : [];

    const missing_properties_json = missingItems.flatMap((x) => {
      const material = x?.material || "";
      const evidence = Array.isArray(x?.evidence) ? x.evidence.join(" | ") : "";
      const note = x?.note || "";

      if (Array.isArray(x?.properties) && x.properties.length) {
        return x.properties.map((p) => ({
          material,
          property: String(p),
          evidence,
          note
        }));
      }

      return [{
        material,
        property: x?.property ? String(x.property) : "Unspecified missing property",
        evidence,
        note
      }];
    });

    return {
      reviewer_summary: "",
      correct_count: Number.isInteger(parsed.audit_summary?.correct_observations)
        ? parsed.audit_summary.correct_observations
        : correctItems.length,
      incorrect_count: Number.isInteger(parsed.audit_summary?.incorrect_observations)
        ? parsed.audit_summary.incorrect_observations
        : incorrectItems.length,
      missing_properties_json,
      notes: Array.isArray(parsed.validation_notes)
        ? parsed.validation_notes.map(String)
        : []
    };
  }

  return null;
}

async function runReviewer({ reviewerProvider, sourceText, schema, candidateJson }) {
  const model = defaultModelFor(reviewerProvider);
  const validate = ajv.compile(reviewSchema());

  const system = reviewSystemPrompt();
  const user = JSON.stringify({
    source_text: sourceText,
    target_extraction_schema: schema,
    candidate_json: candidateJson,
    task: "Review the candidate extraction and return only counts + missing properties JSON."
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
      return { ok: true, provider: reviewerProvider, model, review: parsed.value };
    }

    const normalized = normalizeReviewShape(parsed.value);
    if (normalized && validate(normalized)) {
      return { ok: true, provider: reviewerProvider, model, review: normalized };
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

    let requested = Array.isArray(reviewers) && reviewers.length
      ? reviewers.filter((x) => ["openai", "anthropic", "gemini", "deepseek"].includes(x))
      : ["anthropic", "gemini", "deepseek"];

    requested = [...new Set(requested)].slice(0, 3);

    if (!requested.length) {
      return res.status(400).json({ error: "No valid reviewers provided" });
    }

    const results = {};
    for (const rp of requested) {
      try {
        results[rp] = await runReviewer({
          reviewerProvider: rp,
          sourceText: source_text,
          schema,
          candidateJson: candidate_json
        });
      } catch (err) {
        results[rp] = {
          ok: false,
          provider: rp,
          model: defaultModelFor(rp),
          error: String(err?.message || err)
        };
      }
    }

    return res.status(200).json({ ok: true, reviewers: results });
  } catch (err) {
    return res.status(500).json({ error: String(err?.message || err) });
  }
}
