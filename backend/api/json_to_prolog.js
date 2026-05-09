// api/json_to_prolog.js
//
// Deterministically translate the contextual extraction JSON into
// a flat Prolog-style fact base.
//
// Schema produced:
//   material(M).
//   role(M, Role).
//   property(M, Prop, Value, Unit, Qualifier, Conditions, AppliesTo).
//   evidence(M, Prop, Snippet).
//   item_evidence(M, Snippet).
//
// Body:
//   { kb: object   // candidate_json from extract_json
//   }
//
// Returns:
//   { ok: true, prolog: string, facts: [string], n_materials, n_properties, n_evidence }

function setCors(res) {
  res.setHeader("Access-Control-Allow-Origin", "https://wajahathssn.github.io");
  res.setHeader("Access-Control-Allow-Methods", "GET,POST,OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, x-api-key");
  res.setHeader("Vary", "Origin");
}

// Free-text -> safe Prolog atom (lowercase, identifier-safe).
function pAtom(s) {
  let a = String(s || "")
    .toLowerCase()
    .replace(/[^a-z0-9_]/g, "_")
    .replace(/^_+|_+$/g, "");
  if (!a) return "unknown";
  if (/^[0-9]/.test(a)) a = "x_" + a;
  return a;
}

// Free-text -> safely-quoted Prolog string.
function pString(s) {
  const t = String(s == null ? "" : s).replace(/\\/g, "\\\\").replace(/'/g, "''");
  return `'${t}'`;
}

function jsonToProlog(kb) {
  const facts = [];
  const materialAtoms = new Set();
  let nProps = 0;
  let nEv = 0;

  // Accept either {result: {items: [...]}} (extract_json wrapper) or {items: [...]}
  const items = Array.isArray(kb?.items)
    ? kb.items
    : (kb?.result && Array.isArray(kb.result.items) ? kb.result.items : []);

  facts.push("% Auto-generated Prolog fact base from JSON KB");
  facts.push("% Schema:");
  facts.push("%   material(M).");
  facts.push("%   role(M, Role).");
  facts.push("%   property(M, Prop, Value, Unit, Qualifier, Conditions, AppliesTo).");
  facts.push("%   evidence(M, Prop, Snippet).");
  facts.push("%   item_evidence(M, Snippet).");
  facts.push("");

  for (const item of items) {
    if (!item || typeof item !== "object") continue;
    const M = pAtom(item.material);
    if (!materialAtoms.has(M)) {
      facts.push(`material(${M}).`);
      materialAtoms.add(M);
    }
    if (item.entity_role) facts.push(`role(${M}, ${pString(item.entity_role)}).`);

    const props = Array.isArray(item.properties) ? item.properties : [];
    for (const p of props) {
      if (typeof p === "string") {
        facts.push(`property(${M}, ${pString(p)}, ${pString("")}, ${pString("")}, ${pString("")}, ${pString("")}, ${pString("")}).`);
        nProps++;
        continue;
      }
      if (!p || typeof p !== "object") continue;
      const prop  = pString(p.property);
      const value = pString(p.value);
      const unit  = pString(p.unit);
      const qual  = pString(p.qualifier);
      const cond  = pString(p.conditions);
      const app   = pString(p.applies_to);
      facts.push(`property(${M}, ${prop}, ${value}, ${unit}, ${qual}, ${cond}, ${app}).`);
      nProps++;
      if (p.evidence) {
        facts.push(`evidence(${M}, ${prop}, ${pString(p.evidence)}).`);
        nEv++;
      }
    }

    const itemEv = Array.isArray(item.evidence) ? item.evidence : [];
    for (const e of itemEv) {
      if (e) {
        facts.push(`item_evidence(${M}, ${pString(e)}).`);
        nEv++;
      }
    }
  }

  return {
    facts,
    n_materials: materialAtoms.size,
    n_properties: nProps,
    n_evidence: nEv
  };
}

export default function handler(req, res) {
  setCors(res);
  if (req.method === "OPTIONS") return res.status(204).end();
  if (req.method !== "POST") return res.status(405).json({ error: "Use POST" });

  try {
    const required = process.env.API_AUTH_KEY;
    if (required) {
      const got = req.headers["x-api-key"];
      if (got !== required) return res.status(401).json({ error: "Unauthorized" });
    }

    const { kb } = req.body || {};
    if (!kb || typeof kb !== "object") {
      return res.status(400).json({ error: "Missing kb object" });
    }

    const out = jsonToProlog(kb);
    return res.status(200).json({
      ok: true,
      prolog: out.facts.join("\n"),
      facts: out.facts,
      n_materials: out.n_materials,
      n_properties: out.n_properties,
      n_evidence: out.n_evidence
    });
  } catch (err) {
    return res.status(500).json({ error: String(err?.message || err) });
  }
}
