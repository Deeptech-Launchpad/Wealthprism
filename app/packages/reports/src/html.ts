import { fmtCell, fmtIst, isNumeric, type ReportDoc, type Section } from "./doc.js";
const esc = (s: any) => String(s ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
const CSS = `body{font-family:Inter,Segoe UI,Helvetica,Arial,sans-serif;color:#12213A;margin:0;padding:24px;font-size:13px;background:#fff}
h1{font-size:22px;margin:0 0 4px}h2{font-size:15px;margin:22px 0 6px;color:#12213A;border-bottom:1px solid #E3E8EF;padding-bottom:4px}h3{font-size:13px;margin:16px 0 4px}
.sub{color:#5B6B82;margin-bottom:14px}.meta{color:#5B6B82;font-size:11px;margin-bottom:18px}
table{border-collapse:collapse;width:100%;margin:6px 0 10px}th{background:#F2F5F9;text-align:left;font-weight:600;padding:5px 7px;border-bottom:1px solid #D5DCE6;font-size:12px}
td{padding:4px 7px;border-bottom:1px solid #EEF1F5;font-size:12px;vertical-align:top}.num{text-align:right;font-variant-numeric:tabular-nums}tr.total td{font-weight:700;border-top:1px solid #B7C0CE}
.kv{display:grid;grid-template-columns:repeat(var(--c,2),1fr);gap:4px 18px;margin:6px 0 10px}.kv div{display:flex;justify-content:space-between;border-bottom:1px dotted #E3E8EF;padding:3px 0}.kv span:last-child{font-weight:600}
p{margin:4px 0 8px;line-height:1.45}.small{font-size:11px;color:#5B6B82}.note{font-size:11px;color:#8A6D1C;background:#FBF6E8;padding:6px 8px;border-left:3px solid #B7791F}
.foot{margin-top:28px;padding-top:8px;border-top:1px solid #E3E8EF;font-size:10px;color:#8A94A6}.empty{color:#8A94A6;font-style:italic}`;
function section(s: Section): string {
  switch (s.type) {
    case "heading": return `<h${(s.level ?? 2) + 0}>${esc(s.text)}</h${(s.level ?? 2) + 0}>`;
    case "paragraph": return `<p class="${s.style ?? "normal"}">${esc(s.text)}</p>`;
    case "kv": return `${s.title ? `<h3>${esc(s.title)}</h3>` : ""}<div class="kv" style="--c:${s.columns ?? 2}">${s.items.map((i) => `<div><span>${esc(i.label)}</span><span>${esc(fmtCell(i.value, i.kind ?? "text"))}</span></div>`).join("")}</div>`;
    case "table": {
      if (!s.rows.length && !s.totals) return `${s.title ? `<h3>${esc(s.title)}</h3>` : ""}<p class="empty">${esc(s.empty ?? "Nothing to report for this period.")}</p>`;
      const head = s.columns.map((c) => `<th class="${isNumeric(c.kind) || c.align === "right" ? "num" : ""}">${esc(c.label)}</th>`).join("");
      const row = (r: Record<string, any>, cls = "") => `<tr class="${cls}">${s.columns.map((c) => `<td class="${isNumeric(c.kind) || c.align === "right" ? "num" : ""}">${esc(fmtCell(r[c.key], c.kind))}</td>`).join("")}</tr>`;
      return `${s.title ? `<h3>${esc(s.title)}</h3>` : ""}<table><thead><tr>${head}</tr></thead><tbody>${s.rows.map((r) => row(r)).join("")}${s.totals ? row(s.totals, "total") : ""}</tbody></table>${s.note ? `<p class="small">${esc(s.note)}</p>` : ""}`;
    }
    case "pagebreak": return `<div style="page-break-after:always"></div>`;
  }
}
/** Self-contained HTML (inline CSS) for previews and e-mail bodies; prints to PDF from a browser with the same layout order as the PDF renderer. */
export function renderHtml(doc: ReportDoc): string {
  const meta = [doc.entity, doc.period, doc.audience ? `for the ${doc.audience}` : null].filter(Boolean).join(" · ");
  return `<!doctype html><html><head><meta charset="utf-8"><title>${esc(doc.title)}</title><style>${CSS}</style></head><body>
<h1>${esc(doc.title)}</h1>${doc.subtitle ? `<div class="sub">${esc(doc.subtitle)}</div>` : ""}<div class="meta">${esc(doc.family)}${meta ? " · " + esc(meta) : ""} · generated ${fmtIst(doc.generated_at)}</div>
${doc.sections.map(section).join("\n")}
<div class="foot">${esc(doc.family)} · generated ${fmtIst(doc.generated_at)}${doc.footer_note ? " · " + esc(doc.footer_note) : ""}</div></body></html>`;
}
/** Convert our own rendered HTML (IPS, proposal memo, digest — well-formed, no scripts) into a ReportDoc so it can go through the PDF and XLSX renderers. */
export function docFromHtml(html: string, meta: Omit<ReportDoc, "sections">): ReportDoc {
  const decode = (s: string) => s.replace(/<[^>]+>/g, "").replace(/&nbsp;/g, " ").replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/\s+/g, " ").trim();
  const body = (html.match(/<body[^>]*>([\s\S]*)<\/body>/i)?.[1] ?? html).replace(/<style[\s\S]*?<\/style>/gi, "").replace(/<script[\s\S]*?<\/script>/gi, "");
  const sections: Section[] = []; const re = /<(h1|h2|h3|h4|p|li|table|div)([^>]*)>([\s\S]*?)<\/\1>|<table[\s\S]*?<\/table>/gi;
  // tables first: cut them out so nested block matches do not double-count; keep order by position
  const tokens: { at: number; html: string; tag: string }[] = [];
  body.replace(/<table[\s\S]*?<\/table>/gi, (m, at) => { tokens.push({ at, html: m, tag: "table" }); return m; });
  const rest = body.replace(/<table[\s\S]*?<\/table>/gi, (m) => " ".repeat(m.length));
  rest.replace(/<(h1|h2|h3|h4|p|li)([^>]*)>([\s\S]*?)<\/\1>/gi, (m, tag, _a, inner, at) => { tokens.push({ at, html: inner, tag: tag.toLowerCase() }); return m; });
  tokens.sort((a, b) => a.at - b.at);
  for (const t of tokens) {
    if (t.tag === "table") {
      const rowsHtml = [...t.html.matchAll(/<tr[^>]*>([\s\S]*?)<\/tr>/gi)].map((m) => [...m[1].matchAll(/<(td|th)[^>]*>([\s\S]*?)<\/\1>/gi)].map((c) => ({ th: c[1].toLowerCase() === "th", text: decode(c[2]) })));
      if (!rowsHtml.length) continue;
      const headerIdx = rowsHtml.findIndex((r) => r.some((c) => c.th)); const header = headerIdx >= 0 ? rowsHtml[headerIdx] : null;
      const n = Math.max(...rowsHtml.map((r) => r.length)); const columns = Array.from({ length: n }, (_, i) => ({ key: `c${i}`, label: header?.[i]?.text ?? "", align: (i > 0 && rowsHtml.slice(headerIdx + 1).every((r) => !r[i] || r[i].text === "" || /^[-−–]?[\d,.]+%?$/.test(r[i].text)) ? "right" : "left") as "left" | "right" }));
      const rows = rowsHtml.filter((_, i) => i !== headerIdx).map((r) => Object.fromEntries(r.map((c, i) => [`c${i}`, c.text])));
      sections.push({ type: "table", columns, rows });
    } else {
      const text = decode(t.html); if (!text) continue;
      if (t.tag === "h1") sections.push({ type: "heading", text, level: 1 }); else if (t.tag === "h2") sections.push({ type: "heading", text, level: 2 }); else if (t.tag === "h3" || t.tag === "h4") sections.push({ type: "heading", text, level: 3 });
      else sections.push({ type: "paragraph", text: t.tag === "li" ? `• ${text}` : text });
    }
  }
  void re;
  return { ...meta, sections };
}
