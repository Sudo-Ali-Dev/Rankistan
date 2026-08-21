/**
 * Safely escapes a single cell value for CSV output.
 * Mitigates CSV Injection (Formula Injection) while preserving valid data types.
 */
export function csvCell(value) {
  if (value === null || value === undefined) {
    return '""';
  }

  if (typeof value === "number") {
    return Number.isNaN(value) ? '""' : `"${value}"`;
  }

  let s = "";
  if (value instanceof Date) {
    s = Number.isNaN(value.getTime()) ? "" : value.toISOString();
  } else if (Array.isArray(value)) {
    s = value.map((v) => (v == null ? "" : String(v))).join(", ");
  } else if (typeof value === "object") {
    try {
      s = JSON.stringify(value);
    } catch {
      s = "[Object]"; 
    }
  } else if (typeof value === "function") {
    s = "[Function]"; 
  } else {
    s = String(value);
  }

  // 1. Escape internal double quotes by doubling them up per RFC 4180 first
  s = s.replace(/"/g, '""');

  // 2. Defensive CSV (Formula) Injection Shielding
  // Checked after processing quotes to ensure characters aren't split or broken unreliably
  // The control-char class is deliberate: leading control characters must not
  // hide a formula prefix from this check.
  // eslint-disable-next-line no-control-regex
  if (/^[\u0000-\u001F\s]*[=+\-@]/.test(s)) {
    s = `'${s}`;
  }

  // 3. Wrap cell context smoothly inside double-quote enclosures
  return `"${s}"`;
}

/**
 * Exports data to a secure CSV file.
 * @param {Array<Object>} devs - The data source array.
 * @param {Array<string>} headers - The column headers.
 */
export function exportCSV(devs, headers = []) {
  // Tightened guard clause to explicitly verify headers array format
  if (!Array.isArray(devs) || !Array.isArray(headers) || headers.length === 0) return;

  const rows = devs.map((d) =>
    headers
      .map((h) => {
        const cellValue = d ? d[h] : "";
        return csvCell(cellValue);
      })
      .join(",")
  );

  const csv = ["\uFEFF" + headers.map(csvCell).join(","), ...rows].join("\r\n");

  if (typeof window === "undefined" || typeof document === "undefined") {
    return csv;
  }

  const blob = new Blob([csv], { type: "text/csv;charset=utf-8;" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = `rankistan-leaderboard-${new Date().toISOString().slice(0, 10)}.csv`;
  a.style.display = "none";
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 100);
}