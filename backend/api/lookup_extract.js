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

function normalizeText(s) {
  return String(s || "")
    .toLowerCase()
    .replace(/&/g, " and ")
    .replace(/[^a-z0-9\s]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function tokenSet(s) {
  return new Set(
    normalizeText(s)
      .split(" ")
      .map((x) => x.trim())
      .filter(Boolean)
  );
}

function overlapScore(a, b) {
  const A = tokenSet(a);
  const B = tokenSet(b);
  if (!A.size || !B.size) return 0;
  let inter = 0;
  for (const x of A) {
    if (B.has(x)) inter++;
  }
  return inter / Math.max(A.size, B.size);
}

function stripHtml(s) {
  return String(s || "")
    .replace(/<[^>]+>/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function reconstructOpenAlexAbstract(inv) {
  if (!inv || typeof inv !== "object") return "";
  const entries = [];
  for (const [word, positions] of Object.entries(inv)) {
    if (!Array.isArray(positions)) continue;
    for (const pos of positions) {
      entries.push([pos, word]);
    }
  }
  entries.sort((a, b) => a[0] - b[0]);
  return entries.map((x) => x[1]).join(" ").trim();
}

function scoreCandidate({ queryTitle, queryYear, queryJournal, candidateTitle, candidateYear, candidateJournal, hasAbstract, hasDoi }) {
  let score = 0;

  const tScore = overlapScore(queryTitle, candidateTitle);
  const jScore = overlapScore(queryJournal, candidateJournal);

  score += tScore * 70;
  score += jScore * 15;

  if (queryYear && candidateYear && Number(queryYear) === Number(candidateYear)) score += 10;
  if (hasAbstract) score += 10;
  if (hasDoi) score += 5;

  return score;
}

async function searchCrossref({ title, year, journal }) {
  const params = new URLSearchParams();
  params.set("query.title", title);
  if (journal) params.set("query.container-title", journal);
  params.set("rows", "8");

  const url = `https://api.crossref.org/works?${params.toString()}`;
  const r = await fetch(url, {
    headers: {
      "User-Agent": "wajahathssn-extractor/1.0 (mailto:example@example.com)"
    }
  });

  if (!r.ok) throw new Error(`Crossref search failed: ${r.status}`);
  const data = await r.json();
  const items = data?.message?.items || [];

  const candidates = items.map((x) => {
    const candidateTitle = Array.isArray(x.title) ? x.title[0] : "";
    const candidateJournal = Array.isArray(x["container-title"]) ? x["container-title"][0] : "";
    const candidateYear =
      x?.issued?.["date-parts"]?.[0]?.[0] ||
      x?.published?.["date-parts"]?.[0]?.[0] ||
      null;

    const abstract = stripHtml(x.abstract || "");
    const doi = x.DOI || "";

    return {
      source: "crossref",
      title: candidateTitle,
      journal: candidateJournal,
      year: candidateYear,
      doi,
      abstract,
      score: scoreCandidate({
        queryTitle: title,
        queryYear: year,
        queryJournal: journal,
        candidateTitle,
        candidateYear,
        candidateJournal,
        hasAbstract: !!abstract,
        hasDoi: !!doi
      }),
      raw: x
    };
  });

  candidates.sort((a, b) => b.score - a.score);
  return candidates;
}

async function searchOpenAlex({ title, year, journal }) {
  const params = new URLSearchParams();
  params.set("search", title);
  params.set("per-page", "8");

  const url = `https://api.openalex.org/works?${params.toString()}`;
  const r = await fetch(url);

  if (!r.ok) throw new Error(`OpenAlex search failed: ${r.status}`);
  const data = await r.json();
  const results = data?.results || [];

  const candidates = results.map((x) => {
    const candidateTitle = x.display_name || "";
    const candidateJournal = x?.primary_location?.source?.display_name || "";
    const candidateYear = x.publication_year || null;
    const abstract = reconstructOpenAlexAbstract(x.abstract_inverted_index);
    const doi = x.doi ? String(x.doi).replace(/^https?:\/\/doi\.org\//i, "") : "";

    return {
      source: "openalex",
      title: candidateTitle,
      journal: candidateJournal,
      year: candidateYear,
      doi,
      abstract,
      score: scoreCandidate({
        queryTitle: title,
        queryYear: year,
        queryJournal: journal,
        candidateTitle,
        candidateYear,
        candidateJournal,
        hasAbstract: !!abstract,
        hasDoi: !!doi
      }),
      raw: x
    };
  });

  candidates.sort((a, b) => b.score - a.score);
  return candidates;
}

async function findBestPaper({ title, year, journal }) {
  let candidates = [];

  try {
    const crossref = await searchCrossref({ title, year, journal });
    candidates.push(...crossref);
  } catch {}

  try {
    const openalex = await searchOpenAlex({ title, year, journal });
    candidates.push(...openalex);
  } catch {}

  if (!candidates.length) {
    throw new Error("No paper candidates found");
  }

  candidates.sort((a, b) => b.score - a.score);
  const best = candidates[0];

  if (!best || best.score < 20) {
    throw new Error("No confident paper match found");
  }

  return best;
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

function verifierModelFor(provider, selectedModel) {
  if (provider === "openai") return "gpt-4o";
  return selectedModel;
}

function extractSystemPromptOneShot() {
  return [
    "You are a strict scientific information extraction engine.",
    "Return ONLY valid JSON. No markdown. No extra text.",
    "The JSON MUST validate against the provided JSON Schema.",
    "Extract only claims explicitly supported by the source text.",
    "Do not guess or infer missing facts.",
    "Use faithful evidence snippets from the source text."
  ].join(" ");
}

function extractSystemPromptTwoShotPass1() {
  return [
    "You are a high-recall scientific extraction engine.",
    "Return ONLY valid JSON matching the provided JSON Schema.",
    "Extract candidate claims from the source text.",
    "Prefer recall over precision in this pass, but do not invent facts.",
    "Use faithful evidence snippets.",
    "No markdown. No explanations."
  ].join(" ");
}

function rulesSystemPromptTwoShot() {
  return [
    "You are a scientific information extraction QA planner.",
    "You will receive source text, task instructions, and a JSON Schema.",
    "Your job is to generate PAPER-SPECIFIC verification rules for auditing an extraction.",
    "Return ONLY valid JSON. No markdown. No explanations.",
    "The rules must be derived from the source text and task, not generic boilerplate.",
    "Focus on likely entity confusions, claim types, and context/qualifier requirements in this paper."
  ].join(" ");
}

function verifySystemPromptTwoShot() {
  return [
    "You are a strict scientific information extraction verifier and repair engine.",
    "You will receive source text, a candidate JSON extraction, a JSON Schema, and a paper-specific verification plan.",
    "Return ONLY valid JSON that matches the schema. No markdown. No explanations.",
    "Apply the paper-specific verification plan strictly.",
    "Keep only claims explicitly supported by the source text.",
    "Do not infer or generalize.",
    "Ensure evidence faithfully supports each claim/property.",
    "Remove unsupported or misattributed claims.",
    "If an item has no valid supported claims left, remove it.",
    "Preserve qualifiers/conditions when present in the source text."
  ].join(" ");
}

function getRulePlanSchema() {
  return {
    type: "object",
    properties: {
      entities: {
        type: "array",
        items: {
          type: "object",
          properties: {
            name: { type: "string" },
            role: { type: "string" }
          },
          required: ["name", "role"]
        }
      },
      claim_types: {
        type: "array",
        items: { type: "string" }
      },
      paper_specific_rules: {
        type: "array",
        items: { type: "string" }
      },
      common_failure_modes: {
        type: "array",
        items: { type: "string" }
      },
      qualifier_expectations: {
        type: "array",
        items: { type: "string" }
      }
    },
    required: ["paper_specific_rules"]
  };
}

async function runOneShot({ provider, model, prompt, schema, validate }) {
  const system = extractSystemPromptOneShot();
  const user = JSON.stringify({ prompt, schema });

  let lastRaw = "";
  for (let attempt = 1; attempt <= 2; attempt++) {
    const raw = await callProvider({ provider, model, system, user });
    lastRaw = raw;

    const parsed = safeJsonParse(raw);
    if (!parsed.ok) continue;

    if (validate(parsed.value)) {
      return { ok: true, result: parsed.value };
    }
  }

  return {
    ok: false,
    error: "Model output did not validate against schema",
    raw: lastRaw
  };
}

async function runTwoShot({ provider, model, prompt, schema, validate }) {
  const pass1System = extractSystemPromptTwoShotPass1();
  const pass1User = JSON.stringify({ prompt, schema });

  let pass1Raw = "";
  let pass1Parsed = null;

  for (let attempt = 1; attempt <= 2; attempt++) {
    const raw = await callProvider({
      provider,
      model,
      system: pass1System,
      user: pass1User
    });
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

  const rulePlanSchema = getRulePlanSchema();
  const rulePlanValidate = ajv.compile(rulePlanSchema);

  const rulesSystem = rulesSystemPromptTwoShot();
  const rulesUser = JSON.stringify({
    source_text: prompt,
    extraction_schema: schema,
    task: "Create a paper-specific verification plan for auditing a scientific JSON extraction."
  });

  let rulesRaw = "";
  let rulesPlan = null;

  for (let attempt = 1; attempt <= 2; attempt++) {
    const raw = await callProvider({
      provider,
      model,
      system: rulesSystem,
      user: rulesUser
    });
    rulesRaw = raw;

    const parsed = safeJsonParse(raw);
    if (!parsed.ok) continue;

    if (rulePlanValidate(parsed.value)) {
      rulesPlan = parsed.value;
      break;
    }
  }

  if (!rulesPlan) {
    rulesPlan = {
      paper_specific_rules: [
        "Keep only explicitly supported claims.",
        "Remove unsupported properties/claims.",
        "Ensure evidence supports each claim.",
        "Preserve qualifiers/conditions if present."
      ]
    };
  }

  const verifySystem = verifySystemPromptTwoShot();
  const verifyUser = JSON.stringify({
    source_text: prompt,
    candidate_json: pass1Parsed,
    schema,
    verification_plan: rulesPlan
  });

  const pass2Model = verifierModelFor(provider, model);

  let pass2Raw = "";
  for (let attempt = 1; attempt <= 2; attempt++) {
    const raw = await callProvider({
      provider,
      model: pass2Model,
      system: verifySystem,
      user: verifyUser
    });
    pass2Raw = raw;

    const parsed = safeJsonParse(raw);
    if (!parsed.ok) continue;

    if (validate(parsed.value)) {
      return {
        ok: true,
        result: parsed.value,
        debug: {
          pass1_model: model,
          pass2_model: pass2Model,
          verification_plan: rulesPlan
        }
      };
    }
  }

  if (validate(pass1Parsed)) {
    return {
      ok: true,
      result: pass1Parsed,
      warning: "Two-shot verification failed; returned pass-1 extraction",
      debug: {
        pass1_model: model,
        pass2_model: pass2Model,
        verification_plan: rulesPlan
      }
    };
  }

  return {
    ok: false,
    error: "Two-shot verification output did not validate against schema",
    raw: pass2Raw || pass1Raw || rulesRaw
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
      if (got !== required) {
        return res.status(401).json({ error: "Unauthorized" });
      }
    }

    const {
      title,
      year,
      journal,
      schema,
      provider,
      model,
      mode,
      include_debug
    } = req.body || {};

    if (!title || typeof title !== "string") {
      return res.status(400).json({ error: "Missing title string" });
    }
    if (!schema || typeof schema !== "object") {
      return res.status(400).json({ error: "Missing schema object" });
    }

    const best = await findBestPaper({ title, year, journal });

    if (!best.abstract) {
      return res.status(404).json({
        ok: false,
        error: "Matched paper but could not retrieve abstract text",
        lookup: {
          matched_title: best.title,
          matched_journal: best.journal,
          matched_year: best.year,
          doi: best.doi || "",
          source: best.source
        }
      });
    }

    const p = provider || "openai";
    const m = model || defaultModelFor(p);
    const extractionMode = mode || "one_shot";

    const validate = ajv.compile(schema);

    const instruction =
      extractionMode === "one_shot"
        ? "Extract mentions of materials and the properties they have which are mentioned in the abstract."
        : "Extract mentions of materials and the properties they have which are mentioned in the abstract. Preserve conditions/qualifiers (e.g., under what conditions, in what device/cell, and with what measured values) when present.";

    const prompt = `DOCUMENT TEXT:\n${best.abstract}\n\nTASK:\n${instruction}`;

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
        retrieval_mode: "metadata_abstract",
        lookup: {
          matched_title: best.title,
          matched_journal: best.journal,
          matched_year: best.year,
          doi: best.doi || "",
          source: best.source,
          score: best.score
        },
        error: runResult.error,
        raw: runResult.raw
      });
    }

    const response = {
      ok: true,
      provider: p,
      model: m,
      mode: extractionMode,
      retrieval_mode: "metadata_abstract",
      lookup: {
        matched_title: best.title,
        matched_journal: best.journal,
        matched_year: best.year,
        doi: best.doi || "",
        source: best.source,
        score: best.score
      },
      result: runResult.result
    };

    if (runResult.warning) response.warning = runResult.warning;
    if (include_debug === true && runResult.debug) {
      response.debug = runResult.debug;
    }

    return res.status(200).json(response);
  } catch (err) {
    return res.status(500).json({ error: String(err?.message || err) });
  }
}
