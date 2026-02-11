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

    const { prompt, schema, provider, model } = req.body || {};
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

    const validate = ajv.compile(schema);

    const system = [
      "You are a strict information extraction engine.",
      "Return ONLY valid JSON. No markdown. No extra text.",
      "The JSON MUST validate against the provided JSON Schema.",
      "If something is not present in the input, use empty arrays/strings; do NOT guess.",
      "Never include explanations."
    ].join(" ");

    const user = JSON.stringify({ prompt, schema });

    let lastRaw = "";
    for (let attempt = 1; attempt <= 2; attempt++) {
      const raw = await callProvider({ provider: p, model: m, system, user });
      lastRaw = raw;

      const parsed = safeJsonParse(raw);
      if (!parsed.ok) continue;

      if (validate(parsed.value)) {
        return res.status(200).json({ ok: true, provider: p, model: m, result: parsed.value });
      }
    }

    return res.status(422).json({
      ok: false,
      provider: p,
      model: m,
      error: "Model output did not validate against schema",
      raw: lastRaw
    });
  } catch (err) {
    return res.status(500).json({ error: String(err?.message || err) });
  }
}
