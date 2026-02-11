import express from "express";
import cors from "cors";
import dotenv from "dotenv";
import Ajv from "ajv";
import { callLLM } from "./providers/index.js";
import { safeJsonParse } from "./utils/json.js";

dotenv.config();

const app = express();
app.use(express.json({ limit: "5mb" }));

// Dev-friendly CORS. In production you should restrict this to your GitHub Pages domain.
app.use(cors({ origin: "*" }));

const ajv = new Ajv({ allErrors: true, strict: false });

// Optional API key protection (recommended for public deployments)
app.use((req, res, next) => {
  const required = process.env.API_AUTH_KEY;
  if (!required) return next();
  const got = req.headers["x-api-key"];
  if (got !== required) return res.status(401).json({ error: "Unauthorized" });
  next();
});

app.get("/health", (_req, res) => res.json({ ok: true }));

/**
 * POST /extract_json
 * body: {
 *   prompt: string,
 *   schema: object,
 *   provider?: "openai",
 *   model?: string
 * }
 */
app.post("/extract_json", async (req, res) => {
  try {
    const { prompt, schema, provider, model } = req.body || {};

    if (!prompt || typeof prompt !== "string") {
      return res.status(400).json({ error: "Missing 'prompt' string" });
    }
    if (!schema || typeof schema !== "object") {
      return res.status(400).json({ error: "Missing 'schema' object" });
    }

    const llmProvider = provider || "openai";
    const llmModel = model || "gpt-4o-mini";

    const validate = ajv.compile(schema);

    const system = [
      "You are a strict information extraction engine.",
      "Return ONLY valid JSON. No markdown. No extra text.",
      "The JSON MUST validate against the provided JSON Schema.",
      "If something is not present in the input, use empty arrays/strings; do NOT guess.",
      "Never include explanations."
    ].join(" ");

    // We send both schema + prompt. (Later you can also send retrieved context.)
    const user = JSON.stringify({ prompt, schema });

    // Try twice to get valid JSON
    let lastRaw = "";
    for (let attempt = 1; attempt <= 2; attempt++) {
      const raw = await callLLM({
        provider: llmProvider,
        model: llmModel,
        system,
        user
      });
      lastRaw = raw;

      const parsed = safeJsonParse(raw);
      if (!parsed.ok) continue;

      if (validate(parsed.value)) {
        return res.json({ ok: true, provider: llmProvider, model: llmModel, result: parsed.value });
      }
    }

    return res.status(422).json({
      ok: false,
      error: "Model output did not validate against schema",
      provider: llmProvider,
      model: llmModel,
      raw: lastRaw
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: String(err?.message || err) });
  }
});

const PORT = process.env.PORT || 8787;
app.listen(PORT, () => console.log(`API running on http://localhost:${PORT}`));
