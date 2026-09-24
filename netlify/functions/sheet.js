// Allowed sheets (key -> Google Sheet ID)
const SHEETS = {
  bbb: '1UInMmMBWA5zvcy4vwSf2XwtxpBqXASiNDkZ-S6Bv_Cg',
  FootballSessions: '1U2ZmiGJfotFVYGRGytANJosiWQJHJcMSSoMzP4DUU4Q',
  HiddenPotential: '1U2ZmiGJfotFVYGRGytANJosiWQJHJcMSSoMzP4DUU4Q'
};
// Proper CSV parser: handles "quoted, cells", "" escaped quotes and line breaks inside cells
function parseCSV(text) {
  const rows = [];
  let row = [];
  let cell = "";
  let inQuotes = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (inQuotes) {
      if (c === '"') {
        if (text[i + 1] === '"') { cell += '"'; i++; } // escaped quote ""
        else inQuotes = false;                          // closing quote
      } else {
        cell += c;
      }
    } else {
      if (c === '"') inQuotes = true;
      else if (c === ',') { row.push(cell); cell = ""; }
      else if (c === '\n') { row.push(cell); rows.push(row); row = []; cell = ""; }
      else if (c === '\r') { /* ignore Windows line endings */ }
      else cell += c;
    }
  }
  if (cell !== "" || row.length) { row.push(cell); rows.push(row); }
  return rows;
}
// 0 -> A, 1 -> B, ... 26 -> AA (used to name empty header cells)
function columnLetter(i) {
  let s = "";
  let n = i + 1;
  while (n > 0) {
    const m = (n - 1) % 26;
    s = String.fromCharCode(65 + m) + s;
    n = Math.floor((n - 1) / 26);
  }
  return s;
}
export async function handler(event, context) {
  // Which sheet? e.g. /.netlify/functions/sheet?sheet=aaa  (default: bbb)
  const key = (event.queryStringParameters && event.queryStringParameters.sheet) || 'bbb';
  const SHEET_ID = SHEETS[key];
  if (!SHEET_ID) {
    return {
      statusCode: 400,
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ error: "Unknown sheet: " + key }),
    };
  }
  const CSV_URL = `https://docs.google.com/spreadsheets/d/${SHEET_ID}/export?format=csv`;

  try {
    const resp = await fetch(CSV_URL);
    if (!resp.ok) throw new Error(`Fetch error: ${resp.status}`);
    const csv = await resp.text();
    // Parse into arrays so column POSITIONS are always preserved
    const table = parseCSV(csv);
    if (!table.length) {
      return {
        statusCode: 200,
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ headers: [], rows: [] })
      };
    }
    // Widest row decides the number of columns
    const width = table.reduce((max, r) => Math.max(max, r.length), 0);
    // Header row: empty header cells get a name like "Column C"
    const headers = [];
    for (let i = 0; i < width; i++) {
      const h = (table[0][i] || "").trim();
      headers.push(h || "Column " + columnLetter(i));
    }
    // Data rows: pad every row to full width (empty cells stay as ""), skip fully empty rows
    const rows = table.slice(1)
      .map(r => {
        const out = [];
        for (let i = 0; i < width; i++) out.push(r[i] ?? "");
        return out;
      })
      .filter(r => r.some(c => c.trim() !== ""));
    return {
      statusCode: 200,
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ headers, rows })
    };
  } catch (e) {
    return {
      statusCode: 500,
      body: JSON.stringify({ error: e.message || "Unknown error" }),
    };
  }
}