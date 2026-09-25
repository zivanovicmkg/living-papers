/**
 * Living Papers MCP server (read-only).
 * Cloudflare Worker, single file, no dependencies.
 * Serves the same paper.json / data.json files that the visual pages at
 * https://papers.biology2.net read. Visitors connect their own AI agent;
 * this server makes no AI calls.
 *
 * Endpoint: POST /mcp  (MCP Streamable HTTP, JSON responses)
 */

const BASE = "https://papers.biology2.net";
const SERVER = { name: "living-papers", version: "1.0.0" };
const PROTOCOLS = ["2025-06-18", "2025-03-26", "2024-11-05"];
const CACHE_MS = 5 * 60 * 1000;

/* ------------------------------------------------------------------ data */

const cache = new Map();
async function getJSON(path) {
  const hit = cache.get(path);
  if (hit && Date.now() - hit.t < CACHE_MS) return hit.v;
  const r = await fetch(`${BASE}/${path}`, { cf: { cacheTtl: 300 } });
  if (!r.ok) throw new Error(`Could not load ${path} (HTTP ${r.status})`);
  const v = await r.json();
  cache.set(path, { t: Date.now(), v });
  return v;
}
async function listPapers() {
  const idx = await getJSON("papers.json");
  return idx.papers;
}
async function loadPaper(slug) {
  const papers = await listPapers();
  const s = slug || papers[0].slug;
  if (!papers.some(p => p.slug === s))
    throw new UserError(`Unknown paper "${s}". Available: ${papers.map(p => p.slug).join(", ")}`);
  const [paper, data] = await Promise.all([getJSON(`${s}/paper.json`), getJSON(`${s}/data.json`)]);
  return { slug: s, paper, data, url: `${BASE}/${s}/` };
}

class UserError extends Error {}
const dk = d => String(+d);
const STATES = ["viable", "early_apoptosis", "late_apoptosis", "necrosis"];

function citation(P) {
  const p = P.paper;
  return `${p.authors[0]} et al. ${p.title}. ${p.journal} ${p.year}, ${p.volume}, ${p.article}. doi:${p.doi} (${p.license})`;
}
function checkLine(P, line) {
  if (!P.cellLines[line]) throw new UserError(`Unknown cell line "${line}". Available: ${Object.keys(P.cellLines).join(", ")}`);
}
function checkDrug(P, line, drug) {
  checkLine(P, line);
  if (!P.cellLines[line].drugs.includes(drug))
    throw new UserError(`${drug} was not tested on ${line}. Drugs for ${line}: ${P.cellLines[line].drugs.join(", ")}`);
}

/* availability of each assay per (line, drug) */
function doses(D, line, drug) {
  const r = D.rtca?.[line]?.[drug];
  const f = D.flow?.[line]?.[drug];
  const q = D.qpcr?.[line]?.[drug];
  const p = Object.keys(D.params?.[line] || {}).filter(k => k.startsWith(drug + " ")).map(k => +k.slice(drug.length + 1));
  const sort = a => [...new Set(a)].sort((x, y) => x - y);
  return {
    rtca: r ? sort(Object.keys(r.series).filter(k => k !== "0").map(Number)) : [],
    flow: f ? sort(Object.keys(f).map(Number)) : [],
    qpcr: q ? sort(Object.keys(q).map(Number)) : [],
    params: sort(p)
  };
}
function needDose(avail, assay, line, drug, dose) {
  if (!avail[assay].includes(+dose))
    throw new UserError(`No ${assay} data for ${drug} ${dose} µM on ${line}. Available ${assay} doses: ${avail[assay].join(", ") || "none"} µM.`);
}

function interp(series, t) {
  const a = series.nci;
  if (t < 0 || t > series.tmax + 2) return null;
  t = Math.min(t, a.length - 1);
  const i = Math.floor(t), f = t - i;
  return i + 1 >= a.length ? a[a.length - 1] : a[i] * (1 - f) + a[i + 1] * f;
}

/* ------------------------------------------------------------------ tools */

const lineP = { type: "string", description: "Cell line, e.g. HCT-116, MDA-MB-231, MRC-5" };
const drugP = { type: "string", description: "Drug name as in list_conditions, e.g. Oxaliplatin, 5-FU, Doxorubicin" };
const doseP = { type: "number", description: "Dose in µM" };
const paperP = { type: "string", description: "Paper slug from list_papers. Optional; defaults to the first paper." };
const obj = (props, req = []) => ({ type: "object", properties: { paper: paperP, ...props }, required: req });

const RULES = " Report values with units and the source figure/table given in the result. Distinguish observed data, derived values and the authors' interpretation. Do not estimate values for doses or drugs that are not in the paper.";

const TOOLS = [
  {
    name: "list_papers",
    description: "List the living papers available on this server, with title, DOI and page URL.",
    inputSchema: { type: "object", properties: {} },
    run: async () => ({ papers: await listPapers(), site: BASE })
  },
  {
    name: "get_paper_overview",
    description: "Metadata, research question, main finding (as reported by the authors), cell lines, drugs, assays and the list of method sections of a paper." + RULES,
    inputSchema: obj({}),
    run: async a => {
      const { paper: P, url } = await loadPaper(a.paper);
      return {
        citation: citation(P), page: url, paper: P.paper, question: P.question, main_finding: P.mainFinding,
        cell_lines: P.cellLines, drugs: P.drugs, assays: P.assays, genes: P.genes,
        method_sections: P.methods.map(m => ({ id: m.id, title: m.title, section: m.section })),
        limitations: P.limitations
      };
    }
  },
  {
    name: "list_conditions",
    description: "List every (cell line, drug) with the doses available for each assay: rtca (impedance curves), flow (cell death states), qpcr (apoptosis genes), params (fitted model parameters). Use this before asking for specific data.",
    inputSchema: obj({ cell_line: lineP, drug: drugP }),
    run: async a => {
      const { paper: P, data: D } = await loadPaper(a.paper);
      const out = [];
      for (const [line, L] of Object.entries(P.cellLines)) {
        if (a.cell_line && a.cell_line !== line) continue;
        for (const drug of L.drugs) {
          if (a.drug && a.drug !== drug) continue;
          out.push({ cell_line: line, kind: L.kind, drug, doses_uM: doses(D, line, drug) });
        }
      }
      if (!out.length) throw new UserError("No matching conditions. Call list_conditions without filters to see all.");
      return { conditions: out };
    }
  },
  {
    name: "get_rtca_curve",
    description: "Real-time impedance curve (normalized cell index, NCI) for one condition and the untreated control of the same plate. Time is hours since seeding; drug_added_h marks treatment. Observed data." + RULES,
    inputSchema: obj({ cell_line: lineP, drug: drugP, dose_uM: doseP, step_h: { type: "number", description: "Sampling step in hours, default 1 (max resolution) " } }, ["cell_line", "drug", "dose_uM"]),
    run: async a => {
      const { paper: P, data: D } = await loadPaper(a.paper);
      checkDrug(P, a.cell_line, a.drug);
      needDose(doses(D, a.cell_line, a.drug), "rtca", a.cell_line, a.drug, a.dose_uM);
      const r = D.rtca[a.cell_line][a.drug], s = r.series[dk(a.dose_uM)], c = r.series["0"];
      const step = Math.max(1, Math.round(a.step_h || 1));
      const pick = arr => arr.map((v, t) => [t, v]).filter(([t]) => t % step === 0);
      return {
        cell_line: a.cell_line, drug: a.drug, dose_uM: +a.dose_uM, unit: "NCI", time_axis: "hours since seeding",
        drug_added_h: r.treat, recording_ends_h: s.tmax,
        treated: pick(s.nci), control_same_plate: pick(c.nci),
        sd_points: s.sd.map(([t, y, sd]) => ({ t_h: t, nci: y, sd })),
        source: `Supplementary Fig ${P.cellLines[a.cell_line].rtcaFigure}`, provenance: "Authors' RTCA workbook, resampled to 1 h", kind: "observed"
      };
    }
  },
  {
    name: "get_viability_percent",
    description: "Impedance of treated wells as % of untreated wells on the same plate, at 24, 48 or 72 h after drug addition. Derived from RTCA." + RULES,
    inputSchema: obj({ cell_line: lineP, drug: drugP, dose_uM: doseP, hours_after_treatment: { type: "number", enum: [24, 48, 72] } }, ["cell_line", "drug", "dose_uM"]),
    run: async a => {
      const { paper: P, data: D } = await loadPaper(a.paper);
      checkDrug(P, a.cell_line, a.drug);
      needDose(doses(D, a.cell_line, a.drug), "rtca", a.cell_line, a.drug, a.dose_uM);
      const r = D.rtca[a.cell_line][a.drug], s = r.series[dk(a.dose_uM)], c = r.series["0"];
      const hs = a.hours_after_treatment ? [+a.hours_after_treatment] : [24, 48, 72];
      const vals = hs.map(h => {
        const t = r.treat + h, x = interp(s, t), y = interp(c, t);
        return { hours_after_treatment: h, percent_of_control: x == null || y == null || y <= 0 ? null : +(x / y * 100).toFixed(1), note: x == null ? `recording ends at ${s.tmax} h after seeding` : undefined };
      });
      return { cell_line: a.cell_line, drug: a.drug, dose_uM: +a.dose_uM, drug_added_h: r.treat, values: vals, unit: "% of same-plate control", source: `Supplementary Fig ${P.cellLines[a.cell_line].rtcaFigure}`, kind: "derived" };
    }
  },
  {
    name: "get_flow_cytometry",
    description: "Annexin V / PI flow cytometry: % viable, early apoptosis, late apoptosis and necrosis at 24 and 72 h after treatment, with the untreated control. Observed data." + RULES,
    inputSchema: obj({ cell_line: lineP, drug: drugP, dose_uM: doseP, time_h: { type: "number", enum: [24, 72] } }, ["cell_line", "drug", "dose_uM"]),
    run: async a => {
      const { paper: P, data: D } = await loadPaper(a.paper);
      checkDrug(P, a.cell_line, a.drug);
      needDose(doses(D, a.cell_line, a.drug), "flow", a.cell_line, a.drug, a.dose_uM);
      const f = D.flow[a.cell_line][a.drug][dk(a.dose_uM)], c = D.flow[a.cell_line].Control;
      const ts = a.time_h ? [String(a.time_h)] : ["24", "72"];
      const named = v => Object.fromEntries(STATES.map((k, i) => [k, v[i]]));
      return {
        cell_line: a.cell_line, drug: a.drug, dose_uM: +a.dose_uM, unit: "% of cells",
        treated: Object.fromEntries(ts.map(t => [t + "h", named(f[t])])),
        untreated: Object.fromEntries(ts.map(t => [t + "h", named(c[t])])),
        gates: "viable AnnV−PI−, early AnnV+PI−, late AnnV+PI+, necrosis AnnV−PI+",
        source: `Supplementary Fig ${P.cellLines[a.cell_line].flowFigure}`, kind: "observed"
      };
    }
  },
  {
    name: "get_gene_expression",
    description: "qPCR fold change vs untreated cells for Bcl-2, Bax, caspase 3, caspase 9 and Fas at 24 and 72 h. Observed data; pathway reading is the authors' interpretation." + RULES,
    inputSchema: obj({ cell_line: lineP, drug: drugP, dose_uM: doseP, time_h: { type: "number", enum: [24, 72] } }, ["cell_line", "drug", "dose_uM"]),
    run: async a => {
      const { paper: P, data: D } = await loadPaper(a.paper);
      checkDrug(P, a.cell_line, a.drug);
      needDose(doses(D, a.cell_line, a.drug), "qpcr", a.cell_line, a.drug, a.dose_uM);
      const q = D.qpcr[a.cell_line][a.drug][dk(a.dose_uM)];
      const idx = a.time_h ? [a.time_h === 24 ? 0 : 1] : [0, 1];
      const genes = P.genes.map(g => ({ gene: g.name, role: g.role, ...Object.fromEntries(idx.map(i => [(i ? 72 : 24) + "h", q[g.key][i]])) }));
      return { cell_line: a.cell_line, drug: a.drug, dose_uM: +a.dose_uM, unit: "fold change vs untreated (2^−ΔΔCt)", genes, source: "Supplementary Fig S9", kind: "observed", authors_interpretation: P.quotes?.qpcr?.text };
    }
  },
  {
    name: "get_model_parameters",
    description: "Fitted parameters s1–s4 of the growth–death model for one condition and for the untreated control, from the RTCA-only fit and from the joint RTCA + flow fit, with fit errors and Q, Q1. Derived values." + RULES,
    inputSchema: obj({ cell_line: lineP, drug: drugP, dose_uM: doseP }, ["cell_line", "drug", "dose_uM"]),
    run: async a => {
      const { paper: P, data: D } = await loadPaper(a.paper);
      checkDrug(P, a.cell_line, a.drug);
      needDose(doses(D, a.cell_line, a.drug), "params", a.cell_line, a.drug, a.dose_uM);
      const x = D.params[a.cell_line][`${a.drug} ${dk(a.dose_uM)}`], c = D.params[a.cell_line].Control;
      const named = v => v && { s1: v[0], s2: v[1], s3: v[2], s4: v[3] };
      const pct = v => v && Object.fromEntries(["s1", "s2", "s3", "s4"].map((k, i) => [k, +(v[i] / c.rtca[i] * 100).toFixed(1)]));
      const tables = a.cell_line === "MDA-MB-231" ? "modeller's workbook (paper shows relative values in Figs 2–3)" : "Supplementary Tables S1–S4";
      return {
        cell_line: a.cell_line, drug: a.drug, dose_uM: +a.dose_uM,
        rtca_fit: { values: named(x.rtca), percent_of_control: pct(x.rtca), fit_error: x.err },
        rtca_at_flow_timepoints_fit: x.rtcaB ? { values: named(x.rtcaB), fit_error: x.errB } : undefined,
        rtca_plus_flow_fit: x.joint ? { values: named(x.joint), percent_of_control: pct(x.joint), fit_error: x.errJ } : undefined,
        control: named(c.rtca), Q_Q1: D.qq1?.[a.cell_line],
        equation: P.methods.find(m => m.id === "m-model")?.equations,
        source: tables, kind: "derived"
      };
    }
  },
  {
    name: "get_sensitivity_analysis",
    description: "Sensitivity of predicted viability to each model parameter (s1–s4, Q, Q1) varied from 25% to 175% of its fitted value, at 24 or 72 h. HCT-116 control. Derived values.",
    inputSchema: obj({ time_h: { type: "number", enum: [24, 72] } }),
    run: async a => {
      const { data: D } = await loadPaper(a.paper);
      const S = D.sens && Object.values(D.sens)[0];
      if (!S) throw new UserError("No sensitivity analysis for this paper.");
      const t = String(a.time_h || 72);
      return { cell_line: Object.keys(D.sens)[0], time_h: +t, parameter_percent: S.x, viability_percent_of_baseline: Object.fromEntries(Object.entries(S.par).map(([k, v]) => [k, v[t]])), fitted_values: Object.fromEntries(Object.entries(S.par).map(([k, v]) => [k, v.base])), source: "modeller's workbook; paper Fig 1 shows the same analysis for MDA-MB-231", kind: "derived" };
    }
  },
  {
    name: "compare_conditions",
    description: "Side-by-side table of one measure for up to 8 conditions. measure: viability_percent (RTCA % of control at 24/48/72 h), flow (cell death states at 72 h), genes (fold change at 24 h), params (s1–s4, RTCA fit)." + RULES,
    inputSchema: obj({
      conditions: { type: "array", maxItems: 8, items: { type: "object", properties: { cell_line: lineP, drug: drugP, dose_uM: doseP }, required: ["cell_line", "drug", "dose_uM"] } },
      measure: { type: "string", enum: ["viability_percent", "flow", "genes", "params"] }
    }, ["conditions", "measure"]),
    run: async a => {
      const tool = { viability_percent: "get_viability_percent", flow: "get_flow_cytometry", genes: "get_gene_expression", params: "get_model_parameters" }[a.measure];
      const extra = { flow: { time_h: 72 }, genes: { time_h: 24 } }[a.measure] || {};
      const rows = [];
      for (const c of a.conditions.slice(0, 8)) {
        try { rows.push({ ...c, result: await TOOLS.find(t => t.name === tool).run({ paper: a.paper, ...c, ...extra }) }); }
        catch (e) { rows.push({ ...c, error: e.message }); }
      }
      return { measure: a.measure, rows };
    }
  },
  {
    name: "get_methods",
    description: "Methods text of the paper, optionally one section by id (see get_paper_overview for ids). Includes equations and notes on how the page processes the data.",
    inputSchema: obj({ section_id: { type: "string" } }),
    run: async a => {
      const { paper: P } = await loadPaper(a.paper);
      const refs = Object.fromEntries(P.references.map(r => [r.n, `${r.authors}. ${r.title}. ${r.journal} ${r.year}. doi:${r.doi}`]));
      const ms = a.section_id ? P.methods.filter(m => m.id === a.section_id) : P.methods;
      if (!ms.length) throw new UserError(`Unknown section. Available: ${P.methods.map(m => m.id).join(", ")}`);
      return { methods: ms, references: refs };
    }
  },
  {
    name: "get_quote",
    description: "Verbatim sentences from the published article (CC BY 4.0) on a topic: rtca, flow, qpcr or model. Use to report what the authors themselves wrote.",
    inputSchema: obj({ topic: { type: "string", enum: ["rtca", "flow", "qpcr", "model"] } }, ["topic"]),
    run: async a => {
      const { paper: P } = await loadPaper(a.paper);
      const q = P.quotes[a.topic];
      if (!q) throw new UserError(`No quotes for "${a.topic}". Available: ${Object.keys(P.quotes).join(", ")}`);
      return { topic: a.topic, section: q.source, verbatim: q.text, citation: citation(P) };
    }
  }
];

/* ------------------------------------------------------------ resources */

async function resourceList() {
  const papers = await listPapers();
  return papers.flatMap(p => [
    { uri: `paper://${p.slug}/overview`, name: `${p.short} — text (paper.json)`, mimeType: "application/json", description: "Metadata, question, methods, limitations, quotes, references, provenance" },
    { uri: `paper://${p.slug}/data`, name: `${p.short} — data (data.json)`, mimeType: "application/json", description: "All numbers shown on the page" },
    { uri: `paper://${p.slug}/citation`, name: `${p.short} — citation`, mimeType: "text/plain" }
  ]);
}
async function resourceRead(uri) {
  const m = /^paper:\/\/([^/]+)\/(overview|data|citation)$/.exec(uri);
  if (!m) throw new UserError(`Unknown resource ${uri}`);
  const { paper, data } = await loadPaper(m[1]);
  const text = m[2] === "overview" ? JSON.stringify(paper) : m[2] === "data" ? JSON.stringify(data) : citation(paper);
  return [{ uri, mimeType: m[2] === "citation" ? "text/plain" : "application/json", text }];
}

/* -------------------------------------------------------------- prompts */

const PROMPTS = [
  { name: "explore_condition", description: "Walk through one condition: viability, cell death, genes, model.",
    arguments: [{ name: "cell_line", required: true }, { name: "drug", required: true }],
    text: a => `Using the living-papers tools, walk me through ${a.drug} on ${a.cell_line}. First call list_conditions for this pair. Then, for each available dose, report: impedance as % of control at 24/48/72 h (get_viability_percent), cell death states at 72 h (get_flow_cytometry), apoptosis genes at 24 h (get_gene_expression) and fitted parameters (get_model_parameters). Keep observed data, derived values and the authors' interpretation separate, and cite the figure or table for every number.` },
  { name: "compare_cancer_vs_fibroblast", description: "Same drug on a cancer line and on MRC-5 fibroblasts, all assays.",
    arguments: [{ name: "drug", required: true }],
    text: a => `Using the living-papers tools, compare ${a.drug} on its cancer cell line and on MRC-5 fibroblasts. Use list_conditions to find doses present in both, then compare_conditions for viability_percent, flow and genes. Present one table per measure with sources. Do not extrapolate to doses that were not tested.` },
  { name: "summarize_paper", description: "Short, sourced summary of the paper for a newcomer.",
    arguments: [],
    text: () => `Using get_paper_overview and get_methods from the living-papers tools, write a 200-word summary of the paper: question, design, main finding as reported by the authors, and limitations. Then give the page URL and the citation.` }
];

/* ------------------------------------------------------------- JSON-RPC */

const ok = (id, result) => ({ jsonrpc: "2.0", id, result });
const err = (id, code, message) => ({ jsonrpc: "2.0", id, error: { code, message } });

async function handle(msg) {
  const { id, method, params = {} } = msg;
  if (id === undefined || id === null) return null; // notification
  switch (method) {
    case "initialize": {
      const v = PROTOCOLS.includes(params.protocolVersion) ? params.protocolVersion : PROTOCOLS[0];
      return ok(id, {
        protocolVersion: v, serverInfo: SERVER,
        capabilities: { tools: { listChanged: false }, resources: { listChanged: false }, prompts: { listChanged: false } },
        instructions: "Read-only access to published papers rebuilt as structured data (Living Papers, Biology 2.0). Start with list_papers or get_paper_overview, then list_conditions. Every result carries its source figure/table. Distinguish observed data, derived values and the authors' interpretation, and never estimate values for untested doses or drugs."
      });
    }
    case "ping": return ok(id, {});
    case "tools/list": return ok(id, { tools: TOOLS.map(({ name, description, inputSchema }) => ({ name, description, inputSchema, annotations: { readOnlyHint: true, openWorldHint: false } })) });
    case "tools/call": {
      const t = TOOLS.find(t => t.name === params.name);
      if (!t) return err(id, -32602, `Unknown tool ${params.name}`);
      try {
        const res = await t.run(params.arguments || {});
        return ok(id, { content: [{ type: "text", text: JSON.stringify(res, null, 1) }], structuredContent: res, isError: false });
      } catch (e) {
        return ok(id, { content: [{ type: "text", text: e.message }], isError: true });
      }
    }
    case "resources/list": return ok(id, { resources: await resourceList() });
    case "resources/templates/list": return ok(id, { resourceTemplates: [] });
    case "resources/read":
      try { return ok(id, { contents: await resourceRead(params.uri) }); }
      catch (e) { return err(id, -32002, e.message); }
    case "prompts/list": return ok(id, { prompts: PROMPTS.map(({ name, description, arguments: args }) => ({ name, description, arguments: args })) });
    case "prompts/get": {
      const p = PROMPTS.find(p => p.name === params.name);
      if (!p) return err(id, -32602, `Unknown prompt ${params.name}`);
      return ok(id, { description: p.description, messages: [{ role: "user", content: { type: "text", text: p.text(params.arguments || {}) } }] });
    }
    default: return err(id, -32601, `Method not found: ${method}`);
  }
}

/* ---------------------------------------------------------------- HTTP */

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS, DELETE",
  "Access-Control-Allow-Headers": "Content-Type, Accept, Mcp-Session-Id, Mcp-Protocol-Version, Authorization",
  "Access-Control-Expose-Headers": "Mcp-Session-Id"
};
const json = (body, status = 200) => new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json", ...CORS } });

export default {
  async fetch(request) {
    const url = new URL(request.url);
    if (request.method === "OPTIONS") return new Response(null, { status: 204, headers: CORS });

    if (url.pathname === "/" && request.method === "GET")
      return new Response(`Living Papers MCP server (read-only).\nConnect your AI agent to ${url.origin}/mcp\nPages: ${BASE}\n`, { headers: { "Content-Type": "text/plain; charset=utf-8", ...CORS } });

    if (url.pathname !== "/mcp") return new Response("Not found", { status: 404, headers: CORS });
    if (request.method === "GET") return new Response("Use POST for MCP requests.", { status: 405, headers: { Allow: "POST", ...CORS } });
    if (request.method === "DELETE") return new Response(null, { status: 204, headers: CORS });
    if (request.method !== "POST") return new Response("Method not allowed", { status: 405, headers: CORS });

    let body;
    try { body = await request.json(); } catch { return json(err(null, -32700, "Parse error"), 400); }
    if (Array.isArray(body)) {
      const out = (await Promise.all(body.map(handle))).filter(Boolean);
      return out.length ? json(out) : new Response(null, { status: 202, headers: CORS });
    }
    const res = await handle(body);
    return res ? json(res) : new Response(null, { status: 202, headers: CORS });
  }
};
