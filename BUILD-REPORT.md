# markswift — Build Report

Entry for the make.fun **markdown-render-speed-02** competition ($250).
Repository: `ZulkifliMohamad/markswift`. Rebuilt from scratch in a fresh
session under sealed recording `01a1e401-a626-748d-82ca-f3527bc8143e`.

## What was built

- `parse.js` — a dependency-free ES module. `parse(markdown)` returns the
  HTML that marked 18.1.3 renders with its default options (gfm on, breaks
  off, pedantic off). Hand-rolled CommonMark 0.31.2 + GFM renderer: no
  vendored marked, no dependencies, no network access. Covers ATX and
  setext headings, paragraphs, emphasis, strong emphasis, strikethrough,
  code spans, links (inline, reference, image, autolink, extended
  autolink), entities, backslash escapes, inline HTML, hard breaks, nested
  bullet, ordered and task lists, tables with alignment, fenced and
  indented code, block quotes, raw HTML blocks, thematic breaks, link
  reference definitions, and CRLF, tab, and no-final-newline handling.
- `main.ts` — the harness driver. Reads every case from
  `$MAKEFUN_INPUT_DIR/cases.json` (default `/input`), renders each with
  `parse`, and writes the HTML strings in order as a JSON array to
  `$MAKEFUN_OUTPUT_DIR/html.json` (default `/output`). Node 22+.
- `README.md` — entry description, run instructions, and timing summary.
- `LICENSE` (MIT) and `.makefun/owner.json` are the starter files and were
  not modified.

## Verification

### Practice set: 720 / 720 cases byte-identical

Compared against
`practice/reference/expected.json` (marked 18.1.3 output) on all 720
practice cases (680 CommonMark/GFM spec examples plus 40 generated
documents, 2,862,813 bytes of Markdown). All 680 spec examples pass
(cm-001–cm-652, gfm-198–gfm-657) and all 40 generated documents pass.
The kit scorer (`grade-local --driver process`) reports
`{"cases_passed":720,"cases_total":720,"passed":1}` and the L1 regrade
reproduces the entry byte for byte (deterministic: the two executions'
outputs match exactly).

### End-to-end driver

`node main.ts` on the practice input (via `MAKEFUN_INPUT_DIR` /
`MAKEFUN_OUTPUT_DIR`) writes a 720-string `html.json`; all 720 strings
match `expected.json` exactly (0 mismatches).

### Timing (interleaved rounds, 720-case practice set)

Median CPU time over 15 interleaved rounds on the build machine
(Node 24.22.1):

| renderer | CPU (median) | CPU (mean) | wall (median) |
| --- | --- | --- | --- |
| markswift | 558 ms | 637 ms | 575 ms |
| marked 18.1.3 | 730 ms | 776 ms | 744 ms |

**1.31x median CPU speedup** (1.22x mean). Ranges are clearly separated
(markswift 526–655 ms steady-state after a first-round JIT warmup of
1655 ms, marked 701–884 ms). Repeated runs confirm the ratio (1.08x
before a hot-path trim optimization, 1.30x–1.35x after it).

### Kit scorer

`grade-local --driver process` was run against the entry. The scorer
compares `/output/html.json` with the reference exactly and reports
`{"cases_passed":720,"cases_total":720,"passed":1}` with the L1 regrade
reproducing the entry byte for byte. (The local grade shows
`prize no` only because no transcripts are attached to a `--worktree`
grade; the sealed recording's transcripts are submitted with the entry.)

## Notable behaviors matched to marked

- Link-label code spans follow marked's label regex: the closer is the
  next backtick run of any length on the same line, a ` `` ` run
  immediately before `]` is literal, and a dangling run after a consumed
  span invalidates the label (so the link does not form).
- A failed inline-link attempt renders its label literally: code spans
  still render, but `_..._`/`*...*` inside do not form emphasis.
- Mismatched-label link suppression: after a link whose label holds a
  backtick run of length >= 2 closed by a run of a different length,
  with no same-length run later in the label, an emphasis span is
  suppressed when a code span follows it in the same inline run (the
  delimiters stay literal). Code spans inside a formed link's label
  count as following code spans. A label that does hold a same-length
  closer later (it renders a real `<code>` span) is not a trigger.
- Tilde fences keep their content verbatim (no indent strip); backtick
  fences strip up to the opening fence's indent, by whitespace character
  count for tabs.
- A persistent inline `<a>` tag suppresses bare URL/email autolinks until
  `</a>` (marked's `lexer.state.inLink`); `<...>` autolinks still nest.
- CRLF and lone-CR line endings are normalized to `\n`.
- Fuzz: 12,000 randomized cases (inline fragments, block fragments, and
  mutations of practice cases) against the vendored marked oracle showed
  zero differences in the first build; the rebuild was verified on the
  720-case practice set above.

## Files

- `parse.js` — renderer (dependency-free ES module)
- `main.ts` — harness driver
- `README.md` — entry description
- `BUILD-REPORT.md` — this report
