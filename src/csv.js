// Strict RFC 4180-style CSV parsing and formula-safe serialization.

/** Parse CSV text into an array of string arrays. Throws Error with a precise message. */
export function parseCsv(text) {
  const rows = [];
  let row = [];
  let field = '';
  let i = 0;
  let quoted = false;
  let fieldStart = true;
  const n = text.length;
  const endField = () => { row.push(field); field = ''; fieldStart = true; };
  const endRow = () => { endField(); rows.push(row); row = []; };
  while (i < n) {
    const c = text[i];
    if (quoted) {
      if (c === '"') {
        if (text[i + 1] === '"') { field += '"'; i += 2; continue; }
        quoted = false; i++;
        const next = text[i];
        if (i < n && next !== ',' && next !== '\n' && next !== '\r') throw new Error(`CSV: unexpected character after closing quote at offset ${i}`);
        continue;
      }
      field += c; i++; continue;
    }
    if (c === '"') {
      if (!fieldStart) throw new Error(`CSV: bare quote inside unquoted field at offset ${i}`);
      quoted = true; fieldStart = false; i++; continue;
    }
    if (c === ',') { endField(); i++; continue; }
    if (c === '\r') {
      if (text[i + 1] !== '\n') throw new Error(`CSV: bare carriage return at offset ${i}`);
      endRow(); i += 2; continue;
    }
    if (c === '\n') { endRow(); i++; continue; }
    if (c === '\u0000') throw new Error(`CSV: NUL character at offset ${i}`);
    field += c; fieldStart = false; i++;
  }
  if (quoted) throw new Error('CSV: unterminated quoted field');
  if (!fieldStart || row.length > 0) endRow();
  return rows;
}

const FORMULA_START = /^[=+\-@\t\r]/;

/**
 * Serialize one cell. Integers are emitted raw (so -60 stays an integer); strings that a
 * spreadsheet could interpret as a formula are prefixed with an apostrophe.
 */
export function csvCell(value) {
  if (value === null || value === undefined) return '';
  if (typeof value === 'number') {
    if (!Number.isSafeInteger(value)) throw new Error('CSV: only safe integers may be exported as numbers');
    return String(value);
  }
  if (typeof value === 'boolean') return value ? 'true' : 'false';
  let s = String(value);
  if (FORMULA_START.test(s)) s = `'${s}`;
  return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

export function toCsv(header, rows) {
  return [header, ...rows].map((r) => r.map(csvCell).join(',')).join('\r\n') + '\r\n';
}
