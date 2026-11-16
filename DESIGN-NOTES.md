# Design Notes — markswift

## Big picture

`parse(markdown)` returns exactly the HTML marked 18.1.3 produces for the
same input (default options). The implementation is two stages: a block
parser that turns lines into a block tree, then an inline parser that turns
each text block's lines into HTML. Where marked departs from the CommonMark
spec, marked wins, so the design notes describe marked's behaviour, not the
spec's.

## Block parsing

One left-to-right pass over the lines. A stack holds the open containers:
the document root, blockquotes, lists, and list items. A pointer tracks the
current leaf block (paragraph, heading, code block, HTML block, table, hr).

For each line:

1. Match the open containers outside-in. A blockquote consumes `>` plus one
   optional space. A list item consumes its content indent (a tab advances
   to the next multiple of 4; a partly-consumed tab is expanded to spaces).
   A list itself consumes nothing.
2. Close every container that did not match, unless the line is a lazy
   continuation of the open paragraph or fenced code block.
3. If the current leaf is a fenced code block, the line is either its
   closing fence or more content. A fence inside a list item also accepts
   lazy content lines that do not match the enclosing item (list items
   only, never blockquotes).
4. Otherwise decide whether the line starts a new block (ATX heading,
   fenced code, HTML block, thematic break, list item, indented code,
   table, setext underline) or continues / closes the leaf.

Paragraphs end at a blank line or when an interrupting block starts. An
ordered list interrupts a paragraph only when it starts at 1, unless it
continues an open ordered list or begins nested inside a list item. An
empty list item cannot interrupt a paragraph unless it continues an open
list of the same kind. A setext underline converts a paragraph to a
heading, except when the paragraph holds only link reference definitions.

Whether a later list marker nests under an open list or starts a sibling
list is decided by RELATIVE indent: each list node stores
`contentIndentRel`, the distance from the content start to the item
content, and the marker's indent is compared against it. Absolute columns
are wrong here, because a blockquote marker consumes one column bare and
two when followed by a space, which shifts the content column by one
between lines.

List looseness is deferred: a blank line records the innermost list it
occurred in, and that list only becomes loose when the next non-blank line
is still inside it. An empty list item is closed by a blank line.

Link reference definitions are collected in a pre-pass over all blocks
before rendering, so a reference can be used before the paragraph that
defines it. The first definition of a label wins. A definition may span up
to three lines (label, destination, title); titles may themselves span
lines. A paragraph that starts with a definition keeps the definition
line, so the pre-pass sees the title when it spills onto the following
line instead of the definition being recorded title-less at the first
line.

Indented code needs four columns of indent and is not allowed inside a
paragraph; blank lines inside it are buffered and only join when a further
indented line follows. Fenced code (three or more backticks or tildes) strips
its own indent from content lines for backtick fences; tilde fences strip
nothing. A tab in fence content inside a container is expanded against
its absolute column in the original line, then the fence indent is
subtracted; the indent strip is column-aware, so a tab straddling the
indent boundary leaves its remainder as spaces. Nested blockquotes do not
add to the column: only the outermost quote's width is not counted. A
leading tab in fence content inside a container expands to spaces to the
next multiple of 4 from the content column; when a blockquote sits
between the fence and its list item, the column is measured relative
to that item's content column instead of absolutely. The same relative
rule applies to a tab directly after a blockquote marker inside a list
item: its width is measured from the item's content column, not from
the absolute column, because the marker itself consumes one column of
the tab. At the top level a backtick fence strips its indent by
character count (a leading tab is dropped whole); a blank line inside
a fence is stripped with the same rule as a non-blank fence line.

HTML blocks come in seven types: script / pre / style / textarea (end at
the matching close tag), comment, processing instruction, declaration,
CDATA (end at their closing marker), block-level tags, and lone tags alone
on a line (end at a blank line). Types 6–7 lose a trailing newline unless
last in the document; types 1–2 also lose it when followed by a blank line,
and a comment loses it when its closing marker sits alone on its own line.

Tables are a header row, a delimiter row (`:` marks alignment, edge pipes
optional), and body rows. Rows split on every unescaped pipe; backticks do
not protect pipes. A dash-only delimiter row is a setext underline, not a
table delimiter. A blank line ends a table, except a line of 0–3 spaces plus
exactly one tab, which is an empty table row.

## Inline parsing

Each text block is scanned once, left to right, building a list of parts:
plain text, code spans, emphasis / strong / strikethrough delimiter runs,
links, images, explicit autolinks, inline HTML tags, and extended
autolinks. Delimiter runs are resolved into em / strong / del nodes in a
separate pairing pass.

Flanking is decided with Unicode whitespace. `*` opens when left-flanking
and closes when right-flanking; `_` opens when left-flanking and not
right-flanking (or left-flanking and preceded by punctuation) and closes
symmetrically. Pairing scans closers in text order and takes the nearest
opener; delimiters strictly between a matched pair are discarded. The rule
of three applies (a pair whose length sum is a multiple of three is skipped
unless both are multiples of three, or one side cannot pair the other way).
A closer that fails to pair is never retried. When a closer that can both
open and close pairs with an opener that can only open, the created node
shields later closers of the same delimiter character from looking past
it, unless the closer is a single delimiter or the inner and outer uses
(emphasis vs strong) differ; a failed closer clears the shields, except
when the failing closer is a single delimiter blocked by a use-mismatch
shield — then the shield stays up, so a later double delimiter cannot
steal the lone opener as an em and must pair with the double opener as a
strong instead. In the
current form the shield blocks a lone closer only when it reaches for a
strong opener, so an outer em can close at the first available `*` past
a shielded inner pair. A closer with spare delimiters (length three or
more) reaching for a strong opener is exempt from the use-mismatch block,
forming the strong with two delimiters and leaving the rest literal; the
remainder of a partly-used closer run is likewise exempt, because it
belongs to the inner pair's own closer run. When a spare closer only
pairs because that exemption overrode a use-mismatch shield, its spare
delimiters stay inside the strong node; when no shield was overridden
they go after the node.
Strikethrough uses one or two tildes; a run of three or more forms none.
Nested emphasis inside a new node is resolved before the outer node is
built, with inner delimiters remapped to children.

Code spans use equal-length backtick runs, attempted only at the start of a
maximal run; content newlines become spaces, and one leading plus one
trailing space is stripped when the content starts and ends with a space
and is not all spaces. In code spans a backslash before a backtick is
literal.

Links: `[` text `]` plus an inline `(destination)` with an optional title,
a reference `[label]` / collapsed `[]` / shortcut, or nothing. The bracket
text is parsed recursively with extended autolinks disabled, so extended
autolinks inside a link stay plain text while explicit autolinks stay
nested links. If the outer link does not form, the recursive result is
discarded and the main scan continues after the literal `[`, re-scanning the
bracket text with extended autolinks enabled. A link does not form when its
bracket text contains a link node, or when it contains a blocking code span
(see below). A label cannot contain an unescaped `[`.

Finding the closing `]`: a backtick run of length n first looks for the
next run of exactly n; if none, the next run of any shorter length closes
it for link-end purposes; if no run follows at all, the `]` is swallowed
and no link forms. The closer search never runs past the `]` that would
end the link text. Backslash-escaped brackets and brackets inside HTML
tags or autolinks do not close. An explicit autolink inside link text
does not block the outer link; only a real link node does.

A blocking code span rejects an inline link or a full / collapsed
reference link (not a shortcut link). It is a code span inside the bracket
text whose content has exactly one inner backtick run, or two or more inner
runs that all pair greedily by equal length, and whose stripped content ends
with a backtick without starting with one, and which is not immediately
followed by `]`. For inline links the blocking code span also disables all
emphasis / strong delimiters inside the bracket text; for reference links
emphasis still forms.

Autolinks: explicit `<scheme:...>` or `<email>` (an email autolink must not
contain a backslash). Extended: `www.` must be lowercase; schemes are only
http / https / ftp (case-insensitive); bare emails need a dotted domain.
A URL candidate stops at whitespace, `<`, or `>`, and at `&` when what
follows looks like an entity. Trimming drops trailing unmatched `)` (count
opens vs closes), a trailing `;` ending an entity-like sequence, and
trailing punctuation `?!.,:;*_~`. A URL containing `](` is kept whole only
while every paren it opens is closed later in the URL. A trailing `_` or
`-` after an email prevents the link, unless the `_` closes an enclosing
underscore emphasis span (an opener must already have been scanned, and
the email may start right after that opener). A scheme email
(`mailto:` / `xmpp:`) never links with a trailing `_`. An inline `<a>`
opening tag that is never closed disables extended autolinks for the rest
of the document; a closing `</a>` re-enables them, and an `<a>` that
forms an HTML block never suppresses them.

Entities: named entities are never decoded — they pass through literally,
and the `&` is left unescaped when it matches `&\w+;`. Only numeric
entities decode (decimal 1–7 digits, hex 1–6 digits; out-of-range or
wrong-length stays literal). Decoded characters are then escaped as text.
In code spans and code blocks `&` is always escaped.

Rendering: text is escaped (`&` with the entity rule, `<`, `>`, `"` in
attributes, `'` in code and text). Hard breaks render as `<br>` and strip
the following line's leading whitespace. A heading renders its level plus
inline content. Lists render `<ul>` / `<ol start="N">` (the start attribute
only when it is not 1); a tight list renders paragraph children bare, a
loose list wraps them in `<p>`. A task checkbox renders immediately after
the opening `<p>` (or `<li>` when the item body does not start with a
paragraph). Tables render `<thead>` / `<tbody>` with `align` attributes
where set; there is no `<tbody>` when there are no body rows.

## Verification

Render the 720 practice cases, run the kit scorer, and compare bytes. A
change is accepted only when the full practice run does not regress and
targeted probes against the marked baseline pass. Speed is measured as the
median of five runs of the full 720-case set, mine vs the marked baseline.
Final result: 720 / 720 practice cases (spec 680 / 680, generated
documents 40 / 40), median speedup 1.347x (markswift 533.4 ms vs marked
718.4 ms over the full 720-case set).
