// Fast drop-in for csv-reader 1.0.0 (make.fun's own CSV reader): run(input) returns
// exactly what csv-reader returns for {text, header}: {columns, rows, errors}.
// Hand-rolled single-pass parser; indexOf-based scanning and a whole-record fast
// path for plain lines, so it does the same reading in a fraction of the time.
//
// Semantics (mirroring csv-reader 1.0.0 exactly):
// - U+FEFF at the very start is dropped.
// - A record ends at LF or CRLF; a line left with no characters is no record.
// - Outside quotes a CR not followed by LF is dropped (stray_cr).
// - A field opening with a quote runs to the next quote that is not doubled;
//   "" inside it is one quote, each CRLF or lone CR inside it is read as LF;
//   what follows its closing quote up to the next comma or line break is
//   appended as it stands (quote_junk, when the field ends); a quote that never
//   closes is a literal character and the text after it is read again as
//   unquoted (unterminated_quote).
// - A quote inside an unquoted field is a literal character.
// - Fields stay strings, never trimmed or converted.
// - columns is the first record when header is true, else null; rows holds the
//   records after it, each padded (short_row, with fields: its field count) or
//   cut (long_row, with extra: the cut fields) to the first record's width.
// - Each error is {code, line, row} in the order met; line is the 1-based line
//   the record starts on (counting every LF, CRLF and lone CR inside quotes),
//   row the record's index in rows (null for the header).

const COMMA = 0;
const LINE_BREAK = 1;
const END = 2;

/** csv-reader 1.0.0's answer for one case's input. */
export function run(input) {
  const text = String(input.text);
  const header = input.header === true;
  const errors = [];
  const rows = [];
  let columns = null;
  let width = -1;
  const n = text.length;
  let pos = 0;
  let line = 1;
  if (n > 0 && text.charCodeAt(0) === 0xfeff) pos = 1;

  // Set by readUnquoted/readQuoted: how the field just read ended.
  let lastEnded = END;
  // Per-record state, read by the error pushes below.
  let recordLine = 1;
  let recordRow = null;
  // One native scan for the next field delimiter (comma, LF or CR).
  const delim = /[,\n\r]/g;
  // One native scan for the next quote or CR, used by the record fast path.
  const special = /["\r]/g;

  // Reads unquoted characters from pos onto `init` up to the next comma or line
  // break. A CR not followed by LF is dropped (stray_cr) and skipped. Returns
  // the field; lastEnded says how it ended, and the count of characters kept
  // after `init` is lastAdded.
  let lastAdded = 0;
  function readUnquoted(init) {
    let value = init;
    let added = 0;
    while (pos < n) {
      delim.lastIndex = pos;
      if (!delim.test(text)) {
        value += text.slice(pos);
        added += n - pos;
        pos = n;
        lastEnded = END;
        lastAdded = added;
        return value;
      }
      const d = delim.lastIndex - 1;
      const kind = text.charCodeAt(d);
      if (kind === 13) {
        if (text.charCodeAt(d + 1) === 10) {
          value += text.slice(pos, d);
          added += d - pos;
          pos = d + 2;
          line += 1;
          lastEnded = LINE_BREAK;
          lastAdded = added;
          return value;
        }
        errors.push({ code: 'stray_cr', line: recordLine, row: recordRow });
        value += text.slice(pos, d);
        added += d - pos;
        pos = d + 1;
        continue;
      }
      value += text.slice(pos, d);
      added += d - pos;
      if (kind === 44) {
        pos = d + 1;
        lastEnded = COMMA;
      } else {
        pos = d + 1;
        line += 1;
        lastEnded = LINE_BREAK;
      }
      lastAdded = added;
      return value;
    }
    lastEnded = END;
    lastAdded = added;
    return value;
  }

  // Reads a quoted field whose opening quote is at pos. Returns the field;
  // lastEnded says how it ended.
  function readQuoted() {
    const open = pos;
    const openLine = line;
    let p = open + 1;
    let closed = -1;
    let escapes = 0;
    while (true) {
      const q = text.indexOf('"', p);
      if (q === -1) break;
      if (text.charCodeAt(q + 1) === 34) {
        escapes += 1;
        p = q + 2;
        continue;
      }
      closed = q;
      break;
    }
    if (closed === -1) {
      // The quote never closes: it is a literal character, and the text after
      // it is read again as unquoted.
      pos = open + 1;
      line = openLine;
      errors.push({ code: 'unterminated_quote', line: recordLine, row: recordRow });
      return readUnquoted('"');
    }
    // Every quote inside the slice is one half of a "" pair (the scan above
    // stopped at the first unpaired quote), and every CR or LF in it is one
    // of the field's own line breaks, so the fix-ups below run on the slice
    // alone and never scan past the field.
    let value = text.slice(open + 1, closed);
    if (escapes > 0) value = value.replace(/""/g, '"');
    const cr = value.indexOf('\r');
    if (cr !== -1) value = value.replace(/\r\n?/g, '\n');
    if (cr !== -1 || value.indexOf('\n') !== -1) {
      // Each LF left in the value is one line break of the field (a CRLF or
      // a lone CR became exactly one LF above).
      let c = 0;
      let i = 0;
      while (true) {
        i = value.indexOf('\n', i);
        if (i === -1) break;
        c += 1;
        i += 1;
      }
      line += c;
    }
    pos = closed + 1;
    if (pos >= n) {
      lastEnded = END;
      return value;
    }
    const c = text.charCodeAt(pos);
    if (c === 44) {
      pos += 1;
      lastEnded = COMMA;
      return value;
    }
    if (c === 10) {
      pos += 1;
      line += 1;
      lastEnded = LINE_BREAK;
      return value;
    }
    if (c === 13 && text.charCodeAt(pos + 1) === 10) {
      pos += 2;
      line += 1;
      lastEnded = LINE_BREAK;
      return value;
    }
    // What follows the closing quote is appended as it stands, up to the next
    // comma or line break.
    const before = value.length;
    const v = readUnquoted(value);
    if (v.length > before) {
      errors.push({ code: 'quote_junk', line: recordLine, row: recordRow });
    }
    return v;
  }

  // Finishes a record's fields: the header, the width checks, or a row.
  // `quoted` is whether the record's only field was quoted (a line left with
  // no characters is no record).
  function finishRecord(fields, quoted) {
    if (fields.length === 1 && fields[0] === '' && !quoted) return;
    if (width < 0) width = fields.length;
    if (header && columns === null) {
      columns = fields;
      return;
    }
    if (fields.length < width) {
      errors.push({ code: 'short_row', line: recordLine, row: recordRow, fields: fields.length });
      while (fields.length < width) fields.push('');
    } else if (fields.length > width) {
      errors.push({ code: 'long_row', line: recordLine, row: recordRow, extra: fields.splice(width) });
    }
    rows.push(fields);
  }

  while (true) {
    // Lines with no characters are no records.
    while (pos < n) {
      const c = text.charCodeAt(pos);
      if (c === 10) {
        pos += 1;
        line += 1;
      } else if (c === 13 && text.charCodeAt(pos + 1) === 10) {
        pos += 2;
        line += 1;
      } else {
        break;
      }
    }
    if (pos >= n) break;

    recordLine = line;
    recordRow = header && columns === null ? null : rows.length;

    // Whole-record fast path: the line holds no quote, and its only CR (if
    // any) is the CRLF at its end. Then it is plain fields split on commas.
    // A single bounded scan finds the first quote or CR; anything past the
    // line's end does not belong to this record.
    const nl = text.indexOf('\n', pos);
    const lineEnd = nl === -1 ? n : nl;
    special.lastIndex = pos;
    if (!special.test(text) || special.lastIndex - 1 >= lineEnd) {
      const fields = text.slice(pos, lineEnd).split(',');
      if (nl === -1) {
        pos = n;
      } else {
        pos = nl + 1;
        line += 1;
      }
      finishRecord(fields, false);
      continue;
    }
    const s = special.lastIndex - 1;
    if (nl !== -1 && s === lineEnd - 1 && text.charCodeAt(s) === 13) {
      const fields = text.slice(pos, lineEnd - 1).split(',');
      pos = nl + 1;
      line += 1;
      finishRecord(fields, false);
      continue;
    }
    // A quote in the line, or a stray CR: fall through to the
    // field-by-field path.

    // Field by field: quoted fields and stray CRs live here.
    const fields = [];
    let ended;
    let quoted = false;
    do {
      if (text.charCodeAt(pos) === 34) {
        quoted = true;
        fields.push(readQuoted());
        ended = lastEnded;
      } else {
        quoted = false;
        fields.push(readUnquoted(''));
        ended = lastEnded;
      }
    } while (ended === COMMA);
    finishRecord(fields, quoted);
  }
  return { columns: header ? columns ?? [] : null, rows, errors };
}
