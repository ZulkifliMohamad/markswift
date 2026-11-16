// markswift: a dependency-free CommonMark 0.31.2 + GFM renderer that returns
// exactly what marked 18.1.3 returns with default options (gfm on, breaks
// off, pedantic off, async off). Where marked departs from the spec, marked
// wins. Single ES module, no imports.

// ---------------------------------------------------------------- utilities

function isWsCode(c) {
  return c === 32 || c === 9 || c === 10 || c === 13 || c === 11 || c === 12;
}
function isSpaceOrTab(c) {
  return c === 32 || c === 9;
}
function isDigit(c) {
  return c >= 48 && c <= 57;
}
function isAlphaNum(c) {
  return (c >= 48 && c <= 57) || (c >= 65 && c <= 90) || (c >= 97 && c <= 122);
}
function isWordChar(c) {
  return isAlphaNum(c) || c === 95;
}
// ASCII punctuation only (for backslash escapes). isPunctCode includes
// Unicode punctuation, which is used for emphasis flanking, not escapes.
function isAsciiPunct(c) {
  return (c >= 33 && c <= 47) || (c >= 58 && c <= 64) || (c >= 91 && c <= 96) || (c >= 123 && c <= 126);
}

function isPunctCode(c) {
  return (
    (c >= 33 && c <= 47) ||
    (c >= 58 && c <= 64) ||
    (c >= 91 && c <= 96) ||
    (c >= 123 && c <= 126) ||
    c === 0xa1 || c === 0xab || c === 0xbb || c === 0xbf ||
    (c >= 0x2000 && c <= 0x206f && !(c >= 0x2000 && c <= 0x200a) && c !== 0x202f && c !== 0x205f) ||
    (c >= 0x2e00 && c <= 0x2e7f) ||
    (c >= 0x3001 && c <= 0x303f) ||
    (c >= 0xff01 && c <= 0xff0f) ||
    (c >= 0xff1a && c <= 0xff20) ||
    (c >= 0xff3b && c <= 0xff40) ||
    (c >= 0xff5b && c <= 0xff65)
  );
}
function isUnicodeWs(c) {
  return (
    c <= 32 ||
    c === 0xa0 ||
    (c >= 0x2000 && c <= 0x200a) ||
    c === 0x202f || c === 0x205f || c === 0x3000 || c === 0xfeff
  );
}

// Column of a position in a line, counting a tab as advancing to the next
// multiple of four. Returns the column at index `end` (exclusive).
function colOf(line, start, end) {
  let col = 0;
  for (let i = start; i < end; i++) {
    const c = line.charCodeAt(i);
    if (c === 9) col = (col + 4) & ~3;
    else col++;
  }
  return col;
}

// Columns occupied by line[start..end] when line[start] is at absolute
// column startCol; returns the absolute column of line[end].
function colFrom(line, start, end, startCol) {
  let col = startCol;
  for (let i = start; i < end; i++) {
    if (line.charCodeAt(i) === 9) col = (col + 4) & ~3;
    else col++;
  }
  return col;
}

// Indent (in columns) of the leading whitespace of `line` starting at `i`
// (whose absolute column is `startCol`), and the index just past it.
// Returns the indent width in columns (not the absolute column).
function leadingIndent(line, i, startCol) {
  let col = startCol || 0;
  let j = i;
  const n = line.length;
  while (j < n) {
    const c = line.charCodeAt(j);
    if (c === 32) { col++; j++; }
    else if (c === 9) { col = (col + 4) & ~3; j++; }
    else break;
  }
  return { col: col - (startCol || 0), idx: j };
}

// Expand the leading tabs of `s` to spaces, where s[0] is at absolute
// column startCol. Used when a block starts inside a container: a leading
// tab there is indent, not paragraph text.
function expandLeadingTabs(s, startCol) {
  let col = startCol || 0;
  let k = 0;
  while (k < s.length) {
    const ch = s.charCodeAt(k);
    if (ch === 32) { col++; k++; continue; }
    if (ch === 9) {
      const w = 4 - (col % 4);
      s = s.slice(0, k) + ' '.repeat(w) + s.slice(k + 1);
      col += w;
      k += w;
      continue;
    }
    break;
  }
  return s;
}

// Return the part of `line` starting at absolute column `targetCol`, where
// `line` starts at absolute column `startCol`. A tab that straddles
// targetCol is replaced by the spaces it contributes after targetCol.
function sliceFromCol(line, startCol, targetCol) {
  let col = startCol;
  let i = 0;
  while (i < line.length) {
    if (col >= targetCol) return line.slice(i);
    const ch = line.charCodeAt(i);
    if (ch === 9) {
      const next = col + (4 - (col % 4));
      if (next <= targetCol) { col = next; i++; continue; }
      return ' '.repeat(next - targetCol) + line.slice(i + 1);
    }
    col++;
    i++;
  }
  return '';
}

// Remove `n` columns of indentation from `line` starting at index `i`
// (column `col`). A tab that is only partly consumed becomes spaces for its
// remaining width when `partialTab` is 'spaces', and is dropped entirely
// when `partialTab` is 'drop'. Returns the remaining string.
function stripIndentCols(line, i, col, n, partialTab) {
  let j = i;
  let c = col;
  let rem = n;
  const len = line.length;
  while (rem > 0 && j < len) {
    const ch = line.charCodeAt(j);
    if (ch === 32) { j++; c++; rem--; }
    else if (ch === 9) {
      const w = 4 - (c & 3);
      if (w <= rem) { j++; c += w; rem -= w; }
      else {
        // Tab is partly consumed. The remainder becomes spaces, and any
        // further leading tabs in the remainder are expanded too (they
        // were part of the same indent run).
        if (partialTab === 'spaces') {
          const rest = expandLeadingTabs(line.slice(j + 1), c + w);
          return ' '.repeat(w - rem) + rest;
        }
        return line.slice(j + 1);
      }
    } else break;
  }
  return line.slice(j);
}

// Escape text for HTML output. `&` is escaped unless it starts something
// that looks like an entity reference: &name; (& followed by word chars and
// a semicolon), &#digits; (1-7 digits), or &#x hex; (1-6 hex digits).
// All of < > " ' are always escaped.
function escText(s) {
  let out = '';
  let start = 0;
  const n = s.length;
  for (let i = 0; i < n; i++) {
    const c = s.charCodeAt(i);
    let rep = null;
    if (c === 38) {
      // '&': check for an entity-looking sequence.
      let j = i + 1;
      if (j < n && s.charCodeAt(j) === 35) {
        j++;
        if (j < n && (s.charCodeAt(j) === 120 || s.charCodeAt(j) === 88)) {
          j++;
          const h0 = j;
          while (j < n && j - h0 < 6) {
            const h = s.charCodeAt(j);
            if ((h >= 48 && h <= 57) || (h >= 65 && h <= 70) || (h >= 97 && h <= 102)) j++;
            else break;
          }
          if (j > h0 && j < n && s.charCodeAt(j) === 59) { i = j; continue; }
        } else {
          const d0 = j;
          while (j < n && j - d0 < 7 && s.charCodeAt(j) >= 48 && s.charCodeAt(j) <= 57) j++;
          if (j > d0 && j < n && s.charCodeAt(j) === 59) { i = j; continue; }
        }
      } else {
        while (j < n && isWordChar(s.charCodeAt(j))) j++;
        if (j > i + 1 && j < n && s.charCodeAt(j) === 59) { i = j; continue; }
      }
      rep = '&amp;';
    } else if (c === 60) rep = '&lt;';
    else if (c === 62) rep = '&gt;';
    else if (c === 34) rep = '&quot;';
    else if (c === 39) rep = '&#39;';
    if (rep !== null) {
      if (start < i) out += s.slice(start, i);
      out += rep;
      start = i + 1;
    }
  }
  if (start === 0) return s;
  if (start < n) out += s.slice(start);
  return out;
}

// Escape everything, unconditionally (code spans, code blocks).
function escFull(s) {
  let out = '';
  let start = 0;
  const n = s.length;
  for (let i = 0; i < n; i++) {
    const c = s.charCodeAt(i);
    let rep = null;
    if (c === 38) rep = '&amp;';
    else if (c === 60) rep = '&lt;';
    else if (c === 62) rep = '&gt;';
    else if (c === 34) rep = '&quot;';
    else if (c === 39) rep = '&#39;';
    if (rep !== null) {
      if (start < i) out += s.slice(start, i);
      out += rep;
      start = i + 1;
    }
  }
  if (start === 0) return s;
  if (start < n) out += s.slice(start);
  return out;
}

// Decode a numeric character reference starting at s[i] === '&'.
// Returns [char, nextIndex] or null. Decimal allows 1-7 digits, hex 1-6.
// Code point 0, surrogates, and values above 0x10FFFF become U+FFFD.
function decodeNumericEntity(s, i) {
  const n = s.length;
  let j = i + 1;
  if (j >= n || s.charCodeAt(j) !== 35) return null;
  j++;
  let code = 0;
  let digits = 0;
  if (j < n && (s.charCodeAt(j) === 120 || s.charCodeAt(j) === 88)) {
    j++;
    while (j < n && digits < 6) {
      const c = s.charCodeAt(j);
      let v = -1;
      if (c >= 48 && c <= 57) v = c - 48;
      else if (c >= 65 && c <= 70) v = c - 55;
      else if (c >= 97 && c <= 102) v = c - 87;
      if (v < 0) break;
      code = code * 16 + v;
      digits++;
      j++;
    }
    if (digits === 0) return null;
  } else {
    while (j < n && digits < 7) {
      const c = s.charCodeAt(j);
      if (c < 48 || c > 57) break;
      code = code * 10 + (c - 48);
      digits++;
      j++;
    }
    if (digits === 0) return null;
  }
  if (j >= n || s.charCodeAt(j) !== 59) return null;
  let ch;
  if (code === 0 || (code >= 0xd800 && code <= 0xdfff) || code > 0x10ffff) {
    ch = '\uFFFD';
  } else {
    ch = String.fromCodePoint(code);
  }
  return [ch, j + 1];
}

// ------------------------------------------------------- raw HTML matching

// Try to match raw HTML starting at s[i] === '<'. Returns the index just
// past the tag, or -1. Handles comments, processing instructions,
// declarations, CDATA sections, open tags and close tags with valid
// attribute syntax. Whitespace inside a tag may include newlines.
function matchHtmlTag(s, i) {
  const n = s.length;
  if (i + 1 >= n) return -1;
  const c1 = s.charCodeAt(i + 1);
  // Comment: <!-- ... --> (also <!--> and <!--->).
  if (c1 === 33 && i + 3 < n && s.charCodeAt(i + 2) === 45 && s.charCodeAt(i + 3) === 45) {
    if (i + 4 < n && s.charCodeAt(i + 4) === 62) return i + 5;
    if (i + 5 < n && s.charCodeAt(i + 4) === 45 && s.charCodeAt(i + 5) === 62) return i + 6;
    const end = s.indexOf('-->', i + 4);
    return end === -1 ? -1 : end + 3;
  }
  // Processing instruction: <? ... ?>
  if (c1 === 63) {
    const end = s.indexOf('?>', i + 2);
    return end === -1 ? -1 : end + 2;
  }
  // Declaration: <! + letter ... >
  if (c1 === 33 && i + 2 < n) {
    const c2 = s.charCodeAt(i + 2);
    if ((c2 >= 65 && c2 <= 90) || (c2 >= 97 && c2 <= 122)) {
      const end = s.indexOf('>', i + 3);
      return end === -1 ? -1 : end + 1;
    }
    // CDATA: <![CDATA[ ... ]]>
    if (s.startsWith('[CDATA[', i + 2)) {
      const end = s.indexOf(']]>', i + 9);
      return end === -1 ? -1 : end + 3;
    }
    return -1;
  }
  let j = i + 1;
  let closing = false;
  if (c1 === 47) {
    closing = true;
    j++;
    if (j >= n) return -1;
  }
  const lc = s.charCodeAt(j);
  if (!((lc >= 65 && lc <= 90) || (lc >= 97 && lc <= 122))) return -1;
  // Tag name.
  j++;
  while (j < n) {
    const c = s.charCodeAt(j);
    if ((c >= 65 && c <= 90) || (c >= 97 && c <= 122) || (c >= 48 && c <= 57) || c === 45) j++;
    else break;
  }
  if (closing) {
    while (j < n && isWsCode(s.charCodeAt(j))) j++;
    if (j < n && s.charCodeAt(j) === 62) return j + 1;
    return -1;
  }
  // Attributes: each attribute must be preceded by whitespace. A
  // valueless attribute is followed by whitespace that separates it from
  // the next attribute; that whitespace counts toward the next attribute's
  // separator (it was already consumed while looking for '=').
  let pendingWs = 0;
  while (true) {
    let ws = pendingWs; pendingWs = 0;
    while (j < n && isWsCode(s.charCodeAt(j))) { j++; ws++; }
    if (j >= n) return -1;
    const c = s.charCodeAt(j);
    if (c === 62) return j + 1;
    if (c === 47) {
      if (j + 1 < n && s.charCodeAt(j + 1) === 62) return j + 2;
      return -1;
    }
    if (ws === 0) return -1; // attribute must follow whitespace
    // Attribute name.
    if (!((c >= 65 && c <= 90) || (c >= 97 && c <= 122) || c === 95 || c === 58)) return -1;
    j++;
    while (j < n) {
      const a = s.charCodeAt(j);
      if ((a >= 65 && a <= 90) || (a >= 97 && a <= 122) || (a >= 48 && a <= 57) || a === 95 || a === 58 || a === 46 || a === 45) j++;
      else break;
    }
    while (j < n && isWsCode(s.charCodeAt(j))) { j++; pendingWs++; }
    if (j < n && s.charCodeAt(j) === 61) {
      pendingWs = 0;
      j++;
      while (j < n && isWsCode(s.charCodeAt(j))) j++;
      if (j >= n) return -1;
      const q = s.charCodeAt(j);
      if (q === 34 || q === 39) {
        j++;
        while (j < n && s.charCodeAt(j) !== q) j++;
        if (j >= n) return -1;
        j++;
      } else {
        const v0 = j;
        while (j < n) {
          const v = s.charCodeAt(j);
          if (isWsCode(v) || v === 34 || v === 39 || v === 61 || v === 60 || v === 62 || v === 96) break;
          j++;
        }
        if (j === v0) return -1;
      }
    }
  }
}

// ------------------------------------------------------- link destinations

// Parse a link destination starting at s[i]. Returns {dest, next} or null.
// Handles <...> destinations and bare destinations (no spaces or control
// characters, balanced parentheses). Backslash escapes are processed.
function parseLinkDest(s, i) {
  const n = s.length;
  if (i >= n) return null;
  if (s.charCodeAt(i) === 60) {
    // Angle-bracket destination.
    let j = i + 1;
    let out = '';
    while (j < n) {
      const c = s.charCodeAt(j);
      if (c === 62) return { dest: out, next: j + 1 };
      if (c === 10 || c === 60) return null;
      if (c === 92 && j + 1 < n && isAsciiPunct(s.charCodeAt(j + 1))) {
        out += s[j + 1];
        j += 2;
        continue;
      }
      out += s[j];
      j++;
    }
    return null;
  }
  let j = i;
  let out = '';
  let depth = 0;
  while (j < n) {
    const c = s.charCodeAt(j);
    if (c <= 32 || c === 127) break;
    if (c === 92 && j + 1 < n && isAsciiPunct(s.charCodeAt(j + 1))) {
      out += s[j + 1];
      j += 2;
      continue;
    }
    if (c === 40) { depth++; out += s[j]; j++; continue; }
    if (c === 41) {
      if (depth === 0) break;
      depth--;
      out += s[j];
      j++;
      continue;
    }
    out += s[j];
    j++;
  }
  if (depth !== 0) return null;
  return { dest: out, next: j };
}

// Parse a link title starting at s[i]. Returns {title, next} or null.
// Titles are "..." or '...' or (...), and may span lines.
function parseLinkTitle(s, i) {
  const n = s.length;
  if (i >= n) return null;
  const c = s.charCodeAt(i);
  let close;
  if (c === 34) close = 34;
  else if (c === 39) close = 39;
  else if (c === 40) close = 41;
  else return null;
  let j = i + 1;
  let out = '';
  while (j < n) {
    const ch = s.charCodeAt(j);
    if (ch === 92 && j + 1 < n && isAsciiPunct(s.charCodeAt(j + 1))) {
      out += s[j + 1];
      j += 2;
      continue;
    }
    if (ch === close) return { title: escAttrValue(out), next: j + 1 };
    if (close === 41 && ch === 40) return null;
    out += s[j];
    j++;
  }
  return null;
}

// Parse the inside of an inline link: s[i] === '('.
// Returns {dest, title, next} (next is just past ')') or null.
function parseInlineLink(s, i) {
  const n = s.length;
  let j = i + 1;
  while (j < n && isWsCode(s.charCodeAt(j))) j++;
  if (j < n && s.charCodeAt(j) === 41) return { dest: '', title: null, next: j + 1 };
  const d = parseLinkDest(s, j);
  if (!d) return null;
  const dest = d.dest;
  j = d.next;
  while (j < n && isWsCode(s.charCodeAt(j))) j++;
  if (j < n && s.charCodeAt(j) === 41) return { dest, title: null, next: j + 1 };
  const t = parseLinkTitle(s, j);
  if (!t) return null;
  j = t.next;
  while (j < n && isWsCode(s.charCodeAt(j))) j++;
  if (j >= n || s.charCodeAt(j) !== 41) return null;
  return { dest, title: t.title, next: j + 1 };
}

// Clean a link destination for output: strip control characters, percent-
// encode with encodeURI, then escape for an attribute value (entity-aware:
// an '&' that starts an entity-looking sequence stays raw).
// encodeURI except that a bare '%' is left raw (marked keeps '%' as-is;
// only valid %XX sequences are preserved, and '%' itself is not encoded).
function encodeUrlPart(p) {
  let out = '';
  for (let i = 0; i < p.length; i++) {
    const c = p.charCodeAt(i);
    if (c === 32) out += '%20';
    else if (c === 34) out += '%22';
    else if (c === 60) out += '%3C';
    else if (c === 62) out += '%3E';
    else if (c === 91) out += '%5B';
    else if (c === 92) out += '%5C';
    else if (c === 93) out += '%5D';
    else if (c === 94) out += '%5E';
    else if (c === 96) out += '%60';
    else if (c === 123) out += '%7B';
    else if (c === 124) out += '%7C';
    else if (c === 125) out += '%7D';
    else if (c < 128) out += p[i];
    else {
      // non-ASCII: UTF-8 percent-encode
      const enc = encodeURIComponent(p[i]);
      out += enc;
    }
  }
  return out;
}

function cleanHref(dest) {
  let cleaned = '';
  for (let i = 0; i < dest.length; i++) {
    const c = dest.charCodeAt(i);
    if (c < 32 || c === 127) continue;
    cleaned += dest[i];
  }
  // Percent-encode, but leave valid %XX sequences intact and bare '%'
  // raw (encodeURI would turn %20 into %2520 and % into %25).
  let enc;
  try {
    enc = cleaned.split(/(%[0-9A-Fa-f]{2})/g).map(p => /^%[0-9A-Fa-f]{2}$/.test(p) ? p : encodeUrlPart(p)).join('');
  } catch (e) {
    enc = cleaned;
  }
  return escAttrValue(enc);
}

// Escape a string for an HTML attribute value, keeping entity-looking
// sequences raw (named entities pass through; numeric entities decode then
// are escaped as text).
function escAttrValue(s) {
  let out = '';
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    if (c === 38) { // '&'
      const ent = decodeEntityAt(s, i);
      if (ent) { out += ent.out; i = ent.end - 1; continue; }
      out += '&amp;'; continue;
    }
    if (c === 34) { out += '&quot;'; continue; }
    if (c === 39) { out += '&#39;'; continue; }
    if (c === 60) { out += '&lt;'; continue; }
    if (c === 62) { out += '&gt;'; continue; }
    out += s[i];
  }
  return out;
}

// ---------- inline parser ----------
// Document-level flag: a multi-line opening <a> tag disables extended
// autolinks (www / scheme / email) for the rest of the document (a marked
// quirk). Reset at the start of parse().
let suppressExtAuto = false;
// Token kinds: string (already-escaped text) or object node.
// Delimiters are collected during the scan and resolved in a second pass.
const DELIM_CHARS = '*_~';

function isLinkLabelChar(c) { return c !== '[' && c !== ']'; }

// Find the end of a bracketed span starting at text[start] === '['.
// Returns { end, blocking, hasLink, fallbacks } where end is the index of the
// matching ']' (or -1), blocking is true when a blocking code span was found,
// hasLink is true when the bracket text contains a link node (which invalidates
// an outer link), and fallbacks lists { n, f, closeEnd } for each backtick run
// of length n that was closed by a shorter run of length f (a fallback-closed
// code span; its backticks stay literal).
// Code spans: a run of n backticks closes at the next run of exactly n; if none,
// the next run of length < n closes it for link-end purposes; if neither exists
// the ']' is swallowed (returns -1).
function findBracketEnd(text, start) {
  const n = text.length;
  let i = start + 1, depth = 0, hasLink = false;
  const cands = []; // { content, closeEnd } for properly-closed code spans
  const fallbacks = []; // { n, f, closeEnd } for fallback-closed code spans
  while (i < n) {
    const c = text.charCodeAt(i);
    if (c === 92) { i += 2; continue; } // backslash escapes next char
    if (c === 96) { // backtick run
      let j = i; while (j < n && text.charCodeAt(j) === 96) j++;
      const len = j - i;
      // find closer: same length first, but never past the ']' that would
      // end this link text (a closer after it belongs to a later span)
      let k = j, closeLen = -1, closeEnd = -1;
      while (k < n) {
        if (text.charCodeAt(k) === 93 && depth === 0) break;
        if (text.charCodeAt(k) === 96) {
          let m = k; while (m < n && text.charCodeAt(m) === 96) m++;
          const rl = m - k;
          if (rl === len) { closeLen = rl; closeEnd = m; break; }
          k = m;
        } else k++;
      }
      if (closeEnd < 0) {
        // fallback: next run of length < len
        k = j;
        while (k < n) {
          if (text.charCodeAt(k) === 96) {
            let m = k; while (m < n && text.charCodeAt(m) === 96) m++;
            if (m - k < len) { closeEnd = m; break; }
            k = m;
          } else k++;
        }
        if (closeEnd < 0) return { end: -1, blocking: false, hasLink: false, fallbacks };
        // fallback-closed: backticks stay literal; no blocking check.
        // Record the pair: a run of len closed by a shorter run of closeEnd - k.
        fallbacks.push({ n: len, f: closeEnd - k, closeEnd });
        i = closeEnd; continue;
      }
      // properly closed code span: record candidate
      cands.push({ content: text.slice(j, closeEnd - closeLen), closeEnd });
      i = closeEnd; continue;
    }
    if (c === 91) { depth++; i++; continue; } // '['
    if (c === 93) { // ']'
      if (depth === 0) {
        // blocking only when the code span is not immediately followed by ']'
        let blocking = false;
        for (let t = 0; t < cands.length; t++) {
          if (cands[t].closeEnd < i && blockingCodeSpan(cands[t].content)) { blocking = true; break; }
        }
        return { end: i, blocking, hasLink, fallbacks };
      }
      depth--; i++; continue;
    }
    if (c === 60) { // '<' could start an autolink or html tag; skip to '>' if it looks like one
      const gt = text.indexOf('>', i + 1);
      if (gt > 0 && gt - i < 200) { i = gt + 1; continue; }
      i++; continue;
    }
    i++;
  }
  return { end: -1, blocking: false, hasLink: false, fallbacks };
}

// Blocking code span rule (from black-box probes of marked 18.1.3):
// content C (between the opener and closer runs). Let R = number of backtick
// runs inside C. Blocking when:
//  - R === 1, or
//  - R >= 2, all inner runs greedily pair by equal length (left to right), and
//    stripped C ends with a backtick and does not start with a backtick.
// The caller also requires text after the code span before the ']' (handled by
// checking the closer is not immediately followed by ']').
function blockingCodeSpan(content) {
  // collect inner backtick runs
  let runs = null, rcount = 0;
  for (let i = 0; i < content.length; i++) {
    if (content.charCodeAt(i) === 96) {
      let j = i; while (j < content.length && content.charCodeAt(j) === 96) j++;
      if (!runs) runs = [];
      runs.push(j - i); rcount++;
      i = j - 1;
    }
  }
  if (rcount === 0) return false;
  if (rcount === 1) return true;
  // greedy pairing by equal length
  const open = [];
  for (let t = 0; t < runs.length; t++) {
    const L = runs[t];
    const idx = open.indexOf(L);
    if (idx >= 0) open.splice(idx, 1);
    else open.push(L);
  }
  if (open.length !== 0) return false;
  // stripped content: one leading + one trailing space removed if both present
  let s = content;
  if (s.length >= 2 && s.charCodeAt(0) === 32 && s.charCodeAt(s.length - 1) === 32) {
    s = s.slice(1, -1);
    // all-spaces content is not stripped; but then it has no backticks, handled above
  }
  if (s.length === 0) return false;
  const endsBt = s.charCodeAt(s.length - 1) === 96;
  const startsBt = s.charCodeAt(0) === 96;
  return endsBt && !startsBt;
}

// End of the emphasis-suppression region opened by a link whose label held a
// fallback-closed code span (opener run length n, fallback closer length f).
// Black-box rule from marked 18.1.3: the region runs from just after the link
// to the first later backtick run of length n; when no such run exists, to the
// LAST later run of length f; when neither exists there is no region (-1).
// Runs are maximal and counted even when backslash-escaped.
function suppressEnd(text, from, n, f) {
  const len = text.length;
  let firstN = -1, lastF = -1;
  let i = from;
  while (i < len) {
    if (text.charCodeAt(i) === 96) {
      let j = i; while (j < len && text.charCodeAt(j) === 96) j++;
      const rl = j - i;
      if (rl === n && firstN < 0) firstN = i;
      if (rl === f) lastF = i;
      i = j;
    } else i++;
  }
  return firstN >= 0 ? firstN : lastF;
}

// Parse a code span starting at text[i] === '`'. Returns { html, end } or null.
// Strict same-length closer (no backtracking); content newlines become spaces;
// one leading+trailing space stripped when content starts+ends with space and
// is not all spaces.
function parseCodeSpan(text, i) {
  const n = text.length;
  let j = i; while (j < n && text.charCodeAt(j) === 96) j++;
  const len = j - i;
  // find next run of exactly len
  let k = j;
  while (k < n) {
    if (text.charCodeAt(k) === 96) {
      let m = k; while (m < n && text.charCodeAt(m) === 96) m++;
      if (m - k === len) {
        let content = text.slice(j, k);
        // newlines -> spaces
        if (content.indexOf('\n') >= 0) content = content.replace(/\n/g, ' ');
        // strip one leading+trailing space when both present and not all spaces
        if (content.length >= 2 && content.charCodeAt(0) === 32 && content.charCodeAt(content.length - 1) === 32) {
          let allSpace = true;
          for (let t = 0; t < content.length; t++) { if (content.charCodeAt(t) !== 32) { allSpace = false; break; } }
          if (!allSpace) content = content.slice(1, -1);
        }
        return { html: '<code>' + escFull(content) + '</code>', text: escFull(content), end: m };
      }
      k = m;
    } else k++;
  }
  return null;
}

// ---------- inline main scan ----------
// refs: Map label -> { href, title }. opts: { noExtAuto, disabled } where
// disabled is a Set of delimiter positions (char offsets) that cannot form emphasis.
function parseInline(text, refs, opts) {
  opts = opts || {};
  const n = text.length;
  const parts = []; // strings and node objects
  const delims = []; // { part, char, len, canOpen, canClose, pos }
  let buf = '';
  const flush = () => { if (buf) { parts.push(buf); buf = ''; } };
  let i = 0;
  const noExtAuto = !!opts.noExtAuto;
  // mutable set of delimiter positions that cannot form emphasis; augmented
  // when a blocking code span rejects an inline link (its bracket text is
  // re-scanned in this same call with emphasis disabled).
  let disabledSet = opts.disabled ? new Set(opts.disabled) : new Set();

  while (i < n) {
    const c = text.charCodeAt(i);
    // backslash escape
    if (c === 92 && i + 1 < n) {
      const nc = text.charCodeAt(i + 1);
      if (isAsciiPunct(nc)) { buf += escText(text[i + 1]); i += 2; continue; }
      if (nc === 10) { // backslash + newline = hard break
        flush(); parts.push({ br: true }); i += 2;
        while (i < n && (text.charCodeAt(i) === 32 || text.charCodeAt(i) === 9)) i++;
        continue;
      }
      buf += '\\'; i++; continue;
    }
    // code span (only at the start of a maximal backtick run)
    if (c === 96) {
      if (i > 0 && text.charCodeAt(i - 1) === 96) { buf += '`'; i++; continue; }
      const cs = parseCodeSpan(text, i);
      if (cs) { flush(); parts.push({ code: cs.html, text: cs.text }); i = cs.end; continue; }
      buf += '`'; i++; continue;
    }
    // emphasis / strikethrough delimiter run
    if (c === 42 || c === 95 || c === 126) { // * _ ~
      let j = i; while (j < n && text.charCodeAt(j) === c) j++;
      const len = j - i;
      const prev = i > 0 ? text[i - 1] : ' ';
      const next = j < n ? text[j] : ' ';
      const lf = isLeftFlanking(prev, next);
      const rf = isRightFlanking(prev, next);
      let canOpen, canClose;
      if (c === 42 || c === 126) { canOpen = lf; canClose = rf; }
      else { // '_'
        canOpen = lf && (!rf || isPunct(prev));
        canClose = rf && (!lf || isPunct(next));
      }
      const pos = i;
      flush();
      const d = { d: String.fromCharCode(c), len, canOpen, canClose, pos, off: 0 };
      if (disabledSet.has(pos)) { d.canOpen = false; d.canClose = false; d.disabled = true; }
      parts.push(d);
      delims.push(d);
      i = j; continue;
    }
    // image / link
    if (c === 33 || c === 91) { // '!' or '['
      const isImg = c === 33;
      let bstart = isImg ? i + 1 : i;
      if (isImg && bstart < n && text.charCodeAt(bstart) !== 91) { buf += '!'; i++; continue; }
      if (bstart >= n || text.charCodeAt(bstart) !== 91) { buf += text[i]; i++; continue; }
      const be = findBracketEnd(text, bstart);
      if (be.end < 0) { // no closing bracket: literal '[' (and '!' if image)
        buf += isImg ? '![' : '['; i = bstart + 1; continue;
      }
      const labelText = text.slice(bstart + 1, be.end);
      const after = be.end + 1;
      const nextCh = after < n ? text.charCodeAt(after) : -1;
      if (nextCh === 40) { // '(' -> try inline link; on failure fall through
        // to reference/shortcut
        const il = parseInlineLink(text, after);
        if (il && !be.blocking) {
          const inner = parseInline(labelText, refs, { noExtAuto: true });
          if (isImg || !inner.hasLink) {
            flush();
            const href = cleanHref(il.dest);
            if (isImg) parts.push({ img: true, src: href, alt: inner.alt, title: il.title });
            else parts.push({ link: true, href, title: il.title, children: inner.parts });
            // A fallback-closed code span inside the label leaves a pending
            // span: emphasis delimiters after the link are disabled up to the
            // end of the suppression region (first later run of the opener
            // length, else the last run of the closer length). Reference
            // links do not trigger this; only inline links/images do.
            if (be.fallbacks) {
              let regionEnd = -1;
              for (let t = 0; t < be.fallbacks.length; t++) {
                const fb = be.fallbacks[t];
                if (fb.closeEnd > be.end) continue;
                const e = suppressEnd(text, il.next, fb.n, fb.f);
                if (e > regionEnd) regionEnd = e;
              }
              if (regionEnd > il.next) {
                for (let t = il.next; t < regionEnd; t++) {
                  const cc = text.charCodeAt(t);
                  if (cc === 42 || cc === 95 || cc === 126) disabledSet.add(t);
                }
              }
            }
            i = il.next; continue;
          }
        }
        if (be.blocking) {
          // blocking code span: inline link rejected, emphasis inside disabled
          for (let t = bstart + 1; t < be.end; t++) {
            const cc = text.charCodeAt(t);
            if (cc === 42 || cc === 95 || cc === 126) disabledSet.add(t);
          }
        }
        // fall through to reference/shortcut below
      }
      // reference / shortcut (only when not followed by '(')
      let refLabel = null, refEnd = -1, hasSecond = false;
      if (nextCh === 91) {
        hasSecond = true;
        if (after + 1 < n && text.charCodeAt(after + 1) === 93) { refLabel = labelText; refEnd = after + 2; }
        else {
          const le = findBracketEnd(text, after);
          if (le.end > after + 1) { refLabel = text.slice(after + 1, le.end); refEnd = le.end + 1; }
        }
      }
      const isShortcut = !hasSecond;
      if (refLabel === null && isShortcut) { refLabel = labelText; refEnd = be.end + 1; }
      // blocking code span rejects full/collapsed references, not shortcuts;
      // emphasis is NOT suppressed for reference links. A label containing
      // '[' is not a valid reference.
      if (refLabel !== null && refLabel.replace(/\\\[/g, '').indexOf('[') < 0 && (!be.blocking || isShortcut)) {
        const norm = normalizeLabel(refLabel);
        const ref = norm && refs.get(norm);
        if (ref) {
          const inner = parseInline(labelText, refs, { noExtAuto: true });
          if (isImg || !inner.hasLink) {
            flush();
            if (isImg) parts.push({ img: true, src: ref.href, alt: inner.alt, title: ref.title });
            else parts.push({ link: true, href: ref.href, title: ref.title, children: inner.parts });
            i = refEnd; continue;
          }
        }
      }
      // no link formed: literal '[' (and '!')
      buf += isImg ? '![' : '['; i = bstart + 1; continue;
    }
    // explicit autolink / inline html tag
    if (c === 60) {
      const tagEnd = matchHtmlTag(text, i);
      if (tagEnd > i) {
        const tag = text.slice(i, tagEnd);
        // an inline <a> opening tag that is never closed disables extended
        // autolinks for the rest of the document (marked quirk); a closing
        // </a> re-enables them. The trigger is a literal space after '<a'
        // (case-insensitive): '<a>' and '<a/>' do not suppress, '<a />',
        // '<a href="u">' and '<A />' do; a tab or newline after '<a' does
        // not. An <a> that forms an HTML block never reaches here, so it
        // does not suppress.
        if (/^<a /i.test(tag)) suppressExtAuto = true;
        else if (/^<\/a\s*>/i.test(tag)) suppressExtAuto = false;
        flush(); parts.push({ html: tag }); i = tagEnd; continue;
      }
      // explicit autolink <scheme:...> or <email>
      const gt = text.indexOf('>', i + 1);
      if (gt > 0 && gt - i < 500) {
        const inner = text.slice(i + 1, gt);
        if (inner.length > 0 && inner.indexOf(' ') < 0 && inner.indexOf('\n') < 0 && inner.indexOf('<') < 0) {
          const m = inner.match(/^([A-Za-z][A-Za-z0-9.+-]{1,31}):([\s\S]*)$/);
          if (m) {
            flush(); parts.push({ auto: true, href: cleanHref(inner), text: escText(inner) }); i = gt + 1; continue;
          }
          if (/^[^\s@\\]+@[^\s@\\]+\.[^\s@\\]+$/.test(inner)) {
            flush(); parts.push({ auto: true, href: 'mailto:' + cleanHref(inner), text: escText(inner) }); i = gt + 1; continue;
          }
        }
      }
      buf += '&lt;'; i++; continue;
    }
    // extended autolink (www / scheme / email). Boundaries differ:
    // www. needs a word boundary (space, newline, tab, >, <, (, *, _, ~);
    // scheme:// (http/https/ftp) has no boundary at all, so it can start
    // mid-word (`xhttp://bar.baz` links `http://bar.baz`); scheme:email
    // (mailto:/xmpp:) requires the previous character to not be
    // alphanumeric (`1mailto:` and `xmailto:` do not link as schemes).
    if (!suppressExtAuto && !noExtAuto && (c === 119 || c === 104 || c === 102 || c === 109 || c === 120 || c === 116 || c === 72 || c === 70 || c === 77 || c === 88 || c === 84)) {
      const prev = i > 0 ? text[i - 1] : ' ';
      const narrow = i === 0 || prev === ' ' || prev === '\n' || prev === '\t' || prev === '>' || prev === '<' || prev === '(' || prev === '*' || prev === '_' || prev === '~';
      let au = null;
      if (narrow) {
        au = tryExtAutolink(text, i);
      } else {
        au = trySchemeUrl(text, i);
        if (!au) {
          const pc = i > 0 ? text.charCodeAt(i - 1) : 32;
          if (!isAlphaNum(pc)) au = trySchemeEmail(text, i);
        }
      }
      if (au) { flush(); parts.push({ auto: true, href: au.href, text: escText(au.text) }); i = au.end; continue; }
    }
    // email autolink: try at any position where a word could start. An
    // email may follow any character that cannot be part of its local part
    // (word chars and '.', '-', '+' are local-part characters, so an email
    // never starts right after one of those).
    if (!suppressExtAuto && !noExtAuto && ((c >= 97 && c <= 122) || (c >= 65 && c <= 90))) {
      const prev = i > 0 ? text.charCodeAt(i - 1) : 32;
      // A '_' that ends an emphasis delimiter run is a valid boundary even
      // though '_' is a word char (e.g. __foo@bar.com__).
      let afterDelim = false;
      if (prev === 95) { for (const d of delims) if (d.d === '_' && d.pos + d.len === i) { afterDelim = true; break; } }
      if (i === 0 || afterDelim || (!isWordChar(prev) && prev !== 46 && prev !== 45 && prev !== 43)) {
        const em = tryEmailAutolink(text, i);
        if (em) {
          if (em.trailEnd !== undefined) {
            // trailing '_' run: link only if an unmatched '_' opener
            // (a delimiter that can open) was scanned before this email
            let hasOpener = false;
            for (const d of delims) if (d.d === '_' && d.canOpen) { hasOpener = true; break; }
            if (!hasOpener) { /* no link; fall through to plain text */ }
            else { const url = text.slice(i, em.trailEnd); flush(); parts.push({ auto: true, href: 'mailto:' + cleanHref(url), text: escText(url) }); i = em.trailEnd; continue; }
          } else { flush(); parts.push({ auto: true, href: em.href, text: escText(em.text) }); i = em.end; continue; }
        }
      }
    }
    // hard break: two or more spaces before newline
    if (c === 10) {
      // count trailing spaces in buf
      let sp = 0; while (buf.length - sp - 1 >= 0 && buf.charCodeAt(buf.length - sp - 1) === 32) sp++;
      // note: buf holds escaped text; spaces are literal ' ' chars
      if (sp >= 2) { buf = buf.slice(0, buf.length - sp); flush(); parts.push({ br: true }); i++;
        while (i < n && (text.charCodeAt(i) === 32 || text.charCodeAt(i) === 9)) i++;
        continue; }
      buf += '\n'; i++; continue;
    }
    // regular text char (with entity handling)
    if (c === 38) { // '&'
      const ent = decodeEntityAt(text, i);
      if (ent) { buf += ent.out; i = ent.end; continue; }
      buf += '&amp;'; i++; continue;
    }
    if (c === 34) { buf += '&quot;'; i++; continue; }
    if (c === 39) { buf += '&#39;'; i++; continue; }
    if (c === 60) { buf += '&lt;'; i++; continue; }
    if (c === 62) { buf += '&gt;'; i++; continue; }
    buf += text[i]; i++;
  }
  flush();
  // resolve emphasis
  const resolved = resolveEmphasis(parts, delims);
  // plain text (for image alt) and whether a link node is present
  const alt = plainText(resolved);
  const hasLink = containsLink(resolved);
  return { parts: resolved, alt, hasLink };
}

// Plain text of a resolved parts array (formatting stripped). Strings are
// already escaped, which is what an image alt attribute needs.
function plainText(parts) {
  let out = '';
  for (const p of parts) {
    if (typeof p === 'string') out += p;
    else if (p.code) out += p.text || '';
    else if (p.img) out += p.alt || '';
    else if (p.children) out += plainText(p.children);
    else if (p.auto) out += p.text;
    else if (p.d) out += escText(p.d.repeat(p.len));
  }
  return out;
}
// A link's text may contain an autolink (<...> or bare URL rendered as one)
// and still form -- marked nests the autolink inside the outer link. Only a
// real link ([...](...) / reference) inside the text invalidates the outer
// link, so autolinks do not count here.
function containsLink(parts) {
  for (const p of parts) {
    if (typeof p !== 'string') {
      if (p.link) return true;
      if (p.children && containsLink(p.children)) return true;
    }
  }
  return false;
}

function isLeftFlanking(prev, next) {
  const pw = !prev || isUnicodeWs(prev.charCodeAt(0));
  const nw = !next || isUnicodeWs(next.charCodeAt(0));
  if (nw) return false;
  if (!isPunct(next)) return true;
  return pw || isPunct(prev);
}
function isRightFlanking(prev, next) {
  const pw = !prev || isUnicodeWs(prev.charCodeAt(0));
  const nw = !next || isUnicodeWs(next.charCodeAt(0));
  if (pw) return false;
  if (!isPunct(prev)) return true;
  return nw || isPunct(next);
}
function isPunct(ch) {
  const code = ch.charCodeAt(0);
  if (code < 128) return isPunctCode(code);
  return /[\p{P}\p{S}]/u.test(ch);
}

// Normalize a link label: collapse internal whitespace to single spaces, lowercase.
// Unicode case folding: ß and ẞ fold to "ss".
function normalizeLabel(s) {
  return s.replace(/ß/g, 'ss').replace(/ẞ/g, 'ss').replace(/\s+/g, ' ').trim().toLowerCase();
}

// ---------- entity decoding at a position ----------
// s[i] === '&'. Returns { out, end } or null when no entity matches.
// Named entities pass through literally (never decoded); numeric entities
// decode then are escaped as text.
function decodeEntityAt(s, i) {
  const n = s.length;
  if (i + 1 < n && s.charCodeAt(i + 1) === 35) {
    const num = decodeNumericEntity(s, i);
    if (num) return { out: escText(num[0]), end: num[1] };
    return null;
  }
  let j = i + 1;
  if (j < n && isWordChar(s.charCodeAt(j))) {
    while (j < n && isWordChar(s.charCodeAt(j))) j++;
    if (j < n && s.charCodeAt(j) === 59) return { out: s.slice(i, j + 1), end: j + 1 };
  }
  return null;
}

// ---------- extended autolinks ----------
// URL candidate: scan until whitespace, '<', '>', or '&' followed by an
// entity-looking sequence. Then trim: drop trailing unmatched ')', drop a
// trailing ';' ending an entity-like sequence, drop trailing punctuation.
const TRIM_PUNCT = '?!.,:;*_~';
function scanUrlCandidate(text, i) {
  const n = text.length;
  let j = i;
  while (j < n) {
    const c = text.charCodeAt(j);
    if (c === 32 || c === 9 || c === 10 || c === 13 || c === 60 || c === 62) break;
    if (c === 38) {
      // stop at '&' when what follows looks like an entity (&word; or &#...;)
      let k = j + 1;
      if (k < n && text.charCodeAt(k) === 35) { break; }
      if (k < n && isWordChar(text.charCodeAt(k))) {
        while (k < n && isWordChar(text.charCodeAt(k))) k++;
        if (k < n && text.charCodeAt(k) === 59) break;
      }
    }
    j++;
  }
  return j;
}
// Single-level paren model for autolink URLs (probed against marked):
// a '(' opens a group only while none is open, and only when the next
// character is not ')' or the paren balance before it is non-negative
// (an empty '()' never opens a group that starts in deficit, so a stray
// ')' before it leaves the closing ')' unprotected); a ')' closes the
// group only while one is open, otherwise it is plain content. Returns
// whether a group is still open at the end of the range and, if so, the
// '(' that opened it.
function parenScan(text, start, end) {
  let inParen = false, openPos = -1, opens = 0, closes = 0;
  for (let k = start; k < end; k++) {
    const c = text.charCodeAt(k);
    if (c === 40) {
      if (!inParen && (text[k + 1] !== ')' || opens >= closes)) { inParen = true; openPos = k; }
      opens++;
    } else if (c === 41) {
      if (inParen) { inParen = false; openPos = -1; }
      closes++;
    }
  }
  return { inParen, openPos };
}
function trimUrl(text, start, end) {
  // end is exclusive. Returns the trimmed end.
  let e = end;
  // Unclosed '(' rule: if a paren group is still open at the end of the
  // URL, truncate at the '(' that opened it.
  const ps = parenScan(text, start, e);
  if (ps.inParen) e = ps.openPos;
  // trim loop until stable
  let changed = true;
  while (changed) {
    changed = false;
    if (e > start) {
      const last = text.charCodeAt(e - 1);
      // drop a trailing ')' only when no paren group is open just
      // before it
      if (last === 41) {
        if (!parenScan(text, start, e - 1).inParen) { e--; changed = true; continue; }
      }
      // drop trailing ';' ending an entity-like sequence
      if (last === 59) {
        let k = e - 2;
        while (k >= start && isWordChar(text.charCodeAt(k))) k--;
        if (k >= start && text.charCodeAt(k) === 38) { e--; changed = true; continue; }
      }
      // drop trailing punctuation
      const ch = text[e - 1];
      if (TRIM_PUNCT.indexOf(ch) >= 0) { e--; changed = true; continue; }
    }
  }
  return e;
}

// Try an extended autolink (www / scheme / email) at text[i].
// Returns { href, text, end } or null. www. needs a word boundary (enforced
// by the caller); scheme:// has no boundary; scheme:email is tried by
// trySchemeEmail with its own boundary.
function tryWwwAutolink(text, i) {
  if (!text.startsWith('www.', i)) return null;
  const end0 = scanUrlCandidate(text, i);
  const end = trimUrl(text, i, end0);
  if (end <= i + 4) return null;
  const url = text.slice(i, end);
  return { href: 'http://' + cleanHref(url), text: url, end };
}

// scheme:// (http, https, ftp only, case-insensitive). No word boundary.
function trySchemeUrl(text, i) {
  const sm = /^[A-Za-z][A-Za-z0-9+.-]*:\/\//.exec(text.slice(i, i + 40));
  if (!sm) return null;
  const scheme = sm[0].slice(0, -3).toLowerCase();
  if (scheme !== 'http' && scheme !== 'https' && scheme !== 'ftp') return null;
  const end0 = scanUrlCandidate(text, i);
  const end = trimUrl(text, i, end0);
  if (end <= i + sm[0].length) return null;
  const url = text.slice(i, end);
  return { href: cleanHref(url), text: url, end };
}

// scheme:email. Only the lowercase schemes `mailto:` and `xmpp:` form a
// scheme:email link. `mailto:` takes no path; `xmpp:` takes one path
// segment of [A-Za-z0-9.@]* (stopping at a second '/', '?', '#', or any
// other character), with trailing '.' trimmed.
function trySchemeEmail(text, i) {
  const n = text.length;
  const cm = /^([A-Za-z][A-Za-z0-9+.-]{1,31}):/.exec(text.slice(i, i + 40));
  if (!cm) return null;
  const scheme = cm[1];
  if (scheme !== 'mailto' && scheme !== 'xmpp') return null;
  const afterColon = i + cm[0].length;
  const em = matchEmailAt(text, afterColon);
  if (!em) return null;
  // a domain ending in '_' never links as a scheme:email (gfm-633)
  if (em.trailEnd !== undefined) return null;
  let end = em.end;
  if (scheme === 'xmpp' && end < n && text.charCodeAt(end) === 47) {
    let p = end + 1;
    while (p < n) {
      const c = text.charCodeAt(p);
      if (isAlphaNum(c) || c === 46 || c === 64) { p++; continue; }
      break;
    }
    if (p > end + 1) {
      // trim trailing '.' from the segment (the '/' itself stays)
      let te = p;
      while (te > end + 1 && text.charCodeAt(te - 1) === 46) te--;
      end = te;
    }
    // else: no segment character after '/': the '/' stays outside
  }
  const url = text.slice(i, end);
  return { href: cleanHref(url), text: url, end };
}

function tryExtAutolink(text, i) {
  return tryWwwAutolink(text, i) || trySchemeUrl(text, i) || trySchemeEmail(text, i);
}

// Match an email starting at text[i]. Returns { end } or null.
// Local part: word chars plus . - _ + ; domain: labels of word chars / '-',
// separated by '.', at least one dot, no empty label, no trailing '_' or '-'
// after the domain (that prevents the link).
function matchEmailAt(text, i) {
  const n = text.length;
  let j = i;
  // local part
  if (j >= n || !isEmailLocalChar(text.charCodeAt(j))) return null;
  while (j < n && isEmailLocalChar(text.charCodeAt(j))) j++;
  if (j >= n || text.charCodeAt(j) !== 64) return null; // '@'
  j++;
  // domain: first label
  let labelStart = j, k = j;
  while (k < n && (isWordChar(text.charCodeAt(k)) || text.charCodeAt(k) === 45)) k++;
  if (k === labelStart) return null; // empty first label
  let dots = 0, end = k;
  while (k < n && text.charCodeAt(k) === 46) {
    // '.' then next label; an empty label after the dot means a trailing
    // dot, which is not part of the email.
    let ls = k + 1, m = ls;
    while (m < n && (isWordChar(text.charCodeAt(m)) || text.charCodeAt(m) === 45)) m++;
    if (m === ls) break;
    dots++; end = m; k = m;
  }
  if (dots === 0) return null; // domain needs a dot
  // The domain must not end with '-' or '_': back up over trailing '-'
  // and '_' in the last label. If the trailing run is all '_' it may be
  // an emphasis closer (e.g. __foo@bar.com__): report trailEnd and let the
  // caller link only when a matching '_' opener exists. Any '-' in the
  // trailing run means no link.
  let e2 = end;
  while (e2 > j && (text.charCodeAt(e2 - 1) === 45 || text.charCodeAt(e2 - 1) === 95)) e2--;
  if (e2 < end) {
    let allUnd = true;
    for (let q = e2; q < end; q++) if (text.charCodeAt(q) !== 95) { allUnd = false; break; }
    if (!allUnd) return null;
    return { end, trailEnd: e2 };
  }
  return { end };
}
function isEmailLocalChar(c) {
  return isWordChar(c) || c === 46 || c === 45 || c === 43; // word, '.', '-', '+'
}

// Try a bare email autolink at text[i]. Returns { href, text, end } or null.
function tryEmailAutolink(text, i) {
  const em = matchEmailAt(text, i);
  if (!em) return null;
  if (em.trailEnd !== undefined) return { trailEnd: em.trailEnd, end: em.end };
  const url = text.slice(i, em.end);
  return { href: 'mailto:' + cleanHref(url), text: url, end: em.end };
}

// ---------- emphasis / strong / strikethrough ----------
// Resolves delimiter runs in a parts array into em/strong/del nodes.
// Delimiter objects are { d, len, canOpen, canClose }. Leftover delimiters
// become literal text. Nested emphasis inside a new node is resolved first.
function resolveEmphasis(parts) {
  let arr = parts.slice();
  // A closer that fails to pair is never retried (single forward pass, as in
  // the reference). A closer that can BOTH open and close, when it pairs,
  // shields the opener it matched: later closers may not look past that
  // shielded node for an opener. A failed closer clears the shields, so a
  // later closer can look back again. This is what keeps the outer strong
  // from forming in '**a *b*c d**' (inner closer can both) while letting it
  // form in '**a *b*c* d**' (an intervening closer fails first) and in
  // '**a *b* c**' (inner closer can only close).
  const failed = new Set();
  for (;;) {
    // collect delimiters in order
    const dlist = [];
    for (let i = 0; i < arr.length; i++) {
      const p = arr[i];
      if (p && typeof p === 'object' && p.d) dlist.push({ idx: i, d: p });
    }
    let formed = false;
    for (let ci = 0; ci < dlist.length && !formed; ci++) {
      const closer = dlist[ci].d;
      if (!closer.canClose || closer.len === 0) continue;
      if (failed.has(closer)) continue;
      const ciIdx = dlist[ci].idx;
      // nearest shielded node to the left of this closer; it blocks lookback
      // only for a strong-forming opener (len >= 2) or when the shielded
      // inner pair itself was strong -- a len-1 opener past a shielded inner
      // em can still form em ('*uses state *callback*markdown**')
      let shieldPos = -1, shieldUse = 0;
      for (let k = ciIdx - 1; k >= 0; k--) {
        const q = arr[k];
        if (q && typeof q === 'object' && q.shield && q.dc === closer.d) { shieldPos = k; shieldUse = q.use || 0; break; }
      }
      let paired = false;
      // Whether this closer was blocked by a use-mismatch shield during
      // its opener scan. A len-1 closer failing on a use mismatch (as in
      // '**removes example *input **parse**parse* release**', where the
      // lone '*' after 'parse' must stay literal) must NOT clear the
      // shield: the shield still has to stop the outer '**' closer from
      // stealing the lone '*' opener as an em. A len-2+ closer failing
      // (as in '**a *b*c**d**', where the first '**' after a tight em is
      // blocked) or a len-1 closer failing only on the len clause (as in
      // '**a *b*c* d**') still clears it, so a later closer can pair.
      let hitMismatch = false;
      for (let oi = ci - 1; oi >= 0; oi--) {
        const opener = dlist[oi].d;
        const oiIdx = dlist[oi].idx;
        // A shield blocks a later pairing only when the closer is a single
        // delimiter reaching for a strong opener (len >= 2, as in
        // '**a *b*c* d**' where the lone '*' after 'c' must stay literal
        // so the '**' pair can still form strong) or when the shielded
        // inner pair's use (em=1, strong=2) differs from this pairing's
        // use (as in '**a *b*c d**', inner em vs outer strong). A lone
        // closer reaching for a lone opener (both len 1, an em pair such
        // as '*state *types*updates* it*') is not blocked: it is the
        // outer em's own closer, and blocking it would let a later '*'
        // steal the pairing. When the uses match (inner strong vs outer
        // strong, or inner em vs outer em) the outer pair still forms.
        const candUse = (opener.len >= 2 && closer.len >= 2) ? 2 : 1;
        // A closer with spare delimiters (len >= 3) reaching for a strong
        // opener is not blocked by a use mismatch: it forms the strong
        // with two of its delimiters and leaves the rest literal (as in
        // '**by command *tool*one***', where the '***' closes the outer
        // strong and leaves one '*' literal).
        const spareCloser = closer.len >= 3 && opener.len >= 2;
        // A leftover closer (remainder of a partly-used run) is exempt
        // from the use-mismatch block: it belongs to the inner pair's own
        // closer run, so that pair's shield must not stop it from closing
        // an outer pair.
        const useMismatchBlocked = shieldUse !== candUse && !spareCloser && !closer.leftover;
        const mismatchBlock = oiIdx <= shieldPos && useMismatchBlocked;
        const lenBlock = oiIdx <= shieldPos && closer.len === 1 && opener.len >= 2;
        if (mismatchBlock) hitMismatch = true;
        if (mismatchBlock || lenBlock) continue;
        if (opener.d !== closer.d) continue;
        if (!opener.canOpen || opener.len === 0) continue;
        // rule of three: when either delimiter can both open and close, the
        // sum must not be a multiple of 3 unless both are multiples of 3.
        if ((opener.canClose || closer.canOpen) &&
            (opener.len + closer.len) % 3 === 0 &&
            (opener.len % 3 !== 0 || closer.len % 3 !== 0)) continue;
        // how many delimiters to use
        let use;
        if (opener.d === '~') {
          // strikethrough uses 1 or 2 tildes; a run of 3+ is not a delimiter
          if (opener.len > 2 || closer.len > 2) continue;
          use = (opener.len >= 2 && closer.len >= 2) ? 2 : 1;
        } else {
          use = (opener.len >= 2 && closer.len >= 2) ? 2 : 1;
        }
        // resolve inner parts first (nested emphasis)
        const inner = resolveEmphasis(arr.slice(oiIdx + 1, ciIdx));
        let node;
        if (opener.d === '~') node = { del: true, children: inner };
        else if (use === 2) node = { strong: true, children: inner };
        else node = { em: true, children: inner };
        // shield only when the inner pair is lopsided: its opener can
        // only open and its closer can both open and close (e.g. the '*'
        // before 'b' in '**a *b*c d**'). When the opener can both (as in
        // '**foo*bar*baz**') or the closer can only close (as in
        // '**a *b* c**'), no shield: the outer pair still forms.
        node.use = use;
        node.dc = opener.d;
        node.shield = opener.canOpen && !opener.canClose && closer.canOpen && closer.canClose;
        // rebuild arr: before opener, opener leftover, node, closer leftover, after closer
        const before = arr.slice(0, oiIdx);
        const after = arr.slice(ciIdx + 1);
        const mid = [];
        if (opener.len > use) {
          const left = { d: opener.d, len: opener.len - use, canOpen: opener.canOpen, canClose: opener.canClose, pos: opener.pos };
          mid.push(left);
        }
        mid.push(node);
        if (closer.len > use) {
          // Mark the remainder of a partly-used closer run: it is the
          // same run as the inner pair's own closer, so the shield that
          // pair set must not block it from closing an outer pair (as in
          // '*then is **next (x)***', where the leftover '*' closes the
          // outer em around the inner strong).
          // A spare closer that only paired because the spareCloser
          // exemption overrode a use-mismatch shield leaves its spare
          // delimiters INSIDE the node, as its last children (as in
          // '**by command *tool*one***' and '**a *b*c***d**', where the
          // tight inner em makes the run's first two delimiters unusable
          // as the closer, so the closer is the run's last two and the
          // spare ones stay inside). When no shield was overridden (as
          // in '**a *b* c***' or '**a***'), the spare goes after the node.
          const right = { d: closer.d, len: closer.len - use, canOpen: closer.canOpen, canClose: closer.canClose, pos: closer.pos, leftover: true };
          const exempted = shieldPos >= 0 && oiIdx <= shieldPos && shieldUse !== candUse && spareCloser && !closer.leftover;
          if (exempted) inner.push(right);
          else mid.push(right);
        }
        arr = before.concat(mid, after);
        formed = true;
        paired = true;
        break;
      }
      if (!paired) {
        failed.add(closer);
        // A len-1 closer that failed on a use-mismatch shield leaves the
        // shield up (see hitMismatch above); any other failure clears it.
        if (!(closer.len === 1 && hitMismatch)) {
          for (let k = 0; k < arr.length; k++) {
            const q = arr[k];
            if (q && typeof q === 'object' && q.shield) q.shield = false;
          }
        }
      }
    }
    if (!formed) break;
  }
  // leftover delimiters become literal text
  for (let i = 0; i < arr.length; i++) {
    const p = arr[i];
    if (p && typeof p === 'object' && p.d) {
      arr[i] = escText(p.d.repeat(p.len));
    }
  }
  return arr;
}

// Render a resolved parts array to HTML.
function renderInline(parts) {
  let out = '';
  for (const p of parts) {
    if (typeof p === 'string') { out += p; continue; }
    if (p.br) { out += '<br>'; continue; }
    if (p.code) { out += p.code; continue; }
    if (p.html) { out += p.html; continue; }
    if (p.auto) { out += '<a href="' + p.href + '">' + p.text + '</a>'; continue; }
    if (p.link) {
      out += '<a href="' + p.href + '"';
      if (p.title != null) out += ' title="' + p.title + '"';
      out += '>' + renderInline(p.children) + '</a>';
      continue;
    }
    if (p.img) {
      out += '<img src="' + p.src + '" alt="' + p.alt + '"';
      if (p.title != null) out += ' title="' + p.title + '"';
      out += '>';
      continue;
    }
    if (p.em) { out += '<em>' + renderInline(p.children) + '</em>'; continue; }
    if (p.strong) { out += '<strong>' + renderInline(p.children) + '</strong>'; continue; }
    if (p.del) { out += '<del>' + renderInline(p.children) + '</del>'; continue; }
    if (p.d) { out += escText(p.d.repeat(p.len)); continue; }
  }
  return out;
}

// ---------- block parser ----------
// Block node types: para, atx, fence, code, html, hr, bq, list, item, table.
// A container stack tracks open blockquotes/lists/items; the current leaf is
// the innermost open leaf block.

function splitLines(src) {
  // Split on \n; strip a trailing \r (CRLF). A trailing newline does not
  // create an extra blank line.
  const raw = src.split('\n');
  if (raw.length > 1 && raw[raw.length - 1] === '') raw.pop();
  const lines = raw.map(l => (l.length && l.charCodeAt(l.length - 1) === 13) ? l.slice(0, -1) : l);
  return lines;
}

// Match a blockquote prefix at line[i..]: up to 3 spaces, '>', optional 1 space.
// Returns the index after the prefix, or -1.
// Match a blockquote marker at line[i..] (i is at absolute column
// startCol). Returns { end, tabSpaces } or null. `end` is the char index
// just after the marker (and any single space after it, or a tab after it).
// If a tab follows '>', the blockquote consumes 1 column of it and
// tabSpaces is the number of spaces the tab's remainder contributes.
function matchBQ(line, i, startCol) {
  const n = line.length;
  let j = i, spaces = 0;
  while (j < n && line.charCodeAt(j) === 32 && spaces < 3) { j++; spaces++; }
  if (j < n && line.charCodeAt(j) === 62) {
    j++;
    if (j < n && line.charCodeAt(j) === 32) { j++; return { end: j, tabSpaces: 0 }; }
    if (j < n && line.charCodeAt(j) === 9) {
      const colAtTab = (startCol || 0) + colOf(line, i, j);
      const w = 4 - (colAtTab % 4);
      return { end: j + 1, tabSpaces: w - 1 };
    }
    return { end: j, tabSpaces: 0 };
  }
  return null;
}

// Parse a list marker at line[i..] (after up to 3 spaces of indent), where
// line[i] is at absolute column startCol.
// Returns { marker, ordered, start, width, contentIndent, indent, afterMarker }
// or null. marker is the raw marker text; width is the marker width in
// columns; contentIndent is the indent (columns, relative to line[i]) of
// the item content; indent is the spaces before the marker.
function parseListMarker(line, i, startCol) {
  const n = line.length;
  let j = i;
  while (j < n && line.charCodeAt(j) === 32) j++;
  const indent = j - i;
  if (indent > 3) return null;
  const c = line.charCodeAt(j);
  let ordered = false, start = 1, markerEnd = -1;
  if (c === 45 || c === 43 || c === 42) { // - + *
    markerEnd = j + 1;
  } else if (c >= 48 && c <= 57) {
    let k = j;
    while (k < n && line.charCodeAt(k) >= 48 && line.charCodeAt(k) <= 57) k++;
    if (k - j > 9) return null;
    if (k < n && (line.charCodeAt(k) === 46 || line.charCodeAt(k) === 41)) {
      ordered = true; start = parseInt(line.slice(j, k), 10); markerEnd = k + 1;
    } else return null;
  } else return null;
  // after the marker: 1+ spaces/tabs, or end of line
  let k = markerEnd;
  let spaces = 0;
  let col = (startCol || 0) + (markerEnd - i); // absolute column at marker end
  while (k < n && (line.charCodeAt(k) === 32 || line.charCodeAt(k) === 9)) {
    if (line.charCodeAt(k) === 9) {
      const w = 4 - (col % 4);
      col += w; spaces += w;
    } else { col++; spaces++; }
    k++;
    if (spaces >= 5) break;
  }
  const afterMarker = k;
  let contentIndent;
  if (k >= n) {
    // blank item: content indent = marker width + 1
    contentIndent = (markerEnd - i) + 1;
  } else if (spaces === 0) {
    return null; // no space after marker
  } else if (spaces >= 5) {
    contentIndent = (markerEnd - i) + 1;
  } else {
    contentIndent = (markerEnd - i) + spaces;
  }
  return { marker: line.slice(j, markerEnd), ordered, start, width: markerEnd - i, contentIndent, indent, afterMarker };
}

// ATX heading: up to 3 spaces, 1-6 '#', space or EOL, optional closing #'s.
function parseATX(line, i) {
  const n = line.length;
  let j = i;
  while (j < n && line.charCodeAt(j) === 32) j++;
  if (j - i > 3) return null;
  let hashes = 0;
  while (j < n && line.charCodeAt(j) === 35) { j++; hashes++; }
  if (hashes === 0 || hashes > 6) return null;
  if (j < n && line.charCodeAt(j) !== 32 && line.charCodeAt(j) !== 9) return null;
  // text: strip leading/trailing spaces and closing #'s
  let text = line.slice(j);
  text = text.replace(/^[ \t]+/, '').replace(/[ \t]+$/, '');
  // closing sequence: trailing #'s preceded by a space, or the whole text
  if (/^#+$/.test(text)) text = '';
  else text = text.replace(/[ \t]+#+$/, '').replace(/[ \t]+$/, '');
  return { level: hashes, text };
}

// Thematic break: up to 3 spaces, 3+ of -, _, or * (same char), only spaces.
function parseHR(line, i) {
  const n = line.length;
  let j = i;
  while (j < n && line.charCodeAt(j) === 32) j++;
  if (j - i > 3) return null;
  if (j >= n) return null;
  const c = line.charCodeAt(j);
  if (c !== 45 && c !== 95 && c !== 42) return null;
  let count = 0;
  while (j < n) {
    const ch = line.charCodeAt(j);
    if (ch === c) { count++; j++; }
    else if (ch === 32 || ch === 9) j++;
    else return null;
  }
  return count >= 3 ? { ch: String.fromCharCode(c) } : null;
}

// Fenced code start: up to 3 spaces, 3+ backticks or tildes. Backtick fence
// info must not contain a backtick. Returns { char, len, info, indent }.
function parseFenceStart(line, i) {
  const n = line.length;
  let j = i;
  while (j < n && line.charCodeAt(j) === 32) j++;
  if (j - i > 3) return null;
  if (j >= n) return null;
  const c = line.charCodeAt(j);
  if (c !== 96 && c !== 126) return null;
  let k = j;
  while (k < n && line.charCodeAt(k) === c) k++;
  const len = k - j;
  if (len < 3) return null;
  const info = line.slice(k).replace(/^[ \t]+/, '').replace(/[ \t]+$/, '');
  if (c === 96 && info.indexOf('`') >= 0) return null;
  return { char: String.fromCharCode(c), len, info, indent: j - i };
}

// HTML block start type (1-7) or 0. line is the content after containers.
function htmlBlockType(line, i) {
  const n = line.length;
  let j = i;
  while (j < n && line.charCodeAt(j) === 32) j++;
  if (j - i > 3) return 0;
  if (j >= n || line.charCodeAt(j) !== 60) return 0;
  // type 1: script, pre, style, textarea (the tag name may end the line;
  // the opening tag can span lines, e.g. `<style\n  type="...">`)
  const m1 = line.slice(j).match(/^<(script|pre|style|textarea)(\s|>|\/|$)/i);
  if (m1) return 1;
  if (line.startsWith('<!--', j)) return 2;
  if (line.startsWith('<?', j)) return 3;
  if (line.startsWith('<!', j)) {
    const c2 = line.charCodeAt(j + 2);
    if ((c2 >= 65 && c2 <= 90) || (c2 >= 97 && c2 <= 122)) return 4;
    if (line.startsWith('[CDATA[', j + 2)) return 5;
    return 0;
  }
  if (line.startsWith('<![CDATA[', j)) return 5;
  // type 6: block-level tag
  const m6 = line.slice(j).match(/^<\/?(address|article|aside|base|basefont|blockquote|body|caption|center|col|colgroup|dd|details|dialog|dir|div|dl|dt|fieldset|figcaption|figure|footer|form|frame|frameset|h1|h2|h3|h4|h5|h6|head|header|hr|html|iframe|legend|li|link|main|menu|menuitem|nav|noframes|ol|optgroup|option|p|param|search|section|summary|table|tbody|td|tfoot|th|thead|title|tr|track|ul)(\s|\/?>|\/?$)/i);
  if (m6) return 6;
  // type 7: open/close tag alone on the line
  if (matchHtmlTag(line, j) >= 0) {
    // must be alone on the line (only whitespace after)
    const end = matchHtmlTag(line, j);
    let k = end;
    while (k < n && (line.charCodeAt(k) === 32 || line.charCodeAt(k) === 9)) k++;
    if (k >= n) return 7;
  }
  return 0;
}

// Link reference definition at the start of a paragraph's lines.
// Returns { label, href, title, consumed } or null. consumed = lines used.
// Parse a link title starting at s[i] ('"' or '\'' or '('), possibly
// spanning multiple lines. lines/startIdx give the following lines.
// Returns { title, consumed } (consumed = extra lines used) or null.
function parseMultiLineTitle(lines, startIdx, s, i) {
  const c = s.charCodeAt(i);
  let close;
  if (c === 34) close = 34;
  else if (c === 39) close = 39;
  else if (c === 40) close = 41;
  else return null;
  let out = '';
  let j = i + 1;
  let li = startIdx;
  let cur = s;
  for (;;) {
    while (j < cur.length) {
      const ch = cur.charCodeAt(j);
      if (ch === 92 && j + 1 < cur.length && isAsciiPunct(cur.charCodeAt(j + 1))) {
        out += cur[j + 1];
        j += 2;
        continue;
      }
      if (ch === close) {
        // only whitespace may follow on this line
        let e = j + 1;
        while (e < cur.length && (cur.charCodeAt(e) === 32 || cur.charCodeAt(e) === 9)) e++;
        if (e < cur.length) return null;
        return { title: escAttrValue(out), consumed: li - startIdx };
      }
      if (close === 41 && ch === 40) return null;
      out += cur[j];
      j++;
    }
    // end of line without closing: continue on the next line
    if (li + 1 >= lines.length) return null;
    li++;
    out += '\n';
    cur = lines[li];
    j = 0;
  }
}

function parseLinkRefDef(lines, startIdx) {
  // A definition may span up to 3 lines (label, dest, title).
  // We parse from lines[startIdx], possibly continuing to following lines.
  const first = lines[startIdx];
  let i = 0;
  while (i < first.length && first.charCodeAt(i) === 32) i++;
  if (i > 3 || i >= first.length || first.charCodeAt(i) !== 91) return null;
  // find label end; the label may span lines, e.g. `[\nfoo\n]: /url`
  // (a definition spans at most 3 lines, so the label spans at most 3).
  let label = null, rest = null, labelEndLine = startIdx;
  const be0 = findBracketEnd(first, i);
  if (be0.end >= 0) {
    label = first.slice(i + 1, be0.end);
    rest = first.slice(be0.end + 1);
  } else {
    let joined = first;
    for (let extra = 1; extra <= 2 && startIdx + extra < lines.length; extra++) {
      joined += '\n' + lines[startIdx + extra];
      const b2 = findBracketEnd(joined, i);
      if (b2.end >= 0) {
        let ln = 0, ls = 0;
        for (let c = 0; c < b2.end; c++) if (joined.charCodeAt(c) === 10) { ln++; ls = c + 1; }
        labelEndLine = startIdx + ln;
        label = joined.slice(i + 1, b2.end);
        rest = lines[labelEndLine].slice(b2.end - ls + 1);
        break;
      }
    }
    if (label === null) return null;
  }
  if (!label.trim()) return null;
  // a link label cannot contain an unescaped '[' (an escaped '\[' is fine)
  if (label.replace(/\\\[/g, '').indexOf('[') >= 0) return null;
  // rest: ':' then optional ws, dest, optional title, only ws to EOL
  let p = 0;
  while (p < rest.length && (rest.charCodeAt(p) === 32 || rest.charCodeAt(p) === 9)) p++;
  if (p >= rest.length || rest.charCodeAt(p) !== 58) return null;
  p++;
  // dest may be on the next line if rest is empty after ':'
  let dest = null, title = null;
  const labelLines = labelEndLine - startIdx + 1;
  let consumed = labelLines;
  const tryParse = (s, lineIdx) => {
    let q = 0;
    while (q < s.length && (s.charCodeAt(q) === 32 || s.charCodeAt(q) === 9)) q++;
    if (q >= s.length) return { needMore: true };
    const d = parseLinkDest(s, q);
    if (!d) return null;
    let r = d.next;
    const wsStart = r;
    while (r < s.length && (s.charCodeAt(r) === 32 || s.charCodeAt(r) === 9)) r++;
    if (r >= s.length) return { dest: d.dest, title: null, rest: '' };
    // a title must be separated from the destination by whitespace
    if (r === wsStart) return null;
    const t = parseMultiLineTitle(lines, lineIdx, s, r);
    if (!t) return null;
    return { dest: d.dest, title: t.title, rest: '', titleLines: t.consumed };
  };
  let r0 = tryParse(rest.slice(p), labelEndLine);
  if (r0 && r0.needMore) {
    // dest on next line
    if (labelEndLine + 1 >= lines.length || labelLines + 1 > 3) return null;
    const r1 = tryParse(lines[labelEndLine + 1], labelEndLine + 1);
    if (!r1 || r1.needMore) return null;
    dest = r1.dest; title = r1.title; consumed = labelLines + 1 + (r1.titleLines || 0);
    // title might be on the third line
    if (title === null && consumed < 3 && labelEndLine + 2 < lines.length) {
      const tl = lines[labelEndLine + 2];
      let q = 0;
      while (q < tl.length && (tl.charCodeAt(q) === 32 || tl.charCodeAt(q) === 9)) q++;
      if (q < tl.length) {
        const t2 = parseMultiLineTitle(lines, labelEndLine + 2, tl, q);
        if (t2) { title = t2.title; consumed = labelLines + 2 + t2.consumed; }
      }
    }
  } else if (r0) {
    dest = r0.dest; title = r0.title;
    consumed = labelLines + (r0.titleLines || 0);
    if (title === null && labelLines + 1 <= 3 && labelEndLine + 1 < lines.length) {
      const tl = lines[labelEndLine + 1];
      let q = 0;
      while (q < tl.length && (tl.charCodeAt(q) === 32 || tl.charCodeAt(q) === 9)) q++;
      if (q < tl.length) {
        const t2 = parseMultiLineTitle(lines, labelEndLine + 1, tl, q);
        if (t2) { title = t2.title; consumed = labelLines + 1 + t2.consumed; }
      }
    }
  } else return null;
  if (dest === null) return null;
  return { label: normalizeLabel(label), href: cleanHref(dest), title, consumed };
}

// ---------- main block parsing ----------
// Parse an array of lines into a block tree. refs is filled with link
// reference definitions (first definition wins).
function parseBlocks(lines, refs, srcEndsWithNewline) {
  const root = { t: 'root', children: [] };
  // stack of open containers (root is stack[0]); each has children.
  const stack = [root];
  let leaf = null; // current open leaf block, or null
  let leafParent = root;

  // Deferred list loosening: a blank line only loosens a list when the next
  // non-blank content is still inside that list. A blank line can sit
  // inside several nested lists; the one that loosens is the deepest list
  // the next content is still inside (a blank between two items of an
  // inner list loosens only the inner list; a blank that leaves the inner
  // list loosens the outer one).
  let pendingLooseLists = null;
  // Lists in the innermost bq-free segment of the stack (deepest first).
  // A blank line inside a blockquote does not loosen a list outside it.
  function listsInScope(st) {
    const out = [];
    for (let s = st.length - 1; s >= 1; s--) {
      const c = st[s];
      if (c.t === 'bq') break;
      if (c.t === 'list') out.push(c);
    }
    return out;
  }
  function innermostList(st) {
    for (let s = st.length - 1; s >= 1; s--) {
      const c = st[s];
      if (c.t === 'bq') break;
      if (c.t === 'list') return c;
      if (c.t === 'item') {
        for (let t = s - 1; t >= 1; t--) {
          if (st[t].t === 'list') return st[t];
          if (st[t].t === 'bq') return null;
        }
        return null;
      }
    }
    return null;
  }

  const cur = () => stack[stack.length - 1];
  const addBlock = (b) => { cur().children.push(b); };
  const closeLeaf = () => { leaf = null; };

  // Match containers against a line. Returns { matched, content, contentCol,
  // blank, lazy } where content is the line after matched container prefixes,
  // contentCol is the column of the content start, blank is whether the
  // remaining content is blank, and lazy is whether the line did not match
  // some container (so it may be a lazy continuation).
  function matchContainers(line) {
    let pos = 0; // char index into line
    let col = 0; // column
    let matched = 0;
    let lazy = false;
    let prefix = ''; // spaces from a partly-consumed tab
    for (let s = 1; s < stack.length; s++) {
      const c = stack[s];
      if (c.t === 'bq') {
        // A tab after '>' inside a list item expands against the list
        // item's content column, not the absolute column (the same rule
        // as the fence-content tab code): subtract the innermost list
        // containing this quote from the column handed to matchBQ, so
        // a tab after '>' in a list-item blockquote gets the width
        // marked gives (as in a fence inside '>...' in a list item,
        // where a tab at absolute column 3 is 2 spaces, not 0).
        let bqBase = 0;
        for (let sj = s - 1; sj >= 1; sj--) {
          if (stack[sj].t === 'list') { bqBase = stack[sj].contentCol || 0; break; }
        }
        const m = matchBQ(line, pos, col - bqBase);
        if (!m) { lazy = true; break; }
        prefix += ' '.repeat(m.tabSpaces);
        col = colFrom(line, pos, m.end, col);
        pos = m.end;
        matched = s;
      } else if (c.t === 'item') {
        // consume the item's content indent (columns), handling tabs.
        // The content begins at col - prefix.length (the prefix holds
        // spaces from a partly-consumed tab), and those prefix spaces
        // count toward this item's indent before the line itself is
        // consumed; otherwise a tab split across nested items leaves
        // the inner item one column short and the line looks lazy.
        const logicalCol = col - prefix.length;
        const target = logicalCol + c.contentIndent;
        let cc = logicalCol;
        let p = pos;
        const startPos = pos;
        const startCol = col;
        let pi = 0;
        while (pi < prefix.length && cc < target) { cc++; pi++; }
        let newPrefix = prefix.slice(pi);
        while (p < line.length && cc < target) {
          const ch = line.charCodeAt(p);
          if (ch === 32) { cc++; p++; }
          else if (ch === 9) {
            const w = 4 - (cc % 4);
            if (cc + w > target) {
              // tab partly consumed: its remaining width becomes spaces
              newPrefix += ' '.repeat(cc + w - target);
              cc = target; p++;
              break;
            }
            cc += w; p++;
          }
          else break;
        }
        if (cc < target) {
          // not enough indent: if the rest is blank, it is a blank line
          // inside the item; otherwise the container does not match.
          let q = p;
          while (q < line.length && (line.charCodeAt(q) === 32 || line.charCodeAt(q) === 9)) q++;
          if (q >= line.length) {
            // blank remainder: the item matches (blank line). A blank line
            // is inside all deeper containers too, so keep matching instead
            // of breaking (a blockquote below still breaks on its marker).
            prefix = newPrefix;
            pos = q; col = colFrom(line, startPos, q, startCol); matched = s;
            continue;
          }
          lazy = true; break;
        }
        prefix = newPrefix;
        col = colFrom(line, startPos, p, startCol); pos = p; matched = s;
      } else if (c.t === 'list') {
        // a list container itself consumes nothing
        matched = s;
      }
    }
    const content = prefix + line.slice(pos);
    const blank = /^[ \t]*$/.test(content);
    return { matched, content, contentCol: col, contentStartCol: col - prefix.length, blank, lazy, pos };
  }

  // Close containers above index `matched` (exclusive of matched).
  function closeContainers(matched) {
    while (stack.length - 1 > matched) {
      stack.pop();
    }
    // the leaf is closed only if its parent container was popped
    if (leaf && !stack.includes(leafParent)) leaf = null;
  }

  for (let li = 0; li < lines.length; li++) {
    const line = lines[li];
    const mc = matchContainers(line);
    const content = mc.content;
    let blank = mc.blank;
    // A whitespace-only line with non-empty content is paragraph content,
    // not a blank line, when it is the last line of its container scope.
    // Inside a blockquote: the line must match the blockquote holding the
    // paragraph, and the next line must not match that blockquote (or, if
    // this is the last line, the blockquote must not be inside a list
    // item); a blockquote inside a list item is kept only when a following
    // non-blank line closes it. At the top level, keep only when this is
    // the document's last line and the source has no trailing newline.
    // Inside a list item with no blockquote it is always a blank line.
    if (blank && leaf && leaf.t === 'para' && content.length > 0) {
      let paraBqIdx = -1;
      for (let s = stack.length - 1; s >= 1; s--) if (stack[s].t === 'bq') { paraBqIdx = s; break; }
      if (paraBqIdx > 0 && mc.matched >= paraBqIdx) {
        let inItem = false;
        for (let s = paraBqIdx - 1; s >= 1; s--) if (stack[s].t === 'item') { inItem = true; break; }
        const nextLine = li + 1 < lines.length ? lines[li + 1] : null;
        if (nextLine === null) {
          blank = inItem;
        } else {
          const mcNext = matchContainers(nextLine);
          blank = mcNext.matched >= paraBqIdx || (inItem && mcNext.blank);
        }
      } else if (paraBqIdx < 0 && stack.length === 1 && li + 1 >= lines.length && !srcEndsWithNewline) {
        blank = false;
      }
    }
    // A line that does not match all containers is a lazy continuation of a
    // paragraph only when it starts no interrupting block and no setext line.
    // Exception: a lazy setext-pattern line inside a blockquote paragraph is
    // re-indented to exactly four spaces and appended to the paragraph.
    // An indented code block never interrupts a paragraph (even lazily),
    // but an ordered list marker outside the paragraph's own container
    // starts a new block at any start number (the paragraph is closed
    // together with its container).
    let isLazyPara = false;
    let lazySetext = false;
    if (mc.lazy && leaf && leaf.t === 'para' && !blank) {
      const intr = tryStartBlock(content, true, mc.contentStartCol);
      let isListOutside = false;
      if (!intr) {
        const inParaScope = stack.indexOf(leafParent) >= 0 && mc.matched >= stack.indexOf(leafParent);
        if (!inParaScope) {
          const lm = parseListMarker(content, 0, mc.contentStartCol);
          if (lm && lm.ordered) isListOutside = true;
        }
      }
      const se = parseSetext(content);
      if (!intr && !se && !isListOutside) isLazyPara = true;
      else if (se && !intr && !isListOutside && stack.some(c => c.t === 'bq')) { isLazyPara = true; lazySetext = true; }
    }
    // Lazy fence content: a non-blank line that does not match all
    // containers can still be fence content (if the fence already has
    // content) when it is not a closing fence or an interrupting block.
    // Only when the unmatched containers are list/item (never a
    // blockquote — a line that leaves a blockquote ends the fence).
    let isLazyFence = false;
    if (mc.lazy && leaf && leaf.t === 'fence' && !blank && leaf.lines.length > 0) {
      let hasBq = false;
      for (let s = mc.matched + 1; s < stack.length; s++) if (stack[s].t === 'bq') { hasBq = true; break; }
      if (!hasBq) {
        const f = leaf;
        // closing fence? (same char, >= opening length, <=3 indent, only
        // spaces after) — checked on the raw line
        let j = 0;
        while (j < line.length && line.charCodeAt(j) === 32) j++;
        let isClose = false;
        if (j <= 3 && j < line.length && line.charCodeAt(j) === f.char.charCodeAt(0)) {
          let k = j;
          while (k < line.length && line.charCodeAt(k) === f.char.charCodeAt(0)) k++;
          if (k - j >= f.len && /^[ \t]*$/.test(line.slice(k))) isClose = true;
        }
        if (!isClose && !tryStartBlock(line, true)) {
          isLazyFence = true;
          // fence content: shed up to the fence indent (backtick fences
          // only; tilde fences strip nothing)
          let c2 = line;
          if (f.char === '`') {
            let strip = f.indent, p = 0;
            while (p < c2.length && strip > 0 && c2.charCodeAt(p) === 32) { p++; strip--; }
            c2 = c2.slice(p);
          }
          f.lines.push(c2);
          continue;
        }
      }
    }
    // close containers that did not match (unless lazy paragraph continuation
    // or lazy fence content)
    if (!isLazyPara && !isLazyFence) {
      closeContainers(mc.matched);
      // If the top is now a list, keep it only when this line starts a list
      // item belonging to it AND no higher-precedence block (hr, atx, fence,
      // html, blockquote) claims the line.
      while (stack.length > 1 && cur().t === 'list') {
        const lm = parseListMarker(mc.content, 0, mc.contentStartCol);
        const list = cur();
        // Compare RELATIVE indents, not absolute columns: a blockquote
        // marker consumes 1 column when bare (">-") but 2 when followed by
        // a space ("> -"), so the absolute column of the content start
        // shifts by 1 between lines and an absolute comparison misjudges
        // a marker sitting exactly at the content column. lm.indent is
        // relative to this line's content start; the list's content
        // indent is relative to the line that opened it; both are
        // measured inside the same containers, so they compare directly.
        const belongs = lm && list.ordered === lm.ordered &&
            ((list.ordered && list.delim === lm.marker[lm.marker.length - 1]) ||
             (!list.ordered && list.bullet === lm.marker)) &&
            lm.indent < list.contentIndentRel;
        // a marker at or beyond the list's content indent starts a nested
        // list inside the list's last item: keep the list
        const nested = lm && lm.indent >= list.contentIndentRel;
        const started = tryStartBlock(mc.content, false, mc.contentStartCol);
        if ((belongs || nested) && started && started.kind === 'list') break;
        stack.pop();
        if (leaf && !stack.includes(leafParent)) leaf = null;
      }
    }

    // Deferred looseness: if a blank line occurred inside a list and this
    // non-blank line is still inside that list, the deepest such list
    // becomes loose.
    if (!blank && pendingLooseLists) {
      for (const l of pendingLooseLists) {
        if (stack.includes(l)) { l.tight = false; break; }
      }
      pendingLooseLists = null;
    }

    if (blank) {
      // a whitespace-only line that contains a tab is a table row (all
      // empty cells), not a blank line, when inside a table: marked keeps
      // the table open across it, while a spaces-only or empty line ends
      // the table
      if (leaf && leaf.t === 'table' && content.indexOf('\t') >= 0) {
        const row = splitTableRow(content);
        while (row.length < leaf.align.length) row.push('');
        leaf.rows.push(row.slice(0, leaf.align.length));
        continue;
      }
      // a blank line following an HTML block marks it (it loses its
      // trailing newline when rendered) — but not a blank line *inside*
      // an HTML block of type 1-5 (that is content, not a separator).
      // Only a truly empty blank line strips the newline; a whitespace-only
      // line leaves it (marked keeps the newline after types 1-5 then).
      if (!(leaf && leaf.t === 'html' && leaf.type <= 5)) {
        const par = cur();
        if (par && par.children.length && content.length === 0) {
          const lastB = par.children[par.children.length - 1];
          if (lastB && lastB.t === 'html') lastB.followedByBlank = true;
        }
      }
      // blank line: a blank line inside a fenced code block is content,
      // with the fence indent stripped (backtick fences only; tilde
      // fences strip nothing) — the same strip as non-blank fence
      // content, so a whitespace-only line keeps only the spaces past
      // the indent.
      if (leaf && leaf.t === 'fence') {
        let bc = content;
        if (leaf.char === '`') {
          if (mc.contentCol === 0) {
            let strip = leaf.indent, p = 0;
            while (p < bc.length && strip > 0 && (bc.charCodeAt(p) === 32 || bc.charCodeAt(p) === 9)) { p++; strip--; }
            bc = bc.slice(p);
          } else {
            bc = stripIndentCols(content, 0, mc.contentStartCol, leaf.indent, 'spaces');
          }
        }
        leaf.lines.push(bc);
        continue;
      }
      // blank line inside an HTML block of type 1-5 is content (it ends
      // only at its closing marker, not at a blank line).
      if (leaf && leaf.t === 'html' && leaf.type <= 5) { leaf.lines.push(content); continue; }
      // blank line inside an indented code block: buffer it (it joins only
      // if a further indented line follows). Keep spaces beyond the 4-column
      // indent as content.
      if (leaf && leaf.t === 'code') {
        const ind = leadingIndent(content, 0, mc.contentStartCol).col;
        leaf.blank.push(ind >= 4 ? stripIndentCols(content, 0, mc.contentStartCol, 4, 'spaces') : '');
        continue;
      }
      // blank line: close the leaf; may loosen a list (deferred: only if
      // the next content is still inside the list). This applies no matter
      // what kind of block preceded the blank line (paragraph, fence,
      // empty item, ...).
      const ls = listsInScope(stack);
      if (ls.length) pendingLooseLists = ls;
      leaf = null;
      // an empty list item is closed by a blank line
      while (stack.length > 1 && cur().t === 'item' && cur().children.length === 0) stack.pop();
      continue;
      continue;
    }

    // Non-blank line.
    // If we are inside a fenced code block, it continues (or closes).
    if (leaf && leaf.t === 'fence') {
      const f = leaf;
      // closing fence: same char, >= opening length, <=3 indent, only spaces
      let j = 0;
      while (j < content.length && content.charCodeAt(j) === 32) j++;
      if (j <= 3 && j < content.length && content.charCodeAt(j) === f.char.charCodeAt(0)) {
        let k = j;
        while (k < content.length && content.charCodeAt(k) === f.char.charCodeAt(0)) k++;
        if (k - j >= f.len) {
          let rest = content.slice(k);
          if (/^[ \t]*$/.test(rest)) { leaf = null; continue; }
        }
      }
      // fence content: strip up to the fence indent. Inside a container
      // stripIndentCols handles a tab straddling the indent boundary (it
      // becomes spaces for its remainder). At the top level (contentCol
      // 0) marked strips by character count instead: up to f.indent
      // leading spaces/tabs are removed, a tab counting as one character,
      // so a leading tab is dropped whole and never leaves a partial
      // space behind.
      let c2 = content;
      if (f.char === '`') {
        if (mc.contentCol === 0) {
          let strip = f.indent, p = 0;
          while (p < c2.length && strip > 0 && (c2.charCodeAt(p) === 32 || c2.charCodeAt(p) === 9)) { p++; strip--; }
          c2 = c2.slice(p);
        } else {
          c2 = stripIndentCols(content, 0, mc.contentStartCol, f.indent, 'spaces');
        }
      }
      // leading tabs in fence content (inside a container) expand to
      // spaces to the next multiple of 4, tracking the column from the
      // content column relative to the innermost list item that contains
      // the fence (a tab inside a blockquote in a list item expands against
      // the item's content column, not the absolute column); at the top
      // level (contentCol 0) tabs stay literal
      if (mc.contentCol > 0) {
        // Only when a blockquote sits between the fence and its list
        // item does the tab expand against the item's content column;
        // without a blockquote the absolute content column applies.
        let baseCol = 0;
        for (let si = stack.length - 1; si >= 0; si--) {
          if (stack[si].t === 'bq') {
            for (let sj = si - 1; sj >= 0; sj--) {
              if (stack[sj].t === 'list') { baseCol = stack[sj].contentCol || 0; break; }
            }
            break;
          }
        }
        // The remainder starts at the absolute column contentStartCol +
        // f.indent (the fence indent was stripped in full); the old code
        // started at contentCol, f.indent columns too early, so a tab
        // there expanded short by up to a whole tab stop. Nested
        // blockquotes do not add to the column: only the outermost
        // blockquote's width is not counted (an inner "> " is content
        // of the outer quote for column purposes), so when quotes nest
        // the outermost quote's width is subtracted. Its width is the
        // content start minus 2 columns per inner quote (each "> ").
        let numBq = 0;
        for (let si = 0; si < stack.length; si++) if (stack[si].t === 'bq') numBq++;
        let outerBqWidth = 0;
        if (numBq > 1) outerBqWidth = mc.contentStartCol - 2 * (numBq - 1);
        let cc = mc.contentStartCol + f.indent - baseCol - outerBqWidth, kk = 0, out = '';
        while (kk < c2.length && (c2.charCodeAt(kk) === 32 || c2.charCodeAt(kk) === 9)) {
          if (c2.charCodeAt(kk) === 32) { out += ' '; cc++; kk++; }
          else { const w = 4 - (cc % 4); out += ' '.repeat(w); cc += w; kk++; }
        }
        if (kk > 0) c2 = out + c2.slice(kk);
      }
      f.lines.push(c2);
      continue;
    }

    // If inside an HTML block, it continues until its end condition.
    if (leaf && leaf.t === 'html') {
      const h = leaf;
      if (h.type <= 5) {
        if (h.endMarker && content.indexOf(h.endMarker) >= 0) {
          h.lines.push(content);
          leaf = null;
        } else h.lines.push(content);
      } else {
        h.lines.push(content);
      }
      continue;
    }

    // If inside an indented code block, a line indented >= 4 continues it.
    if (leaf && leaf.t === 'code') {
      const ind = leadingIndent(content, 0, mc.contentStartCol).col;
      if (ind >= 4) {
        // flush buffered blank lines first
        if (leaf.blank.length) { for (const bl of leaf.blank) leaf.lines.push(bl); leaf.blank = []; }
        leaf.lines.push(stripIndentCols(content, 0, mc.contentStartCol, 4, 'spaces'));
        continue;
      }
      if (/^[ \t]*$/.test(content)) { leaf.blank.push(content); continue; }
      leaf = null; // fall through to start a new block
    }

    // If inside a table, a row continues it unless an interrupting block starts.
    if (leaf && leaf.t === 'table') {
      const intr = tryStartBlock(content, false, mc.contentStartCol);
      if (intr) { leaf = null; startBlock(intr, content, mc.contentStartCol); continue; }
      const row = splitTableRow(content);
      while (row.length < leaf.align.length) row.push('');
      leaf.rows.push(row.slice(0, leaf.align.length));
      continue;
    }

    // If inside a paragraph, check for table / setext / interrupting blocks.
    if (leaf && leaf.t === 'para') {
      // lazy setext-pattern line inside a blockquote: re-indent to 4 spaces
      if (isLazyPara && lazySetext) { leaf.lines.push('    ' + content.replace(/^[ \t]+/, '')); continue; }
      // table: a single-line paragraph followed by a delimiter row. The
      // delimiter cell count must exactly equal the header cell count.
      if (leaf.lines.length === 1) {
        const aligns = parseTableDelimiter(content);
        if (aligns) {
          const header = splitTableRow(leaf.lines[0]);
          if (header.length === aligns.length) {
            const tbl = { t: 'table', align: aligns, header: header.slice(0, aligns.length), rows: [] };
            const par = leafParent.children;
            par[par.length - 1] = tbl;
            leaf = tbl;
            continue;
          }
        }
      }
      // setext underline?
      const se = parseSetext(content);
      if (se) {
        // setext converts the paragraph to a heading, after stripping
        // leading link reference definitions (if only defs remain, the line
        // is paragraph text, not a setext underline)
        const stripped = stripLinkRefDefs(leaf.lines, refs);
        if (stripped.lines.length > 0) {
          const h = { t: 'atx', level: se, text: stripped.lines.join('\n').replace(/^[ \t]+/, '').replace(/[ \t]+$/, '') };
          // replace the paragraph with the heading in its parent
          const par = leafParent.children;
          par[par.length - 1] = h;
          leaf = null;
          continue;
        } else {
          // only definitions: the setext line becomes paragraph text
          leaf.lines = [content];
          leaf._defOnly = false;
          continue;
        }
      }
      // interrupting blocks
      const intr = tryStartBlock(content, true, mc.contentStartCol);
      if (intr) {
        leaf = null;
        startBlock(intr, content, mc.contentStartCol);
        continue;
      }
      // lazy continuation (or normal continuation): append the line. A
      // leading tab inside a container expands against the absolute
      // column, except when a blockquote sits between the line and its
      // list item: then it expands against the item's content column
      // (the same rule as fence content). At the top level a tab stays
      // literal. A lazy line keeps its leading whitespace, except that
      // an indent of four or more columns sheds exactly four columns
      // (the indented-code indent); a smaller indent is kept whole.
      let lineContent = content;
      if (mc.contentStartCol > 0) {
        let baseCol = 0;
        for (let si = stack.length - 1; si >= 0; si--) {
          if (stack[si].t === 'bq') {
            for (let sj = si - 1; sj >= 0; sj--) {
              if (stack[sj].t === 'list') { baseCol = stack[sj].contentCol || 0; break; }
            }
            break;
          }
        }
        lineContent = expandLeadingTabs(content, mc.contentStartCol - baseCol);
      }
      if (isLazyPara && stack.length > 1) {
        const ind = leadingIndent(lineContent, 0, mc.contentStartCol).col;
        leaf.lines.push(ind >= 4 ? stripIndentCols(lineContent, 0, mc.contentStartCol, 4, 'spaces') : lineContent);
      }
      else leaf.lines.push(lineContent);
      continue;
    }

    // No current leaf: start a new block.
    const started = tryStartBlock(content, false, mc.contentStartCol);
    if (started) { startBlock(started, content, mc.contentStartCol); continue; }
    // Otherwise a paragraph (or link ref defs, handled in startBlock).
    startParagraph(content);
  }

  // ---- helpers (hoisted function declarations) ----
  function loosenList(st) {
    // a blank line loosens the list when the innermost matched container
    // (scanning down from the last matched, stopping at a blockquote) is a
    // list or list item.
    for (let s = st.length - 1; s >= 1; s--) {
      const c = st[s];
      if (c.t === 'bq') break;
      if (c.t === 'list') { c.tight = false; return; }
      if (c.t === 'item') {
        // find the enclosing list
        for (let t = s - 1; t >= 1; t--) {
          if (st[t].t === 'list') { st[t].tight = false; return; }
          if (st[t].t === 'bq') return;
        }
        return;
      }
    }
  }

  function parseSetext(line) {
    let j = 0;
    while (j < line.length && line.charCodeAt(j) === 32) j++;
    if (j > 3) return 0;
    if (j >= line.length) return 0;
    const c = line.charCodeAt(j);
    if (c !== 61 && c !== 45) return 0;
    let k = j;
    while (k < line.length && line.charCodeAt(k) === c) k++;
    let rest = line.slice(k);
    if (/^[ \t]*$/.test(rest)) return c === 61 ? 1 : 2;
    return 0;
  }

  // Strip leading link reference definitions from a paragraph's lines,
  // recording them in refs. Returns { lines } (remaining lines).
  function stripLinkRefDefs(paraLines, refsMap) {
    const out = [];
    let idx = 0;
    while (idx < paraLines.length) {
      const d = parseLinkRefDef(paraLines, idx);
      if (!d) {
        if (isDanglingTitleLine(paraLines, idx) && idx + 1 < paraLines.length && parseLinkRefDef(paraLines, idx + 1)) { idx++; continue; }
        break;
      }
      if (!refsMap.has(d.label)) refsMap.set(d.label, { href: d.href, title: d.title });
      idx += d.consumed;
    }
    for (let k = idx; k < paraLines.length; k++) out.push(paraLines[k]);
    return { lines: out };
  }

  // Try to recognize a block start at content. `inPara` is whether we are
  // interrupting a paragraph (which restricts what can interrupt).
  // Returns a descriptor { kind, ... } or null.
  function tryStartBlock(content, inPara, startCol) {
    // ATX heading
    const atx = parseATX(content, 0);
    if (atx) return { kind: 'atx', level: atx.level, text: atx.text };
    // fenced code
    const fence = parseFenceStart(content, 0);
    if (fence) return { kind: 'fence', char: fence.char, len: fence.len, info: fence.info, indent: fence.indent };
    // HTML block (type 7 cannot interrupt a paragraph)
    const ht = htmlBlockType(content, 0);
    if (ht && !(inPara && ht === 7)) return { kind: 'html', type: ht };
    // thematic break
    if (parseHR(content, 0)) return { kind: 'hr' };
    // blockquote
    const bq = matchBQ(content, 0, startCol || 0);
    if (bq) return { kind: 'bq', after: bq.end, tabSpaces: bq.tabSpaces };
    // list item (ordered lists only interrupt a paragraph when start is 1,
    // unless an open list of the same kind allows a different start)
    const lm = parseListMarker(content, 0, startCol || 0);
    if (lm) {
      // an empty list item cannot interrupt a paragraph, unless it continues
      // an open list of the same kind
      if (inPara && /^[ \t]*$/.test(content.slice(lm.afterMarker))) {
        let continues = false;
        for (let s = stack.length - 1; s >= 1; s--) {
          const c = stack[s];
          if (c.t === 'list' && c.ordered === lm.ordered &&
              ((lm.ordered && c.delim === lm.marker[lm.marker.length - 1]) ||
               (!lm.ordered && c.bullet === lm.marker))) { continues = true; break; }
          if (c.t === 'bq') break;
        }
        if (!continues) return null;
      }
      if (!inPara) return { kind: 'list', marker: lm };
      if (!lm.ordered) return { kind: 'list', marker: lm };
      if (lm.start === 1) return { kind: 'list', marker: lm };
      // an ordered list starting at non-1 may still begin inside a list
      // item (as a nested list within the item's paragraph)
      if (leafParent && leafParent.t === 'item') return { kind: 'list', marker: lm };
      // open-list exception: an open list of the same kind (ordered) allows
      // a different start number to continue it.
      for (let s = stack.length - 1; s >= 1; s--) {
        if (stack[s].t === 'list' && stack[s].ordered) return { kind: 'list', marker: lm };
        if (stack[s].t === 'bq') break;
      }
      return null;
    }
    // table: a header row followed by a delimiter row (checked by caller
    // when starting a paragraph; handled in startParagraph)
    // indented code (not inside a paragraph)
    if (!inPara) {
      const ind = leadingIndent(content, 0, startCol || 0).col;
      if (ind >= 4) return { kind: 'code' };
    }
    return null;
  }

  function startBlock(desc, content, col) {
    if (desc.kind === 'atx') {
      addBlock({ t: 'atx', level: desc.level, text: desc.text });
      leaf = null;
    } else if (desc.kind === 'fence') {
      const f = { t: 'fence', char: desc.char, len: desc.len, info: desc.info, indent: desc.indent, lines: [] };
      addBlock(f); leaf = f; leafParent = cur();
    } else if (desc.kind === 'html') {
      const endMarker = desc.type === 1 ? null : (
        desc.type === 2 ? '-->' : desc.type === 3 ? '?>' : desc.type === 4 ? '>' : desc.type === 5 ? ']]>' : null);
      // type 1 end marker is the matching close tag (the open tag may end
      // the line when it spans lines)
      let em = endMarker;
      if (desc.type === 1) {
        const m = content.match(/<(script|pre|style|textarea)(?:[\s>]|$)/i);
        if (m) em = '</' + m[1].toLowerCase() + '>';
      }
      const h = { t: 'html', type: desc.type, endMarker: em, lines: [content] };
      addBlock(h); leaf = h; leafParent = cur();
      // type 1-5 end at the closing marker; if the first line contains it,
      // the block may end immediately (checked on subsequent lines)
      if (em && desc.type !== 1 && content.indexOf(em) >= 0) leaf = null;
      if (desc.type === 1 && em && content.toLowerCase().indexOf(em) >= 0) {
        // the close tag might be on this same line; keep it open only if the
        // marker appears after the open tag
        const openEnd = content.search(/>/);
        const closeIdx = content.toLowerCase().indexOf(em, openEnd);
        if (closeIdx >= 0) leaf = null;
      }
    } else if (desc.kind === 'hr') {
      addBlock({ t: 'hr' }); leaf = null;
    } else if (desc.kind === 'bq') {
      const bq = { t: 'bq', children: [] };
      addBlock(bq); stack.push(bq);
      // re-process this line with the blockquote matched
      leaf = null;
      // The line's content after the '>' is processed as a fresh line within
      // the blockquote: push it back by re-running the line logic. We do this
      // by directly handling the remainder here. A tab after '>' contributes
      // its remainder as spaces (the blockquote consumed 1 column of it).
      const rest = ' '.repeat(desc.tabSpaces || 0) + content.slice(desc.after);
      const restCol = (col || 0) + colOf(content, 0, desc.after) - (desc.tabSpaces || 0);
      processLineContent(rest, true, restCol);
    } else if (desc.kind === 'list') {
      startList(desc.marker, content, col || 0);
    } else if (desc.kind === 'code') {
      const cd = { t: 'code', lines: [stripIndentCols(content, 0, col || 0, 4, 'spaces')], blank: [] };
      addBlock(cd); leaf = cd; leafParent = cur();
    }
  }

  // Process content that is already inside the current containers (used after
  // opening a blockquote, and for list item content). `inBq` is unused.
  // `startCol` is the absolute column of content[0].
  function processLineContent(content, inBq, startCol) {
    if (/^[ \t]*$/.test(content)) { leaf = null; return; }
    if (leaf && leaf.t === 'para') { leaf.lines.push(content); return; }
    // a leading tab in a fresh block inside a container is indent: expand
    // it against the absolute column (a paragraph continuation keeps its
    // tab, but a fresh block does not)
    content = expandLeadingTabs(content, startCol || 0);
    const started = tryStartBlock(content, false, startCol || 0);
    if (started) { startBlock(started, content, startCol || 0); return; }
    startParagraph(content);
  }

  function startList(marker, content, startCol) {
    startCol = startCol || 0;
    // A marker belongs to the open list (as a sibling item) when it is the
    // same kind and its column is less than the list's content column
    // (the column where the first item's content starts). A marker at or
    // beyond that column starts a nested list inside the open list's last
    // item; a shallower marker (or a different kind) starts a new list.
    const markerCol = startCol + marker.indent;
    let list = null;
    const top = cur();
    const sameKind = top.t === 'list' && top.ordered === marker.ordered &&
        ((top.ordered && top.delim === (marker.marker[marker.marker.length - 1])) ||
         (!top.ordered && top.bullet === marker.marker));
    // Relative-indent comparison (see the keep-list loop above): the
    // marker's indent is relative to this line's content start and the
    // list's content indent is relative to its opening line's content
    // start; absolute columns drift when a blockquote consumes a space
    // on one line but not the other.
    if (sameKind && marker.indent < top.contentIndentRel) {
      // sibling item: the list's content column follows the latest item
      // (a later marker is judged against the most recent item's indent,
      // so progressively indented siblings stay siblings)
      list = top;
      list.contentCol = startCol + marker.contentIndent;
      list.contentIndentRel = marker.contentIndent;
    } else if (top.t === 'list' && marker.indent >= top.contentIndentRel) {
      // nested list inside the open list's last item
      const lastItem = top.children[top.children.length - 1];
      if (lastItem) {
        stack.push(lastItem);
        list = { t: 'list', ordered: marker.ordered, start: marker.start, tight: true, children: [],
                 bullet: marker.ordered ? null : marker.marker,
                 delim: marker.ordered ? marker.marker[marker.marker.length - 1] : null,
                 markerCol, contentCol: startCol + marker.contentIndent,
                 contentIndentRel: marker.contentIndent };
        addBlock(list);
        stack.push(list);
      }
    }
    if (!list) {
      // a different list type (or no list on top): close an open list first
      // so the new list becomes a sibling, not a child.
      if (top.t === 'list') { stack.pop(); if (leaf && !stack.includes(leafParent)) leaf = null; }
      list = { t: 'list', ordered: marker.ordered, start: marker.start, tight: true, children: [],
               bullet: marker.ordered ? null : marker.marker,
               delim: marker.ordered ? marker.marker[marker.marker.length - 1] : null,
               markerCol, contentCol: startCol + marker.contentIndent,
               contentIndentRel: marker.contentIndent };
      addBlock(list);
      stack.push(list);
    }
    // create the item
    const item = { t: 'item', children: [], contentIndent: marker.contentIndent };
    list.children.push(item);
    stack.push(item);
    leaf = null;
    // the item's content is the rest of the line after the marker, computed
    // by column: contentIndent is in columns, not characters, so a tab
    // after the marker is expanded against the absolute column
    const rest = sliceFromCol(content, startCol, startCol + marker.contentIndent);
    const restCol = startCol + marker.contentIndent;
    // task list checkbox?
    let r = rest;
    const task = r.match(/^\[([ xX])\] /);
    let checkbox = null;
    if (task) { checkbox = task[1] !== ' '; r = r.slice(task[0].length).replace(/^[ \t]+/, ''); }
    if (checkbox !== null) item.checkbox = checkbox;
    // content indent for the item: the marker's contentIndent is relative to
    // the line start; but the item container matches by consuming that many
    // columns from the line start. We store it relative to the container's
    // own start column (which is the line's column after outer containers).
    // For simplicity, recompute: the item content starts at marker.afterMarker
    // columns in; the item's contentIndent (columns from line start) is
    // marker.contentIndent. The matchContainers logic consumes from the
    // current column, so we store the absolute column target.
    item.contentIndent = marker.contentIndent;
    item._rest = r;
    if (/^[ \t]*$/.test(r)) { leaf = null; return; }
    // column of r[0]: restCol plus the columns stripped for the checkbox
    processLineContent(r, false, restCol + colOf(rest, 0, rest.length - r.length));
  }

  function startParagraph(content) {
    // A paragraph may start with link reference definitions.
    const lines = [content];
    // We collect the paragraph lines lazily in the main loop (leaf.lines).
    // Here we just create the paragraph; definitions are stripped when the
    // paragraph closes (or when a setext converts it). To strip leading
    // definitions promptly, check the first line now.
    const d = parseLinkRefDef(lines, 0);
    if (d && d.consumed >= 1) {
      // Keep the definition line in the paragraph so collectRefs (which
      // runs after all lines are present) can parse the definition with a
      // title that spills onto a following line. Do not store the ref here:
      // with only one line visible the title would be lost.
      const p = { t: 'para', lines: [content], _defOnly: true };
      addBlock(p); leaf = p; leafParent = cur();
      return;
    }
    const p = { t: 'para', lines: [content] };
    addBlock(p); leaf = p; leafParent = cur();
  }

  return root.children;
}

// ---------- tables ----------
// A delimiter row: cells separated by '|', each cell is optional ':' +
// 1+ '-' + optional ':', with optional edge pipes. Returns alignments
// ('left'|'right'|'center'|null) or null.
function parseTableDelimiter(line) {
  let s = line.trim();
  // A delimiter of only dashes (no pipe, no colon) is a setext underline,
  // not a table delimiter. Check the original line (before stripping edge
  // pipes) for pipes/colons.
  if (!s.includes('|') && !s.includes(':')) return null;
  if (s.startsWith('|')) s = s.slice(1);
  if (s.endsWith('|')) s = s.slice(0, -1);
  if (!s) return null;
  const cells = s.split('|');
  const aligns = [];
  for (const cell of cells) {
    const t = cell.trim();
    if (!/^-+$/.test(t.replace(/^:/, '').replace(/:$/, ''))) {
      // must be dashes with optional colons
      if (!/^:?-+:?$/.test(t)) return null;
    }
    if (!/^:?-+:?$/.test(t)) return null;
    if (t.startsWith(':') && t.endsWith(':')) aligns.push('center');
    else if (t.endsWith(':')) aligns.push('right');
    else if (t.startsWith(':')) aligns.push('left');
    else aligns.push(null);
  }
  return aligns;
}

// Split a table row on unescaped pipes (backticks do not protect pipes).
function splitTableRow(line) {
  const cells = [];
  let cur = '', i = 0;
  const n = line.length;
  // strip one leading/trailing pipe (with surrounding spaces)
  let s = line;
  let t = s.trim();
  if (t.startsWith('|')) { const idx = s.indexOf('|'); s = s.slice(idx + 1); }
  t = s.trim();
  if (t.endsWith('|')) { const idx = s.lastIndexOf('|'); s = s.slice(0, idx); }
  while (i < s.length) {
    const c = s.charCodeAt(i);
    if (c === 92 && i + 1 < s.length && s.charCodeAt(i + 1) === 124) { cur += '|'; i += 2; continue; }
    if (c === 124) { cells.push(cur); cur = ''; i++; continue; }
    cur += s[i]; i++;
  }
  cells.push(cur);
  return cells;
}

// ---------- rendering ----------
function renderBlocks(blocks, refs, docLast, srcEndsWithNewline) {
  let out = '';
  for (const b of blocks) out += renderBlock(b, refs, docLast, srcEndsWithNewline);
  return out;
}

function renderBlock(b, refs, docLast, srcEndsWithNewline) {
  switch (b.t) {
    case 'para': {
      const text = b.lines.join('\n');
      // strip leading link reference definitions (they were recorded during
      // parsing, but a paragraph that starts with them and has text after
      // should render only the text)
      const stripped = stripDefsFromText(text, refs);
      if (!stripped.trim()) return '';
      const inline = parseInline(stripped, refs, {});
      return '<p>' + renderInline(inline.parts) + '</p>\n';
    }
    case 'atx': {
      const inline = parseInline(b.text, refs, {});
      return '<h' + b.level + '>' + renderInline(inline.parts) + '</h' + b.level + '>\n';
    }
    case 'fence': {
      let info = b.info || '';
      // first word of info, backslash escapes processed
      const first = info.split(/\s+/)[0] || '';
      const lang = first.replace(/\\([!\"#$%&'()*+,\-.\/:;<=>?@\[\\\]^_`{|}~])/g, '$1');
      const cls = lang ? ' class="language-' + escText(lang) + '"' : '';
      let content = b.lines.join('\n');
      // content ending in blank lines loses exactly one trailing newline
      if (content) content += '\n';
      if (content.endsWith('\n\n')) content = content.slice(0, -1);
      return '<pre><code' + cls + '>' + escFull(content) + '</code></pre>\n';
    }
    case 'code': {
      let content = b.lines.join('\n');
      if (content) content += '\n';
      if (content.endsWith('\n\n')) content = content.slice(0, -1);
      return '<pre><code>' + escFull(content) + '</code></pre>\n';
    }
    case 'html': {
      const s = b.lines.join('\n') + '\n';
      // The final HTML block loses its trailing newline when the source
      // does not end with a newline.
      if (b === docLast && !srcEndsWithNewline && s.endsWith('\n')) return s.slice(0, -1);
      // Any HTML block followed by a blank line loses its trailing newline.
      if (b.followedByBlank && s.endsWith('\n')) return s.slice(0, -1);
      // types 6-7 lose the trailing newline unless this is the last block
      // in the document
      if ((b.type === 6 || b.type === 7) && b !== docLast && s.endsWith('\n')) return s.slice(0, -1);
      return s;
    }
    case 'hr': return '<hr>\n';
    case 'bq': {
      return '<blockquote>\n' + renderBlocks(b.children, refs, docLast, srcEndsWithNewline) + '</blockquote>\n';
    }
    case 'list': {
      const tag = b.ordered ? 'ol' : 'ul';
      const start = b.ordered && b.start !== 1 ? ' start="' + b.start + '"' : '';
      let out = '<' + tag + start + '>\n';
      for (const item of b.children) out += renderBlock(item, refs, docLast, srcEndsWithNewline);
      out += '</' + tag + '>\n';
      return out;
    }
    case 'item': {
      const cb = b.checkbox !== undefined && b.checkbox !== null
        ? (b.checkbox ? '<input checked="" disabled="" type="checkbox">' : '<input disabled="" type="checkbox">')
        : '';
      let inner = '';
      for (const kid of b.children) {
        if (b._tight && kid.t === 'para') {
          const text = kid.lines.join('\n');
          const stripped = stripDefsFromText(text, refs);
          if (!stripped.trim()) continue;
          const inline = parseInline(stripped, refs, {});
          inner += renderInline(inline.parts);
        } else {
          inner += renderBlock(kid, refs, docLast, srcEndsWithNewline);
        }
      }
      if (cb) {
        if (inner.startsWith('<p>')) inner = '<p>' + cb + ' ' + inner.slice(3);
        else inner = cb + ' ' + inner;
      }
      return '<li>' + inner + '</li>\n';
    }
    case 'table': {
      const aligns = b.align;
      let out = '<table>\n<thead>\n<tr>\n';
      const head = b.header;
      for (let i = 0; i < head.length; i++) {
        const a = aligns[i] ? ' align="' + aligns[i] + '"' : '';
        const inline = parseInline(head[i].trim(), refs, {});
        out += '<th' + a + '>' + renderInline(inline.parts) + '</th>\n';
      }
      out += '</tr>\n</thead>\n';
      if (b.rows.length) {
        out += '<tbody>';
        for (const row of b.rows) {
          out += '<tr>\n';
          for (let i = 0; i < head.length; i++) {
            const a = aligns[i] ? ' align="' + aligns[i] + '"' : '';
            const cell = (row[i] !== undefined ? row[i] : '').trim();
            const inline = parseInline(cell, refs, {});
            out += '<td' + a + '>' + renderInline(inline.parts) + '</td>\n';
          }
          out += '</tr>\n';
        }
        out += '</tbody>';
      }
      out += '</table>\n';
      return out;
    }
    default: return '';
  }
}

// A line that is only a link title, e.g. `  "Using in url when"` -- the title
// of a preceding reference definition that spilled onto its own line. The
// def-scanning loops skip such a line (after at least one def) instead of
// stopping, so later definitions on following lines are still collected.
function isDanglingTitleLine(lines, idx) {
  const s = lines[idx];
  let q = 0;
  while (q < s.length && (s.charCodeAt(q) === 32 || s.charCodeAt(q) === 9)) q++;
  if (q >= s.length) return false;
  const t = parseMultiLineTitle(lines, idx, s, q);
  return !!t;
}

// Strip leading link reference definitions from a paragraph's text (they
// were already recorded in refs during parsing). Returns the remaining text.
function stripDefsFromText(text, refs) {
  const lines = text.split('\n');
  let idx = 0;
  while (idx < lines.length) {
    const d = parseLinkRefDef(lines, idx);
    if (!d) {
      if (isDanglingTitleLine(lines, idx) && idx + 1 < lines.length && parseLinkRefDef(lines, idx + 1)) { idx++; continue; }
      break;
    }
    if (!refs.has(d.label)) refs.set(d.label, { href: d.href, title: d.title });
    idx += d.consumed;
  }
  return lines.slice(idx).join('\n');
}

// ---------- top-level parse ----------
export function parse(src) {
  suppressExtAuto = false;
  const refs = new Map();
  const lines = splitLines(src);
  const srcEndsWithNewline = src.endsWith('\n');
  const blocks = parseBlocks(lines, refs, srcEndsWithNewline);
  // Mark tight lists: propagate tightness to items for rendering.
  const markTight = (bs, tight) => {
    for (const b of bs) {
      if (b.t === 'list') {
        for (const it of b.children) { it._tight = b.tight; markTight(it.children, b.tight); }
      } else if (b.t === 'bq' || b.t === 'item') {
        markTight(b.children, tight);
      }
    }
  };
  markTight(blocks, true);
  // Collect all link reference definitions before rendering, so a reference
  // can be used before the paragraph that defines it.
  const collectRefs = (bs) => {
    for (const b of bs) {
      if (b.t === 'para') {
        const text = b.lines.join('\n');
        const ls = text.split('\n');
        let idx = 0;
        while (idx < ls.length) {
          const d = parseLinkRefDef(ls, idx);
          if (!d) {
            if (isDanglingTitleLine(ls, idx) && idx + 1 < ls.length && parseLinkRefDef(ls, idx + 1)) { idx++; continue; }
            break;
          }
          if (!refs.has(d.label)) refs.set(d.label, { href: d.href, title: d.title });
          idx += d.consumed;
        }
      } else if (b.children) collectRefs(b.children);
    }
  };
  collectRefs(blocks);
  // the last leaf block in the document (for the HTML trailing-newline rule)
  let docLast = null;
  if (blocks.length) {
    let b = blocks[blocks.length - 1];
    while (b.children && b.children.length) b = b.children[b.children.length - 1];
    docLast = b;
  }
  return renderBlocks(blocks, refs, docLast, srcEndsWithNewline);
}
