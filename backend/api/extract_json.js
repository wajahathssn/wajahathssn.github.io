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
    headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
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
    headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
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
      max_tokens: 2000,
      temperature: 0,
      system,
      messages: [{ role: "user", content: user }]
    })
  });

  const text = await r.text();
  if (!r.ok) throw new Error(`Anthropic error: ${r.status} ${text}`);
  const data = JSON.parse(text);
  return data.content?.map(b => b.text).join("") ?? "";
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
  return data.candidates?.[0]?.content?.parts?.map(p => p.text).join("") ?? "";
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

function buildExtractSystemPrompt() {
  return [
    "You are a strict information extraction engine.",
    "Return ONLY valid JSON. No markdown. No extra text.",
    "The JSON MUST validate against the provided JSON Schema.",
    "If something is not present in the input, use empty arrays/strings; do NOT guess.",
    "Never include explanations."
  ].join(" ");
}

function buildVerifySystemPrompt() {
  return [
    "You are a strict JSON verification and repair engine for information extraction.",
    "You will receive source text, a candidate JSON extraction, and a JSON Schema.",
    "Return ONLY valid JSON that matches the schema.",
    "Remove unsupported claims/properties.",
    "Fix obvious misattributions only if directly supported by the source text.",
    "Do not invent new facts.",
    "Do not include explanations."
  ].join(" ");
}

async function runOneShot({ provider, model, prompt, schema, validate }) {
  const system = buildExtractSystemPrompt();
  const user = JSON.stringify({ prompt, schema });

  let lastRaw = "";
  for (let attempt = 1; attempt <= 2; attempt++) {
    const raw = await callProvider({ provider, model, system, user });
    lastRaw = raw;

    const parsed = safeJsonParse(raw);
    if (!parsed.ok) continue;

    if (validate(parsed.value)) {
      return { ok: true, result: parsed.value, raw: raw };
    }
  }

  return {
    ok: false,
    error: "Model output did not validate against schema",
    raw: lastRaw
  };
}

async function runTwoShot({ provider, model, prompt, schema, validate }) {
  // Pass 1: extract candidate JSON
  const extractSystem = buildExtractSystemPrompt();
  const extractUser = JSON.stringify({ prompt, schema });

  let pass1Raw = "";
  let pass1Parsed = null;

  for (let attempt = 1; attempt <= 2; attempt++) {
    const raw = await callProvider({ provider, model, system: extractSystem, user: extractUser });
    pass1Raw = raw;

    const parsed = safeJsonParse(raw);
    if (!parsed.ok) continue;

    pass1Parsed = parsed.value;
    break;
  }

  if (!pass1Parsed) {
    return {
      ok: false,
      error: "Two-shot pass 1 failed to produce parseable JSON",
      raw: pass1Raw
    };
  }

  // Pass 2: verify + repair candidate JSON
  const verifySystem = buildVerifySystemPrompt();
  const verifyUser = JSON.stringify({
    source_text: prompt,
    candidate_json: pass1Parsed,
    schema
  });

  let pass2Raw = "";
  for (let attempt = 1; attempt <= 2; attempt++) {
    const raw = await callProvider({ provider, model, system: verifySystem, user: verifyUser });
    pass2Raw = raw;

    const parsed = safeJsonParse(raw);
    if (!parsed.ok) continue;

    if (validate(parsed.value)) {
      return {
        ok: true,
        result: parsed.value,
        raw: pass2Raw
      };
    }
  }

  // Fallback: if pass 2 fails but pass 1 is valid, return pass 1
  if (validate(pass1Parsed)) {
    return {
      ok: true,
      result: pass1Parsed,
      raw: pass1Raw,
      warning: "Two-shot verification failed; returned pass-1 extraction"
    };
  }

  return {
    ok: false,
    error: "Two-shot verification output did not validate against schema",
    raw: pass2Raw || pass1Raw
  };
}

export default async function handler(req, res) {
  setCors(res);

  if (req.method === "OPTIONS") return res.status(204).end();
  if (req.method !== "POST") return res.status(405).json({ error: "Use POST" });

  try {
    // Optional endpoint auth
    const required = process.env.API_AUTH_KEY;
    if (required) {
      const got = req.headers["x-api-key"];
      if (got !== required) return res.status(401).json({ error: "Unauthorized" });
    }

    const { prompt, schema, provider, model, mode, retrieval_mode } = req.body || {};
    if (!prompt || typeof prompt !== "string") return res.status(400).json({ error: "Missing prompt string" });
    if (!schema || typeof schema !== "object") return res.status(400).json({ error: "Missing schema object" });

    const p = provider || "openai";

    const defaultModel =
      p === "openai" ? "gpt-4o-mini" :
      p === "anthropic" ? "claude-sonnet-4-5-20250929" :
      p === "gemini" ? "gemini-3-pro-preview" :
      p === "deepseek" ? "deepseek-chat" :
      "gpt-4o-mini";

    const m = model || defaultModel;
    const extractionMode = mode || "one_shot";
    const retrievalMode = retrieval_mode || "full_text";

    const validate = ajv.compile(schema);

    const runResult =
      extractionMode === "two_shot"
        ? await runTwoShot({ provider: p, model: m, prompt, schema, validate })
        : await runOneShot({ provider: p, model: m, prompt, schema, validate });

    if (!runResult.ok) {
      return res.status(422).json({
        ok: false,
        provider: p,
        model: m,
        mode: extractionMode,
        retrieval_mode: retrievalMode,
        error: runResult.error,
        raw: runResult.raw
      });
    }

    return res.status(200).json({
      ok: true,
      provider: p,
      model: m,
      mode: extractionMode,
      retrieval_mode: retrievalMode,
      warning: runResult.warning,
      result: runResult.result
    });

  } catch (err) {
    return res.status(500).json({ error: String(err?.message || err) });
  }
}
