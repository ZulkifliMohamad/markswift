// markswift — a fast CommonMark 0.31.2 + GFM renderer whose output matches
// marked 18.1.3 with default options (gfm on, breaks off, pedantic off)
// byte for byte on every case. Dependency-free ES module, no caching
// across cases: parse() computes everything from the markdown it is given.

// ---------------------------------------------------------------- helpers

const ESC_RE = /&(?!(?:#\d{1,7}|#[Xx][0-9A-Fa-f]{1,6}|\w+);)|[<>"']/g;
const ESC_MAP = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };

// Full escape: every & < > " ' is escaped. Used for code spans, code
// blocks, attribute values, autolink text, and characters produced by a
// backslash escape or a numeric entity reference.
function esc(s) {
  return s.replace(/[&<>"']/g, (ch) => ESC_MAP[ch]);
}

// Text escape (marked's escapeNoEncode): & < > " ' are escaped, except an
// & that begins something that looks like an entity reference
// (&name; &#123; &#x1f;) is left alone, so a literal &ouml; in the source
// passes through as &ouml;.
function escText(s) {
  return s.replace(ESC_RE, (ch) => ESC_MAP[ch]);
}

// Remove backslash escapes before ASCII punctuation (\* -> *, \" -> ").
function unescape(s) {
  let out = '';
  for (let i = 0; i < s.length; i++) {
    if (s.charCodeAt(i) === 92 && i + 1 < s.length && isAsciiPunct(s.charCodeAt(i + 1))) {
      out += s[i + 1];
      i++;
    } else {
      out += s[i];
    }
  }
  return out;
}

function cleanUrl(href) {
  try {
    return encodeURI(href).replace(/%25/g, '%');
  } catch (e) {
    return null;
  }
}

function isAsciiPunct(code) {
  return (code >= 33 && code <= 47) || (code >= 58 && code <= 64) ||
    (code >= 91 && code <= 96) || (code >= 123 && code <= 126);
}
// CommonMark punctuation: ASCII punctuation or Unicode category P
// (punctuation) or S (symbol). £ and € are symbols, so they count
// (cm-354: *£* and *€* are not emphasis, like *$*).
const UNICODE_PUNCT = /[\p{P}\p{S}]/u;
function isPunct(code) {
  if (code < 128) return isAsciiPunct(code);
  return UNICODE_PUNCT.test(String.fromCodePoint(code));
}

function isWsCode(code) {
  return code === 32 || code === 9 || code === 10 || code === 11 || code === 12 ||
    code === 13 || code === 0xA0 || code === 0x1680 || (code >= 0x2000 && code <= 0x200A) ||
    code === 0x202F || code === 0x205F || code === 0x3000 || code === 0xFEFF;
}

// Whitespace test for a single character (undefined = start/end of text).
function isWsChar(ch) {
  return ch === undefined || ch === ' ' || ch === '\t' || ch === '\n' || ch === '\r';
}

// Full Unicode case folding for label matching (toLowerCase plus the
// multi-character foldings it does not do: ß -> ss and the Latin ligatures).
function foldCase(s) {
  return s.toLowerCase()
    .replace(/ß/g, 'ss')
    .replace(/ﬀ/g, 'ff').replace(/ﬁ/g, 'fi').replace(/ﬂ/g, 'fl')
    .replace(/ﬃ/g, 'ffi').replace(/ﬄ/g, 'ffl')
    .replace(/ﬅ/g, 'st').replace(/ﬆ/g, 'st');
}

// Normalize a link label: resolve backslash escapes, collapse every run
// of whitespace (including line endings) to one space, trim, fold case.
function normalizeLabel(raw) {
  // Link labels match on the raw text (case-folded, whitespace collapsed).
  // Backslash escapes are NOT resolved for matching (cm-545: '[foo\!]'
  // does not match the definition '[foo!]').
  return foldCase(raw.replace(/\s+/g, ' ').replace(/^ | $/g, ''));
}

// Decode a numeric character reference at text[i] ('&'). Returns the
// decoded character and the index just past the ';', or null.
function numericEntity(text, i) {
  // &#123;  &#x1f;  (1-7 decimal digits, 1-6 hex digits, ';' required)
  if (text[i + 1] !== '#') return null;
  let j = i + 2;
  let code = 0;
  if (text[j] === 'x' || text[j] === 'X') {
    j++;
    const start = j;
    while (j < text.length && j - start < 6) {
      const c = text.charCodeAt(j);
      if ((c >= 48 && c <= 57) || (c >= 65 && c <= 70) || (c >= 97 && c <= 102)) {
        code = code * 16 + (c <= 57 ? c - 48 : (c & 31) + 9);
        j++;
      } else break;
    }
    if (j === start || text[j] !== ';') return null;
  } else {
    const start = j;
    while (j < text.length && j - start < 7) {
      const c = text.charCodeAt(j);
      if (c >= 48 && c <= 57) {
        code = code * 10 + (c - 48);
        j++;
      } else break;
    }
    if (j === start || text[j] !== ';') return null;
  }
  if (code === 0 || code > 0x10FFFF || (code >= 0xD800 && code <= 0xDFFF)) {
    return { ch: '\uFFFD', end: j + 1 };
  }
  return { ch: String.fromCodePoint(code), end: j + 1 };
}

// ---------------------------------------------------------------- inline

// A part is either a literal string node {t:0, s} or a live emphasis
// delimiter node {t:1, ch, len, open, close}. Delimiter nodes keep their
// identity while the emphasis pass wraps content around them.

function flanking(text, i, n) {
  // Delimiter run text[i..i+n). Returns [canOpen, canClose] for '*'/'_'.
  // The start and end of the text count as whitespace.
  const prev = i > 0 ? text[i - 1] : undefined;
  const next = i + n < text.length ? text[i + n] : undefined;
  const prevWs = prev === undefined || isWsCode(prev.charCodeAt(0));
  const nextWs = next === undefined || isWsCode(next.charCodeAt(0));
  const prevPunct = prev !== undefined && isPunct(prev.charCodeAt(0));
  const nextPunct = next !== undefined && isPunct(next.charCodeAt(0));
  const left = !nextWs && (!nextPunct || prevWs || prevPunct);
  const right = !prevWs && (!prevPunct || nextWs || nextPunct);
  return [left, right];
}

// Find the closing ']' of a link label starting at text[i] == '['.
// Balanced brackets count, backslash escapes and code spans are skipped.
// Returns the index of the matching ']' or -1.
function findClosingBracket(text, i, strict) {
  let level = 0;
  // Whether a code span has been consumed in this label. A dangling
  // backtick run invalidates the label only after one was consumed
  // (marked's label regex cannot consume a dangling run once a span has
  // closed); a lone unmatched run is literal text and the label still
  // closes (doc-09: '[docs each ``url`]' forms a link). In loose mode
  // (strict === false) the code-span validity is ignored: the same-length
  // closer rule finds the would-be ']' of a label whose span is invalid.
  let spanConsumed = false;
  for (let j = i; j < text.length; j++) {
    const c = text.charCodeAt(j);
    if (c === 92) { j++; continue; } // backslash escape
    if (c === 96) { // backtick run: skip the whole code span
      let k = j;
      while (k < text.length && text.charCodeAt(k) === 96) k++;
      const n = k - j;
      // 2+ backticks immediately before ']' are literal text (marked's
      // label regex '``+(?=\])' alternative), not a span opener.
      if (strict !== false && n >= 2 && k < text.length && text.charCodeAt(k) === 93) { j = k - 1; continue; }
      // The closer is the NEXT backtick run on this line, of ANY length
      // (marked's label regex closes a span at the next run, since its
      // content may not contain a backtick). A closer on a later line,
      // past the ']' that closes the label, does not count (doc-09).
      // A closer on the same line still protects a ']' inside the code
      // span ('[foo `bar]baz`](/url)'). In loose mode the closer must be
      // the same length (the old rule).
      let m = k;
      let closed = -1;
      let closedLen = 0;
      while (m < text.length && text.charCodeAt(m) !== 10) {
        if (text.charCodeAt(m) === 96) {
          let e = m;
          while (e < text.length && text.charCodeAt(e) === 96) e++;
          if (strict === false && e - m !== n) { m = e; continue; }
          closed = m;
          closedLen = e - m;
          break;
        }
        m++;
      }
      // No closer on this line: if a span was already consumed, the
      // dangling run cannot be consumed by the label regex, so the label
      // has no valid closing bracket (doc-16/18/20/22/23/30: a
      // '`` a ` b ``' span leaves a dangling '``'). Otherwise the run is
      // literal text; skip it and keep looking for ']'.
      if (closed === -1) {
        if (strict !== false && spanConsumed) return -1;
        j = k - 1;
        continue;
      }
      spanConsumed = true;
      j = closed + closedLen - 1;
      continue;
    }
    if (c === 60) { // <: autolink or HTML tag: skip it whole, so a ']' inside
      // it does not close the label (cm-524/526/536/538).
      const al = parseAutolink(text, j);
      if (al) { j = al.end - 1; continue; }
      const te = htmlTagEnd(text, j);
      if (te !== -1) { j = te - 1; continue; }
    }
    if (c === 91) level++;
    else if (c === 93) {
      level--;
      if (level === 0) return j;
    }
  }
  return -1;
}

// Parse a link destination starting at text[i]. Returns {href, end}
// where end is the index just past the destination, or null.
function parseDestination(text, i) {
  if (text[i] === '<') {
    let j = i + 1;
    while (j < text.length) {
      const c = text.charCodeAt(j);
      // A backslash before punctuation escapes it: '\>' is a literal '>',
      // not the closing bracket (cm-493).
      if (c === 92 && j + 1 < text.length && isAsciiPunct(text.charCodeAt(j + 1))) { j += 2; continue; }
      if (c === 62) return { href: text.slice(i + 1, j), end: j + 1 };
      if (c === 10 || c === 60 || c < 32) return null;
      j++;
    }
    return null;
  }
  let j = i;
  let depth = 0;
  while (j < text.length) {
    const c = text.charCodeAt(j);
    if (c === 92) { j += 2; continue; }
    if (c === 32 || c === 9 || c === 10 || c === 13) break;
    if (c === 40) depth++;
    else if (c === 41) {
      if (depth === 0) break;
      depth--;
    } else if (c < 32) return null;
    j++;
  }
  if (depth !== 0) return null;
  return { href: text.slice(i, j), end: j };
}

// Parse an optional link title starting at text[i] (after the destination
// and the whitespace between). Returns {title, end} or null. If the next
// char is not a title opener, returns {title: null, end: i}.
function parseTitle(text, i) {
  const q = text[i];
  if (q !== '"' && q !== "'" && q !== '(') return null;
  const close = q === '(' ? ')' : q;
  let j = i + 1;
  let out = '';
  while (j < text.length) {
    const c = text.charCodeAt(j);
    if (c === 92 && j + 1 < text.length) {
      const d = text.charCodeAt(j + 1);
      if (d === 10) { out += '\n'; j += 2; continue; }
      if (isAsciiPunct(d)) { out += text[j + 1]; j += 2; continue; }
    }
    if (c === close.charCodeAt(0)) return { title: out, end: j + 1 };
    out += text[j];
    j++;
  }
  return null;
}

// Skip spaces/tabs/newlines starting at i.
function skipWs(text, i) {
  while (i < text.length) {
    const c = text.charCodeAt(i);
    if (c === 32 || c === 9 || c === 10 || c === 13) i++;
    else break;
  }
  return i;
}

// Try to parse an inline link "(dest title)" starting at text[i] == '('.
// Returns {href, title, end} or null.
function parseInlineLink(text, i) {
  let j = skipWs(text, i + 1);
  const dest = parseDestination(text, j);
  if (!dest) return null;
  const destEnd = dest.end;
  j = skipWs(text, dest.end);
  let title = null;
  if (text[j] !== ')') {
    // A title must be separated from the destination by whitespace.
    if (j === destEnd) return null;
    const t = parseTitle(text, j);
    if (!t) return null;
    title = t.title;
    j = skipWs(text, t.end);
  }
  if (text[j] !== ')') return null;
  const href = cleanUrl(unescape(dest.href));
  if (href === null) return null;
  return { href, title, end: j + 1 };
}

// Try to parse an autolink <...> starting at text[i] == '<'.
// Returns {html, end} or null.
function parseAutolink(text, i) {
  // <scheme:...>
  let j = i + 1;
  if (j < text.length && /[A-Za-z]/.test(text[j])) {
    let k = j + 1;
    while (k < text.length && /[A-Za-z0-9+.-]/.test(text[k])) k++;
    if (k - j >= 2 && k - j <= 32 && text[k] === ':') {
      let e = k + 1;
      while (e < text.length) {
        const c = text.charCodeAt(e);
        if (c === 62) {
          const url = text.slice(j, e);
          const href = cleanUrl(url);
          if (href === null) return null;
          return { html: '<a href="' + escText(href) + '">' + escText(url) + '</a>', end: e + 1 };
        }
        if (c === 32 || c === 60 || c < 32) break;
        e++;
      }
    }
  }
  // <email>
  const m = /^[A-Za-z0-9.!#$%&'*+\/=?^_`{|}~-]+@[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?(?:\.[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?)*>/.exec(text.slice(i + 1));
  if (m) {
    const email = m[0].slice(0, -1);
    const href = cleanUrl('mailto:' + email);
    if (href === null) return null;
    return { html: '<a href="' + escText(href) + '">' + escText(email) + '</a>', end: i + 1 + m[0].length };
  }
  return null;
}

// Try to parse an inline HTML tag, comment, processing instruction,
// declaration or CDATA section starting at text[i] == '<'.
// Returns the index just past the tag, or -1.
function htmlTagEnd(text, i) {
  if (text.startsWith('<!--', i)) {
    // An abrupt empty comment '<!-->' or '<!--->' ends at its '>'.
    if (text[i + 4] === '>') return i + 5;
    if (text[i + 4] === '-' && text[i + 5] === '>') return i + 6;
    const j = text.indexOf('-->', i + 4);
    return j === -1 ? -1 : j + 3;
  }
  if (text.startsWith('<?', i)) {
    const j = text.indexOf('?>', i + 2);
    return j === -1 ? -1 : j + 2;
  }
  if (text.startsWith('<![CDATA[', i)) {
    const j = text.indexOf(']]>', i + 9);
    return j === -1 ? -1 : j + 3;
  }
  if (text.startsWith('<!', i)) {
    if (i + 2 < text.length && /[A-Za-z]/.test(text[i + 2])) {
      const j = text.indexOf('>', i + 2);
      return j === -1 ? -1 : j + 1;
    }
    return -1;
  }
  let j = i + 1;
  const closing = text[j] === '/';
  if (closing) j++;
  if (j >= text.length || !/[A-Za-z]/.test(text[j])) return -1;
  j++;
  while (j < text.length && /[A-Za-z0-9-]/.test(text[j])) j++;
  if (closing) {
    // A closing tag takes no attributes: only whitespace then '>'.
    while (j < text.length) {
      const c = text.charCodeAt(j);
      if (c === 32 || c === 9 || c === 10 || c === 13) j++;
      else break;
    }
    return text[j] === '>' ? j + 1 : -1;
  }
  // Attributes: each one must be separated from the preceding token by
  // whitespace (cm-609 '<m:abc>' and cm-622 '<a href='bar'title=title>' are
  // not tags). A valueless attribute leaves j at the end of its name so the
  // next iteration counts the whitespace correctly (cm-616 '_boolean').
  for (;;) {
    let k = j;
    let ws = 0;
    while (k < text.length) {
      const c = text.charCodeAt(k);
      if (c === 32 || c === 9 || c === 10 || c === 13) { k++; ws++; }
      else break;
    }
    if (text[k] === '>') return k + 1;
    if (text[k] === '/' && text[k + 1] === '>') return k + 2;
    if (ws === 0) return -1;
    j = k;
    if (j >= text.length || !/[A-Za-z_:]/.test(text[j])) return -1;
    j++;
    while (j < text.length && /[A-Za-z0-9_.:-]/.test(text[j])) j++;
    // Look ahead for '=' without consuming the whitespace after the name.
    let m = j;
    while (m < text.length) {
      const c = text.charCodeAt(m);
      if (c === 32 || c === 9 || c === 10 || c === 13) m++;
      else break;
    }
    if (text[m] === '=') {
      k = m + 1;
      while (k < text.length) {
        const c = text.charCodeAt(k);
        if (c === 32 || c === 9 || c === 10 || c === 13) k++;
        else break;
      }
      if (text[k] === '"') {
        const e = text.indexOf('"', k + 1);
        if (e === -1) return -1;
        j = e + 1;
      } else if (text[k] === "'") {
        const e = text.indexOf("'", k + 1);
        if (e === -1) return -1;
        j = e + 1;
      } else {
        if (k >= text.length) return -1;
        const c = text.charCodeAt(k);
        if (c === 32 || c === 9 || c === 10 || c === 13 || c === 34 || c === 39 ||
          c === 61 || c === 60 || c === 62 || c === 96) return -1;
        while (k < text.length) {
          const d = text.charCodeAt(k);
          if (d === 32 || d === 9 || d === 10 || d === 13 || d === 34 || d === 39 ||
            d === 61 || d === 60 || d === 62 || d === 96) break;
          k++;
        }
        j = k;
      }
    }
    // No '=': valueless attribute; j stays at the end of the name.
  }
}

// Try to parse a code span starting at text[i] == '`'.
// Returns {html, end} or null.
function parseCodeSpan(text, i) {
  let j = i;
  while (j < text.length && text.charCodeAt(j) === 96) j++;
  const n = j - i;
  let m = j;
  while (m < text.length) {
    if (text.charCodeAt(m) === 96) {
      let e = m;
      while (e < text.length && text.charCodeAt(e) === 96) e++;
      if (e - m === n) {
        let content = text.slice(j, m).replace(/\n/g, ' ');
        if (content.length >= 2 && content[0] === ' ' && content[content.length - 1] === ' ' &&
          /[^ ]/.test(content)) {
          content = content.slice(1, -1);
        }
        return { html: '<code>' + esc(content) + '</code>', end: e };
      }
      m = e;
    } else m++;
  }
  return null;
}

// Try to parse a strikethrough ~~...~~ starting at text[i] == '~'.
// Returns {html, end} or null.
function parseDel(text, i, links, inLink) {
  // Marked's del, with nesting: the opener matches the closer that leaves
  // inner same-length openers matched first (depth counting). A run that
  // can close matches the nearest unmatched opener; a run that can only
  // open nests deeper. So '~~a ~~b~~ c~~' is <del>a <del>b</del> c</del>,
  // while '~~a~~b~~c~~' is <del>a</del>b<del>c</del> (a can-both run closes).
  // One or two tildes open (try two first); the content must not start with
  // whitespace or '~', must not end with whitespace/'~'/backslash, and the
  // closer (same run length) must not be followed by '~'.
  for (let run = 2; run >= 1; run--) {
    if (text[i + run - 1] !== '~') continue;
    const start = i + run;
    if (start >= text.length) continue;
    const nc = text.charCodeAt(start);
    if (nc === 32 || nc === 9 || nc === 10 || nc === 13 || nc === 126) continue;
    let depth = 0;
    let j = start;
    while (j < text.length) {
      const c = text.charCodeAt(j);
      if (c === 92 && j + 1 < text.length) { j += 2; continue; } // skip escape
      if (c !== 126) { j++; continue; }
      let k = j;
      while (k < text.length && text.charCodeAt(k) === 126) k++;
      if (k - j !== run) { j = k; continue; } // different length, skip
      const prev = text.charCodeAt(j - 1);
      // A '~' before the closer blocks it only when it is a real
      // delimiter: an ESCAPED '~' (odd backslashes before it, e.g. the
      // '\~' in doc-15 '~~run \~~~') is literal content and does not
      // block (the content 'run \~' renders as 'run ~' inside the del).
      let prevIsDelim = prev === 126;
      if (prevIsDelim) {
        let nb = 0;
        let p = j - 2;
        while (p >= 0 && text.charCodeAt(p) === 92) { nb++; p--; }
        if (nb % 2 === 1) prevIsDelim = false;
      }
      const prevOk = prev !== 32 && prev !== 9 && prev !== 10 && prev !== 13 &&
        prev !== 92 && !prevIsDelim;
      const after = k < text.length ? text.charCodeAt(k) : -1;
      const canClose = prevOk && (after === -1 || after !== 126);
      const canOpen = after !== -1 && after !== 32 && after !== 9 && after !== 10 &&
        after !== 13 && after !== 126;
      if (canClose) {
        if (depth === 0) {
          const inner = inline(text.slice(start, j), links, inLink);
          return { html: '<del>' + inner + '</del>', end: k };
        }
        depth--;
      } else if (canOpen) {
        depth++;
      }
      j = k;
    }
  }
  return null;
}

// A valid domain segment: starts and ends alphanumeric, hyphens inside.
function domainSegment(text, i) {
  if (i >= text.length) return -1;
  const c0 = text.charCodeAt(i);
  if (!((c0 >= 48 && c0 <= 57) || (c0 >= 65 && c0 <= 90) || (c0 >= 97 && c0 <= 122))) return -1;
  let j = i + 1;
  while (j < text.length) {
    const c = text.charCodeAt(j);
    if ((c >= 48 && c <= 57) || (c >= 65 && c <= 90) || (c >= 97 && c <= 122) || c === 45) j++;
    else break;
  }
  if (j - i > 63) return -1;
  if (text.charCodeAt(j - 1) === 45) return -1;
  return j;
}

// Parse a domain starting at i: segments joined by '.', at least one dot.
// Returns the index just past the domain, or -1.
function parseDomain(text, i) {
  let j = domainSegment(text, i);
  if (j === -1) return -1;
  let dots = 0;
  while (text[j] === '.') {
    const k = domainSegment(text, j + 1);
    if (k === -1) break;
    dots++;
    j = k;
  }
  if (dots === 0) return -1;
  return j;
}

// Parse an email address starting at i. Returns {email, end} or null.
// The domain must contain a dot.
function parseEmail(text, i) {
  let j = i;
  while (j < text.length) {
    const c = text.charCodeAt(j);
    if ((c >= 48 && c <= 57) || (c >= 65 && c <= 90) || (c >= 97 && c <= 122) ||
      ".!#$%&'*+/=?^_`{|}~-".indexOf(text[j]) !== -1) j++;
    else break;
  }
  if (j === i || text[j] !== '@') return null;
  const d = parseDomain(text, j + 1);
  if (d === -1) return null;
  // Marked's GFM email ends with (?![\w-]): a word char or '-' right after
  // the domain invalidates the whole address (gfm-632/633: 'a.b-'/'a.b_').
  if (d < text.length && /[\w-]/.test(text[d])) return null;
  return { email: text.slice(i, d), end: d };
}

// GFM extended-autolink email: marked's /[A-Za-z0-9._+-]+@...(?![\w-])/.
// The local part is narrower than CommonMark's (no !#$%&'*+/=?^`{|}~).
// Is there an unmatched '_' emphasis opener before position pos? Used by
// the GFM email lookahead: a '_' that closes emphasis (the closing '__'
// in '__foo bar@example.com__') is a delimiter, not a word char, so it
// must not block the email. A literal trailing '_' (gfm-633: 'a.b_') has
// no opener before it, so it still blocks.
function hasUnderscoreOpener(delims, pos) {
  if (!delims) return false;
  for (let k = 0; k < delims.length; k++) {
    const d = delims[k];
    if (d.ch === '_' && d.open && d.len > 0 && d.pos < pos) return true;
  }
  return false;
}

function parseGfmEmail(text, i, delims) {
  let j = i;
  while (j < text.length) {
    const c = text.charCodeAt(j);
    if ((c >= 48 && c <= 57) || (c >= 65 && c <= 90) || (c >= 97 && c <= 122) ||
      c === 46 || c === 95 || c === 43 || c === 45) j++;
    else break;
  }
  if (j === i || text[j] !== '@') return null;
  const d = parseDomain(text, j + 1);
  if (d === -1) return null;
  if (d < text.length && /[\w-]/.test(text[d])) {
    // A '_' that closes emphasis is a delimiter, not a word char.
    if (!(text.charCodeAt(d) === 95 && hasUnderscoreOpener(delims, d))) return null;
  }
  return { email: text.slice(i, d), end: d };
}

// Strip trailing punctuation, entity references and unbalanced ')', the
// way GFM extended autolinks do. Returns the trimmed end index.
function trimAutolinkEnd(text, i, end) {
  // A '(' must open a balanced group (marked's _backpedal): truncate at
  // the first '(' that has no ')' after it in the candidate. Any '('
  // before the last ')' is balanced; the first '(' after it is not, so
  // the URL ends there (e.g. 'https://a.io)](https://b.io' ends at
  // 'https://a.io)]', the '(' starting a second URL is literal).
  let lastClose = -1;
  for (let k = end - 1; k >= i; k--) {
    if (text.charCodeAt(k) === 41) { lastClose = k; break; }
  }
  for (let k = lastClose === -1 ? i : lastClose + 1; k < end; k++) {
    if (text.charCodeAt(k) === 40) { end = k; break; }
  }
  for (;;) {
    // trailing entity reference &name; / &#12; / &#x1f;
    if (end > i && text.charCodeAt(end - 1) === 59) {
      let k = end - 2;
      while (k >= i && /[A-Za-z0-9#]/.test(text[k])) k--;
      if (k >= i && text.charCodeAt(k) === 38) {
        const body = text.slice(k + 1, end - 1);
        if (/^(?:#\d{1,7}|#[Xx][0-9A-Fa-f]{1,6}|\w+)$/.test(body)) {
          end = k;
          continue;
        }
      }
    }
    // trailing punctuation ? ! . , : ; * _ ~ ' "
    if (end > i) {
      const c = text.charCodeAt(end - 1);
      if (c === 63 || c === 33 || c === 46 || c === 44 || c === 58 || c === 59 ||
        c === 42 || c === 95 || c === 126 || c === 39 || c === 34) {
        end--;
        continue;
      }
    }
    // trailing ')' without a matching '(': only the LAST ')' is a
    // candidate, and only when no unmatched '(' precedes it. A ')' that
    // closes an open '(' is balanced and stays (doc-12: the ')' after
    // 'page=4' is unbalanced but mid-URL, while the final ')' closes the
    // '(' before './docs/create.md', so the URL keeps both).
    if (end > i && text.charCodeAt(end - 1) === 41) {
      let depth = 0;
      for (let k = i; k < end - 1; k++) {
        if (text.charCodeAt(k) === 40) depth++;
        else if (text.charCodeAt(k) === 41 && depth > 0) depth--;
      }
      if (depth === 0) {
        end--;
        continue;
      }
    }
    return end;
  }
}

// Try a GFM extended autolink (www. / scheme: / bare email) at text[i].
// prevOk is true when the char before i is the start, whitespace or one
// of * _ ~ (. Returns {html, end} or null.
function parseExtendedAutolink(text, i, prevOk, delims) {
  if (!prevOk) return null;
  const n = text.length;
  let end = -1;
  let href = null;
  let display = null;
  let kind = -1; // 0 = www., 1 = scheme:, 2 = bare email
  if (text.startsWith('www.', i)) {
    const d = parseDomain(text, i + 4);
    if (d === -1) return null;
    end = d;
    kind = 0;
    while (end < n) {
      const c = text.charCodeAt(end);
      if (c === 32 || c === 9 || c === 10 || c === 13 || c === 60) break;
      end++;
    }
    display = text.slice(i, end);
    href = 'http://' + display;
  } else if (i + 1 < n && /[A-Za-z]/.test(text[i])) {
    let k = i + 1;
    while (k < n && /[A-Za-z0-9+.-]/.test(text[k])) k++;
    if (k - i >= 2 && k - i <= 32 && text[k] === ':') {
      const after = k + 1;
      if (text.startsWith('//', after)) {
        const d = parseDomain(text, after + 2);
        if (d === -1) return null;
        end = d;
        kind = 1;
        while (end < n) {
          const c = text.charCodeAt(end);
          if (c === 32 || c === 9 || c === 10 || c === 13 || c === 60) break;
          end++;
        }
        display = text.slice(i, end);
        href = display;
      } else {
        const em = parseGfmEmail(text, after, delims);
        if (!em) return null;
        end = em.end;
        kind = 1;
        // xmpp: takes an optional /resource suffix (gfm-634/635).
        if (text.slice(i, k).toLowerCase() === 'xmpp' && end < n && text[end] === '/') {
          let p = end + 1;
          while (p < n) {
            const c = text.charCodeAt(p);
            if ((c >= 48 && c <= 57) || (c >= 65 && c <= 90) || (c >= 97 && c <= 122) ||
              c === 64 || c === 46) p++;
            else break;
          }
          if (p > end + 1) end = p;
        }
        display = text.slice(i, end);
        href = display;
      }
    }
    // Not a scheme: fall through and try a bare email below.
    if (end === -1) {
      const em = parseGfmEmail(text, i, delims);
      if (!em) return null;
      end = em.end;
      kind = 2;
      display = em.email;
      href = 'mailto:' + display;
    }
  } else {
    const em = parseGfmEmail(text, i, delims);
    if (!em) return null;
    end = em.end;
    kind = 2;
    display = em.email;
    href = 'mailto:' + display;
  }
  if (end === -1 || end <= i) return null;
  end = trimAutolinkEnd(text, i, end);
  if (end <= i) return null;
  display = text.slice(i, end);
  if (kind === 0) href = 'http://' + display;
  else if (kind === 2) href = 'mailto:' + display;
  else href = display;
  const clean = cleanUrl(href);
  if (clean === null) return null;
  return { html: '<a href="' + escText(clean) + '">' + escText(display) + '</a>', end };
}

// Is the char before position pos a valid start for an extended autolink:
// the start of the text, whitespace, or one of * _ ~ ( < ?
function prevOkAt(text, pos) {
  if (pos === 0) return true;
  const c = text.charCodeAt(pos - 1);
  return c === 32 || c === 9 || c === 10 || c === 13 || c === 42 || c === 95 ||
    c === 126 || c === 40 || c === 60;
}

function isEmailLocalChar(code) {
  return (code >= 48 && code <= 57) || (code >= 65 && code <= 90) ||
    (code >= 97 && code <= 122) ||
    ".!#$%&'*+/=?^_`{|}~-".indexOf(String.fromCharCode(code)) !== -1;
}

// Find the first position in text[i..end) that could start a GFM extended
// autolink (www. / scheme: / email). Returns the start index or -1.
function findAutolinkStart(text, i, end) {
  let p = i;
  while (p < end) {
    const w = text.indexOf('www.', p);
    const at = text.indexOf('@', p);
    const col = text.indexOf(':', p);
    let cand = -1;
    let kind = 0;
    if (w !== -1 && w < end && (cand === -1 || w < cand)) { cand = w; kind = 1; }
    if (at !== -1 && at < end && (cand === -1 || at < cand)) { cand = at; kind = 2; }
    if (col !== -1 && col < end && (cand === -1 || col < cand)) { cand = col; kind = 3; }
    if (cand === -1) return -1;
    if (kind === 1) {
      if (prevOkAt(text, cand)) return cand;
      p = cand + 1;
    } else if (kind === 2) {
      let L = cand;
      while (L > i && isEmailLocalChar(text.charCodeAt(L - 1))) L--;
      if (L < cand && prevOkAt(text, L)) return L;
      p = cand + 1;
    } else {
      let S = cand;
      while (S > i && /[A-Za-z0-9+.-]/.test(text[S - 1])) S--;
      if (cand - S >= 2 && cand - S <= 32 && /[A-Za-z]/.test(text[S]) &&
        prevOkAt(text, S)) return S;
      p = cand + 1;
    }
  }
  return -1;
}

// Does a link label hold a backtick run of length >= 2 whose next
// backtick run in the label is a different length, with no same-length
// run later in the label (so the run cannot form a valid same-length
// code span)? Such a link suppresses emphasis that follows it up to the
// last code span in the same inline run (doc-28/16/35). A label that
// DOES hold a same-length closer later (doc-33: 'less `` a ` b ``'
// renders '<code>a ` b</code>') is not a trigger.
function labelHasMismatch(labelText) {
  const runs = [];
  let i = 0;
  while (i < labelText.length) {
    if (labelText.charCodeAt(i) === 96) {
      let j = i;
      while (j < labelText.length && labelText.charCodeAt(j) === 96) j++;
      runs.push(j - i);
      i = j;
    } else i++;
  }
  for (let r = 0; r < runs.length; r++) {
    const n = runs[r];
    if (n < 2) continue;
    let hasSameLater = false;
    for (let s = r + 1; s < runs.length; s++) {
      if (runs[s] === n) { hasSameLater = true; break; }
    }
    if (hasSameLater) continue;
    if (r + 1 < runs.length && runs[r + 1] !== n) return true;
  }
  return false;
}

// The emphasis pass: match delimiter pairs and wrap the content between
// them in <em>/<strong>. Operates on the parts array in place.
function processEmphasis(parts, delims, suppress) {
  // Matched spans, as [openPos, closePos] text indices. An opener lying
  // strictly inside a matched span cannot be used: it would cross the
  // span's tags (cm-469/470).
  const spans = [];
  const insideSpan = (pos) => {
    for (let s = 0; s < spans.length; s++) {
      if (pos > spans[s][0] && pos < spans[s][1]) return true;
    }
    return false;
  };
  for (let di = 0; di < delims.length; di++) {
    const closer = delims[di];
    if (!closer.close || closer.len === 0) continue;
    // Longest original length of a spent can-both delimiter (opener-only
    // match) this closer has passed. Rule (b) below blocks a later pair
    // when this is at least the closer's length.
    let passedOlen = 0;
    // Look backwards for openers. After a match, if the closer still has
    // delimiters left, keep looking for an earlier opener (cm-409), and
    // if the same opener still has delimiters left, retry it (a run of 3
    // forms <strong> then <em>, cm-416/417/464/467).
    let dj = di - 1;
    while (closer.len > 0 && dj >= 0) {
      const opener = delims[dj];
      if (opener.ch !== closer.ch || !opener.open || opener.len === 0) {
        // (a) A spent can-both delimiter whose opener was opener-only
        // blocks a single-delimiter closer when it was LONGER than the
        // closer (doc-03: '*first changes **code**request*', spent '**'
        // vs single '*'). cm-411 (opener could close) and doc-06 (spent
        // '*' same length as the closer) pass it by. A longer closer
        // (e.g. '**') passes it by as well, for a strong.
        if (opener.ch === closer.ch && opener.open && opener.close &&
          opener.len === 0 && closer.len === 1 && opener.mOO &&
          opener.olen > closer.len) break;
        // Passing a spent can-both delimiter whose opener was opener-only
        // arms rule (b) for the next opener this closer reaches.
        if (opener.ch === closer.ch && opener.open && opener.close &&
          opener.len === 0 && opener.mOO) passedOlen = Math.max(passedOlen, opener.olen);
        dj--;
        continue;
      }
      if (insideSpan(opener.pos)) { dj--; continue; }
      // Odd-match rule (spec rule 9/10): if either side can both open and
      // close, and the sum of the lengths is a multiple of 3, they cannot
      // match unless both lengths are multiples of 3 (cm-411/412).
      if ((opener.open && opener.close) || (closer.open && closer.close)) {
        const sum = opener.len + closer.len;
        if (sum % 3 === 0 && !(opener.len % 3 === 0 && closer.len % 3 === 0)) { dj--; continue; }
      }
      // (b) After passing a spent can-both delimiter whose opener was
      // opener-only, a pair whose lengths sum to a multiple of 3 (not
      // both multiples) cannot match — but only when the passed
      // delimiter was at least as long as the closer (doc-11: the spent
      // '**' is as long as the '**' closer, so the '*' opener is skipped
      // and the '**' opener matches for a strong; doc-04: the spent '*'
      // is shorter than the '**' closer, so the '*' opener matches for
      // an em; doc-06, sum 1+1=2, matches too). '**a *b* c* d**' — where
      // the spent delimiter was closer-only, so nothing was passed —
      // matches it as well.
      if (passedOlen >= closer.len) {
        const sum = opener.len + closer.len;
        if (sum % 3 === 0 && !(opener.len % 3 === 0 && closer.len % 3 === 0)) { dj--; continue; }
      }
      // Mismatched-label link suppression (doc-28/16/35): after a link
      // whose label holds a backtick run of length >= 2 closed by a run
      // of a different length, an emphasis span is suppressed when a
      // code span follows it in the same inline run. The delimiters
      // stay literal. (The link end precedes the opener; a code span
      // starts after the closer.)
      if (suppress && suppress.linkEnds.length > 0 && suppress.codeStarts.length > 0) {
        let linkBefore = false;
        for (let q = 0; q < suppress.linkEnds.length; q++) {
          if (suppress.linkEnds[q] <= opener.pos) { linkBefore = true; break; }
        }
        if (linkBefore) {
          let codeAfter = false;
          for (let q = 0; q < suppress.codeStarts.length; q++) {
            if (suppress.codeStarts[q] > closer.pos) { codeAfter = true; break; }
          }
          if (codeAfter) { dj--; continue; }
        }
      }
      const use = (opener.len >= 2 && closer.len >= 2) ? 2 : 1;
      const openTag = use === 2 ? '<strong>' : '<em>';
      const closeTag = use === 2 ? '</strong>' : '</em>';
      const oi = parts.indexOf(opener);
      const ci = parts.indexOf(closer);
      if (oi === -1 || ci === -1 || oi >= ci) break;
      // The close tag normally goes before the closer node, so a leftover
      // delimiter renders after it ('**foo***' -> '<strong>foo</strong>*').
      // But when the closer passed a spent can-both delimiter to reach
      // this opener AND the match is a strong (use 2), the leftover
      // renders BEFORE the close tag, inside the emphasis (doc-11:
      // '**return that *old*two***' -> '<strong>...two*</strong>'; the
      // inner '*' after 'old' is can-both there, closer-only in
      // '**a *b* c***' where the leftover stays out; doc-04 is an em
      // (use 1), so its leftover stays out too).
      parts.splice(passedOlen > 0 && use === 2 ? ci + 1 : ci, 0, { t: 0, s: closeTag });
      parts.splice(oi + 1, 0, { t: 0, s: openTag });
      opener.len -= use;
      closer.len -= use;
      // Remember whether this closer's opener could itself close: a later
      // single-delimiter closer is blocked by this spent delimiter only
      // when its opener was opener-only (see the block rule above).
      closer.mOO = !opener.close;
      if (opener.len === 0) parts.splice(parts.indexOf(opener), 1);
      if (closer.len === 0) parts.splice(parts.indexOf(closer), 1);
      spans.push([opener.pos, closer.pos]);
      if (opener.len > 0 && closer.len > 0) continue;
      dj--;
    }
  }
}

function renderParts(parts) {
  let out = '';
  for (const p of parts) {
    if (p.t === 0) out += p.s;
    else out += p.ch.repeat(p.len);
  }
  return out;
}

// Render one image's alt text: backslash escapes and numeric entities
// are processed, but no other inline formatting happens.
function plainText(s) {
  return labelAltText(s, {});
}

// Does the label text itself contain a link? A link cannot contain a link,
// so an outer link whose label contains one does not form (cm-518/519/532/533).
function labelHasLink(labelText, links) {
  if (labelText.indexOf('[') === -1) return false;
  return inlineSaved(labelText, links, false).indexOf('<a href="') !== -1;
}

// Image alt text: render the label as inline (inner links resolve to their
// text, emphasis is flattened), then strip all tags, leaving already-escaped
// plain text (cm-520/573/574/575/576/577/585/589). An inner image contributes
// its own alt text (cm-574: '![foo ![bar](/url)](/url2)' -> alt 'foo bar').
function labelAltText(labelText, links) {
  const html = inlineSaved(labelText, links, false);
  let out = '';
  let k = 0;
  while (k < html.length) {
    if (html[k] === '<') {
      const e = html.indexOf('>', k);
      if (e === -1) { out += html.slice(k); break; }
      const tag = html.slice(k, e + 1);
      if (tag.startsWith('<img ')) {
        const a = tag.indexOf(' alt="');
        if (a !== -1) {
          const v = tag.indexOf('"', a + 6);
          if (v !== -1) out += tag.slice(a + 6, v);
        }
      }
      k = e + 1;
    } else {
      out += html[k];
      k++;
    }
  }
  return out;
}

// Parse inline markdown to HTML. links maps normalized labels to
// Inline rendering that does not let an <a> tag inside the extracted text
// change the document-level inLinkHtml (marked saves/restores inLink around
// link-text and alt-text tokenization; an <a> there does not persist, while
// an <a> inside del/emphasis content does).
function inlineSaved(text, links, inLink, noEm) {
  const saved = inLinkHtml;
  const out = inline(text, links, inLink, noEm);
  inLinkHtml = saved;
  return out;
}

// {href, title}. inLink disables link parsing (links cannot contain links).
// noEm disables emphasis and strikethrough (a failed inline-link attempt
// renders its label literally: code spans still render, but '_..._' and
// '*...*' inside do not form emphasis, doc-16/20/23).
function inline(text, links, inLink, noEm) {
  const parts = [];
  const delims = [];
  // Mismatched-label link ends and code-span starts (text indices), for
  // the emphasis suppression in processEmphasis (doc-28/16/35).
  const mismatchLinkEnds = [];
  const codeSpanStarts = [];
  let buf = '';
  const flush = () => {
    if (buf) {
      parts.push({ t: 0, s: escText(buf) });
      buf = '';
    }
  };
  let i = 0;
  const n = text.length;
  while (i < n) {
    const c = text.charCodeAt(i);
    if (c === 92) { // backslash
      const d = text[i + 1];
      if (d === '\n') {
        flush();
        parts.push({ t: 0, s: '<br>' });
        i += 2;
        // A hard break swallows the next line's leading whitespace (cm-637).
        while (i < n && (text.charCodeAt(i) === 32 || text.charCodeAt(i) === 9)) i++;
        continue;
      }
      if (d !== undefined && isAsciiPunct(d.charCodeAt(0))) {
        buf += esc(d);
        i += 2;
        continue;
      }
      buf += '\\';
      i++;
      continue;
    }
    if (c === 96) { // backtick: code span
      const cs = parseCodeSpan(text, i);
      if (cs) {
        flush();
        parts.push({ t: 0, s: cs.html });
        codeSpanStarts.push(i);
        i = cs.end;
        continue;
      }
      // No matching closer for this run: the whole run is literal text
      // (cm-347: ```foo`` has no code span; a sub-run is not an opener).
      let j = i;
      while (j < n && text.charCodeAt(j) === 96) j++;
      buf += text.slice(i, j);
      i = j;
      continue;
    }
    if (c === 42 || c === 95) { // * or _: emphasis delimiter run
      const ch = text[i];
      let j = i;
      while (j < n && text.charCodeAt(j) === c) j++;
      const len = j - i;
      if (noEm) { buf += ch.repeat(len); i = j; continue; }
      const [left, right] = flanking(text, i, len);
      let canOpen;
      let canClose;
      if (ch === '*') {
        canOpen = left;
        canClose = right;
      } else {
        canOpen = left && (!right || isWsChar(text[i - 1]) || (text[i - 1] !== undefined && isPunct(text.charCodeAt(i - 1))));
        canClose = right && (!left || isWsChar(text[j]) || (text[j] !== undefined && isPunct(text.charCodeAt(j))));
      }
      if (!canOpen && !canClose) {
        buf += ch.repeat(len);
      } else {
        flush();
        const node = { t: 1, ch, len, olen: len, open: canOpen, close: canClose, pos: i };
        parts.push(node);
        delims.push(node);
      }
      i = j;
      continue;
    }
    if (c === 126) { // ~: strikethrough
      if (noEm) { buf += '~'; i++; continue; }
      const d = parseDel(text, i, links, inLink);
      if (d) {
        flush();
        parts.push({ t: 0, s: d.html });
        i = d.end;
        continue;
      }
      buf += '~';
      i++;
      continue;
    }
    if (c === 91 || (c === 33 && text[i + 1] === '[')) { // [ or ![
      const isImage = c === 33;
      const start = isImage ? i + 1 : i;
      const close = findClosingBracket(text, start);
      if (close !== -1) {
        const labelText = text.slice(start + 1, close);
        let done = false;
        // A link cannot contain a link: if the label itself contains a link,
        // the outer link does not form (the inner one will, when it is scanned).
        // Images are exempt: their label is alt text (cm-518/519/532/533).
        const blocked = !isImage && !inLink && labelHasLink(labelText, links);
        if (!blocked) {
          if (text[close + 1] === '(') {
            const link = parseInlineLink(text, close + 1);
            if (link) {
              flush();
              if (isImage) {
                const alt = labelAltText(labelText, links);
                parts.push({ t: 0, s: '<img src="' + escText(link.href) + '" alt="' + alt + '"' + (link.title !== null ? ' title="' + escText(link.title) + '"' : '') + '>' });
              } else if (!inLink) {
                const inner = inlineSaved(labelText, links, true);
                parts.push({ t: 0, s: '<a href="' + escText(link.href) + '"' + (link.title !== null ? ' title="' + escText(link.title) + '"' : '') + '>' + inner + '</a>' });
              } else {
                parts.push({ t: 0, s: escText(text.slice(i, link.end)) });
              }
              i = link.end;
              done = true;
            } else {
              // Inline link invalid: fall back to a shortcut reference (cm-568).
              const ref = links[normalizeLabel(labelText)];
              if (ref) {
                flush();
                if (isImage) {
                  const alt = labelAltText(labelText, links);
                  parts.push({ t: 0, s: '<img src="' + escText(ref.href) + '" alt="' + alt + '"' + (ref.title !== null ? ' title="' + escText(ref.title) + '"' : '') + '>' });
                } else if (!inLink) {
                  const inner = inlineSaved(labelText, links, true);
                  parts.push({ t: 0, s: '<a href="' + escText(ref.href) + '"' + (ref.title !== null ? ' title="' + escText(ref.title) + '"' : '') + '>' + inner + '</a>' });
                } else {
                  parts.push({ t: 0, s: escText(text.slice(i, close + 1)) });
                }
                i = close + 1;
                done = true;
              }
            }
          } else if (text[close + 1] === '[') {
            const close2 = findClosingBracket(text, close + 1);
            if (close2 !== -1) {
              const refLabel = close2 === close + 2 ? labelText : text.slice(close + 2, close2);
              const ref = links[normalizeLabel(refLabel)];
              if (ref) {
                flush();
                if (isImage) {
                  const alt = labelAltText(labelText, links);
                  parts.push({ t: 0, s: '<img src="' + escText(ref.href) + '" alt="' + alt + '"' + (ref.title !== null ? ' title="' + escText(ref.title) + '"' : '') + '>' });
                } else if (!inLink) {
                  const inner = inlineSaved(labelText, links, true);
                  parts.push({ t: 0, s: '<a href="' + escText(ref.href) + '"' + (ref.title !== null ? ' title="' + escText(ref.title) + '"' : '') + '>' + inner + '</a>' });
                } else {
                  parts.push({ t: 0, s: escText(text.slice(i, close2 + 1)) });
                }
                i = close2 + 1;
                done = true;
              }
            }
          } else {
            const ref = links[normalizeLabel(labelText)];
            if (ref) {
              flush();
              if (isImage) {
                const alt = labelAltText(labelText, links);
                parts.push({ t: 0, s: '<img src="' + escText(ref.href) + '" alt="' + alt + '"' + (ref.title !== null ? ' title="' + escText(ref.title) + '"' : '') + '>' });
              } else if (!inLink) {
                const inner = inlineSaved(labelText, links, true);
                parts.push({ t: 0, s: '<a href="' + escText(ref.href) + '"' + (ref.title !== null ? ' title="' + escText(ref.title) + '"' : '') + '>' + inner + '</a>' });
              } else {
                parts.push({ t: 0, s: escText(text.slice(i, close + 1)) });
              }
              i = close + 1;
              done = true;
            }
          }
        }
        if (done) {
          // A link whose label holds a mismatched backtick run suppresses
          // emphasis that follows it up to the last code span (doc-28).
          // i is the link end here (set by the sub-case that formed it).
          if (!isImage && labelHasMismatch(labelText)) mismatchLinkEnds.push(i);
          // Code spans inside a formed link's label count as code spans
          // after an emphasis for the suppression (doc-16: '`a_b`' lives
          // inside '[previous `a_b`](./docs/we.md)'). The label starts at
          // start+1 in the outer text.
          if (!isImage) {
            let p = 0;
            while (p < labelText.length) {
              if (labelText.charCodeAt(p) === 96) {
                const cs = parseCodeSpan(labelText, p);
                if (cs) { codeSpanStarts.push(start + 1 + p); p = cs.end; continue; }
              }
              p++;
            }
          }
          continue;
        }
        // A failed inline-link attempt '[label](...)' renders its label
        // literally: code spans still render, but '_..._'/'*...*' inside
        // do not form emphasis (doc-16/20/23). Only when the next char
        // is '(' (an inline-link attempt); a failed reference/shortcut
        // still parses its label normally ('[but _foo bar_]' forms <em>).
        // Images and blocked (label-contains-link) cases are exempt.
        if (!isImage && !blocked && text[close + 1] === '(') {
          flush();
          parts.push({ t: 0, s: '[' + inlineSaved(labelText, links, inLink, true) + ']' });
          i = close + 1;
          continue;
        }
      } else {
        // No valid closing bracket (the label's code span is invalid):
        // find the would-be ']' and, if an inline-link attempt follows,
        // render the label literally without emphasis (doc-16/20/23).
        if (!isImage) {
          const loose = findClosingBracket(text, start, false);
          if (loose !== -1 && text[loose + 1] === '(') {
            flush();
            parts.push({ t: 0, s: '[' + inlineSaved(text.slice(start + 1, loose), links, inLink, true) + ']' });
            i = loose + 1;
            continue;
          }
        }
      }
      buf += text[i];
      i++;
      continue;
    }
    if (c === 60) { // <: autolink, html tag, or literal
      // A <...> autolink forms even inside link text (marked nests it:
      // '[a <https://x.com> b](url)' keeps the inner autolink). Only bare
      // URL/email autolinks are gated by inLink.
      const al = parseAutolink(text, i);
      if (al) {
        flush();
        parts.push({ t: 0, s: al.html });
        i = al.end;
        continue;
      }
      const te = htmlTagEnd(text, i);
      if (te !== -1) {
        // An inline <a ...> tag sets the persistent inLink state (bare
        // URL/email autolinks stop forming until a </a> clears it, doc-03);
        // an HTML block's <a> does not reach here, so it never sets it.
        // Marked's patterns: start '<a ' (space, not just '<a>'), end
        // '</a>' (no space before '>').
        const tag = text.slice(i, te);
        if (!inLinkHtml && /^<a /i.test(tag)) inLinkHtml = true;
        else if (inLinkHtml && /^<\/a>/i.test(tag)) inLinkHtml = false;
        flush();
        parts.push({ t: 0, s: tag });
        i = te;
        continue;
      }
      buf += '&lt;';
      i++;
      continue;
    }
    if (c === 38) { // &: numeric entity, or plain text
      const e = numericEntity(text, i);
      if (e) {
        buf += esc(e.ch);
        i = e.end;
        continue;
      }
      buf += '&';
      i++;
      continue;
    }
    if (c === 10) { // newline: hard break if 2+ spaces before it
      let k = buf.length;
      while (k > 0 && buf.charCodeAt(k - 1) === 32) k--;
      if (buf.length - k >= 2) {
        buf = buf.slice(0, k);
        flush();
        parts.push({ t: 0, s: '<br>' });
        i++;
        // A hard break swallows the next line's leading whitespace (cm-636).
        while (i < n && (text.charCodeAt(i) === 32 || text.charCodeAt(i) === 9)) i++;
      } else {
        buf += '\n';
        i++;
      }
      continue;
    }
    // plain text run up to the next special char, stopping early at a
    // possible GFM extended autolink (www. / scheme: / email). Inside link
    // text (inLink) or after an unclosed inline <a> tag (inLinkHtml) no
    // bare URL/email autolink forms (doc-01, doc-03).
    let j = i;
    while (j < n) {
      const d = text.charCodeAt(j);
      if (d === 92 || d === 96 || d === 42 || d === 95 || d === 126 || d === 91 ||
        d === 60 || d === 38 || d === 10 || (d === 33 && text[j + 1] === '[')) break;
      j++;
    }
    const cand = (inLink || inLinkHtml) ? -1 : (() => {
      // The autolink search window extends past '_', '*', '~' (valid in
      // email local parts but run-breaking) to the next hard boundary, so
      // 'a.b-c_d@a.b' is found even though '_' ends the plain-text run.
      let wj = j;
      while (wj < n) {
        const d = text.charCodeAt(wj);
        if (d === 32 || d === 9 || d === 10 || d === 13 || d === 60 || d === 96 ||
          d === 92 || d === 91 || d === 38) break;
        wj++;
      }
      const c = findAutolinkStart(text, i, wj);
      // Only act on an autolink that starts inside this run; one starting
      // after the run boundary is found after the delimiter is processed.
      return c !== -1 && c < j ? c : -1;
    })();
    if (cand === -1) {
      buf += text.slice(i, j);
      i = j;
    } else {
      if (cand > i) buf += text.slice(i, cand);
      const al = parseExtendedAutolink(text, cand, true, delims);
      if (al) {
        flush();
        parts.push({ t: 0, s: al.html });
        i = al.end;
      } else {
        buf += text[cand];
        i = cand + 1;
      }
    }
  }
  flush();
  if (!noEm) processEmphasis(parts, delims, { linkEnds: mismatchLinkEnds, codeStarts: codeSpanStarts });
  return renderParts(parts);
}

// ---------------------------------------------------------------- blocks

function isBlank(line) {
  for (let i = 0; i < line.length; i++) {
    const c = line.charCodeAt(i);
    if (c !== 32 && c !== 9) return false;
  }
  return true;
}

// Columns of leading whitespace (space = 1, tab = to the next multiple of 4).
function indentCols(line) {
  let col = 0;
  for (let i = 0; i < line.length; i++) {
    const c = line.charCodeAt(i);
    if (c === 32) col++;
    else if (c === 9) col += 4 - (col & 3);
    else break;
  }
  return col;
}

// Remove n columns of leading indent. The text starts at column startCol
// in the original line, so tabs in the leading whitespace expand by that
// column. By default a tab that survives a strip is expanded to spaces
// (container prefixes: list items, blockquotes, definitions). For code
// content (keepTab true) a tab that starts at or after the boundary is
// preserved literally (doc-02: '    \tindented' strips to '\tindented');
// a tab that straddles the boundary leaves its remainder as spaces.
// Strip up to `n` leading whitespace CHARACTERS (a tab counts as one
// character) from a fenced-code content line. A tab that starts before
// the boundary is removed entirely; a tab at/after the boundary is kept
// (doc-17/doc-13: '\tindented with a tab' in a ```toml fence becomes
// 'indented with a tab', not ' indented with a tab'; a '\t\tfoo' line
// loses both tabs). This is NOT the column-based stripIndent: indented
// code keeps column counting (a tab there occupies its full width and
// leaves remainder spaces).
function stripFenceIndent(line, n) {
  let i = 0;
  while (i < n && i < line.length) {
    const c = line.charCodeAt(i);
    if (c === 32 || c === 9) i++;
    else break;
  }
  return line.slice(i);
}

function stripIndent(line, n, startCol, keepTab) {
  if (n <= 0) return line;
  let col = startCol || 0;
  let i = 0;
  if (keepTab) {
    while (i < line.length && col < n) {
      const c = line.charCodeAt(i);
      if (c === 32) { col++; i++; }
      else if (c === 9) {
        const w = 4 - (col & 3);
        if (col + w <= n) { col += w; i++; }
        else return ' '.repeat(col + w - n) + line.slice(i + 1);
      }
      else break;
    }
    return line.slice(i);
  }
  let spaces = 0;
  while (i < line.length) {
    const c = line.charCodeAt(i);
    if (c === 32) { spaces++; col++; i++; }
    else if (c === 9) { const w = 4 - (col & 3); spaces += w; col += w; i++; }
    else break;
  }
  const rest = line.slice(i);
  const remaining = Math.max(0, spaces - n);
  return ' '.repeat(remaining) + rest;
}

function firstNonWs(line) {
  for (let i = 0; i < line.length; i++) {
    const c = line.charCodeAt(i);
    if (c !== 32 && c !== 9) return i;
  }
  return -1;
}

// Parse a link label starting at text[i] == '['. The label ends at the
// first unescaped ']' and must not contain an unescaped '['.
function parseLabel(text, i) {
  let j = i + 1;
  let content = '';
  while (j < text.length) {
    const c = text.charCodeAt(j);
    if (c === 92) {
      if (j + 1 >= text.length) return null;
      content += text[j] + text[j + 1];
      j += 2;
      continue;
    }
    if (c === 91) return null;
    if (c === 93) {
      if (content.replace(/\s/g, '') === '') return null;
      return { raw: content, end: j + 1 };
    }
    content += text[j];
    j++;
  }
  return null;
}

// Try to parse a link reference definition starting at lines[i].
// Returns the number of lines consumed, or 0.
function tryDef(lines, i, end, links) {
  if (indentCols(lines[i]) > 3) return 0;
  let text = '';
  let count = 0;
  for (let k = i; k < end && count < 10; k++) {
    if (isBlank(lines[k])) break;
    if (count > 0) text += '\n';
    text += k === i ? stripIndent(lines[k], Math.min(3, indentCols(lines[k]))) : lines[k];
    count++;
  }
  if (text.charCodeAt(0) !== 91) return 0;
  const label = parseLabel(text, 0);
  if (!label) return 0;
  let j = skipWs(text, label.end);
  if (text[j] !== ':') return 0;
  j = skipWs(text, j + 1);
  const destStart = j;
  const dest = parseDestination(text, j);
  if (!dest) return 0;
  if (dest.href === '' && text[destStart] !== '<') return 0;
  // End of the destination's line.
  let destLineEnd = text.indexOf('\n', dest.end);
  if (destLineEnd === -1) destLineEnd = text.length;
  // Is there non-whitespace content on the destination's line after it?
  let k = dest.end;
  while (k < destLineEnd && (text.charCodeAt(k) === 32 || text.charCodeAt(k) === 9)) k++;
  const sameLineContent = k < destLineEnd;
  let title = null;
  let defEnd = destLineEnd;
  const j2 = skipWs(text, dest.end);
  if (j2 < text.length && text[j2] !== '\n') {
    // A title candidate. It must be separated from the destination by
    // whitespace, and only whitespace may follow it up to its line end.
    if (sameLineContent && j2 === dest.end) return 0;
    const t = parseTitle(text, j2);
    if (t) {
      let titleLineEnd = text.indexOf('\n', t.end);
      if (titleLineEnd === -1) titleLineEnd = text.length;
      let e = t.end;
      while (e < titleLineEnd && (text.charCodeAt(e) === 32 || text.charCodeAt(e) === 9)) e++;
      if (e >= titleLineEnd) {
        title = t.title;
        defEnd = titleLineEnd;
      } else if (sameLineContent) {
        return 0;
      }
      // else: an invalid title on a later line; fall back to no title
    } else if (sameLineContent) {
      return 0;
    }
    // else: no title on a later line; fall back to no title
  }
  const key = normalizeLabel(label.raw);
  if (key === '') return 0;
  const linesUsed = text.slice(0, defEnd).split('\n').length;
  if (!(key in links)) {
    const href = cleanUrl(unescape(dest.href));
    if (href !== null) links[key] = { href, title };
  }
  return linesUsed;
}

// ATX heading: #..###### followed by space/tab/EOL, optional closing #'s.
// Returns {level, content} (raw content text; the caller renders it).
function atxHeading(line, ind) {
  let i = firstNonWs(line);
  if (i === -1 || line.charCodeAt(i) !== 35) return null;
  let j = i;
  while (j < line.length && line.charCodeAt(j) === 35) j++;
  const level = j - i;
  if (level > 6) return null;
  if (j < line.length) {
    const c = line.charCodeAt(j);
    if (c !== 32 && c !== 9) return null;
  }
  let content = trimEndWs(line.slice(j));
  // closing sequence: trailing #'s preceded by a space. The space may be
  // the one right after the opening #'s, so check before stripping it.
  // Manual scan (no regex): trailing '#' run, preceded by space/tab.
  let e = content.length;
  while (e > 0 && content.charCodeAt(e - 1) === 35) e--;
  if (e < content.length && e > 0 && (content.charCodeAt(e - 1) === 32 || content.charCodeAt(e - 1) === 9)) {
    content = content.slice(0, e);
  }
  content = trimWs(content);
  return { level, content };
}

// Strip leading and trailing spaces/tabs without a regex (the regex
// trim is a hot path: isThematicBreak/atxHeading/setext run per line).
function trimWs(s) {
  let a = 0;
  let b = s.length;
  while (a < b && (s.charCodeAt(a) === 32 || s.charCodeAt(a) === 9)) a++;
  while (b > a && (s.charCodeAt(b - 1) === 32 || s.charCodeAt(b - 1) === 9)) b--;
  return a === 0 && b === s.length ? s : s.slice(a, b);
}

// Strip trailing spaces/tabs only.
function trimEndWs(s) {
  let b = s.length;
  while (b > 0 && (s.charCodeAt(b - 1) === 32 || s.charCodeAt(b - 1) === 9)) b--;
  return b === s.length ? s : s.slice(0, b);
}

// Thematic break: 3+ of the same * - _ with only spaces between.
function isThematicBreak(line) {
  let a = 0;
  let b = line.length;
  while (a < b && (line.charCodeAt(a) === 32 || line.charCodeAt(a) === 9)) a++;
  while (b > a && (line.charCodeAt(b - 1) === 32 || line.charCodeAt(b - 1) === 9)) b--;
  if (b - a < 3) return false;
  const ch = line.charCodeAt(a);
  if (ch !== 42 && ch !== 45 && ch !== 95) return false;
  let count = 0;
  for (let k = a; k < b; k++) {
    const c = line.charCodeAt(k);
    if (c === ch) count++;
    else if (c !== 32 && c !== 9) return false;
  }
  return count >= 3;
}

// Setext underline: === or --- (only spaces around). Returns 1 or 2.
function setextLevel(line) {
  let a = 0;
  let b = line.length;
  while (a < b && (line.charCodeAt(a) === 32 || line.charCodeAt(a) === 9)) a++;
  while (b > a && (line.charCodeAt(b - 1) === 32 || line.charCodeAt(b - 1) === 9)) b--;
  if (b - a === 0) return 0;
  const ch = line.charCodeAt(a);
  if (ch !== 61 && ch !== 45) return 0;
  for (let k = a; k < b; k++) if (line.charCodeAt(k) !== ch) return 0;
  return ch === 61 ? 1 : 2;
}

// Fenced code block starting at lines[i]. Returns {html, next} or null.
function fencedCode(lines, i, end, ind) {
  const line = lines[i];
  let p = firstNonWs(line);
  const fence = line.charCodeAt(p);
  if (fence !== 96 && fence !== 126) return null;
  let q = p;
  while (q < line.length && line.charCodeAt(q) === fence) q++;
  const len = q - p;
  if (len < 3) return null;
  const info = trimWs(line.slice(q))
  if (fence === 96 && info.indexOf('`') !== -1) return null;
  const lang = unescape(info.split(/[ \t]/, 1)[0]);
  const content = [];
  let j = i + 1;
  while (j < end) {
    const l = lines[j];
    const li = indentCols(l);
    let r = firstNonWs(l);
    if (r === -1) r = l.length;
    if (li <= 3 && l.charCodeAt(r) === fence) {
      let s = r;
      while (s < l.length && l.charCodeAt(s) === fence) s++;
      if (s - r >= len) {
        let t = s;
        while (t < l.length && (l.charCodeAt(t) === 32 || l.charCodeAt(t) === 9)) t++;
        if (t === l.length) return { html: fenceHtml(content, lang), next: j + 1 };
      }
    }
    // Marked strips the opening fence's indent from content lines only
    // for backtick fences. A tilde fence keeps its content verbatim
    // (doc-22/29: '~~~typescript' with 3-space content keeps all 3).
    content.push(fence === 96 ? stripFenceIndent(l, ind) : l);
    j++;
  }
  return { html: fenceHtml(content, lang), next: j };
}

function fenceHtml(content, lang) {
  // Lines joined by '\n'; a trailing '\n' is added unless the last line
  // is blank (the join already ends in '\n' then) (cm-318).
  let body = '';
  if (content.length) {
    body = content.join('\n');
    if (content[content.length - 1] !== '') body += '\n';
  }
  const cls = lang ? ' class="language-' + escText(lang) + '"' : '';
  return '<pre><code' + cls + '>' + esc(body) + '</code></pre>\n';
}

// Indented code block starting at lines[i] (indent >= 4).
function indentedCode(lines, i, end) {
  const content = [];
  let j = i;
  while (j < end) {
    const l = lines[j];
    if (isBlank(l)) {
      // blank line: included only if a code line follows; its content is
      // the line minus 4 columns (a 6-space blank line keeps 2 spaces)
      let k = j + 1;
      while (k < end && isBlank(lines[k])) k++;
      if (k < end && indentCols(lines[k]) >= 4) {
        while (j < k) { content.push(stripIndent(lines[j], 4, 0, true)); j++; }
        continue;
      }
      break;
    }
    if (indentCols(l) < 4) break;
    content.push(stripIndent(l, 4, 0, true));
    j++;
  }
  const body = content.length ? content.join('\n') + '\n' : '';
  return { html: '<pre><code>' + esc(body) + '</code></pre>\n', next: j };
}

const HTML_BLOCK_TAGS = new Set(('address article aside base basefont blockquote body caption center col colgroup dd details dialog dir div dl dt fieldset figcaption figure footer form frame frameset h1 h2 h3 h4 h5 h6 head header hr html iframe legend li link main menu nav noframes ol optgroup option p param section summary table tbody td tfoot th thead title tr track ul').split(' '));

// HTML block starting at lines[i]. type7Only selects only type 7
// (a tag that is not type 1-6); otherwise types 1-6. Returns {html, next}
// or null. Types 1-5 end at their terminator line, types 6-7 at a blank
// line; the raw lines are kept verbatim.
function htmlBlock(lines, i, end, ind, type7Only) {
  const line = lines[i];
  const p = firstNonWs(line);
  if (p === -1 || line.charCodeAt(p) !== 60) return null;
  const rest = line.slice(p);
  let kind = 0; // 1..7
  let endTag = null;
  let m = /^<(script|pre|style|textarea)(?:[ \t>]|$)/i.exec(rest);
  if (m) { kind = 1; endTag = m[1].toLowerCase(); }
  else if (rest.startsWith('<!--')) kind = 2;
  else if (rest.startsWith('<?')) kind = 3;
  else if (/^<![A-Za-z]/.test(rest)) kind = 4;
  else if (rest.startsWith('<![CDATA[')) kind = 5;
  else {
    const tm = /^<\/?([A-Za-z][A-Za-z0-9-]*)(?:[ \t>\/]|$)/.exec(rest);
    if (!tm) return null;
    if (HTML_BLOCK_TAGS.has(tm[1].toLowerCase())) kind = 6;
    else {
      kind = 7;
      // Type 7: the tag must be complete and the only content on the line.
      // <del>*foo*</del> is a paragraph, but a lone <del> is an HTML block.
      const tagEnd = htmlTagEnd(line, p);
      if (tagEnd === -1) return null;
      let r = tagEnd;
      while (r < line.length && (line.charCodeAt(r) === 32 || line.charCodeAt(r) === 9)) r++;
      if (r < line.length) return null;
    }
  }
  if (type7Only && kind !== 7) return null;
  if (!type7Only && kind === 7) return null;
  if (kind <= 5) {
    const terminator = kind === 1 ? '</' + endTag :
      kind === 2 ? '-->' : kind === 3 ? '?>' : kind === 4 ? '>' : ']]>';
    const raw = [line];
    let j = i + 1;
    let closed = kind === 1 ? rest.toLowerCase().indexOf(terminator) !== -1 : rest.indexOf(terminator) !== -1;
    while (j < end && !closed) {
      raw.push(lines[j]);
      const low = lines[j].toLowerCase();
      if (low.indexOf(terminator) !== -1) closed = true;
      j++;
    }
    // raw is the source slice: lines joined, plus the trailing newline
    // of the last line when the source has one. The trailing newline is
    // kept only when the block is followed by a non-empty line (or the
    // source ends with a newline); a following EMPTY line swallows it,
    // but a whitespace-only line does not (doc-15: a '\t' line after
    // '-->' keeps the newline).
    let html = raw.join('\n');
    if (j < end) { if (lines[j].length > 0) html += '\n'; }
    else if (lines === topLines && srcEndsWithNewline) html += '\n';
    return { html, next: j };
  }
  const raw = [line];
  let j = i + 1;
  while (j < end && !isBlank(lines[j])) {
    raw.push(lines[j]);
    j++;
  }
  // Type 6/7: the lines joined, no trailing newline, unless the block
  // runs to the end of the source (then the source's trailing newline).
  let html = raw.join('\n');
  if (j >= end && lines === topLines && srcEndsWithNewline) html += '\n';
  return { html, next: j };
}

// The links map of the current top-level parse (set by parse()).
let thisLinks = null;
let srcEndsWithNewline = true;
// The top-level lines array (set by parse()); HTML blocks compare against
// it to tell whether they run to the end of the source or just to the end
// of a blockquote/list sub-array.
let topLines = null;
// Deferred inline renderings: block parsing records the raw text of each
// paragraph/heading/table cell here and emits a placeholder; parse()
// renders them all after the whole document is block-parsed, so a link
// reference definition that appears after the paragraph that uses it is
// already known (forward references).
let inlineJobs = [];
// Persistent "inside an <a> tag" state (marked's lexer.state.inLink). An
// inline <a ...> tag sets it; only a </a> clears it. It persists across
// blocks and paragraphs for the whole document, and gates bare URL/email
// autolinks (the url tokenizer) but NOT <...> autolinks or [text](url)
// links. Set by inline() when it emits an HTML tag; reset by parse().
let inLinkHtml = false;
// Deferred jobs created by list() probes for LOOSE lists: the probe HTML is
// discarded (the items are re-rendered), so these jobs are orphans. They
// must not be rendered (their inline() would wrongly move inLinkHtml).
// Reset by parse(); list() adds the probe job ids when the list is loose.
let orphanJobs = new Set();

function deferInline(text) {
  const id = inlineJobs.length;
  inlineJobs.push(text);
  return '\u0000' + id + '\u0000';
}

// A paragraph starting at lines[i]. Returns {html, next}.
function paragraph(lines, i, end, links, tight, inList) {
  const acc = [];
  let j = i;
  // leading link reference definitions are stripped from the paragraph
  while (j < end && !isBlank(lines[j])) {
    const used = tryDef(lines, j, end, links);
    if (used === 0) break;
    j += used;
  }
  while (j < end) {
    const line = lines[j];
    if (isBlank(line)) break;
    if (acc.length > 0) {
      const ind = indentCols(line);
      if (ind <= 3) {
        const st = setextLevel(line);
        if (st > 0) {
          const text = acc.join('\n').replace(/^\s+/, '').replace(/\s+$/, '');
          return { html: '<h' + st + '>' + deferInline(text) + '</h' + st + '>\n', next: j + 1 };
        }
        if (atxHeading(line, ind)) break;
        if (fencedCode(lines, j, end, ind)) break;
        if (htmlBlock(lines, j, end, ind, false)) break;
        if (isThematicBreak(line)) break;
        const fni = firstNonWs(line);
        if (fni !== -1 && line.charCodeAt(fni) === 62) break;
        if (listCanInterrupt(lines, j, end, inList)) break;
      }
    }
    acc.push(line);
    j++;
  }
  if (acc.length === 0) return { html: '', next: j };
  // The first line's indent is kept (cm-222/224/275), and the last line's
  // trailing spaces are kept too: they are literal text (cm-226/241).
  // Only a soft/hard break inside the text consumes trailing spaces.
  const text = acc.join('\n');
  if (tight) return { html: deferInline(text), next: j };
  return { html: '<p>' + deferInline(text) + '</p>\n', next: j };
}

// Can the list starting at lines[j] interrupt a paragraph? The first
// item must be non-empty. An ordered list must start at 1, UNLESS we are
// parsing a list item's content directly: inside a list item any ordered
// start interrupts the item's paragraph (doc-01: '505791.' starts a list).
// A blockquote resets this (its content is parsed with inList false).
function listCanInterrupt(lines, j, end, inList) {
  const mk = listMarker(lines[j]);
  if (!mk) return false;
  if (mk.ordered && mk.num !== 1 && !inList) return false;
  return !mk.empty;
}

// Parse a list marker at the start of line. Returns null, or
// {ordered, num, delim, markerLen, contentIndent, empty, content} where
// content is the first line's content after the marker.
function listMarker(line) {
  const ind = indentCols(line);
  if (ind > 3) return null;
  const p = firstNonWs(line);
  if (p === -1) return null;
  // A thematic break line is not a list item (* * * is <hr>, not a list).
  if (isThematicBreak(line)) return null;
  const c = line.charCodeAt(p);
  let markerLen;
  let ordered = false;
  let num = 0;
  let delim = '';
  if (c === 45 || c === 43 || c === 42) {
    markerLen = 1;
  } else if (c >= 48 && c <= 57) {
    let q = p;
    while (q < line.length && line.charCodeAt(q) >= 48 && line.charCodeAt(q) <= 57) q++;
    if (q - p > 9) return null;
    const d = line.charCodeAt(q);
    if (d !== 46 && d !== 41) return null;
    num = Number(line.slice(p, q));
    delim = line[q];
    markerLen = q - p + 1;
    ordered = true;
  } else return null;
  const after = p + markerLen;
  if (after >= line.length) {
    return { ordered, num, delim, markerLen, contentIndent: ind + markerLen + 1, empty: true, content: '' };
  }
  // The marker must be followed by whitespace; *foo* and +++ are not lists.
  const ac = line.charCodeAt(after);
  if (ac !== 32 && ac !== 9) return null;
  // whitespace after the marker
  let q = after;
  let col = ind + markerLen;
  while (q < line.length) {
    const d = line.charCodeAt(q);
    if (d === 32) { col++; q++; }
    else if (d === 9) col += 4 - (col & 3), q++;
    else break;
  }
  if (q >= line.length) {
    return { ordered, num, delim, markerLen, contentIndent: ind + markerLen + 1, empty: true, content: '' };
  }
  const ws = col - (ind + markerLen);
  const contentIndent = ws >= 1 && ws <= 4 ? col : ind + markerLen + 1;
  const content = stripIndent(line.slice(after), ws >= 1 && ws <= 4 ? ws : 1, ind + markerLen);
  return { ordered, num, delim, markerLen, contentIndent, empty: false, content };
}

// A line (at indent <= 3) that would interrupt a paragraph: ATX heading,
// fenced code, HTML block types 1-6, blockquote, thematic break, or a list
// that can interrupt a paragraph.
function isParagraphInterrupt(lines, j, end) {
  const line = lines[j];
  const ind = indentCols(line);
  if (ind > 3) return false;
  if (atxHeading(line, ind)) return true;
  if (fencedCode(lines, j, end, ind)) return true;
  if (htmlBlock(lines, j, end, ind, false)) return true;
  if (isThematicBreak(line)) return true;
  const fni = firstNonWs(line);
  if (fni !== -1 && line.charCodeAt(fni) === 62) return true;
  if (listCanInterrupt(lines, j, end)) return true;
  return false;
}

// Is the last block of the given (dedented) content lines a paragraph?
// Used to decide lazy continuation lines in lists and blockquotes.
// Strip container prefixes ('>' markers and list markers) repeatedly to
// reach the innermost content of a line. Returns null for an empty item.
function innermostLine(line) {
  let s = line;
  while (true) {
    const ind = indentCols(s);
    if (ind <= 3) {
      const p = firstNonWs(s);
      if (p !== -1 && s.charCodeAt(p) === 62) {
        s = stripQuote(s);
        continue;
      }
    }
    const mk = listMarker(s);
    if (mk) {
      if (mk.content === '' || mk.content === undefined) return null;
      s = mk.content;
      continue;
    }
    break;
  }
  return s;
}
// Is the content currently inside an unclosed fenced code block? Scan the
// lines tracking fence open/close. A lazy line cannot continue a code block,
// so this makes lastBlockIsParagraph false inside a fence (doc-01).
function inUnclosedFence(lines) {
  let fenceCh = 0;
  let fenceLen = 0;
  for (const line of lines) {
    const ind = indentCols(line);
    if (ind > 3) continue; // only lines with indent <= 3 can open/close
    const p = firstNonWs(line);
    if (p === -1) continue; // blank line
    const c = line.charCodeAt(p);
    if (fenceCh) {
      if (c === fenceCh) {
        let q = p;
        while (q < line.length && line.charCodeAt(q) === fenceCh) q++;
        if (q - p >= fenceLen) {
          let t = q;
          while (t < line.length && (line.charCodeAt(t) === 32 || line.charCodeAt(t) === 9)) t++;
          if (t === line.length) { fenceCh = 0; fenceLen = 0; }
        }
      }
      continue;
    }
    if (c === 96 || c === 126) {
      let q = p;
      while (q < line.length && line.charCodeAt(q) === c) q++;
      if (q - p >= 3) {
        const info = trimWs(line.slice(q))
        if (c === 126 || info.indexOf('`') === -1) {
          fenceCh = c;
          fenceLen = q - p;
        }
      }
    }
  }
  return fenceCh !== 0;
}

// True when `lines` ends inside a fenced code block that already has at
// least one non-blank content line. A fence that just opened (no content
// yet) does not count: an under-indented line right after the opener ends
// the containing block instead (doc-17: '   ```toml' followed by an
// indent-0 line is an EMPTY fence; doc-02: the fence already has two
// content lines, so the indent-0 'function f(a, b) {' is fence content).
function inFenceWithContent(lines) {
  let fenceCh = 0;
  let fenceLen = 0;
  let hasContent = false;
  for (const line of lines) {
    const ind = indentCols(line);
    if (ind > 3) { if (fenceCh) hasContent = true; continue; }
    const p = firstNonWs(line);
    if (p === -1) continue; // blank line is not content for this test
    const c = line.charCodeAt(p);
    if (fenceCh) {
      if (c === fenceCh) {
        let q = p;
        while (q < line.length && line.charCodeAt(q) === fenceCh) q++;
        if (q - p >= fenceLen) {
          let t = q;
          while (t < line.length && (line.charCodeAt(t) === 32 || line.charCodeAt(t) === 9)) t++;
          if (t === line.length) { fenceCh = 0; fenceLen = 0; hasContent = false; continue; }
        }
      }
      hasContent = true;
      continue;
    }
    if (c === 96 || c === 126) {
      let q = p;
      while (q < line.length && line.charCodeAt(q) === c) q++;
      if (q - p >= 3) {
        const info = trimWs(line.slice(q))
        if (c === 126 || info.indexOf('`') === -1) {
          fenceCh = c;
          fenceLen = q - p;
          hasContent = false;
        }
      }
    }
  }
  return fenceCh !== 0 && hasContent;
}
function lastBlockIsParagraph(content) {
  if (inUnclosedFence(content)) return false;
  let lastIdx = -1;
  for (let t = content.length - 1; t >= 0; t--) {
    if (isBlank(content[t])) return false;
    lastIdx = t;
    break;
  }
  if (lastIdx === -1) return false;
  // The last line may still carry nested container markers (the outer
  // container stripped only one level); reach the innermost content.
  const last = innermostLine(content[lastIdx]);
  if (last === null) return false;
  const ind = indentCols(last);
  if (ind <= 3) {
    if (atxHeading(last, ind)) return false;
    if (fencedCode([last], 0, 1, ind)) return false;
    if (htmlBlock([last], 0, 1, ind, false)) return false;
    if (isThematicBreak(last)) return false;
    if (setextLevel(last) > 0) return false;
    const fni = firstNonWs(last);
    if (fni !== -1 && last.charCodeAt(fni) === 62) return false;
    if (listMarker(last)) return false;
  }
  if (ind >= 4) {
    // A line with indent >= 4 is an indented code block unless it follows
    // a paragraph line (then it is a paragraph continuation).
    let prevIdx = -1;
    for (let t = lastIdx - 1; t >= 0; t--) {
      if (isBlank(content[t])) return false;
      prevIdx = t;
      break;
    }
    if (prevIdx === -1) return false;
    const prev = innermostLine(content[prevIdx]);
    if (prev === null) return false;
    const pind = indentCols(prev);
    if (pind >= 4) return false;
    if (pind <= 3) {
      if (atxHeading(prev, pind)) return false;
      if (fencedCode([prev], 0, 1, pind)) return false;
      if (htmlBlock([prev], 0, 1, pind, false)) return false;
      if (isThematicBreak(prev)) return false;
      if (setextLevel(prev) > 0) return false;
      const pf = firstNonWs(prev);
      if (pf !== -1 && prev.charCodeAt(pf) === 62) return false;
      if (listMarker(prev)) return false;
    }
  }
  return true;
}

// Is this line a lazy continuation of the paragraph that ends the content?
function isLazyContinuation(content, line) {
  if (!lastBlockIsParagraph(content)) return false;
  return !isParagraphInterrupt([line], 0, 1);
}

// A lazy continuation line that looks like a setext underline is added
// indented by 4 spaces, so it stays paragraph text instead of becoming
// a heading (a setext underline cannot be a lazy line).
function lazyLine(line, n) {
  // A lazy continuation line is stripped by min(indent, n) columns — the
  // item's content indent for a list, 4 (the indented-code amount) for a
  // blockquote — EXCEPT a short lazy line (indent < n and indent < 4)
  // keeps its leading whitespace as paragraph text. Evidence (marked):
  // '- foo\n    bar' (indent 4, n 2) -> 'foo\n  bar'; '- foo\n  bar'
  // (2, 2) -> 'foo\nbar'; '- foo\n bar' (1, 2) -> 'foo\n bar' (kept);
  // cm-291 '  1.  A paragraph\n    with two lines.' (indent 4, n 6) ->
  // 'with two lines.' (all 4 stripped); '> foo\n    bar' (4, 4) ->
  // 'foo\nbar'; '> foo\n bar' (1, 4) -> 'foo\n bar' (kept). A setext
  // underline is re-indented by 4 spaces so it stays paragraph text.
  let s = line;
  const ind = indentCols(line);
  if (!(ind < n && ind < 4)) s = stripIndent(line, n);
  return setextLevel(s) > 0 ? '    ' + s : s;
}
// Strip leading blockquote markers ('>' + optional space) repeatedly,
// to reach the innermost content of a nested blockquote line.
function stripQuotePrefix(line) {
  let s = line;
  while (true) {
    const ind = indentCols(s);
    if (ind > 3) break;
    const p = firstNonWs(s);
    if (p === -1 || s.charCodeAt(p) !== 62) break;
    s = stripQuote(s);
  }
  return s;
}

function isQuoteLine(line) {
  if (indentCols(line) > 3) return false;
  const p = firstNonWs(line);
  return p !== -1 && line.charCodeAt(p) === 62;
}

function stripQuote(line) {
  const p0 = firstNonWs(line);
  const ind = indentCols(line);
  // the text after '>' starts at column ind + 1; strip the one optional space
  return stripIndent(line.slice(p0 + 1), 1, ind + 1);
}

// Blockquote starting at lines[i].
function blockquote(lines, i, end, links) {
  const content = [];
  let j = i;
  while (j < end) {
    const l = lines[j];
    // A completely blank line (no '>' marker) ends the blockquote, even
    // if a later line has a '>' (cm-242/252: two separate blockquotes).
    if (isBlank(l)) break;
    if (isQuoteLine(l)) {
      const stripped = stripQuote(l);
      // A whitespace-only stripped line (e.g. '>  ' -> ' ') is paragraph
      // content, not a blank line, when the last block is a paragraph
      // (cm-241). Merge it into the last content line.
      if (stripped !== '' && stripped.trim() === '' && lastBlockIsParagraph(content)) {
        content[content.length - 1] += '\n' + stripped;
        j++;
        continue;
      }
      content.push(stripped);
      j++;
      continue;
    }
    if (isLazyContinuation(content, l)) {
      // Merge the lazy line into the last content line so it is parsed as
      // paragraph continuation text, not as a new block (cm-238/292).
      const ll = lazyLine(l, 4);
      if (content.length > 0) content[content.length - 1] += '\n' + ll;
      else content.push(ll);
      j++;
      continue;
    }
    break;
  }
  const inner = blocks(content, 0, content.length, links, false, false);
  return { html: '<blockquote>\n' + inner.html + '</blockquote>\n', next: j };
}

// Split a table row on unescaped pipes, keeping code spans intact.
// Returns the cells, or null if the row has no pipe at all.
function splitTableRow(line) {
  // A line with no '|' is a single-cell row (gfm-202: a bare 'bar' is a row).
  if (line.indexOf('|') === -1) return [line];
  // Marked's split (no code-span awareness: only an escaped pipe is
  // literal, a '|' inside a code span still separates). Mark each
  // unescaped pipe by prefixing a space, then split on ' |'. An escaped
  // pipe (odd backslashes before it) stays a literal '|'.
  const tmp = line.replace(/\|/g, (m, off, s) => {
    let escaped = false;
    let p = off;
    while (--p >= 0 && s[p] === '\\') escaped = !escaped;
    return escaped ? '|' : ' |';
  });
  const cells = tmp.split(' |');
  // Drop the leading empty cell for a leading pipe and the trailing empty
  // cell for a trailing pipe.
  if (cells.length > 0 && cells[0].trim() === '') cells.shift();
  if (cells.length > 0 && cells[cells.length - 1].trim() === '') cells.pop();
  return cells.map((c) => c.trim().replace(/\\\|/g, '|'));
}

// GFM table starting at lines[i]. Returns {html, next} or null.
// Does this line end a GFM table body? Mirrors marked's table body rule:
// a body row is any non-blank line that does not start a block (thematic
// break, ATX heading, blockquote, indented code, fence, list, HTML block).
// A row need not contain a '|' (gfm-202: a bare 'bar' is a one-cell row).
// Does this single line start a fenced code block? (For the table-body
// boundary check; the block-level fencedCode takes lines+index.)
function isFenceStart(line) {
  const p = firstNonWs(line);
  if (p === -1) return false;
  if (indentCols(line) > 3) return false;
  const fence = line.charCodeAt(p);
  if (fence !== 96 && fence !== 126) return false;
  let q = p;
  while (q < line.length && line.charCodeAt(q) === fence) q++;
  if (q - p < 3) return false;
  if (fence === 96 && line.slice(q).indexOf('`') !== -1) return false;
  return true;
}
function tableBodyStops(line) {
  // Marked's table-body regex excludes only a line of SPACES (' *\n'), so
  // a line containing a tab is a body row, not a blank line (doc-02: a
  // lone '\t' line becomes a row of empty cells, and the following text
  // line becomes a single-cell row). A line of only spaces ends the body.
  if (/^ *$/.test(line)) return true;
  if (isThematicBreak(line)) return true;
  if (/^ {0,3}#{1,6}(?:\s|$)/.test(line)) return true;
  if (/^ {0,3}>/.test(line)) return true;
  // Indented code stops the body, but only when the line has non-whitespace
  // content: a whitespace-only line (even a lone tab, indent 4) is a body
  // row, not code (marked's code pattern requires a non-newline char).
  if (indentCols(line) >= 4 && /[^ \t]/.test(line)) return true;
  if (isFenceStart(line)) return true;
  if (/^ {0,3}(?:[*+-]|1[.)])[ \t]+[^ \t]/.test(line)) return true;
  if (/^ {0,3}(?:<\/?(?:address|article|aside|base|basefont|blockquote|body|caption|center|col|colgroup|dd|details|dialog|dir|div|dl|dt|fieldset|figcaption|figure|footer|form|frame|frameset|h[1-6]|head|header|hr|html|iframe|legend|li|link|main|menu|menuitem|meta|nav|noframes|ol|optgroup|option|p|param|search|section|summary|table|tbody|td|tfoot|th|thead|title|tr|track|ul)(?: +|\n|\/?>)|<!--|<\?|<!\[CDATA\[|<![A-Z])/.test(line)) return true;
  return false;
}
function table(lines, i, end, links) {
  if (i + 1 >= end) return null;
  if (lines[i].indexOf('|') === -1 || lines[i + 1].indexOf('|') === -1) return null;
  const header = splitTableRow(lines[i]);
  if (!header) return null;
  const delim = splitTableRow(lines[i + 1]);
  if (!delim || delim.length !== header.length) return null;
  const aligns = [];
  for (const cell of delim) {
    const c = cell.trim();
    if (!/^:?-+:?$/.test(c)) return null;
    aligns.push(c.charCodeAt(0) === 58 && c.charCodeAt(c.length - 1) === 58 ? 'center' :
      c.charCodeAt(c.length - 1) === 58 ? 'right' :
      c.charCodeAt(0) === 58 ? 'left' : null);
  }
  const rows = [];
  let j = i + 2;
  while (j < end && !tableBodyStops(lines[j])) {
    const row = splitTableRow(lines[j]);
    if (!row) break;
    rows.push(row);
    j++;
  }
  let html = '<table>\n<thead>\n<tr>\n';
  for (let c = 0; c < header.length; c++) {
    const a = aligns[c] ? ' align="' + aligns[c] + '"' : '';
    html += '<th' + a + '>' + deferInline(header[c].trim()) + '</th>\n';
  }
  html += '</tr>\n</thead>\n';
  if (rows.length > 0) {
    html += '<tbody>';
    for (const row of rows) {
      html += '<tr>\n';
      for (let c = 0; c < header.length; c++) {
        const cell = c < row.length ? row[c].trim() : '';
        const a = aligns[c] ? ' align="' + aligns[c] + '"' : '';
        html += '<td' + a + '>' + deferInline(cell) + '</td>\n';
      }
      html += '</tr>\n';
    }
    html += '</tbody>';
  }
  html += '</table>\n';
  return { html, next: j };
}

// List starting at lines[i]. Returns {html, next} or null.
function list(lines, i, end, links) {
  const first = listMarker(lines[i]);
  if (!first) return null;
  const ordered = first.ordered;
  const delim = first.delim;
  const bulletCh = ordered ? -1 : lines[i].charCodeAt(firstNonWs(lines[i]));
  const c0 = first.contentIndent;
  const items = [];
  let j = i;
  let betweenBlank = false;
  // Content indent of the last item added. A new marker line is a sibling
  // only when its indent is below the PREVIOUS item's content indent
  // (cm-295: indents 0,1,2,3 are all siblings, not nested sublists).
  let lastContentIndent = Infinity;
  const sameMarker = (line) => {
    const mk = listMarker(line);
    if (!mk || mk.ordered !== ordered) return false;
    if (ordered) return mk.delim === delim;
    return line.charCodeAt(firstNonWs(line)) === bulletCh;
  };
  while (j < end) {
    const mk = listMarker(lines[j]);
    const mkInd = indentCols(lines[j]);
    if (!mk || !sameMarker(lines[j]) || mkInd >= lastContentIndent) break;
    const content = [mk.content];
    // GFM task list: '[ ]'/'[x]'/'[X]' followed by whitespace and content
    // (listIsTask). The marker and its following whitespace are stripped;
    // the checkbox HTML (with its trailing space) is added at render time.
    let task = null;
    const tm = /^\[([ xX])\][ \t]+\S/.exec(mk.content);
    if (tm) {
      task = tm[1] === ' ' ? 'unchecked' : 'checked';
      content[0] = mk.content.replace(/^\[[ xX]\][ \t]+/, '');
    }
    const itemContentIndent = mk.contentIndent;
    let k = j + 1;
    while (k < end) {
      const l = lines[k];
      if (isBlank(l)) {
        let m = k + 1;
        while (m < end && isBlank(lines[m])) m++;
        if (m >= end) { k = m; break; }
        if (sameMarker(lines[m]) && indentCols(lines[m]) < itemContentIndent) {
          betweenBlank = true;
          k = m;
          break;
        }
        // An empty item ends at a blank line: there is no content for a
        // following indented line to continue (cm-280).
        const hasContent = content.some((c) => !isBlank(c));
        if (indentCols(lines[m]) >= itemContentIndent && hasContent) {
          while (k < m) { content.push(''); k++; }
          continue;
        }
        // The next line is not part of this item. Stop AT the blank line
        // (not past it) so the caller sees the blank and can mark the
        // list loose (cm-325: a blank between a nested list and 'baz').
        break;
      }
      const ind = indentCols(l);
      if (ind >= itemContentIndent) {
        content.push(stripIndent(l, itemContentIndent));
        k++;
        continue;
      }
      // A line inside a fenced code block that already has content is
      // fence content even with indent below the item indent (doc-02:
      // 'function f(a, b) {' at indent 0 inside a ```css fence in a list
      // item). It stays part of the item; without this the item ends
      // early, the fence is left unclosed, and a later fence line opens
      // a runaway top-level block that swallows the rest of the document.
      // A fence with no content yet does NOT keep the line (doc-17: an
      // indent-0 line right after '   ```toml' is a new paragraph and
      // the fence is empty).
      if (inFenceWithContent(content)) {
        content.push(stripIndent(l, itemContentIndent));
        k++;
        continue;
      }
      // Any list marker ends this item: a same-type marker is a sibling,
      // a different-type marker starts a new list (cm-302: '3)' after
      // '1.'/'2.'). It is never a lazy continuation.
      if (listMarker(l)) break;
      if (sameMarker(l)) break;
      if (isLazyContinuation(content, l)) {
        // Merge the lazy line into the last content line so it is parsed
        // as paragraph continuation text, not as a new block.
        const ll = lazyLine(l, itemContentIndent);
        if (content.length > 0) content[content.length - 1] += '\n' + ll;
        else content.push(ll);
        k++;
        continue;
      }
      break;
    }
    items.push({ lines: content, start: mk.num, task });
    lastContentIndent = itemContentIndent;
    j = k;
  }
  if (items.length === 0) return null;
  // Probes determine tight/loose. For a loose list the probe HTML is
  // discarded (items are re-rendered below), so every job the probes
  // created is an orphan: mark them so parse() skips rendering them (their
  // inline() would wrongly move the document-level inLinkHtml state).
  const probeStart = inlineJobs.length;
  const probes = items.map((it) => blocks(it.lines, 0, it.lines.length, links, true, true));
  const loose = betweenBlank || probes.some((p) => p.loose);
  if (loose) for (let q = probeStart; q < inlineJobs.length; q++) orphanJobs.add(q);
  let html = ordered
    ? '<ol' + (first.num !== 1 ? ' start="' + first.num + '"' : '') + '>\n'
    : '<ul>\n';
  for (let t = 0; t < items.length; t++) {
    let itemHtml = loose
      ? blocks(items[t].lines, 0, items[t].lines.length, links, false, true).html
      : probes[t].html;
    const task = items[t].task;
    if (task) {
      const cb = task === 'checked'
        ? '<input checked="" disabled="" type="checkbox"> '
        : '<input disabled="" type="checkbox"> ';
      // Loose items wrap the text in <p>: the checkbox goes inside it.
      if (itemHtml.startsWith('<p>')) itemHtml = '<p>' + cb + itemHtml.slice(3);
      else itemHtml = cb + itemHtml;
    }
    html += '<li>' + itemHtml + '</li>\n';
  }
  html += ordered ? '</ol>\n' : '</ul>\n';
  return { html, next: j };
}

// Parse a range of lines into HTML. Returns {html, loose}: loose is true
// when two blocks at this level are separated by a blank line.
function blocks(lines, start, end, links, tight, inList) {
  let out = '';
  let i = start;
  let seenBlock = false;
  let blankSince = false;
  let loose = false;
  while (i < end) {
    if (isBlank(lines[i])) { blankSince = true; i++; continue; }
    const defLines = tryDef(lines, i, end, links);
    if (defLines > 0) {
      // A definition is a block: a blank line before it makes the list
      // loose, even though it renders nothing (cm-317).
      if (seenBlock && blankSince) loose = true;
      seenBlock = true;
      blankSince = false;
      i += defLines;
      continue;
    }
    const line = lines[i];
    const ind = indentCols(line);
    let html = null;
    let next = i + 1;
    if (ind <= 3) {
      const atx = atxHeading(line, ind);
      if (atx) {
        html = '<h' + atx.level + '>' + deferInline(atx.content) + '</h' + atx.level + '>\n';
      } else {
        const f = fencedCode(lines, i, end, ind);
        if (f) { html = f.html; next = f.next; }
        else {
          const h = htmlBlock(lines, i, end, ind, false);
          if (h) { html = h.html; next = h.next; }
          else {
            const fni = firstNonWs(line);
            if (fni !== -1 && line.charCodeAt(fni) === 62) {
              const b = blockquote(lines, i, end, links);
              html = b.html; next = b.next;
            } else if (isThematicBreak(line)) {
              html = '<hr>\n';
            } else {
              const l = list(lines, i, end, links);
              if (l) { html = l.html; next = l.next; }
              else {
                const t = table(lines, i, end, links);
                if (t) { html = t.html; next = t.next; }
                else {
                  const h7 = htmlBlock(lines, i, end, ind, true);
                  if (h7) { html = h7.html; next = h7.next; }
                }
              }
            }
          }
        }
      }
    }
    if (html === null) {
      if (ind >= 4) {
        const c = indentedCode(lines, i, end);
        html = c.html; next = c.next;
      } else {
        const p = paragraph(lines, i, end, links, tight, inList);
        html = p.html; next = p.next;
      }
    }
    if (seenBlock && blankSince) loose = true;
    seenBlock = true;
    blankSince = false;
    out += html;
    i = next;
  }
  return { html: out, loose };
}

export function parse(src) {
  thisLinks = {};
  inlineJobs = [];
  inLinkHtml = false;
  orphanJobs = new Set();
  // Normalize line endings: \r\n and lone \r are line breaks (CommonMark);
  // without this a \r survives at the end of each line and leaks into
  // headings and paragraphs (doc-38, which uses \r\n throughout). Only
  // run the replace when a \r is present, so the common case costs a
  // single indexOf scan instead of a regex pass and a new string.
  if (src.indexOf('\r') !== -1) src = src.replace(/\r\n?/g, '\n');
  srcEndsWithNewline = src.endsWith('\n');
  const lines = src.split('\n');
  if (lines.length > 0 && lines[lines.length - 1] === '') lines.pop();
  topLines = lines;
  const out = blocks(lines, 0, lines.length, thisLinks, false, false).html;
  if (inlineJobs.length === 0) return out;
  // Orphan probe jobs (loose lists) are skipped: their output is discarded
  // and rendering them would wrongly move inLinkHtml. Their placeholders
  // never appear in out, so '' is never substituted.
  const rendered = inlineJobs.map((t, id) => orphanJobs.has(id) ? '' : inline(t, thisLinks, false));
  return out.replace(/\u0000(\d+)\u0000/g, (m, n) => rendered[+n]);
}
