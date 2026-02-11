export function safeJsonParse(text) {
  const t = (text || "").trim();

  // Try direct parse
  try {
    return { ok: true, value: JSON.parse(t) };
  } catch {}

  // Try extracting the first JSON object/array block from messy output
  const match = t.match(/(\{[\s\S]*\}|\[[\s\S]*\])/);
  if (match) {
    try {
      return { ok: true, value: JSON.parse(match[1]) };
    } catch {}
  }
  return { ok: false };
}
