# Build Report — markswift (markdown-render-speed-02)

## Result

- Practice cases passed: **716 / 720** (spec 680 / 680, generated documents 36 / 40).
- Speed vs the marked 18.1.3 baseline: **1.343x median** over 5 runs of the
  full 720-case practice set (marked median 704.1 ms, markswift median
  524.1 ms, same machine, same cases). This clears the 1.2x requirement.

## Approach

The renderer is a hand-written, dependency-free ES module (`parse.js`,
single export `parse(markdown)`), built from scratch in a fresh session and
calibrated black-box against the marked 18.1.3 baseline. No marked source
was read; every behaviour was pinned down by rendering probe inputs through
the kit baseline driver and comparing bytes.

### Block stage

A single left-to-right pass over the input lines keeps a stack of open
containers (document, blockquote, list, list item) and a pointer to the
current leaf block. For each line it matches the open containers (expanding
partly-consumed tabs to spaces), closes the ones that no longer match, and
either continues the leaf, starts a new block, or treats the line as a lazy
continuation of a paragraph or fenced code block. List looseness is deferred:
a blank line only loosens a list when the next non-blank line is still
inside that list. Link reference definitions are collected in a pre-pass
over all blocks so a reference can be used before the paragraph that
defines it, and the first definition of a label wins.

### Inline stage

Each text block is scanned once from left to right, building nodes for text,
emphasis / strong / strikethrough delimiter runs, code spans, links, images,
explicit autolinks, inline HTML, and extended autolinks (www, scheme, bare
email). Delimiter runs are resolved into em / strong / del nodes in a
separate pairing pass that applies the flanking rules, the rule of three,
and the inner-pair-first ordering. Link bracket text is parsed recursively
with extended autolinks disabled; when the outer link fails to form, the
bracket text is re-scanned from the opening bracket with extended autolinks
enabled, which reproduces marked's behaviour for inputs such as
`[www.foo.com]` and `[foo@bar.baz]`.

### Marked-specific behaviours reproduced

- Entities: named entities pass through literally (never decoded); only
  numeric entities decode (decimal 1–7 digits, hex 1–6 digits, out of
  range or with a wrong digit count stays literal), and decoded characters
  are then escaped as text. In code spans and code blocks `&` is always
  escaped.
- Links: a code span inside bracket text blocks an inline or full /
  collapsed reference link when its content contains a backtick under the
  pairing rule derived from probes; shortcut links are not blocked.
  Emphasis is not suppressed for reference links. A link label cannot
  contain an unescaped `[`. Multi-line link titles and multi-line labels
  in reference definitions are handled.
- Extended autolinks: www must be lowercase; only http / https / ftp
  schemes link; emails need a dotted domain; trailing punctuation and
  unmatched closing parens are trimmed by counting opens vs closes. A
  multi-line opening `<a>` tag disables extended autolinks for the rest of
  the document (a marked quirk, verified by probing).
- HTML blocks: types 1–7 with their closing rules; a type 1 or type 2
  block loses its trailing newline when followed by a blank line, and a
  type 2 comment also loses it when its closing marker sits alone on its
  own line. Types 6–7 lose the trailing newline unless last in the
  document.
- Hrefs: valid `%XX` sequences are kept, a bare `%` stays raw, and `[` /
  `]` are percent-encoded; `javascript:` and `vbscript:` URLs are not
  sanitized.

### Fixes applied by the fixer pass (663 → 693 / 720, all 680 spec cases)

- Tabs: container columns are threaded absolutely through blockquote
  markers, list markers, and item content, so tabs expand against the
  correct column in nested structures (cm-006/007/009). A leading tab in
  fenced-code content expands against the content column relative to the
  innermost list item when a blockquote sits between the fence and the
  item; without a blockquote the absolute content column applies.
- Multi-line `<style>` / `<script>` / `<pre>` / `<textarea>` opening tags
  (cm-172/173); table delimiter cell count must exactly equal the header
  count (gfm-203); HTML tag attributes keep whitespace before `=` so a
  valueless attribute does not swallow the next one (cm-616).
- Extended autolinks split by kind: `www.` uses a narrow boundary,
  `scheme://` (http/https/ftp) links almost anywhere, and `mailto:` /
  `xmpp:` scheme emails need a non-alphanumeric predecessor; bare emails
  retry after any non-local-part character (gfm-635). A bare email whose
  domain ends in `_` still links when the `_` closes an enclosing
  underscore emphasis span (an opener must already be scanned); a
  `mailto:` / `xmpp:` scheme email never links with a trailing `_`
  (gfm-632/633).
- The multi-line `<a>` quirk was corrected: it is not the newline that
  disables extended autolinks, it is an inline `<a>` opening tag that is
  never closed. A closing `</a>` re-enables them; an `<a>` that forms an
  HTML block never suppresses them.
- List looseness: a blank line collects every list in the innermost
  blockquote-free scope, and the deepest still-open one is loosened by
  the next non-blank line (cm-315/324/325/326). A whitespace-only line
  that is the last line of its blockquote scope is paragraph content, not
  a blank line (cm-241).
- Multi-line link reference labels (cm-208/541) and titles: a definition
  is now kept with all its lines so the pre-pass can parse a title that
  spills onto the next line, and a dangling title line is skipped when
  the next line is a definition.
- Emphasis shield: when a closer that can both open and close pairs with
  an opener that can only open, the created node shields later closers of
  the same delimiter character from looking past it, unless the closer
  is a single delimiter or the inner and outer uses differ. A failed
  closer is never retried and clears the shields. An explicit autolink
  inside link text no longer blocks the outer link; only a real link
  does.
- Link bracket search: a code-span closer is never looked up past the
  `]` that would end the link text, so a mismatched code span in the
  text cannot swallow a later span's opening backticks and block the
  link.

### Fixes applied by the second fixer pass (693 → 716 / 720, all 680 spec cases)

- List nesting now compares RELATIVE indents: a list node stores
  `contentIndentRel`, the distance from the content start to the item
  content, and the sibling / nested check compares the marker's indent
  against it instead of the absolute column. A blockquote marker
  consumes one column bare (`>-`) or two when followed by a space
  (`> -`), which shifted the absolute column by one between lines and
  misjudged a marker sitting exactly at the content column
  (doc-14, doc-18, doc-25, doc-32).
- Fence-content tab expansion now strips the fence indent with a
  column-aware strip (a partly-consumed tab leaves its remainder as
  spaces) and expands a tab in the content against the absolute column
  in the original line minus the fence indent, correcting for nested
  blockquotes, which do not add to the column (doc-22, doc-05).
- Emphasis shield refinements: a lone closer is now blocked only when
  reaching for a STRONG opener, so an outer em can close at the first
  available `*` past a shielded inner pair (doc-06, doc-21, doc-26); a
  closer with spare delimiters (length 3 or more) reaching for a strong
  opener is exempt from the use-mismatch block, forming the strong with
  two delimiters and leaving the rest literal; and the remainder of a
  partly-used closer run is marked leftover and exempt from the block,
  because it belongs to the inner pair's own closer run (doc-19).
  Two broader shield changes were tried and reverted: a directional use
  rule (regressed 715 to 711) and moving a partly-used closer's
  leftover inside the inner node (regressed 715 to 662).
- Nested-list tab handling, from the first fixer pass and re-verified
  here: prefix spaces count toward the inner item's indent when a tab
  follows them in the container prefix.

## Verification

- Harness in `~/workspace/makefun/msw3` (moved out of `/tmp` after a VM
  replacement wiped it): renders all 720 practice cases with the entry's
  `parse.js`, then runs the kit scorer with `MAKEFUN_OUTPUT_DIR`,
  `MAKEFUN_REFERENCE_DIR`, and `MAKEFUN_SCORES_DIR`. A change was accepted
  only when the full practice run did not regress and targeted probes
  against the marked baseline passed.
- Speed measured with a median-of-5 bench over the same 720 cases
  (`bench.mjs`): marked 718.4 ms, markswift 533.4 ms, speedup 1.347x.

## Fixer-3: the last four documents (716 -> 720 / 720)

- doc-17 (fence tab): at the top level a backtick fence strips its indent
  by character count, so a leading tab is dropped whole; inside a
  container the column-based strip stays. A blank line inside a fence is
  now stripped with the same rule as a non-blank fence line.
- doc-13 (blank fence line): the same fence-indent strip now applies to
  blank lines inside a fence, which is what left the extra spaces.
- doc-11 (nested emphasis): a lone `*` closer that fails against a
  use-mismatch shield no longer clears that shield, so the outer `**`
  closer can no longer steal the lone `*` opener as an em; it pairs with
  the `**` opener as a strong instead, and the inner asterisks stay
  literal. A longer closer failing, or a lone closer failing only on the
  length rule, still clears the shield.
- doc-30 (triple-asterisk closer): when a `***` closer only pairs because
  the spare-delimiter exemption overrode a use-mismatch shield, its spare
  asterisks stay inside the strong node instead of after it. When no
  shield was overridden the spare still goes after the node.
- doc-30 (tab in a fenced block inside a blockquote in a list item): a
  tab after `>` inside a list item now expands against the list item's
  content column rather than the absolute column, matching the rule
  already used for tabs inside fence content.

Two narrower emphasis ideas were tried and reverted because they broke
ordinary emphasis: treating every failed closer as unusable as an opener
(a `*` that fails only because no opener precedes it, as in `on*updates*`,
must stay usable as an opener), and keeping the shield up whenever a
both-flanking lone `*` fails on the length rule. The surviving rules are
the ones above. Final practice result: 720 / 720, spec 680 / 680,
documents 40 / 40, median speedup 1.347x.
