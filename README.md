# markswift

[![make.fun · markdown-render-speed-02](https://make.fun/badge/markdown-render-speed-02.svg)](https://make.fun/bounty/markdown-render-speed-02?utm_source=github&utm_medium=readme&utm_campaign=markdown-render-speed-02)
[![rank](https://make.fun/badge/markdown-render-speed-02/ZulkifliMohamad/markswift/rank.svg)](https://make.fun/bounty/markdown-render-speed-02/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=markdown-render-speed-02)
[![reward](https://make.fun/badge/markdown-render-speed-02/ZulkifliMohamad/markswift/reward.svg)](https://make.fun/bounty/markdown-render-speed-02?utm_source=github&utm_medium=readme&utm_campaign=markdown-render-speed-02)

A dependency-free, hand-written Markdown renderer that produces byte-identical
HTML to marked 18.1.3 (default options: GFM on, breaks off, pedantic off,
async off), and runs faster than marked itself.

## What it does

`parse.js` exports a single function, `parse(markdown)`, which returns the
HTML string marked would produce for the same input. It covers the full
CommonMark 0.31.2 spec plus the GFM 0.29 extensions: ATX and setext headings,
paragraphs, emphasis and strong emphasis, strikethrough, code spans, links
(inline, reference, collapsed, shortcut, image, explicit and extended
autolinks), entities, backslash escapes, inline HTML, hard breaks, nested
bullet / ordered / task lists, tables with alignment, fenced and indented
code blocks, block quotes, raw HTML blocks, thematic breaks, and link
reference definitions. It also handles CRLF line endings, tabs, and inputs
without a final newline.

`main.ts` is the competition driver: it reads `/input/cases.json`, renders
each case alone with `parse()`, and writes `/output/html.json`.

## Usage

```js
import { parse } from './parse.js';
console.log(parse('# Hello\n\nSome **bold** text.\n'));
```

## How it works

The parser runs in two stages. The block stage walks the input lines once,
maintaining a stack of open containers (document, blockquote, list, list
item) and a pointer to the current leaf block, deciding for each line whether
it continues the open containers, starts a new block, or lazily continues a
paragraph or fenced code block. The inline stage scans each text block once
from left to right, building nodes for text, emphasis, links, code spans,
autolinks, raw HTML, and strikethrough, then resolves delimiter runs into
em / strong / del nodes in a separate pairing pass.

Where marked departs from the CommonMark spec, marked wins: the renderer was
calibrated against the marked 18.1.3 baseline as a black box, case by case,
including its entity handling (named entities pass through literally, only
numeric entities decode), its link-text model (bracket text is re-scanned
when an outer link fails to form), its blocking-code-span rule for links,
and its extended-autolink trimming rules.

## Files

- `parse.js` — the renderer (dependency-free ES module).
- `main.ts` — the competition driver (`node /bot/main.ts`).
- `DESIGN-NOTES.md` — design notes for the parser.
- `BUILD-REPORT.md` — build report for this entry.
- `LICENSE` — license.

## License

See `LICENSE`.
