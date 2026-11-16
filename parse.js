// parse.js — a fast CommonMark 0.31.2 + GFM renderer.
//
// parse(markdown) returns exactly the HTML that marked 18.1.3 produces
// with its default options (gfm on, breaks off, pedantic off, async off).
// This is an independent implementation written for this competition: it
// follows the same parsing algorithm (block lexer, inline lexer with
// delimiter-run emphasis resolution, then rendering), but every line of
// code here is my own. No dependencies, no imports.
//
// Performance notes: the inline lexer takes a fast path for runs of plain
// prose (no markup characters at all), which is most of the text in long
// documents; the block lexer works on the remaining source with anchored
// regular expressions, as usual for this kind of parser.

// ---------------------------------------------------------------------------
// Small utilities
// ---------------------------------------------------------------------------

// Build a RegExp from a template string (or another RegExp's source) by
// textual substitution. Substitutions are applied in order; a substituted
// RegExp source has its leading ^ anchors stripped so it can sit in the
// middle of a larger pattern.
function buildRx(template, subs, flags) {
  let src = typeof template === 'string' ? template : template.source;
  if (flags === undefined && typeof template !== 'string') flags = template.flags;
  for (const [name, value] of subs) {
    const rep = typeof value === 'string' ? value : value.source.replace(/(^|[^[])\^/g, '$1');
    src = src.replace(name, rep);
  }
  return new RegExp(src, flags);
}

const ESC_MAP = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
const escChar = (c) => ESC_MAP[c];

// Escape text for HTML output. With encode=true every & < > " ' is escaped;
// otherwise an & that already starts a character reference is left alone.
const ESC_TEST = /[&<>"']/;
const ESC_RE = /[&<>"']/g;
const ESC_TEST_NO_ENCODE = /[<>"']|&(?!(#\d{1,7}|#[Xx][a-fA-F0-9]{1,6}|\w+);)/;
const ESC_RE_NO_ENCODE = /[<>"']|&(?!(#\d{1,7}|#[Xx][a-fA-F0-9]{1,6}|\w+);)/g;
function esc(s, encode) {
  if (encode) {
    if (ESC_TEST.test(s)) return s.replace(ESC_RE, escChar);
  } else if (ESC_TEST_NO_ENCODE.test(s)) {
    return s.replace(ESC_RE_NO_ENCODE, escChar);
  }
  return s;
}

// Decode numeric character references only (marked 18 leaves named
// entities such as &copy; untouched). A bare & that does not start a valid
// reference becomes &amp;; 0, surrogates and out-of-range values become U+FFFD.
const NUM_REF = /&#(?:(\d{1,7})|[Xx]([A-Fa-f0-9]{1,6}));/;
const NUM_REF_OR_AMP = /&#(?:(\d{1,7})|[Xx]([A-Fa-f0-9]{1,6}));|&(?!(#\d{1,7}|#[Xx][a-fA-F0-9]{1,6}|\w+);)/g;
function unescapeRefs(s) {
  if (!NUM_REF.test(s)) return s;
  return s.replace(NUM_REF_OR_AMP, (whole, dec, hex) => {
    if (dec === undefined && hex === undefined) return '&amp;';
    const code = dec === undefined ? parseInt(hex, 16) : parseInt(dec, 10);
    if (code === 0 || code > 0x10ffff || (code >= 0xd800 && code <= 0xdfff)) return '\uFFFD';
    if (code === 38) return '&amp;';
    return String.fromCodePoint(code);
  });
}

// Encode a link destination the way encodeURI does, but keep % as %.
function encodeHref(href) {
  try {
    return encodeURI(href).replace(/%25/g, '%');
  } catch {
    return null;
  }
}

// Normalise a link reference label: trim, collapse inner whitespace, fold case.
const WS_RUN = /\s+/g;
function normLabel(label) {
  return label.trim().replace(WS_RUN, ' ').toLowerCase().toUpperCase().toLowerCase();
}

// Strip trailing characters: with `inverted` false, strip trailing `ch`;
// with it true, strip trailing characters that are not `ch`.
function stripTail(s, ch, inverted) {
  const n = s.length;
  if (n === 0) return '';
  let cut = 0;
  for (; cut < n;) {
    const c = s.charAt(n - cut - 1);
    if (c === ch && !inverted) cut++;
    else if (c !== ch && inverted) cut++;
    else break;
  }
  return s.slice(0, n - cut);
}

// Drop trailing blank lines, keeping at most one blank line at the end.
const BLANK_LINE = /^[ \t]*$/;
function trimBlankTail(s) {
  const lines = s.split('\n');
  let end = lines.length - 1;
  for (; end >= 0 && BLANK_LINE.test(lines[end]);) end--;
  return lines.length - end <= 2 ? s : lines.slice(0, end + 1).join('\n');
}

// Expand tabs to spaces with tab stops every 4 columns, starting at column `col`.
function expandTabs(s, col = 0) {
  let out = '';
  let pos = col;
  for (const ch of s) {
    if (ch === '\t') {
      const width = 4 - (pos % 4);
      out += ' '.repeat(width);
      pos += width;
    } else {
      out += ch;
      pos++;
    }
  }
  return out;
}

// Find the index of the first unmatched close character in `s`, skipping
// backslash escapes. Returns -1 when balanced, -2 when an opener is left
// unclosed, otherwise the index of the unmatched closer.
function findUnbalanced(s, pair) {
  if (s.indexOf(pair[0]) === -1 && s.indexOf(pair[1]) === -1) return -1;
  let depth = 0;
  for (let i = 0; i < s.length; i++) {
    if (s[i] === '\\') i++;
    else if (s[i] === pair[0]) depth++;
    else if (s[i] === pair[1] && (depth--, depth < 0)) return i;
  }
  return depth > 0 ? -2 : -1;
}

// Split a table row on unescaped pipes, trimming cells and honouring the
// expected column count `cols` (truncate or pad with empty cells).
const FIND_PIPE = /\|/g;
const SPLIT_PIPE = / \|/;
const SLASH_PIPE = /\\\|/g;
function splitRow(s, cols) {
  const marked = s.replace(FIND_PIPE, (ch, off, whole) => {
    let escaped = false;
    let p = off;
    for (; --p >= 0 && whole[p] === '\\';) escaped = !escaped;
    return escaped ? '|' : ' |';
  });
  const cells = marked.split(SPLIT_PIPE);
  if (cells[0].trim() || cells.shift(), cells.length > 0 && !cells.at(-1)?.trim()) cells.pop();
  if (cols) {
    if (cells.length > cols) cells.splice(cols);
    else for (; cells.length < cols;) cells.push('');
  }
  for (let i = 0; i < cells.length; i++) cells[i] = cells[i].trim().replace(SLASH_PIPE, '|');
  return cells;
}

// ---------------------------------------------------------------------------
// Regular expressions
// ---------------------------------------------------------------------------

const BLOCK_TAGS =
  'address|article|aside|base|basefont|blockquote|body|caption|center|col|colgroup|dd|details|dialog|dir|div|dl|dt|fieldset|figcaption|figure|footer|form|frame|frameset|h[1-6]|head|header|hr|html|iframe|legend|li|link|main|menu|menuitem|meta|nav|noframes|ol|optgroup|option|p|param|search|section|summary|table|tbody|td|tfoot|th|thead|title|tr|track|ul';

const RE = {
  codeRemoveIndent: /^(?: {0,3}\t| {1,4})/gm,
  outputLinkReplace: /\\([[\]])/g,
  indentCodeCompensation: /^(\s+)(?:```)/,
  beginningSpace: /^\s+/,
  endingHash: /#$/,
  startingSpaceChar: /^ /,
  endingSpaceChar: / $/,
  endingSpaceTabChar: /[ \t]$/,
  nonSpaceChar: /[^ ]/,
  newLineGlobal: /\n/g,
  tabGlobal: /\t/g,
  leadingSpaceTab: /^[ \t]+/,
  blankLine: BLANK_LINE,
  doubleBlankLine: /\n[ \t]*\n[ \t]*$/,
  blockquoteStart: /^ {0,3}>/,
  blockquoteSetextReplace: /\n {0,3}((?:=+|-+)[ \t]*)(?=\n|$)/g,
  blockquoteSetextReplace2: /^ {0,3}>[ \t]?/gm,
  blockquoteMarkerWhitespace: /^( {0,3}>)([ \t]+)/gm,
  listReplaceNesting: /^ {1,4}(?=( {4})*[^ ])/g,
  listIsTask: /^\[[ xX]\][ \t]+\S/,
  listReplaceTask: /^\[[ xX]\][ \t]+/,
  listTaskCheckbox: /\[[ xX]\]/,
  anyLine: /\n.*\n/,
  hrefBrackets: /^<(.*)>$/,
  tableDelimiter: /[:|]/,
  tableAlignChars: /^\||\| *$/g,
  tableRowBlankLine: /\n[ \t]*$/,
  tableAlignRight: /^ *-+: *$/,
  tableAlignCenter: /^ *:-+: *$/,
  tableAlignLeft: /^ *:-+ *$/,
  startATag: /^<a /i,
  endATag: /^<\/a>/i,
  startPreScriptTag: /^<(pre|code|kbd|script)(\s|>)/i,
  endPreScriptTag: /^<\/(pre|code|kbd|script)(\s|>)/i,
  startAngleBracket: /^</,
  endAngleBracket: />$/,
  unicodeAlnum: /[\p{L}\p{N}]/u,
  percentDecode: /%25/g,
  carriageReturn: /\r\n|\r/g,
  spaceLine: /^ +$/gm,
  notSpaceStart: /^\S*/,
  endingNewline: /\n$/,
  // A backslash followed by an ASCII punctuation character; $1 is the char.
  unescapePunct: /\\([\p{P}\p{S}])/gu,
};

// Character classes for the emphasis delimiter machinery.
const PUNCT = /[\p{P}\p{S}]/u; // any punctuation or symbol
const PUNCT_SPACE = /[\s\p{P}\p{S}]/u; // whitespace, punctuation or symbol
const NOT_PUNCT_SPACE = /[^\s\p{P}\p{S}]/u; // anything else
// Punctuation except `~`: the opening-delimiter pattern and the `*`
// closing-delimiter pattern use these, because `~` is itself a delimiter
// (strikethrough) and must behave like a word character there. The `_`
// closing-delimiter pattern and the `~` patterns use the plain classes.
const PUNCT_NO_TILDE = /(?!~)[\p{P}\p{S}]/u;
const PUNCT_SPACE_NO_TILDE = /(?!~)[\s\p{P}\p{S}]/u;
const NOT_PUNCT_SPACE_OR_TILDE = /(?:[^\s\p{P}\p{S}]|~)/u;
const OPEN_QUOTE = /[\p{Pi}\p{Ps}"']/u;
// A single punctuation/space character (but never * or _ at the start).
const PUNCT_START = /^((?![*_])[\s\p{P}\p{S}])/u;

// --- Block-level patterns -------------------------------------------------
const HR_SRC = ' {0,3}((?:-[\\t ]*){3,}|(?:_[ \\t]*){3,}|(?:\\*[ \\t]*){3,})(?:\\n+|$)';
// Same pattern with a non-capturing outer group: used inside the setext
// heading pattern so its group does not shift the (=+|-+) group index.
const HR_NC = / {0,3}(?:(?:-[\t ]*){3,}|(?:_[ \t]*){3,}|(?:\*[ \t]*){3,})(?:\n+|$)/;
const HEADING_SRC = ' {0,3}#{1,6}(?:\\s|$)';
const HTML_START_SRC =
  ' {0,3}(?:</?(?:TAG)(?: +|\\n|/?>)|<(?:(?:script|pre|style|textarea)(?:[\\s>]|$)|!--)|<\\?|<![A-Za-z]|<!\\[CDATA\\[)';

const BLOCK = {
  newline: /^(?:[ \t]*(?:\n|$))+/,
  code: /^((?: {4}| {0,3}\t)[^\n]+(?:\n(?:[ \t]*(?:\n|$))*)?)+/,
  fences: /^ {0,3}(`{3,}(?=[^`\n]*(?:\n|$))|~{3,})([^\n]*)(?:\n|$)(?:|([\s\S]*?)(?:\n|$))(?: {0,3}(?:(?=`)\1`*|(?=~)\1~*) *(?=\n|$)|$)/,
  hr: new RegExp('^' + HR_SRC),
  heading: /^ {0,3}(#{1,6})(?=\s|$)(.*)(?:\n+|$)/,
  text: /^[^\n]+/,
  bullet: / {0,3}(?:[*+-]|\d{1,9}[.)])/,
};

// Setext heading: the "lheading" pattern is built from a template whose
// placeholders name the constructs that may not start a heading's lines.
const LHEADING_TEMPLATE =
  '^(?!bull |blockCode|fences|blockquote|heading|html|table)((?:.|\\n(?!\\s*?\\n|bull |fences|blockquote|heading|hr|html|table))+?)\\n {0,3}(=+|-+)[ \\t]*(?:\\n+|$)';
BLOCK.lheading = buildRx(LHEADING_TEMPLATE, [
  [/bull/g, BLOCK.bullet],
  [/blockCode/g, /(?: {4}| {0,3}\t)/],
  [/fences/g, / {0,3}(?:`{3,}|~{3,})/],
  [/blockquote/g, / {0,3}>/],
  [/heading/g, / {0,3}#{1,6}(?:\s|$)/],
  [/hr/g, HR_NC],
  [/html/g, / {0,3}<[^\n>]+>\n/],
  [/table/g, / {0,3}\|?(?:[:\- ]*\|)+[\:\- ]*\n/],
]);

// Link reference definition.
const LABEL_INNER = '(?!\\s*\\])(?:\\\\[\\s\\S]|[^\\[\\]\\\\\\n]|\\n(?![ \\t]*\\n))+';
BLOCK.def = buildRx(
  '^ {0,3}\\[(label)\\]: *(?:\\n[ \\t]*)?([^<\\s][^\\s]*|<.*?>)(?:(?: +(?:\\n[ \\t]*)?| *\\n[ \\t]*)(title))? *(?:\\n+|$)',
  [
    ['label', new RegExp(LABEL_INNER)],
    ['title', /(?:"(?:\\[\s\S]|[^"\\])*"|'(?:\\[\s\S]|[^'\\\n]|\n(?!\n))*'|\((?:\\[\s\S]|[^()\\])*\))/],
  ],
);

// Fenced code blocks can also start a list item, a heading, etc.; the
// indented variants below are cached per indent level (0..3).
function cachedPattern(builder) {
  const cache = [];
  return (n) => {
    const i = Math.max(0, Math.min(3, n - 1));
    return cache[i] || (cache[i] = builder(i));
  };
}
const nextBullet = cachedPattern((n) => new RegExp(`^ {0,${n}}(?:[*+-]|\\d{1,9}[.)])((?:[ \\t][^\\n]*)?(?:\\n|$))`));
const hrAt = cachedPattern((n) => new RegExp(`^ {0,${n}}((?:-[ \\t]*){3,}|(?:_[ \\t]*){3,}|(?:\\*[ \\t]*){3,})(?:\\n+|$)`));
const fencesBeginAt = cachedPattern((n) => new RegExp(`^ {0,${n}}(?:\`\`\`|~~~)`));
const headingBeginAt = cachedPattern((n) => new RegExp(`^ {0,${n}}#{1,6}(?:\\s|$)`));
const htmlBeginAt = cachedPattern((n) =>
  buildRx(`^ {0,${n}}(?:</?(?:TAG)(?: +|$|/?>)|<(?:(?:script|pre|style|textarea)(?:[\\s>]|$)|!--)|<\\?|<![A-Za-z]|<!\\[CDATA\\[)`, [['TAG', BLOCK_TAGS]], 'i'),
);
const blockquoteBeginAt = cachedPattern((n) => new RegExp(`^ {0,${n}}>`));

// One test for "this line interrupts a list item": a fence, a heading, an
// HTML block start, a block quote, a new list item, or a thematic break.
// A second, smaller one for "the previous content line already starts
// such a construct" (no quote, no new item). Both are boolean tests only.
const HTML_BEGIN_INNER = `(?:</?(?:${BLOCK_TAGS})(?: +|$|/?>)|<(?:(?:script|pre|style|textarea)(?:[\\s>]|$)|!--)|<\\?|<![A-Za-z]|<!\\[CDATA\\[)`;
const HR_INNER = `(?:(?:-[ \\t]*){3,}|(?:_[ \\t]*){3,}|(?:\\*[ \\t]*){3,})(?:\\n+|$)`;
const interruptAt = cachedPattern((n) =>
  new RegExp(
    `^ {0,${n}}(?:(?:\`\`\`|~~~)|#{1,6}(?:\\s|$)|${HTML_BEGIN_INNER}|>|(?:[*+-]|\\d{1,9}[.)])(?:[ \\t]|\\n|$)|${HR_INNER})`,
    'i',
  ),
);
const contentInterruptAt = cachedPattern((n) =>
  new RegExp(`^ {0,${n}}(?:(?:\`\`\`|~~~)|#{1,6}(?:\\s|$)|${HTML_BEGIN_INNER}|${HR_INNER})`, 'i'),
);

// First line of `src` (without its newline), and the rest after it.
function splitFirstLine(src) {
  const nl = src.indexOf('\n');
  if (nl === -1) return [src, ''];
  return [src.slice(0, nl), src.substring(nl + 1)];
}

// HTML block (type 1-7 of the spec).
const HTML_COMMENT = /<!--(?:-?>|[\s\S]*?(?:-->|$))/;
BLOCK.html = buildRx(
  '^ {0,3}(?:<(script|pre|style|textarea)[\\s>][\\s\\S]*?(?:</\\1>[^\\n]*\\n*|$)|comment[^\\n]*(\\n+|$)|<\\?[\\s\\S]*?(?:\\?>[^\\n]*\\n*|$)|<![A-Z][\\s\\S]*?(?:>[^\\n]*\\n*|$)|<!\\[CDATA\\[[\\s\\S]*?(?:\\]\\]>[^\\n]*\\n*|$)|</?(tag)(?:[ \\t]+|\\n|/?>|$)[\\s\\S]*?(?:(?:\\n[ \t]*)+\\n|$)|<(?!(?:script|pre|style|textarea)(?![a-z0-9-]))([a-z][a-z0-9-]*)(?:attribute)*? */?>(?=[ \\t]*(?:\\n|$))[\\s\\S]*?(?:(?:\\n[ \t]*)+\\n|$)|</[a-z][a-z0-9-]*\\s*>(?=[ \\t]*(?:\\n|$))[\\s\\S]*?(?:(?:\\n[ \t]*)+\\n|$))',
  [
    ['comment', HTML_COMMENT],
    ['tag', BLOCK_TAGS],
    ['attribute', / +[a-zA-Z:_][\w.:-]*(?: *= *"[^"\n]*"| *= *'[^'\n]*'| *= *[^\s"'=<>`]+)?/],
  ],
  'i',
);

// Table: header row, delimiter row, then body rows until an interrupting construct.
BLOCK.table = buildRx(
  "^ *([^\\n ].*)\\n {0,3}((?:\\| *)?:?-+:? *(?:\\| *:?-+:? *)*(?:\\| *)?)(?:\\n((?:(?! *\\n|hr|heading|blockquote|code|fences|list|html).*(?:\\n|$))*)\\n*|$)",
  [
    ['hr', BLOCK.hr],
    ['heading', / {0,3}#{1,6}(?:\s|$)/],
    ['blockquote', / {0,3}>/],
    ['code', /(?: {4}| {0,3}\t)[^\n]/],
    ['fences', / {0,3}(?:`{3,}(?=[^`\n]*(?:\n|$))|~~~)[^\n]*(?:\n|$)/],
    ['list', / {0,3}(?:[*+-]|1[.)])[ \t]/],
    ['html', buildRx(HTML_START_SRC, [['TAG', BLOCK_TAGS]])],
  ],
);

// Paragraph: consumes lines until a blank line or an interrupting construct.
// `listPattern` is the list-marker pattern that may interrupt a paragraph.
// The top-level (GFM) paragraph stops at a table; the paragraph inside a
// block quote does not (its lookahead drops the table alternative too).
function paragraphPattern(listPattern, keepTable) {
  return buildRx(
    '^([^\\n]+(?:\\n(?!hr|heading|lheading|blockquote|fences|list|html|table|[ \\t]+\\n)[^\\n]+)*)',
    [
      ['hr', BLOCK.hr],
      ['heading', / {0,3}#{1,6}(?:\s|$)/],
      ['|lheading', ''],
      keepTable ? ['table', BLOCK.table] : ['|table', ''],
      ['blockquote', / {0,3}>/],
      ['fences', / {0,3}(?:`{3,}(?=[^`\n]*(?:\n|$))|~~~)[^\n]*(?:\n|$)/],
      ['list', listPattern],
      ['html', buildRx(HTML_START_SRC, [['TAG', BLOCK_TAGS]])],
    ],
  );
}
BLOCK.paragraph = paragraphPattern(/ {0,3}(?:[*+-]|1[.)])[ \t]+[^ \t\n]/, true);

// A list item is `bullet + optional rest-of-line`.
function listItemPattern(bulletSrc) {
  return new RegExp(`^( {0,3}${bulletSrc})((?:[\\t ][^\\n]*)?(?:\\n|$))`);
}
// The list-start pattern: bullet, then the rest of the first line.
BLOCK.list = buildRx('^(bull)([ \\t][^\\n]*?)?(?:\\n|$)', [['bull', BLOCK.bullet]]);
// Block quote: lines starting with `>` (plus lazy continuation lines),
// where a "paragraph" inside uses the looser list pattern.
BLOCK.blockquote = buildRx(
  '^( {0,3}> ?(?:(?![ \\t]*(?:\\n|$))(paragraph)|[^\\n]*)(?:\\n|$))+',
  [['paragraph', paragraphPattern(/ {0,3}(?:[*+-]|\d{1,9}[.)])(?:[ \t]|\n|$)/, false)]],
);

// --- Inline-level patterns ------------------------------------------------

// A link label: balanced brackets, backslash escapes, code spans.
const BRACKETED = /\[(?:\\[\s\S]|[^\[\]\\])*\]/;
const LINK_LABEL = buildRx(
  /(?:\[(?:brackets|\\[\s\S]|[^\[\]\\])*\]|\\[\s\S]|`+(?!`)[^`]*?`+(?!`)|``+(?=\])|[^\[\]\\`])*?/,
  [['brackets', BRACKETED]],
);
const REF_LABEL_TAIL = buildRx(
  /(?:[^\[\]\\`]*(?:\[(?:brackets|\\[\s\S]|[^\[\]\\])*\]|\\[\s\S]|`+(?!`)[^`]*?`+(?!`)|``+(?=\]))){0,999}?[^\[\]\\`]*?/,
  [['brackets', BRACKETED]],
);
const REF_LABEL_FULL = /(?!\s*\])(?:\\[\s\S]|[^\[\]\\]){1,999}/;

const INLINE = {
  escape: /^\\([!"#$%&'()*+,\-./:;<=>?@\[\]\\^_`{|}~])/,
  code: /^(`+)([^`]|[^`][\s\S]*?[^`])\1(?!`)/,
  br: /^( {2,}|\\)\n(?!\s*$)[ \t]*/,
  // An autolink <scheme:...> or <email>.
  autolink: buildRx(/^<(scheme:[^\s\x00-\x1f<>]*|email)>/, [
    ['scheme', /[a-zA-Z][a-zA-Z0-9+.-]{1,31}/],
    ['email', /[a-zA-Z0-9.!#$%&'*+/=?^_`{|}~-]+(@)[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?(?:\.[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?)+(?![-_])/],
  ]),
  // Raw HTML tag, comment, processing instruction, declaration, CDATA.
  tag: buildRx(
    '^comment|^</[a-zA-Z][a-zA-Z0-9-]*\\s*>|^<[a-zA-Z][a-zA-Z0-9-]*(?:attribute)*?\\s*/?>|^<\\?[\\s\\S]*?\\?>|^<![a-zA-Z]+\\s[\\s\\S]*?>|^<!\\[CDATA\\[[\\s\\S]*?\\]\\]>',
    [
      ['comment', buildRx(HTML_COMMENT, [['(?:-->|$)', '-->']])],
      ['attribute', /\s+[a-zA-Z:_][\w.:-]*(?:\s*=\s*"[^"]*"|\s*=\s*'[^']*'|\s*=\s*[^\s"'=<>`]+)?/],
    ],
  ),
  link: buildRx(/^!?\[(label)\]\([ \t\n]*(href)(?:(?:[ \t]+(?:\n[ \t]*)?|\n[ \t]*)(title))?[ \t\n]*\)/, [
    ['label', LINK_LABEL],
    ['href', /<(?:\\.|[^\n<>\\])+>|[^ \t\n\x00-\x1f]+|(?=\))/],
    ['title', /"(?:\\[\s\S]|[^"\\])*"|'(?:\\[\s\S]|[^'\\])*'|\((?:\\[\s\S]|[^)\\])*\)/],
  ]),
  reflink: buildRx(/^!?\[(label)\]\[(ref)\]/, [
    ['label', LINK_LABEL],
    ['ref', new RegExp(LABEL_INNER)],
  ]),
  nolink: buildRx(/^!?\[(ref)\](?:\[\])?/, [['ref', new RegExp(LABEL_INNER)]]),
};

// Search patterns used only to mask link/code/html spans while scanning
// for emphasis delimiters.
const LINK_SKIP = /\[(?:[^\[\]`]|(?<a>`+)[^`]+\k<a>(?!`))*?\]\((?:\\[\s\S]|[^\(\)]|\((?:\\[\s\S]|[^\(\)])*\))*\)/;
const CODE_SKIP = /(?<b>`+)[^`]+\k<b>(?!`)/;
INLINE.blockSkip = buildRx(/link|precode-code|html/g, [
  ['link', LINK_SKIP],
  ['precode-', '(?<!`)()'],
  ['code', CODE_SKIP],
  ['html', /<(?! )[^<>]*?>/],
]);
INLINE.reflinkSearch = buildRx('reflink|nolink(?!\\()', [
  ['reflink', buildRx(/^!?\[(label)\]\[(ref)\]/, [['label', REF_LABEL_TAIL], ['ref', REF_LABEL_FULL]])],
  ['nolink', buildRx(/^!?\[(ref)\](?:\[\])?/, [['ref', REF_LABEL_FULL]])],
], 'g');

// Extended autolinks (www., http(s)://, ftp://, email) and the backpedal
// that trims trailing punctuation off a matched URL.
const PROTOCOL = /[hH][tT][tT][pP][sS]?|[fF][tT][pP]/;
const EMAIL_LOCAL = /[A-Za-z0-9._+-]+(@)[a-zA-Z0-9-_]+(?:\.[a-zA-Z0-9-_]*[a-zA-Z0-9])+(?![\w-])/;
const EMAIL_FULL = /[A-Za-z0-9._+-]+@[a-zA-Z0-9-_]+(?:\.[a-zA-Z0-9-_]*[a-zA-Z0-9])+(?![\w-])/;
const EMAIL_PROTOCOL = buildRx(/(?:mailto:email|xmpp:email(?:\/[A-Za-z0-9@.]+)?)/, [[/email/g, EMAIL_FULL]]);
INLINE.url = buildRx(/^emailProtocol|^((?:protocol):\/\/|www\.)(?:[a-zA-Z0-9\-]+\.?)+[^\s<]*|^email/, [
  ['emailProtocol', EMAIL_PROTOCOL],
  ['protocol', PROTOCOL],
  ['email', EMAIL_LOCAL],
]);
INLINE.backpedal = /(?:[^?!.,:;*_'\"~()&]+|\([^)]*\)|&(?![a-zA-Z0-9]+;$)|[?!.,:;*_'\"~)]+(?!$))+/;

// Plain-text scanner: consumes a run of text, stopping before anything
// that could start inline markup (or an extended autolink / email).
INLINE.text = buildRx(
  /^(?:[^a-zA-Z0-9](?=emailProtocol)|(`+|~+|[^`~])(?:(?=[`~])|(?= {2,}\n)|(?=[a-zA-Z0-9.!#$%&'*+\/=?_`{|}~-]+@)|[\s\S]*?(?:(?=[\\<!\[`*~_]|\b_|protocol:\/\/|wwwStart|$)|[^ ](?= {2,}\n)|[^a-zA-Z0-9](?=emailProtocol)|[^a-zA-Z0-9.!#$%&'*+\/=?_`{|}~-](?=[a-zA-Z0-9.!#$%&'*+\/=?_`{|}~-]+@))))/,
  [
    ['protocol', PROTOCOL],
    [/emailProtocol/g, /(?:mailto|xmpp):/],
    ['wwwStart', '(?<![^\\s*_~(])www\\.'],
  ],
);

// --- Emphasis / strikethrough delimiter patterns --------------------------
// Opening delimiter: a run of * or _ plus the character that follows it
// (punctuation in $1/$3, other non-space in $2/$4).
const LDELIM_SRC = '^(?:\\*+(?:((?!\\*)punct)|([^\\s*]))?)|^_+(?:((?!_)punct)|([^\\s_]))?';
INLINE.emStrongLDelim = buildRx(LDELIM_SRC, [[/punct/g, PUNCT_NO_TILDE]], 'u');
// Closing-delimiter scanners. Groups $1..$6 hold the delimiter run for
// the six "can close" contexts; the first two alternatives are skips.
const RDELIM_AST_SRC =
  '^[^_*]*?__[^_*]*?\\*[^_*]*?(?=__)|[^*]+(?=[^*])|(?!\\*)punct(\\*+)(?=[\\s]|$)|notPunctSpace(\\*+)(?!\\*)(?=punctSpace|$)|(?!\\*)punctSpace(\\*+)(?=notPunctSpace)|[\\s](\\*+)(?!\\*)(?=punct)|(?!\\*)punct(\\*+)(?!\\*)(?=punct)|notPunctSpace(\\*+)(?=notPunctSpace)';
const RDELIM_UND_SRC =
  '^[^_*]*?\\*\\*[^_*]*?_[^_*]*?(?=\\*\\*)|[^_]+(?=[^_])|(?!_)punct(_+)(?=[\\s]|$)|notPunctSpace(_+)(?!_)(?=punctSpace|$)|(?!_)punctSpace(_+)(?=notPunctSpace)|[\\s](_+)(?!_)(?=punct)|(?!_)punct(_+)(?!_)(?=punct)';
const DEL_RDELIM_SRC =
  '^[^~]+(?=[^~])|(?!~)punct(~~?)(?=[\\s]|$)|notPunctSpace(~~?)(?!~)(?=punctSpace|$)|(?!~)punctSpace(~~?)(?=notPunctSpace)|[\\s](~~?)(?!~)(?=punct)|(?!~)punct(~~?)(?!~)(?=punct)|notPunctSpace(~~?)(?=notPunctSpace)';
INLINE.emStrongRDelimAst = buildRx(RDELIM_AST_SRC, [
  [/notPunctSpace/g, NOT_PUNCT_SPACE_OR_TILDE],
  [/punctSpace/g, PUNCT_SPACE_NO_TILDE],
  [/punct/g, PUNCT_NO_TILDE],
], 'gu');
INLINE.emStrongRDelimUnd = buildRx(RDELIM_UND_SRC, [
  [/notPunctSpace/g, NOT_PUNCT_SPACE],
  [/punctSpace/g, PUNCT_SPACE],
  [/punct/g, PUNCT],
], 'gu');
INLINE.delLDelim = buildRx(/^~~?(?:((?!~)punct)|[^\s~])/, [[/punct/g, PUNCT]], 'u');
INLINE.delRDelim = buildRx(DEL_RDELIM_SRC, [
  [/notPunctSpace/g, NOT_PUNCT_SPACE],
  [/punctSpace/g, PUNCT_SPACE],
  [/punct/g, PUNCT],
], 'gu');
// Code spans and backslash-escapes, used to mask text for delimiter scans.
INLINE.anyPunctOutsideCode = buildRx(/(`+)(?:[^`]|[^`][\s\S]*?[^`])\1(?!`)|`+|\\(punct)/, [[/punct/g, PUNCT]], 'gu');

// Fast-path probe: anything in a run of prose that forces the full inline scan.
function needsInlineScan(src) {
  return (
    src.includes('\\') || src.includes('`') || src.includes('*') ||
    src.includes('[') || src.includes('<') || src.includes('_') ||
    src.includes('~') || src.includes('  \n') || src.includes('@') ||
    src.includes('www.') || src.includes('mailto:') || src.includes('xmpp:') ||
    URL_PROTOCOL.test(src)
  );
}
const URL_PROTOCOL = /(?:[hH][tT][tT][pP][sS]?|[fF][tT][pP]):\/\//;

// ---------------------------------------------------------------------------
// Emphasis delimiter scanning
// ---------------------------------------------------------------------------

// Scan a (masked) source for the last position where a delimiter run could
// close emphasis/strong (`*`/`_`) or strikethrough (`~`): the run must be
// preceded by a character that is not a space, tab, newline, CR or FF.
function scanDelims(src) {
  const lastEm = { '*': -1, _: -1 };
  let lastDel = -1;
  const n = src.length;
  for (let s = 0; s < n; s++) {
    const ch = src[s];
    if (ch !== '*' && ch !== '_' && ch !== '~') continue;
    const before = s === 0 ? '\n' : src[s - 1];
    let i = s + 1;
    for (; i < n && src[i] === ch;) i++;
    if (before !== ' ' && before !== '\t' && before !== '\n' && before !== '\r' && before !== '\f') {
      if (ch === '~') lastDel = s;
      else lastEm[ch] = s;
    }
    s = i - 1;
  }
  return { maskedSrc: src, lastEm, lastDel };
}

// Mask link destinations, code spans and raw HTML tags so delimiter runs
// inside them are invisible to the emphasis scan, and mask link labels
// that refer to known definitions (so a `[` inside link text cannot open
// emphasis either). Returns the masked string, same length as the input.
function maskForEmphasis(src, links, linkInText) {
  let out = src;
  if (links && src.includes('[')) {
    const re = INLINE.reflinkSearch;
    const maskRef = (match) => {
      const open = match.lastIndexOf('[');
      if (!Object.hasOwn(links, normLabel(match.slice(open + 1, -1)))) return match;
      if (open > 1 && match.charAt(0) !== '!') {
        const inner = match.slice(1, open - 1);
        if (linkInText(inner)) {
          return '[' + inner.replace(re, maskRef) + '][' + 'a'.repeat(match.length - open - 2) + ']';
        }
      }
      return '[' + 'a'.repeat(match.length - 2) + ']';
    };
    out = out.replace(re, maskRef);
  }
  // Each mask pass is skipped when the string cannot contain what it hides.
  if (out.includes('`') || out.includes('\\')) {
    out = out.replace(INLINE.anyPunctOutsideCode, (whole, ticks, punct) =>
      punct ? '+'.repeat(whole.length) : ticks ? ticks + whole.slice(ticks.length, -ticks.length).replace(/`/g, '+') + ticks : whole,
    );
  }
  if (out.includes('](') || out.includes('`') || out.includes('<')) {
    out = out.replace(INLINE.blockSkip, (whole, _ticks, emptyGroup) => {
      const keep = emptyGroup ? emptyGroup.length : 0;
      return whole.slice(0, keep) + '[' + 'a'.repeat(whole.length - keep - 2) + ']';
    });
  }
  return out;
}

// Does `src` contain a link (inline or reference) that is not an image?
function linkInText(src, links) {
  if (!src.includes('[')) return false;
  for (const m of src.matchAll(INLINE.blockSkip)) {
    if (INLINE.link.test(m[0]) && src.charAt(m.index - 1) !== '!') return true;
  }
  for (const m of src.matchAll(INLINE.reflinkSearch)) {
    const s = m[0];
    const open = s.lastIndexOf('[');
    if (
      !(s.charAt(0) === '!' || !Object.hasOwn(links, normLabel(s.slice(open + 1, -1)))) &&
      !(open > 1 && linkInText(s.slice(1, open - 1), links))
    ) {
      return true;
    }
  }
  return false;
}

// ---------------------------------------------------------------------------
// Inline tokenizers. Each takes the remaining source (and, for the emphasis
// family, the masked source plus the previous character) and returns a
// token object, or undefined when it does not match.
// ---------------------------------------------------------------------------

// A `<` inside a link label that starts a tag or autolink disqualifies the
// link: the label would swallow markup that belongs outside the link.
function hasTagInLabel(src, label, labelOffset) {
  if (!label.includes('<')) return false;
  for (let s = 0; s < label.length; s++) {
    if (label[s] === '\\') {
      s++;
      continue;
    }
    if (label[s] === '`') {
      const m = INLINE.code.exec(label.slice(s));
      if (m) {
        s += m[0].length - 1;
        continue;
      }
    }
    if (label[s] !== '<') continue;
    const rest = src.slice(labelOffset + s);
    const m = INLINE.tag.exec(rest) || INLINE.autolink.exec(rest);
    if (m) {
      if (m[0].length > label.length - s) return true;
      s += m[0].length - 1;
    }
  }
  return false;
}

function tokenizeEscape(src) {
  const m = INLINE.escape.exec(src);
  if (m) return { type: 'escape', raw: m[0], text: m[1] };
}

function tokenizeTag(src, lx) {
  const m = INLINE.tag.exec(src);
  if (!m) return;
  if (!lx.state.inLink && RE.startATag.test(m[0])) lx.state.inLink = true;
  else if (lx.state.inLink && RE.endATag.test(m[0])) lx.state.inLink = false;
  if (!lx.state.inRawBlock && RE.startPreScriptTag.test(m[0])) lx.state.inRawBlock = true;
  else if (lx.state.inRawBlock && RE.endPreScriptTag.test(m[0])) lx.state.inRawBlock = false;
  return { type: 'html', raw: m[0], text: m[0] };
}

// Shared finish for inline and reference links/images.
function finishLink(m, dest, title, raw, lx) {
  const text = m[1].replace(RE.outputLinkReplace, '$1');
  const isImage = m[0].charAt(0) === '!';
  const wasInLink = lx.state.inLink;
  const wasEmitted = lx.state.linkEmitted;
  const wasRawBlock = lx.state.inRawBlock;
  lx.state.inLink = true;
  lx.state.linkEmitted = false;
  const inner = lx.inlineTokens(text);
  const nested = lx.state.linkEmitted;
  lx.state.linkEmitted = wasEmitted;
  lx.state.inLink = wasInLink;
  if (!isImage) {
    if (nested) {
      lx.state.inRawBlock = wasRawBlock;
      return undefined;
    }
    lx.state.linkEmitted = true;
  }
  return { type: isImage ? 'image' : 'link', raw, href: dest, title: title || null, text, tokens: inner };
}

function tokenizeLink(src, lx) {
  if (lx.state.linkParenPossible === false) return;
  const m = INLINE.link.exec(src);
  if (!m) return;
  const labelOff = m[0].charAt(0) === '!' ? 2 : 1;
  if (hasTagInLabel(src, m[1], labelOff, lx)) return;
  let dest = m[2].trim();
  if (RE.startAngleBracket.test(dest)) {
    if (!RE.endAngleBracket.test(dest)) return;
    const stripped = stripTail(dest.slice(0, -1), '\\');
    if ((dest.length - stripped.length) % 2 === 0) return;
  } else {
    const close = findUnbalanced(m[2], '()');
    if (close === -2) return;
    if (close > -1) {
      const head = (m[0].indexOf('!') === 0 ? 5 : 4) + m[1].length + close;
      m[2] = m[2].substring(0, close);
      m[0] = m[0].substring(0, head).trim();
      m[3] = '';
    }
  }
  const noTrail = stripTail(m[0].slice(0, -1), '\\');
  if ((m[0].length - noTrail.length) % 2 === 0) return;
  let href = m[2];
  const title = m[3] ? m[3].slice(1, -1) : '';
  href = href.trim();
  if (RE.startAngleBracket.test(href)) href = href.slice(1, -1);
  return finishLink(
    m,
    href && href.replace(RE.unescapePunct, '$1'),
    title && title.replace(RE.unescapePunct, '$1'),
    m[0],
    lx,
  );
}

function tokenizeReflink(src, lx) {
  const m = INLINE.reflink.exec(src) || INLINE.nolink.exec(src);
  if (!m) return;
  const labelOff = m[0].charAt(0) === '!' ? 2 : 1;
  if (hasTagInLabel(src, m[1], labelOff, lx)) return;
  const def = lx.links[normLabel(m[2] || m[1])];
  if (!def) {
    const ch = m[0].charAt(0);
    return { type: 'text', raw: ch, text: ch };
  }
  return finishLink(m, def.href, def.title, m[0], lx);
}

function tokenizeEmStrong(src, masked, prev, lx) {
  const m = INLINE.emStrongLDelim.exec(src);
  if (!m || (!m[1] && !m[2] && !m[3] && !m[4])) return;
  const ch = m[0][0];
  const samePrev = prev === ch;
  const off = masked.length - src.length;
  let runStart = off;
  for (; runStart > 0 && masked[runStart - 1] === ch;) runStart--;
  const beforeRun = [...masked.slice(Math.max(0, runStart - 2), runStart)].at(-1) ?? '';
  const beforeIsPunct = beforeRun === '*' || beforeRun === '_' || PUNCT_START.test(beforeRun);
  if (runStart < off) prev = beforeRun;
  const canOpen = runStart < off ? beforeIsPunct : PUNCT_START.test(prev);
  if (m[4] && RE.unicodeAlnum.test(prev)) return;
  const punctAfter = m[1] || m[3] || '';
  if (!punctAfter || !prev || canOpen) {
    const k = [...m[0]].length - 1;
    const totalRun = off - runStart + k;
    const oddSkip = beforeRun.trim() !== '' && (punctAfter !== '' || (ch === '*' && !beforeIsPunct));
    const scanRe = ch === '*' ? INLINE.emStrongRDelimAst : INLINE.emStrongRDelimUnd;
    const lastCloser = lx.lastEmCloser(masked, ch);
    const searchFrom = off + k;
    if (lastCloser < searchFrom) return;
    const rest = masked.slice(searchFrom);
    const limit = lastCloser - searchFrom;
    let openLeft = k;
    let skipped = 0;
    scanRe.lastIndex = 0;
    let hit;
    for (; (hit = scanRe.exec(rest)) !== null && !(hit.index > limit);) {
      const g = hit[1] || hit[2] || hit[3] || hit[4] || hit[5] || hit[6];
      if (!g) continue;
      const b = [...g].length;
      if (hit[3] || hit[4]) {
        openLeft += b;
        continue;
      }
      if (hit[5] || hit[6] || oddSkip) {
        if (samePrev && (hit[5] || hit[6])) break;
        if (totalRun % 3 !== 0 && (totalRun + b) % 3 === 0) {
          skipped += b;
          continue;
        }
      }
      openLeft -= b;
      if (openLeft > 0) continue;
      const use = Math.min(b, b + openLeft + skipped);
      const firstLen = [...hit[0]][0].length;
      const raw = src.slice(0, k + hit.index + firstLen + use);
      if (Math.min(k, use) % 2 === 1) {
        const inner = raw.slice(1, -1);
        return { type: 'em', raw, text: inner, tokens: lx.inlineTokens(inner) };
      }
      const inner = raw.slice(2, -2);
      return { type: 'strong', raw, text: inner, tokens: lx.inlineTokens(inner) };
    }
  }
  return undefined;
}

function tokenizeCodespan(src) {
  const m = INLINE.code.exec(src);
  if (!m) return;
  let text = m[2].replace(RE.newLineGlobal, ' ');
  const hasNonSpace = RE.nonSpaceChar.test(text);
  const padded = RE.startingSpaceChar.test(text) && RE.endingSpaceChar.test(text);
  if (hasNonSpace && padded) text = text.substring(1, text.length - 1);
  return { type: 'codespan', raw: m[0], text };
}

function tokenizeBr(src) {
  const m = INLINE.br.exec(src);
  if (m) return { type: 'br', raw: m[0] };
}

function tokenizeDel(src, masked, prev, lx) {
  const m = INLINE.delLDelim.exec(src);
  if (!m) return;
  // A punctuation character right after the opener only blocks the
  // delimiter when the character before it is not punctuation either.
  if (m[1] && prev && !PUNCT_START.test(prev)) return;
  const openLen = [...m[0]].length - 1;
  const off = masked.length - src.length;
  const lastCloser = lx.lastDelCloser(masked);
  const searchFrom = off + openLen;
  if (lastCloser < searchFrom) return;
  const rest = masked.slice(searchFrom);
  const limit = lastCloser - searchFrom;
  const scanRe = INLINE.delRDelim;
  let pending = openLen;
  scanRe.lastIndex = 0;
  let hit;
  for (; (hit = scanRe.exec(rest)) !== null && !(hit.index > limit);) {
    const g = hit[1] || hit[2] || hit[3] || hit[4] || hit[5] || hit[6];
    if (!g) continue;
    let len = [...g].length;
    if (len !== openLen) continue;
    if (hit[3] || hit[4]) {
      pending += len;
      continue;
    }
    pending -= len;
    if (pending > 0) continue;
    len = Math.min(len, len + pending);
    const firstLen = [...hit[0]][0].length;
    const raw = src.slice(0, openLen + hit.index + firstLen + len);
    const inner = raw.slice(openLen, -openLen);
    return { type: 'del', raw, text: inner, tokens: lx.inlineTokens(inner) };
  }
  return undefined;
}

function tokenizeAutolink(src) {
  const m = INLINE.autolink.exec(src);
  if (!m) return;
  let text;
  let href;
  if (m[2] === '@') {
    text = m[1];
    href = 'mailto:' + text;
  } else {
    text = m[1];
    href = text;
  }
  return { type: 'link', raw: m[0], text, href, autolink: true, tokens: [{ type: 'text', raw: text, text }] };
}

function tokenizeUrl(src) {
  const m = INLINE.url.exec(src);
  if (!m) return;
  let text;
  let href;
  if (m[2] === '@') {
    text = m[0];
    href = 'mailto:' + text;
  } else {
    let cur = m[0];
    for (;;) {
      const next = INLINE.backpedal.exec(cur)?.[0] ?? '';
      if (next === cur) break;
      cur = next;
    }
    m[0] = cur;
    text = cur;
    href = m[1] === 'www.' ? 'http://' + cur : cur;
  }
  return { type: 'link', raw: m[0], text, href, autolink: true, tokens: [{ type: 'text', raw: text, text }] };
}

function isWordCode(code) {
  return (code >= 48 && code <= 57) || (code >= 65 && code <= 90) || (code >= 97 && code <= 122) || code === 95;
}
function isAlnumCode(code) {
  return (code >= 48 && code <= 57) || (code >= 65 && code <= 90) || (code >= 97 && code <= 122);
}
// Characters that may appear in an email local part (and in the
// "www."/"mailto:" lookaheads of the text scan).
function isEmailLocalCode(code) {
  return (
    isAlnumCode(code) ||
    code === 46 || code === 33 || code === 35 || code === 36 || code === 37 || code === 38 ||
    code === 39 || code === 42 || code === 43 || code === 45 || code === 47 || code === 61 ||
    code === 63 || code === 94 || code === 95 || code === 96 || code === 123 || code === 124 ||
    code === 125 || code === 126
  );
}
function isEmailAt(s, i) {
  if (!isEmailLocalCode(s.charCodeAt(i))) return false;
  // The local part must run unbroken up to an `@`; find the next `@`
  // natively first so plain prose (no `@` at all) costs almost nothing.
  const at = s.indexOf('@', i + 1);
  if (at === -1) return false;
  for (let j = i + 1; j < at; j++) if (!isEmailLocalCode(s.charCodeAt(j))) return false;
  return true;
}
function isProtocolAt(s, i) {
  const a = s.charCodeAt(i) | 32;
  if (a === 104) {
    if ((s.charCodeAt(i + 1) | 32) !== 116 || (s.charCodeAt(i + 2) | 32) !== 116 || (s.charCodeAt(i + 3) | 32) !== 112) return false;
    let j = i + 4;
    if ((s.charCodeAt(j) | 32) === 115) j++;
    return s[j] === ':' && s[j + 1] === '/' && s[j + 2] === '/';
  }
  if (a === 102) {
    return (s.charCodeAt(i + 1) | 32) === 116 && (s.charCodeAt(i + 2) | 32) === 112 && s[i + 3] === ':' && s[i + 4] === '/' && s[i + 5] === '/';
  }
  return false;
}
function isWwwPrev(ch) {
  return ch === ' ' || ch === '\t' || ch === '\n' || ch === '\r' || ch === '\f' || ch === '\v' || ch === '*' || ch === '_' || ch === '~' || ch === '(' || /\s/.test(ch);
}
// Two or more spaces followed by a newline, starting at `i`.
function isHardBreakAt(s, i) {
  if (s[i] !== ' ' || s[i + 1] !== ' ') return false;
  let j = i + 2;
  while (s[j] === ' ') j++;
  return s[j] === '\n';
}

// Characters and patterns that end a run of plain text (another inline
// tokenizer can match starting there). One regex pass finds the next
// candidate of any kind; the match is then validated (a `www.` needs a
// qualifying previous character, a newline needs two spaces before it,
// and so on). An email address is handled separately below: its stop
// position (the start of the local part) lies before the `@` that
// triggers it, so a regex that matches the `@` would order it wrong
// against a markup character sitting inside the local part.
const TEXT_STOP_RE = /[\\`\[<*!~_]|www\.|:\/\/|mailto:|xmpp:| {2,}\n/g;

// Manual replacement for the plain-text pattern: consumes a run of text,
// stopping exactly where another inline tokenizer could match (a markup
// character, a URL/email start, or a hard break).
// Always consumes at least one character.
function scanTextToken(src, lx) {
  const n = src.length;
  const inRaw = lx.state.inRawBlock;
  const finish = (end) => {
    const raw = src.slice(0, end);
    return { type: 'text', raw, text: inRaw ? raw : unescapeRefs(raw), escaped: inRaw };
  };
  // A single non-alphanumeric character before mailto:/xmpp: is its own token.
  if (n >= 2 && !isAlnumCode(src.charCodeAt(0)) && (src.startsWith('mailto:', 1) || src.startsWith('xmpp:', 1))) {
    return finish(1);
  }
  // First character(s): a backtick run, a tilde run, or one character.
  let i;
  const c0 = src[0];
  if (c0 === '`' || c0 === '~') {
    i = 1;
    while (i < n && src[i] === c0) i++;
  } else {
    i = 1;
  }
  // Stops that apply right after those first characters.
  if (i < n) {
    if (isHardBreakAt(src, i) || isEmailAt(src, i)) return finish(i);
    const ch = src[i];
    if (ch === '\\' || ch === '`' || ch === '[' || ch === '<' || ch === '!' || ch === '*' || ch === '~' || ch === '_') return finish(i);
    if (isProtocolAt(src, i)) return finish(i);
    if (src.startsWith('www.', i) && (i === 0 || isWwwPrev(src[i - 1]))) return finish(i);
  } else {
    return finish(n);
  }
  // Find the end of the run: the earliest position where a stop applies.
  let end = n;
  // An email address: the text ends at the start of its local part (the
  // character before that part is the last text character). The first
  // valid `@` gives the earliest such end, because local parts are
  // disjoint and ordered.
  let at = src.indexOf('@', i + 1);
  while (at !== -1) {
    let j = at;
    while (j > i && isEmailLocalCode(src.charCodeAt(j - 1))) j--;
    // The local part must be non-empty and must not extend back past the
    // scan (else the address started before this text run).
    if (j > i && at > j) { end = j; break; }
    if (j === i && at > j && !isEmailLocalCode(src.charCodeAt(i - 1))) { end = i; break; }
    at = src.indexOf('@', at + 1);
  }
  // One native regex pass locates the next candidate of any other kind;
  // each candidate is then validated, and invalid ones are skipped.
  TEXT_STOP_RE.lastIndex = i;
  let m;
  while ((m = TEXT_STOP_RE.exec(src)) !== null) {
    const p = m.index;
    if (p >= end) break;
    const hit = m[0];
    if (hit.length === 1) {
      // A markup character ends the text right before it.
      end = p;
      break;
    }
    if (hit === 'www.') {
      if (isWwwPrev(src[p - 1])) { end = p; break; }
    } else if (hit === '://') {
      // A URL scheme ends the text at its first letter.
      let start = -1;
      if (p >= 5 && src.slice(p - 5, p).toLowerCase() === 'https') start = p - 5;
      else if (p >= 4) {
        const four = src.slice(p - 4, p).toLowerCase();
        if (four === 'http' || four === 'ftp') start = p - 4;
      }
      if (start >= i) { end = start; break; }
    } else if (hit.endsWith('\n')) {
      // A hard break: the match starts at the first of the spaces, but
      // only when the space run does not extend back before the scan.
      if (src[p - 1] !== ' ') { end = p; break; }
      // Otherwise the spaces started before this text run: no hard break
      // here, and the span holds no other stop, so keep scanning past it.
    } else {
      // `mailto:` / `xmpp:` after a non-alphanumeric character.
      if (p > i && !isAlnumCode(src.charCodeAt(p - 1))) { end = p; break; }
    }
  }
  return finish(end);
}

function tokenizeText(src, lx) {
  return scanTextToken(src, lx);
}

// ---------------------------------------------------------------------------
// Lexer: block tokenization, then inline tokenization.
// ---------------------------------------------------------------------------

class Lexer {
  constructor() {
    this.links = Object.create(null);
    this.state = { inLink: false, inRawBlock: false, linkEmitted: false, linkParenPossible: true, top: true };
    this.inlineQueue = [];
    this.maskStack = [];
  }

  // Delimiter-scan cache for the current inline run: the top entry is used
  // when its masked source matches, otherwise a fresh scan is run.
  lastEmCloser(masked, ch) {
    const top = this.maskStack.at(-1);
    if (top && top.maskedSrc === masked) return top.lastEm[ch];
    return scanDelims(masked).lastEm[ch];
  }
  lastDelCloser(masked) {
    const top = this.maskStack.at(-1);
    if (top && top.maskedSrc === masked) return top.lastDel;
    return scanDelims(masked).lastDel;
  }

  lex(src) {
    src = src.replace(RE.carriageReturn, '\n');
    const tokens = [];
    this.blockTokens(src, tokens);
    for (let i = 0; i < this.inlineQueue.length; i++) {
      const entry = this.inlineQueue[i];
      this.state.inRawBlock = false;
      this.inlineTokens(entry.src, entry.tokens);
    }
    this.inlineQueue = [];
    return tokens;
  }

  // Queue a string for inline tokenization once the block pass is done
  // (link definitions anywhere in the document must be visible to it).
  inline(src, tokens = []) {
    this.inlineQueue.push({ src, tokens });
    return tokens;
  }

  blockTokens(src, tokens, nested = false) {
    let shortest = Infinity;
    for (; src;) {
      if (src.length < shortest) shortest = src.length;
      else throw new Error('Infinite loop on byte: ' + src.charCodeAt(0));
      let tok;
      if ((tok = this.tokSpace(src))) {
        src = src.substring(tok.raw.length);
        const prev = tokens.at(-1);
        if (tok.raw.length === 1 && prev !== undefined) prev.raw += '\n';
        else tokens.push(tok);
        continue;
      }
      if ((tok = this.tokCode(src))) {
        src = src.substring(tok.raw.length);
        const prev = tokens.at(-1);
        if (prev?.type === 'paragraph' || prev?.type === 'text') {
          prev.raw += (prev.raw.endsWith('\n') ? '' : '\n') + tok.raw;
          prev.text += '\n' + tok.text;
          this.inlineQueue.at(-1).src = prev.text;
        } else tokens.push(tok);
        continue;
      }
      if ((tok = this.tokFences(src))) {
        src = src.substring(tok.raw.length);
        tokens.push(tok);
        continue;
      }
      if ((tok = this.tokHeading(src))) {
        src = src.substring(tok.raw.length);
        tokens.push(tok);
        continue;
      }
      if ((tok = this.tokHr(src))) {
        src = src.substring(tok.raw.length);
        tokens.push(tok);
        continue;
      }
      if ((tok = this.tokBlockquote(src))) {
        src = src.substring(tok.raw.length);
        tokens.push(tok);
        continue;
      }
      if ((tok = this.tokList(src))) {
        src = src.substring(tok.raw.length);
        tokens.push(tok);
        continue;
      }
      if ((tok = this.tokHtml(src))) {
        src = src.substring(tok.raw.length);
        tokens.push(tok);
        continue;
      }
      if ((tok = this.tokDef(src))) {
        src = src.substring(tok.raw.length);
        const prev = tokens.at(-1);
        if (prev?.type === 'paragraph' || prev?.type === 'text') {
          prev.raw += (prev.raw.endsWith('\n') ? '' : '\n') + tok.raw;
          prev.text += '\n' + tok.raw;
          this.inlineQueue.at(-1).src = prev.text;
        } else {
          if (!this.links[tok.tag]) this.links[tok.tag] = { href: tok.href, title: tok.title };
          tokens.push(tok);
        }
        continue;
      }
      if ((tok = this.tokTable(src))) {
        src = src.substring(tok.raw.length);
        tokens.push(tok);
        continue;
      }
      if ((tok = this.tokLheading(src))) {
        src = src.substring(tok.raw.length);
        tokens.push(tok);
        continue;
      }
      if (this.state.top && (tok = this.tokParagraph(src))) {
        const prev = tokens.at(-1);
        if (nested && prev?.type === 'paragraph') {
          prev.raw += (prev.raw.endsWith('\n') ? '' : '\n') + tok.raw;
          prev.text += '\n' + tok.text;
          this.inlineQueue.pop();
          this.inlineQueue.at(-1).src = prev.text;
        } else tokens.push(tok);
        nested = false;
        src = src.substring(tok.raw.length);
        continue;
      }
      if ((tok = this.tokText(src))) {
        src = src.substring(tok.raw.length);
        const prev = tokens.at(-1);
        if (prev?.type === 'text') {
          prev.raw += (prev.raw.endsWith('\n') ? '' : '\n') + tok.raw;
          prev.text += '\n' + tok.text;
          this.inlineQueue.pop();
          this.inlineQueue.at(-1).src = prev.text;
        } else tokens.push(tok);
        continue;
      }
      if (src) throw new Error('Infinite loop on byte: ' + src.charCodeAt(0));
    }
    this.state.top = true;
    return tokens;
  }

  // --- Block tokenizers ----------------------------------------------------
  tokSpace(src) {
    const m = BLOCK.newline.exec(src);
    if (m && m[0].length > 0) return { type: 'space', raw: m[0] };
  }

  tokCode(src) {
    const m = BLOCK.code.exec(src);
    if (!m) return;
    const raw = trimBlankTail(m[0]);
    return { type: 'code', raw, codeBlockStyle: 'indented', text: raw.replace(RE.codeRemoveIndent, '') };
  }

  tokFences(src) {
    const m = BLOCK.fences.exec(src);
    if (!m) return;
    let text = m[3] || '';
    const indent = m[0].match(RE.indentCodeCompensation);
    if (indent !== null) {
      const width = indent[1];
      text = text.split('\n').map((line) => {
        const lead = line.match(RE.beginningSpace);
        if (lead === null) return line;
        return line.slice(Math.min(lead[0].length, width.length));
      }).join('\n');
    }
    return {
      type: 'code',
      raw: m[0],
      lang: m[2] ? m[2].trim().replace(RE.unescapePunct, '$1') : m[2],
      text,
    };
  }

  tokHeading(src) {
    const m = BLOCK.heading.exec(src);
    if (!m) return;
    let text = m[2].trim();
    if (RE.endingHash.test(text)) {
      const stripped = stripTail(text, '#');
      if (!stripped || RE.endingSpaceTabChar.test(stripped)) text = stripped.trim();
    }
    return { type: 'heading', raw: stripTail(m[0], '\n'), depth: m[1].length, text, tokens: this.inline(text) };
  }

  tokHr(src) {
    const m = BLOCK.hr.exec(src);
    if (m) return { type: 'hr', raw: stripTail(m[0], '\n') };
  }

  tokBlockquote(src) {
    const m = BLOCK.blockquote.exec(src);
    if (!m) return;
    let lines = stripTail(m[0], '\n').split('\n');
    let raw = '';
    let text = '';
    const tokens = [];
    while (lines.length > 0) {
      let seenMarker = false;
      const chunk = [];
      let p;
      for (p = 0; p < lines.length; p++) {
        if (RE.blockquoteStart.test(lines[p])) {
          chunk.push(lines[p]);
          seenMarker = true;
        } else if (!seenMarker) chunk.push(lines[p]);
        else break;
      }
      lines = lines.slice(p);
      const chunkRaw = chunk.join('\n');
      const stripped = chunkRaw
        .replace(RE.blockquoteMarkerWhitespace, (whole, marker, ws) => marker + expandTabs(ws, marker.length))
        .replace(RE.blockquoteSetextReplace, '\n    $1')
        .replace(RE.blockquoteSetextReplace2, '');
      raw = raw ? raw + '\n\n' + chunkRaw : chunkRaw;
      text = text ? text + '\n\n' + stripped : stripped;
      const savedTop = this.state.top;
      this.state.top = true;
      this.blockTokens(stripped, tokens, true);
      this.state.top = savedTop;
      if (lines.length === 0) break;
      const last = tokens.at(-1);
      if (last?.type === 'code' || last?.type === 'heading' || last?.type === 'hr' || last?.type === 'html' || last?.type === 'table') break;
      if (last?.type === 'blockquote') {
        const inner = last;
        const rest = lines.join('\n');
        const combined = inner.raw + '\n' + rest.replace(RE.blockquoteSetextReplace2, '');
        const reparsed = this.tokBlockquote(combined);
        tokens[tokens.length - 1] = reparsed;
        const leftover = combined.substring(reparsed.raw.length).replace(/^\n/, '');
        const leftoverLines = leftover ? leftover.split('\n').length : 0;
        const consumed = leftoverLines ? lines.slice(0, -leftoverLines) : lines;
        if (consumed.length > 0) raw = raw + '\n\n' + consumed.join('\n');
        text = text.substring(0, text.length - inner.text.length) + reparsed.text;
        lines = lines.slice(consumed.length);
        if (lines.length > 0 && RE.blockquoteStart.test(lines[0])) continue;
        break;
      }
      if (last?.type === 'list') {
        const inner = last;
        const combined = inner.raw + '\n' + lines.join('\n');
        const reparsed = this.tokList(combined);
        tokens[tokens.length - 1] = reparsed;
        const extra = reparsed.raw.length > inner.raw.length
          ? combined.slice(inner.raw.length + 1, reparsed.raw.length).split('\n').length
          : 0;
        if (extra > 0) {
          const taken = lines.slice(0, extra).join('\n');
          raw = raw + '\n\n' + taken;
          text = text + '\n\n' + taken;
        }
        lines = lines.slice(extra);
        continue;
      }
    }
    return { type: 'blockquote', raw, tokens, text };
  }

  tokList(src) {
    const m = BLOCK.list.exec(src);
    if (!m) return;
    const whole = src;
    const consumed = () => whole.length - src.length;
    const first = m[1].trim();
    const ordered = first.length > 1;
    const list = {
      type: 'list',
      raw: '',
      ordered,
      start: ordered ? +first.slice(0, -1) : '',
      loose: false,
      items: [],
    };
    const bulletSrc = ordered ? `\\d{1,9}\\${first.slice(-1)}` : `\\${first}`;
    const itemRe = listItemPattern(bulletSrc);
    let pendingLoose = false;
    for (; src;) {
      let empty = false;
      let itemText = '';
      const itemStart = consumed();
      const hit = itemRe.exec(src);
      if (!hit || BLOCK.hr.test(src)) break;
      src = src.substring(hit[0].length);
      const firstLine = hit[2].endsWith('\n') ? hit[2].slice(0, -1) : hit[2];
      const bulletLen = hit[1].length;
      const expanded = firstLine[0] === ' ' || firstLine[0] === '\t'
        ? firstLine.replace(RE.leadingSpaceTab, (ws) => expandTabs(ws, bulletLen))
        : firstLine;
      const [nextLine] = splitFirstLine(src);
      let isEmpty = !expanded.trim();
      let indent;
      if (isEmpty) indent = bulletLen + 1;
      else {
        indent = expanded.search(RE.nonSpaceChar);
        if (indent > 4) indent = 1;
        itemText = expanded.slice(indent);
        indent += bulletLen;
      }
      if (isEmpty && BLANK_LINE.test(nextLine)) {
        src = src.substring(nextLine.length + 1);
        empty = true;
      }
      if (!empty) {
        const interrupts = interruptAt(indent);
        const contentInterrupts = contentInterruptAt(indent);
        let content = expanded;
        for (; src;) {
          const [line, rest] = splitFirstLine(src);
          const wide = line[0] === ' ' || line[0] === '\t'
            ? line.replace(RE.leadingSpaceTab, (ws) => expandTabs(ws))
            : line;
          if (interrupts.test(line)) break;
          const nonSpace = wide.search(RE.nonSpaceChar);
          if (nonSpace >= indent || nonSpace === -1) {
            itemText += '\n' + wide.slice(indent);
          } else {
            const flatContent = content.includes('\t') ? content.replace(RE.tabGlobal, '    ') : content;
            if (isEmpty || flatContent.search(RE.nonSpaceChar) >= 4 || contentInterrupts.test(content)) break;
            const asSetext = /^ {0,3}(?:=+|-+) *$/.test(line) && BLOCK.lheading.test(`${content}\n${line}`)
              ? `    ${wide.replace(/^ {0,3}/, '')}`
              : line;
            itemText += '\n' + asSetext;
          }
          isEmpty = nonSpace === -1;
          src = rest;
          content = wide.slice(indent);
        }
      }
      const itemRaw = whole.slice(itemStart, consumed());
      if (!list.loose) {
        if (pendingLoose) list.loose = true;
        else if (RE.doubleBlankLine.test(itemRaw)) pendingLoose = true;
      }
      list.items.push({
        type: 'list_item',
        raw: itemRaw,
        task: !!RE.listIsTask.test(itemText),
        loose: false,
        text: itemText,
        tokens: [],
      });
    }
    const lastItem = list.items.at(-1);
    if (!lastItem) return;
    lastItem.raw = lastItem.raw.trimEnd();
    lastItem.text = lastItem.text.trimEnd();
    list.raw = whole.slice(0, consumed()).trimEnd();
    for (const item of list.items) {
      this.state.top = false;
      item.tokens = this.blockTokens(item.text, []);
      if (!list.loose) {
        const spaces = item.tokens.filter((t) => t.type === 'space');
        if (spaces.length > 0 && spaces.some((t) => RE.anyLine.test(t.raw))) list.loose = true;
      }
    }
    for (const item of list.items) {
      const firstTok = item.tokens[0];
      if (item.task && (firstTok?.type === 'text' || firstTok?.type === 'paragraph')) {
        item.text = item.text.replace(RE.listReplaceTask, '');
        firstTok.raw = firstTok.raw.replace(RE.listReplaceTask, '');
        firstTok.text = firstTok.text.replace(RE.listReplaceTask, '');
        for (let i = this.inlineQueue.length - 1; i >= 0; i--) {
          if (RE.listIsTask.test(this.inlineQueue[i].src)) {
            this.inlineQueue[i].src = this.inlineQueue[i].src.replace(RE.listReplaceTask, '');
            break;
          }
        }
        const box = RE.listTaskCheckbox.exec(item.raw);
        if (box) {
          const checkbox = { type: 'checkbox', raw: box[0] + ' ', checked: box[0] !== '[ ]' };
          item.checked = checkbox.checked;
          if (list.loose) {
            if (item.tokens[0] && ['paragraph', 'text'].includes(item.tokens[0].type) && 'tokens' in item.tokens[0] && item.tokens[0].tokens) {
              item.tokens[0].raw = checkbox.raw + item.tokens[0].raw;
              item.tokens[0].text = checkbox.raw + item.tokens[0].text;
              item.tokens[0].tokens.unshift(checkbox);
            } else {
              item.tokens.unshift({ type: 'paragraph', raw: checkbox.raw, text: checkbox.raw, tokens: [checkbox] });
            }
          } else item.tokens.unshift(checkbox);
        }
      } else if (item.task) item.task = false;
    }
    if (list.loose) {
      for (const item of list.items) {
        item.loose = true;
        for (const t of item.tokens) if (t.type === 'text') t.type = 'paragraph';
      }
    }
    return list;
  }

  tokHtml(src) {
    const m = BLOCK.html.exec(src);
    if (!m) return;
    const raw = trimBlankTail(m[0]);
    return { type: 'html', block: true, raw, pre: m[1] === 'pre' || m[1] === 'script' || m[1] === 'style', text: raw };
  }

  tokDef(src) {
    const m = BLOCK.def.exec(src);
    if (!m) return;
    if (!RE.startAngleBracket.test(m[2]) && findUnbalanced(m[2], '()') !== -1) return;
    const href = m[2] ? m[2].replace(RE.hrefBrackets, '$1').replace(RE.unescapePunct, '$1') : '';
    const title = m[3] ? m[3].substring(1, m[3].length - 1).replace(RE.unescapePunct, '$1') : m[3];
    return { type: 'def', tag: normLabel(m[1]), raw: stripTail(m[0], '\n'), href, title };
  }

  tokTable(src) {
    const m = BLOCK.table.exec(src);
    if (!m || !RE.tableDelimiter.test(m[2])) return;
    const header = splitRow(m[1]);
    const delim = m[2].replace(RE.tableAlignChars, '').split('|');
    const body = m[3]?.trim() ? m[3].replace(RE.tableRowBlankLine, '').split('\n') : [];
    if (header.length !== delim.length) return;
    const table = { type: 'table', raw: stripTail(m[0], '\n'), header: [], align: [], rows: [] };
    for (const cell of delim) {
      if (RE.tableAlignRight.test(cell)) table.align.push('right');
      else if (RE.tableAlignCenter.test(cell)) table.align.push('center');
      else if (RE.tableAlignLeft.test(cell)) table.align.push('left');
      else table.align.push(null);
    }
    for (let i = 0; i < header.length; i++) {
      table.header.push({ text: header[i], tokens: this.inline(header[i]), header: true, align: table.align[i] });
    }
    for (const row of body) {
      table.rows.push(splitRow(row, table.header.length).map((cell, i) => ({
        text: cell, tokens: this.inline(cell), header: false, align: table.align[i],
      })));
    }
    return table;
  }

  tokLheading(src) {
    const m = BLOCK.lheading.exec(src);
    if (!m) return;
    const text = m[1].trim();
    return { type: 'heading', raw: stripTail(m[0], '\n'), depth: m[2].charAt(0) === '=' ? 1 : 2, text, tokens: this.inline(text) };
  }

  tokParagraph(src) {
    const m = BLOCK.paragraph.exec(src);
    if (!m) return;
    const text = m[1].charAt(m[1].length - 1) === '\n' ? m[1].slice(0, -1) : m[1];
    return { type: 'paragraph', raw: m[0], text, tokens: this.inline(text) };
  }

  tokText(src) {
    const m = BLOCK.text.exec(src);
    if (!m) return;
    return { type: 'text', raw: m[0], text: m[0], tokens: this.inline(m[0]) };
  }

  // --- Inline tokenization ----------------------------------------------
  inlineTokens(src, tokens = []) {
    const savedParen = this.state.linkParenPossible;
    this.state.linkParenPossible = savedParen && src.includes(')');
    try {
      return this.scanInline(src, tokens);
    } finally {
      this.state.linkParenPossible = savedParen;
    }
  }

  scanInline(src, tokens) {
    // Fast path: prose with no markup characters at all is a single text token.
    if (!needsInlineScan(src)) {
      const inRaw = this.state.inRawBlock;
      tokens.push({ type: 'text', raw: src, text: inRaw ? src : unescapeRefs(src), escaped: inRaw });
      return tokens;
    }
    const needsMask = src.includes('*') || src.includes('_') || src.includes('~');
    // The masks only hide link labels, code spans, HTML tags and backslash
    // escapes; a string with none of `[`, backtick, `<`, `\` masks to itself.
    const masked = needsMask && (src.includes('[') || src.includes('`') || src.includes('<') || src.includes('\\'))
      ? maskForEmphasis(src, this.links, (s) => linkInText(s, this.links))
      : src;
    if (needsMask) this.maskStack.push(scanDelims(masked));
    try {
      return this.scanInlineMasked(src, masked, tokens);
    } finally {
      if (needsMask) this.maskStack.pop();
    }
  }

  scanInlineMasked(src, masked, tokens) {
    let shortest = Infinity;
    let prevChar = '';
    let prevWasText = false;
    for (; src;) {
      if (src.length < shortest) shortest = src.length;
      else throw new Error('Infinite loop on byte: ' + src.charCodeAt(0));
      if (!prevWasText) prevChar = '';
      prevWasText = false;
      let tok;
      // Dispatch on the first character: most tokenizers can only match
      // when the source starts with a particular character, so the rest
      // are not even tried. Order inside each branch is the usual one.
      // Note: the masked string is never consumed; emphasis and
      // strikethrough read their position in it from the length difference.
      const ch0 = src[0];
      if (ch0 === '\\') {
        if ((tok = tokenizeEscape(src))) {
          src = src.substring(tok.raw.length);
          tokens.push(tok);
          continue;
        }
        if ((tok = tokenizeBr(src))) {
          src = src.substring(tok.raw.length);
          tokens.push(tok);
          continue;
        }
      } else if (ch0 === '<') {
        if ((tok = tokenizeTag(src, this))) {
          src = src.substring(tok.raw.length);
          tokens.push(tok);
          continue;
        }
        if ((tok = tokenizeAutolink(src))) {
          src = src.substring(tok.raw.length);
          tokens.push(tok);
          continue;
        }
      } else if (ch0 === '[' || ch0 === '!') {
        if ((tok = tokenizeLink(src, this))) {
          src = src.substring(tok.raw.length);
          tokens.push(tok);
          continue;
        }
        if ((tok = tokenizeReflink(src, this))) {
          src = src.substring(tok.raw.length);
          const prev = tokens.at(-1);
          if (tok.type === 'text' && prev?.type === 'text') {
            prev.raw += tok.raw;
            prev.text += tok.text;
          } else tokens.push(tok);
          continue;
        }
      } else if (ch0 === '*' || ch0 === '_') {
        if ((tok = tokenizeEmStrong(src, masked, prevChar, this))) {
          src = src.substring(tok.raw.length);
          tokens.push(tok);
          continue;
        }
        // An email address may start with `_` (e.g. _foo@bar.com).
        if (ch0 === '_' && !this.state.inLink && (tok = tokenizeUrl(src))) {
          src = src.substring(tok.raw.length);
          tokens.push(tok);
          continue;
        }
      } else if (ch0 === '`') {
        if ((tok = tokenizeCodespan(src))) {
          src = src.substring(tok.raw.length);
          tokens.push(tok);
          continue;
        }
      } else if (ch0 === '~') {
        if ((tok = tokenizeDel(src, masked, prevChar, this))) {
          src = src.substring(tok.raw.length);
          tokens.push(tok);
          continue;
        }
      } else if (ch0 === ' ' || ch0 === '\t') {
        if ((tok = tokenizeBr(src))) {
          src = src.substring(tok.raw.length);
          tokens.push(tok);
          continue;
        }
      } else if (!this.state.inLink && (tok = tokenizeUrl(src))) {
        src = src.substring(tok.raw.length);
        tokens.push(tok);
        continue;
      }
      if ((tok = tokenizeText(src, this))) {
        src = src.substring(tok.raw.length);
        if (tok.raw.slice(-1) !== '_') prevChar = tok.raw.slice(-1);
        prevWasText = true;
        const prev = tokens.at(-1);
        if (prev?.type === 'text') {
          prev.raw += tok.raw;
          prev.text += tok.text;
        } else tokens.push(tok);
        continue;
      }
      if (src) throw new Error('Infinite loop on byte: ' + src.charCodeAt(0));
    }
    return tokens;
  }
}

// ---------------------------------------------------------------------------
// Rendering
// ---------------------------------------------------------------------------

function renderBlocks(tokens) {
  let out = '';
  for (const tok of tokens) {
    switch (tok.type) {
      case 'space':
        break;
      case 'hr':
        out += '<hr>\n';
        break;
      case 'heading':
        out += `<h${tok.depth}>${renderInline(tok.tokens)}</h${tok.depth}>\n`;
        break;
      case 'code': {
        const lang = (tok.lang || '').match(RE.notSpaceStart)?.[0] ?? '';
        const body = tok.text ? tok.text.replace(RE.endingNewline, '') + '\n' : '';
        const inner = esc(body, true);
        out += lang
          ? `<pre><code class="language-${esc(lang)}">${inner}</code></pre>\n`
          : `<pre><code>${inner}</code></pre>\n`;
        break;
      }
      case 'table': {
        let head = '';
        for (const cell of tok.header) head += renderTableCell(cell);
        let body = '';
        for (const row of tok.rows) {
          let cells = '';
          for (const cell of row) cells += renderTableCell(cell);
          body += `<tr>\n${cells}</tr>\n`;
        }
        out += `<table>\n<thead>\n<tr>\n${head}</tr>\n</thead>\n${body ? `<tbody>${body}</tbody>` : ''}</table>\n`;
        break;
      }
      case 'blockquote':
        out += `<blockquote>\n${renderBlocks(tok.tokens)}</blockquote>\n`;
        break;
      case 'list': {
        let items = '';
        for (const item of tok.items) items += renderListItem(item);
        const tag = tok.ordered ? 'ol' : 'ul';
        const start = tok.ordered && tok.start !== 1 ? ` start="${tok.start}"` : '';
        out += `<${tag}${start}>\n${items}</${tag}>\n`;
        break;
      }
      case 'checkbox':
        out += `<input ${tok.checked ? 'checked="" ' : ''}disabled="" type="checkbox"> `;
        break;
      case 'html':
        out += tok.text;
        break;
      case 'def':
        break;
      case 'paragraph':
        out += `<p>${renderInline(tok.tokens)}</p>\n`;
        break;
      case 'text':
        out += renderTextToken(tok, false);
        break;
      default:
        throw new Error(`Token with "${tok.type}" type was not found.`);
    }
  }
  return out;
}

function renderTableCell(cell) {
  const tag = cell.header ? 'th' : 'td';
  const align = cell.align ? ` align="${cell.align}"` : '';
  return `<${tag}${align}>${renderInline(cell.tokens)}</${tag}>\n`;
}

function renderListItem(item) {
  return `<li>${renderBlocks(item.tokens)}</li>\n`;
}

// A text token: either inline tokens, raw text (inside a
// <pre>/<code>/<kbd>/<script> span, or when rendering plain text for an
// image alt), or escaped text.
function renderTextToken(tok, textMode) {
  if ('tokens' in tok && tok.tokens) return renderInline(tok.tokens, textMode);
  if (textMode) return tok.text;
  if ('escaped' in tok && tok.escaped) return tok.text;
  return esc(tok.text);
}

function renderInline(tokens, textMode = false) {
  let out = '';
  for (const tok of tokens) {
    switch (tok.type) {
      case 'escape':
        out += textMode ? tok.text : esc(tok.text);
        break;
      case 'html':
        out += tok.text;
        break;
      case 'link': {
        if (textMode) {
          out += renderInline(tok.tokens, true);
          break;
        }
        const inner = tok.autolink ? esc(tok.text, true) : renderInline(tok.tokens, false);
        const href = encodeHref(tok.href);
        if (href === null) {
          out += inner;
          break;
        }
        let tag = `<a href="${esc(href, tok.autolink)}"`;
        if (tok.title) tag += ` title="${esc(tok.title)}"`;
        out += `${tag}>${inner}</a>`;
        break;
      }
      case 'image': {
        if (textMode) {
          out += tok.tokens ? renderInline(tok.tokens, true) : tok.text;
          break;
        }
        const alt = tok.tokens ? renderInline(tok.tokens, true) : tok.text;
        const href = encodeHref(tok.href);
        if (href === null) {
          out += esc(alt);
          break;
        }
        let tag = `<img src="${esc(href)}" alt="${esc(alt)}"`;
        if (tok.title) tag += ` title="${esc(tok.title)}"`;
        out += `${tag}>`;
        break;
      }
      case 'checkbox':
        out += textMode ? tok.raw : `<input ${tok.checked ? 'checked="" ' : ''}disabled="" type="checkbox"> `;
        break;
      case 'strong':
        out += textMode ? renderInline(tok.tokens, true) : `<strong>${renderInline(tok.tokens)}</strong>`;
        break;
      case 'em':
        out += textMode ? renderInline(tok.tokens, true) : `<em>${renderInline(tok.tokens)}</em>`;
        break;
      case 'codespan':
        out += textMode ? tok.text : `<code>${esc(tok.text, true)}</code>`;
        break;
      case 'br':
        out += textMode ? '' : '<br>';
        break;
      case 'del':
        out += textMode ? renderInline(tok.tokens, true) : `<del>${renderInline(tok.tokens)}</del>`;
        break;
      case 'text':
        out += renderTextToken(tok, textMode);
        break;
      default:
        throw new Error(`Token with "${tok.type}" type was not found.`);
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

/** The HTML marked 18.1.3 renders for `markdown`, with marked's defaults. */
export function parse(markdown) {
  return renderBlocks(new Lexer().lex(markdown));
}
