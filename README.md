# Living Papers

Published research rebuilt from its own data: an interactive page for readers and a Model Context Protocol (MCP) server for AI agents, both reading the same files.

Marko Živanović · Biology 2.0 · https://papers.biology2.net

## Papers

| Paper | Live page | What is inside |
|---|---|---|
| Živanović M. et al. *Pharmaceutics* 2023, 15, 1628 · [doi:10.3390/pharmaceutics15061628](https://doi.org/10.3390/pharmaceutics15061628) | [/pharmaceutics-2023/](https://papers.biology2.net/pharmaceutics-2023/) | Real-time impedance (RTCA) for 3 cell lines and 8 drugs, flow cytometry, qPCR, a growth–death model, 47 references |
| Demetriades M., Zivanovic M. et al. *Pharmaceutics* 2022, 14, 749 · [doi:10.3390/pharmaceutics14040749](https://doi.org/10.3390/pharmaceutics14040749) | [/pharmaceutics-2022/](https://papers.biology2.net/pharmaceutics-2022/) | MTT for 2 cell lines and 8 drugs, all six wells per dose, IC50, agent-based model, 25 references |

## What a living paper does

- **Explore** every result by cell line, drug and dose instead of scrolling figures. Each view names the figure or table it replaces.
- **Compare** any conditions side by side.
- **Citation as evidence.** When one living paper cites another, the citation opens the cited data. Reference [31] in the 2023 paper opens the 2022 MTT values next to the 2023 impedance values for the same drug and dose.
- **Your data.** Drop an xCELLigence export (.xls/.xlsx) or a CSV on the 2023 page and compare your curves with the published ones. The file is read in the browser and never uploaded.
- **Ask your AI.** The MCP server in [`mcp/`](mcp/) serves the same data to any agent. Your agent, your tokens: the pages make no AI calls.

## Structure

```
index.html            landing page
papers.json           list of papers (read by the MCP server)
lib/                  SheetJS, loaded only when a visitor drops a spreadsheet
mcp/worker.js         MCP server (Cloudflare Worker)
<paper-slug>/
  index.html          the page (HTML, CSS and JS in one file)
  paper.json          all text: metadata, question, methods, limitations, quotes, references, provenance
  data.json           all numbers
  og.png              link preview image
```

The page renders only from `paper.json` and `data.json`. Every number states its source (figure, table or the authors' raw workbook) and whether it is observed or derived.

## Adding a paper

1. Create a folder named after the paper (for example `journal-year`).
2. Put the paper's numbers in `data.json` and its text in `paper.json` (schema `living-paper/1.0`).
3. Add the page `index.html` and a card on the landing page.
4. Add the paper to `papers.json` once the MCP server has tools for its data type.

Only open-access papers (CC BY) are included, and results are shown as published.

## License

Code: MIT, see [LICENSE](LICENSE). Paper content: CC BY 4.0 as published by the authors; cite the original article. SheetJS: Apache 2.0.
