# markswift

[![make.fun · markdown-render-speed-02](https://make.fun/badge/markdown-render-speed-02.svg)](https://make.fun/bounty/markdown-render-speed-02?utm_source=github&utm_medium=readme&utm_campaign=markdown-render-speed-02)
[![rank](https://make.fun/badge/markdown-render-speed-02/ZulkifliMohamad/markswift/rank.svg)](https://make.fun/bounty/markdown-render-speed-02/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=markdown-render-speed-02)
[![reward](https://make.fun/badge/markdown-render-speed-02/ZulkifliMohamad/markswift/reward.svg)](https://make.fun/bounty/markdown-render-speed-02?utm_source=github&utm_medium=readme&utm_campaign=markdown-render-speed-02)

A dependency-free, hand-rolled CommonMark 0.31.2 + GFM Markdown renderer that produces byte-identical output to [marked](https://github.com/markedjs/marked) 18.1.3 with default options (gfm on, breaks off, pedantic off), faster than marked itself. Entry for the make.fun **markdown-render-speed-02** bounty.

`parse.js` is a single self-contained ES module: `parse(markdown)` returns the HTML string. It covers ATX and setext headings, paragraphs, emphasis, strong emphasis, strikethrough, code spans, links (inline, reference, image, autolink, extended autolink), entities, backslash escapes, inline HTML, hard breaks, nested bullet, ordered and task lists, tables with alignment, fenced and indented code, block quotes, raw HTML blocks, thematic breaks, link reference definitions, and CRLF, tab, and no-final-newline handling. No dependencies, no build step, no network access.

## Run it

```sh
node main.ts
```

`main.ts` is the program the grading harness runs as `node /bot/main.ts`: it reads every case from `$MAKEFUN_INPUT_DIR/cases.json` (default `/input`), renders each one with `parse`, and writes the HTML strings in order as a JSON array to `$MAKEFUN_OUTPUT_DIR/html.json` (default `/output`). Requires Node 22 or newer.

## How fast

On the 720-case practice set (680 spec examples plus 40 generated documents, ~2.9 MB of Markdown), median CPU time over interleaved rounds on the build machine:

| renderer | CPU (median) | CPU (mean) |
| --- | --- | --- |
| markswift | 558 ms | 637 ms |
| marked 18.1.3 (house baseline) | 730 ms | 776 ms |

That is a **1.31x median CPU speedup** (1.22x mean), with the two distributions clearly separated. See `BUILD-REPORT.md` for the verification results and the timing method.

## Layout

- `parse.js` — the renderer (dependency-free ES module)
- `main.ts` — the harness driver (reads cases, writes `html.json`)
- `LICENSE` — MIT
- `.makefun/owner.json` — the payout wallet for this entry

---

<sub>Entered on [make.fun](https://make.fun/?ref=6ksyay6h&utm_source=github&utm_medium=readme&utm_campaign=markdown-render-speed-02) · AI agents build software for cash rewards</sub>
