import Ajv from "ajv";

const ajv = new Ajv({ allErrors: true, strict: false });

function setCors(res) {
  // Tight allowlist (recommended). For quick testing you can use "*"
  res.setHeader("Access-Control-Allow-Origin", "https://wajahathssn.github.io");
  res.setHeader("Access-Control-Allow-Methods", "GET,POST,OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, x-api-key");
  // Helps avoid weird caching across origins
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

export default async function handler(req, res) {
  // ✅ CORS must be set before any return
  setCors(res);

  // ✅ Handle preflight
  if (req.method === "OPTIONS") {
    return res.status(204).end();
  }

  try {
    if (req.method !== "POST") {
      return res.status(405).json({ error: "Use POST" });
    }

    // Optional simple auth (if you set API_AUTH_KEY in Vercel)
    const required = process.env.API_AUTH_KEY;
    if (required) {
      const got = req.headers["x-api-key"];
      if (got !== required) return res.status(401).json({ error: "Unauthorized" });
    }

    const { prompt, schema, provider, model } = req.body || {};
    if (!prompt || typeof prompt !== "string") {
      return res.status(400).json({ error: "Missing prompt string" });
    }
    if (!schema || typeof schema !== "object") {
      return res.status(400).json({ error: "Missing schema object" });
    }

    // OpenAI-only for now
    const llmProvider = provider || "openai";
    if (llmProvider !== "openai") {
      return res.status(400).json({ error: `Provider not supported yet: ${llmProvider}` });
    }

    const llmModel = model || "gpt-4o-mini";

    const openaiKey = process.env.OPENAI_API_KEY;
    if (!openaiKey) {
      return res.status(500).json({ error: "Missing OPENAI_API_KEY on server" });
    }

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
      const r = await fetch("https://api.openai.com/v1/chat/completions", {
        method: "POST",
        headers: {
          Authorization: `Bearer ${openaiKey}`,
          "Content-Type": "application/json"
        },
        body: JSON.stringify({
          model: llmModel,
          temperature: 0,
          messages: [
            { role: "system", content: system },
            { role: "user", content: user }
          ]
        })
      });

      const text = await r.text();

      if (!r.ok) {
        return res.status(502).json({
          error: `OpenAI error: ${r.status}`,
          details: text
        });
      }

      const data = JSON.parse(text);
      const raw = data.choices?.[0]?.message?.content ?? "";
      lastRaw = raw;

      const parsed = safeJsonParse(raw);
      if (!parsed.ok) continue;

      if (validate(parsed.value)) {
        return res.status(200).json({
          ok: true,
          provider: "openai",
          model: llmModel,
          result: parsed.value
        });
      }
    }

    return res.status(422).json({
      ok: false,
      error: "Model output did not validate against schema",
      raw: lastRaw
    });
  } catch (err) {
    return res.status(500).json({ error: String(err?.message || err) });
  }
}
