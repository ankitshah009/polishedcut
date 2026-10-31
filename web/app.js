(() => {
  const $ = (s) => document.querySelector(s);
  const el = (tag, cls, txt) => { const e = document.createElement(tag); if (cls) e.className = cls; if (txt != null) e.textContent = txt; return e; };
  let picked = [], es = null, current = null;

  // ---------- upload ----------
  const drop = $("#drop"), input = $("#files");
  const refreshGo = () => { $("#go").disabled = !picked.length || !$("#brief").value.trim(); };
  function addFiles(list) {
    for (const f of list) if (f.type.startsWith("video/") || /\.(mp4|mov|webm|mkv|m4v)$/i.test(f.name)) picked.push(f);
    renderClips(); refreshGo();
  }
  function renderClips() {
    const ul = $("#cliplist"); ul.replaceChildren();
    picked.forEach((f, i) => {
      const li = el("li"); li.append(el("span", null, `clip${i + 1} · ${f.name}`));
      const x = el("button", null, "✕"); x.title = "Remove";
      x.onclick = (e) => { e.preventDefault(); picked.splice(i, 1); renderClips(); refreshGo(); };
      li.append(x); ul.append(li);
    });
  }
  input.onchange = () => { addFiles(input.files); input.value = ""; };
  ["dragenter", "dragover"].forEach((t) => drop.addEventListener(t, (e) => { e.preventDefault(); drop.classList.add("over"); }));
  ["dragleave", "drop"].forEach((t) => drop.addEventListener(t, (e) => { e.preventDefault(); drop.classList.remove("over"); }));
  drop.addEventListener("drop", (e) => addFiles(e.dataTransfer.files));
  $("#brief").oninput = refreshGo;

  $("#go").onclick = async () => {
    const fd = new FormData();
    fd.append("brief", $("#brief").value.trim());
    picked.forEach((f) => fd.append("files", f, f.name));
    $("#go").disabled = true; setStatus("Uploading clips…", "busy");
    try {
      const r = await fetch("/api/runs", { method: "POST", body: fd });
      if (!r.ok) throw new Error(await r.text());
      const run = await r.json();
      history.replaceState(null, "", `#${run.id}`);
      watch(run.id); loadRuns();
    } catch (e) { setStatus(`Upload failed: ${e.message}`, "error"); refreshGo(); }
  };

  // ---------- status ----------
  function setStatus(t, cls) { const s = $("#status"); s.textContent = t; s.className = `status ${cls}`; }
  function phase(run) {
    const its = run.iterations || [], n = its.length;
    switch (run.status) {
      case "queued": return ["Queued…", "busy"];
      case "drafting": return [n ? `Argon is patching v${n} into v${n + 1}…` : "Argon is drafting the first cut…", "busy"];
      case "rendering": return [`Rendering v${n && !its[n - 1].critique ? n : n + 1}…`, "busy"];
      case "critiquing": return [`Argon is watching v${n}…`, "busy"];
      case "done": return [`Final cut ready · v${n}${n > 1 ? ` after ${n - 1} fix${n > 2 ? "es" : ""}` : ""}`, "done"];
      case "error": return [`Error: ${run.error || "unknown"}`, "error"];
    }
    return [run.status, "idle"];
  }

  // ---------- helpers ----------
  const fmt = (s) => { s = Math.max(0, +s || 0); const m = Math.floor(s / 60); return `${m}:${(s % 60).toFixed(1).padStart(4, "0")}`; };
  const sec = (v) => `${(+v).toFixed(1)}s`;
  function videoUrl(run, p) {
    if (!p) return null;
    if (/^https?:|^\//.test(p) && p.startsWith("/runs/")) return p;
    const k = p.indexOf(`${run.id}/`);
    return k >= 0 ? `/runs/${p.slice(k)}` : `/runs/${run.id}/${p.split("/").pop()}`;
  }
  function describe(op) {
    const c = op.cut_id || "cut";
    switch (op.op) {
      case "trim": {
        const bits = [];
        if (op.src_in != null) bits.push(`start at ${sec(op.src_in)}`);
        if (op.src_out != null) bits.push(`end at ${sec(op.src_out)}`);
        return `Trimmed ${c} to ${bits.join(" and ") || "new bounds"}`;
      }
      case "remove_cut": return `Removed ${c}`;
      case "insert_cut": return `Inserted ${op.clip_id || "a clip"} ${op.src_in != null ? `${sec(op.src_in)}–${sec(op.src_out)}` : ""}${op.index != null ? ` at position ${op.index + 1}` : ""}`.trim();
      case "move_cut": return `Moved ${c} to position ${(op.index ?? 0) + 1}`;
      case "set_caption": return `Changed caption ${(op.index ?? 0) + 1}${op.text ? ` to “${op.text}”` : ""}`;
      case "remove_caption": return `Removed caption ${(op.index ?? 0) + 1}`;
      case "add_caption": return `Added caption “${op.text || ""}”${op.start != null ? ` at ${fmt(op.start)}` : ""}`;
      case "set_title": return op.text ? `Set title to “${op.text}”` : "Removed the title card";
    }
    return op.op;
  }

  // ---------- render ----------
  function render(run) {
    current = run;
    const [txt, cls] = phase(run); setStatus(txt, cls);
    $("#title").textContent = run.brief || "Untitled";
    const strip = $("#strip");
    const keep = {}; strip.querySelectorAll("video").forEach((v) => { keep[v.dataset.src] = v; });
    strip.replaceChildren();
    const its = run.iterations || [];
    const done = run.status === "done";
    its.forEach((it, i) => {
      const last = i === its.length - 1, isFinal = done && last;
      const card = el("article", "card" + (isFinal ? " final" : ""));
      if (i === 0 || isFinal) card.classList.add("cmp");
      const head = el("div", "chead"); head.append(el("b", null, `v${it.n}`));
      head.append(el("span", "tag", isFinal ? "Final cut" : last && !done ? phase(run)[0].replace(/…$/, "") : it.critique && it.critique.checks.every((c) => c.passed) ? "Passed" : "Revised"));
      card.append(head);
      const url = videoUrl(run, it.video);
      let vid = null;
      if (url && !(last && run.status === "rendering" && !done)) {
        vid = keep[url] || Object.assign(el("video"), { controls: true, preload: "metadata", playsInline: true, src: url });
        vid.dataset.src = url; card.append(vid);
      } else card.append(el("div", "ph", "Rendering…"));
      const cr = it.critique;
      if (cr) {
        const s = el("div", "sect"); s.append(el("h3", null, "What Argon saw"));
        if (cr.summary) s.append(el("p", "summary", cr.summary));
        const ul = el("ul", "checks");
        cr.checks.forEach((c) => {
          const li = el("li", c.passed ? "ok" : "bad");
          li.append(el("span", "mark", c.passed ? "✓" : "✕"), el("span", null, c.name));
          if (c.at != null && vid) {
            const b = el("button", "ts", fmt(c.at)); b.title = "Jump to this moment";
            b.onclick = () => { vid.currentTime = c.at; vid.play().catch(() => {}); };
            li.append(b);
          } else li.append(el("span"));
          if (c.note) li.append(el("span", "note", c.note));
          ul.append(li);
        });
        s.append(ul); card.append(s);
        if (cr.patches && cr.patches.length && !isFinal) {
          const p = el("div", "sect"); p.append(el("h3", null, `Fixes going into v${it.n + 1}`));
          const pl = el("ul", "patches"); cr.patches.forEach((op) => pl.append(el("li", null, describe(op))));
          p.append(pl); card.append(p);
        }
      } else if (!done) {
        card.append(Object.assign(el("div", "sect"), { innerHTML: '<h3>What Argon saw</h3><p class="summary">Watching…</p>' }));
      }
      if (isFinal && url) { const a = el("a", "dl", "Download final cut"); a.href = url; a.download = `${run.id}_final.mp4`; card.append(a); }
      strip.append(card);
    });
    if (!done && run.status !== "error" && !(its.length && !its[its.length - 1].critique)) {
      const n = its.length + 1, card = el("article", "card pending");
      const head = el("div", "chead"); head.append(el("b", null, `v${n}`), el("span", "tag", n === 1 ? "Drafting" : "Next"));
      card.append(head, el("div", "ph", phase(run)[0])); strip.append(card);
    }
    if (!strip.children.length) strip.append(el("p", "empty", phase(run)[0]));
    applyCompare();
  }
  function applyCompare() {
    const on = $("#compare").checked && current && current.status === "done" && (current.iterations || []).length > 1;
    $("#strip").classList.toggle("compare", !!on);
  }
  $("#compare").onchange = applyCompare;

  // ---------- live ----------
  function watch(id) {
    if (es) es.close();
    fetch(`/api/runs/${id}`).then((r) => r.ok ? r.json() : null).then((r) => r && render(r));
    es = new EventSource(`/api/runs/${id}/events`);
    es.onmessage = (e) => { try { render(JSON.parse(e.data)); } catch (_) {} };
    es.addEventListener("end", () => { es.close(); es = null; refreshGo(); loadRuns(); });
  }
  async function loadRuns() {
    try {
      const runs = await (await fetch("/api/runs")).json();
      const ul = $("#runs"); ul.replaceChildren();
      runs.forEach((r) => { const li = el("li"), a = el("a", null, `${r.status === "done" ? "✓" : "•"} ${r.brief}`); a.href = `#${r.id}`; a.onclick = () => watch(r.id); li.append(a); ul.append(li); });
    } catch (_) {}
  }
  loadRuns();
  if (location.hash.length > 1) watch(location.hash.slice(1));
})();
