# Living Papers MCP server

A read-only [Model Context Protocol](https://modelcontextprotocol.io) server that gives AI agents the same data as the pages. It runs as a single Cloudflare Worker (`worker.js`, no dependencies, free tier).

- Endpoint: `https://living-papers-mcp.zivanovicmkg.workers.dev/mcp`
- Transport: Streamable HTTP, JSON responses, no sign-in, CORS open
- Source of truth: it fetches `papers.json` and each paper's `paper.json` / `data.json` from https://papers.biology2.net (5-minute cache), so updating the site updates the server.

## Tools
`list_papers`, `get_paper_overview`, `list_conditions`, `get_rtca_curve`, `get_viability_percent`, `get_flow_cytometry`, `get_gene_expression`, `get_model_parameters`, `get_sensitivity_analysis`, `compare_conditions`, `get_methods`, `get_quote`.
Every result carries its source figure or table and is marked `observed` or `derived`.

Also exposes resources (`paper://<slug>/overview | data | citation`) and prompts (`explore_condition`, `compare_cancer_vs_fibroblast`, `summarize_paper`).

Current tools are written for the RTCA / flow / qPCR schema of Pharmaceutics 2023. Pharmaceutics 2022 (MTT) is on the site but not yet served through MCP.

## Connect
Claude: Settings → Connectors → Add custom connector → paste the endpoint → No sign-in.
Any other MCP client: use the same URL.

## Deploy your own
Cloudflare dashboard → Workers → Create → paste `worker.js` → Deploy. Change `BASE` at the top to your own site.
