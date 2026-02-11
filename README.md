<!doctype html>
<html>
<head>
  <meta charset="utf-8" />
  <title>PDF → JSON Extractor</title>
  <style>
    body { font-family: system-ui; max-width: 900px; margin: 40px auto; padding: 0 16px; }
    textarea { width: 100%; min-height: 100px; }
    pre { background: #f6f8fa; padding: 12px; border-radius: 8px; overflow:auto; }
    .row { display:flex; gap:12px; flex-wrap:wrap; }
    button { padding: 10px 14px; cursor:pointer; }
    input[type="file"] { padding: 8px; }
  </style>
</head>
<body>
  <h1>PDF → JSON Extractor</h1>

  <div class="row">
    <input id="pdf" type="file" accept="application/pdf" />
    <button id="uploadBtn">1) Upload & Index</button>
  </div>

  <h3>Query / Extraction instruction</h3>
  <textarea id="query">Extract materials and the properties they have which are mentioned in the abstract.</textarea>
  <button id="askBtn">2) Run Extraction</button>

  <h3>Result (JSON)</h3>
  <pre id="out">{}</pre>
  <button id="downloadBtn">Download JSON</button>

  <script>
    // TODO: set your API base URL (Cloudflare Worker / Vercel function)
    const API_BASE = "https://YOUR-WORKER.your-subdomain.workers.dev";

    let docId = null;

    document.getElementById("uploadBtn").onclick = async () => {
      const f = document.getElementById("pdf").files[0];
      if (!f) return alert("Choose a PDF first.");

      const fd = new FormData();
      fd.append("file", f);

      const r = await fetch(`${API_BASE}/ingest`, { method: "POST", body: fd });
      if (!r.ok) return alert("Upload failed");
      const data = await r.json();
      docId = data.doc_id;
      alert(`Indexed! doc_id=${docId}`);
    };

    document.getElementById("askBtn").onclick = async () => {
      if (!docId) return alert("Upload & index first.");
      const query = document.getElementById("query").value;

      const r = await fetch(`${API_BASE}/extract`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ doc_id: docId, query })
      });

      const data = await r.json();
      document.getElementById("out").textContent = JSON.stringify(data, null, 2);
    };

    document.getElementById("downloadBtn").onclick = () => {
      const text = document.getElementById("out").textContent || "{}";
      const blob = new Blob([text], { type: "application/json" });
      const a = document.createElement("a");
      a.href = URL.createObjectURL(blob);
      a.download = `extraction-${docId || "result"}.json`;
      a.click();
      URL.revokeObjectURL(a.href);
    };
  </script>
</body>
</html>
