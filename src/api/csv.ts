/**
 * Minimal RFC 4180 CSV writer for the bulk exports. Values containing a comma,
 * quote or newline are quoted; null becomes an empty cell. A leading = + - @
 * is prefixed with ' so a spreadsheet does not run the cell as a formula
 * (CSV injection), since some values come from the portal.
 */
export function toCsv<T extends Record<string, unknown>>(columns: readonly (keyof T & string)[], rows: readonly T[]): string {
  const lines = [columns.join(",")];
  for (const row of rows) lines.push(columns.map((column) => cell(row[column])).join(","));
  return `${lines.join("\r\n")}\r\n`;
}

function cell(value: unknown): string {
  if (value === null || value === undefined) return "";
  let text = String(value);
  if (typeof value === "string" && /^[=+\-@]/.test(text)) text = `'${text}`;
  return /[",\r\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}
