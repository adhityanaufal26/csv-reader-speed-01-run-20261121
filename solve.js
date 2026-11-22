// Fast drop-in for csv-reader 1.0.0: run(input) returns {columns, rows, errors} with the same
// broken-row policy, reached by scanning each field once and slicing it in bulk instead of
// accumulating it a character at a time. Unquoted fields are walked with a tight charCodeAt
// loop that stops at the next comma / LF / CRLF (counting stray CRs on the way); quoted
// fields jump between quotes with indexOf and only rebuild a run when it holds a CR.
//
// Policy (mirrors the reference exactly):
//   - a leading U+FEFF is dropped; a record ends at LF or CRLF; an empty line is no record;
//   - outside quotes a CR not followed by LF is dropped (stray_cr);
//   - a field opening with a quote runs to the next undoubled quote, "" is one quote, and each
//     CRLF or lone CR inside reads as LF; text after the closing quote up to the next comma or
//     line break is appended verbatim (quote_junk, reported when the field ends); a quote that
//     never closes is a literal character and the text after it is re-read as unquoted
//     (unterminated_quote);
//   - a quote inside an unquoted field is literal; fields are never trimmed or converted;
//   - columns is the first record when header is true (else null, [] when there is none); rows
//     are padded (short_row) or cut (long_row) to the first record's width;
//   - errors are {code, line, row} in the order met; line is the 1-based line the record
//     starts on counting every LF/CRLF/lone CR inside quotes; row is the index in rows,
//     null for the header.

// Field terminators.
const COMMA = 0;
const LINE = 1;
const END = 2;

// Scratch shared by the two scanners below (single-threaded, overwritten on every call):
// where the scan stopped, how the field ended, how many characters an unquoted scan kept,
// and the current 1-based line.
let scanPos = 0;
let scanEnded = END;
let scanAdded = 0;
let scanLine = 1;

// Scans unquoted text from `pos` onto `prefix` up to the next comma, line break or end of
// text. A CR not followed by LF is dropped with a stray_cr error. Sets scanPos/scanEnded/
// scanAdded (and scanLine when a line break ends the field) and returns the field value.
function scanUnquoted(text, pos, n, prefix, errors, recordLine, recordRow) {
  let i = pos;
  let crs = 0;
  let end = n;
  let ended = END;
  let next = n;
  while (i < n) {
    const c = text.charCodeAt(i);
    if (c === 44) { end = i; ended = COMMA; next = i + 1; break; }
    if (c === 10) { end = i; ended = LINE; next = i + 1; break; }
    if (c === 13) {
      if (text.charCodeAt(i + 1) === 10) { end = i; ended = LINE; next = i + 2; break; }
      crs += 1;
    }
    i += 1;
  }
  let value;
  if (crs === 0) {
    value = text.slice(pos, end);
  } else {
    for (let k = 0; k < crs; k++) errors.push({ code: 'stray_cr', line: recordLine, row: recordRow });
    value = text.slice(pos, end).split('\r').join('');
  }
  scanAdded = value.length;
  scanPos = next;
  scanEnded = ended;
  if (ended === LINE) scanLine += 1;
  return prefix === '' ? value : prefix + value;
}

// One run of quoted text between quotes: CRLF and lone CR each read as a single LF, and every
// line break inside advances scanLine. Returns the text as it stands in the field value.
function quotedRun(text, start, end) {
  const s = text.slice(start, end);
  if (s.indexOf('\r') === -1) {
    // No CR: only count the LFs, the slice itself is the value piece.
    let i = s.indexOf('\n');
    while (i !== -1) {
      scanLine += 1;
      i = s.indexOf('\n', i + 1);
    }
    return s;
  }
  // Rebuild with each CRLF / lone CR collapsed to one LF.
  let out = '';
  let p = 0;
  const len = s.length;
  while (p < len) {
    const r = s.indexOf('\r', p);
    const l = s.indexOf('\n', p);
    if (r === -1 && l === -1) {
      out += s.slice(p);
      break;
    }
    if (l !== -1 && (r === -1 || l < r)) {
      out += s.slice(p, l + 1);
      scanLine += 1;
      p = l + 1;
    } else {
      out += s.slice(p, r) + '\n';
      scanLine += 1;
      p = s.charCodeAt(r + 1) === 10 ? r + 2 : r + 1;
    }
  }
  return out;
}

// Scans a field whose opening quote is at `pos`. Sets scanPos/scanEnded (and scanLine) and
// returns the field value.
function scanQuoted(text, pos, n, errors, recordLine, recordRow) {
  const openPos = pos;
  const openLine = scanLine;
  pos += 1;
  let runStart = pos;
  let parts = null; // pieces of the value once a doubled quote forces a join
  let value = '';
  let closed = false;
  while (pos < n) {
    const q = text.indexOf('"', pos);
    if (q === -1) break;
    const run = quotedRun(text, runStart, q);
    if (text.charCodeAt(q + 1) === 34) {
      // Doubled quote: one literal quote, the field goes on.
      if (parts === null) parts = [run, '"'];
      else parts.push(run, '"');
      pos = q + 2;
      runStart = pos;
      continue;
    }
    pos = q + 1;
    closed = true;
    if (parts === null) value = run;
    else {
      parts.push(run);
      value = parts.join('');
    }
    break;
  }
  if (!closed) {
    // The quote never closes: it is a literal character and the text after it is re-read
    // as an unquoted field (the line count from the failed scan is rewound first).
    errors.push({ code: 'unterminated_quote', line: recordLine, row: recordRow });
    scanLine = openLine;
    return scanUnquoted(text, openPos + 1, n, '"', errors, recordLine, recordRow);
  }
  if (pos >= n) {
    scanPos = pos;
    scanEnded = END;
    scanAdded = 0;
    return value;
  }
  const c = text.charCodeAt(pos);
  if (c === 44) {
    scanPos = pos + 1;
    scanEnded = COMMA;
    scanAdded = 0;
    return value;
  }
  if (c === 10) {
    scanPos = pos + 1;
    scanEnded = LINE;
    scanLine += 1;
    scanAdded = 0;
    return value;
  }
  if (c === 13 && text.charCodeAt(pos + 1) === 10) {
    scanPos = pos + 2;
    scanEnded = LINE;
    scanLine += 1;
    scanAdded = 0;
    return value;
  }
  // Whatever follows the closing quote is appended as it stands up to the next comma or
  // line break; quote_junk is reported when the field ends, after any stray_cr inside it.
  const whole = scanUnquoted(text, pos, n, value, errors, recordLine, recordRow);
  if (scanAdded > 0) errors.push({ code: 'quote_junk', line: recordLine, row: recordRow });
  return whole;
}

/** The reading of one CSV input, {text, header}: {columns, rows, errors}. */
export function run(input) {
  const text = String(input.text);
  const header = input.header === true;
  const n = text.length;
  const errors = [];
  const rows = [];
  let columns = null;
  let width = -1;

  let pos = n > 0 && text.charCodeAt(0) === 0xfeff ? 1 : 0;
  scanLine = 1;

  while (true) {
    // Lines with no characters are no records.
    while (pos < n) {
      const c = text.charCodeAt(pos);
      if (c === 10) {
        pos += 1;
        scanLine += 1;
      } else if (c === 13 && text.charCodeAt(pos + 1) === 10) {
        pos += 2;
        scanLine += 1;
      } else {
        break;
      }
    }
    if (pos >= n) break;

    const recordLine = scanLine;
    const recordRow = header && columns === null ? null : rows.length;
    const fields = [];
    let lastQuoted = false;
    let ended = COMMA;
    while (ended === COMMA) {
      if (text.charCodeAt(pos) === 34) {
        lastQuoted = true;
        fields.push(scanQuoted(text, pos, n, errors, recordLine, recordRow));
      } else {
        lastQuoted = false;
        fields.push(scanUnquoted(text, pos, n, '', errors, recordLine, recordRow));
      }
      pos = scanPos;
      ended = scanEnded;
    }

    // A line that held only stray CRs is left with no characters: no record (its errors stay).
    if (fields.length === 1 && fields[0] === '' && !lastQuoted) continue;

    if (width < 0) width = fields.length;
    if (header && columns === null) {
      columns = fields;
      continue;
    }
    if (fields.length < width) {
      errors.push({ code: 'short_row', line: recordLine, row: recordRow, fields: fields.length });
      while (fields.length < width) fields.push('');
    } else if (fields.length > width) {
      errors.push({ code: 'long_row', line: recordLine, row: recordRow, extra: fields.splice(width) });
    }
    rows.push(fields);
  }

  return { columns: header ? (columns ?? []) : null, rows, errors };
}
