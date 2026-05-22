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
    } catch (e) {
      s = "[Object]"; 
    }
  } else if (typeof value === "function") {
    s = "[Function]"; 
  } else {
    s = String(value);
  }

  // Defensive CSV (Formula) Injection Shielding
  // Full-width characters (＝, ＋, －, ＠) are excluded as major parsers (Excel/Sheets)
  // do not evaluate them natively, and escaping them risks mangling internationalized text.
  if (/^[\u0000-\u001F\s]*[=+\-@]/.test(s)) {
    s = `'${s}`;
  }

  // Escape internal double quotes by doubling them per RFC 4180
  s = s.replace(/"/g, '""');
  return `"${s}"`;
}

/**
 * Exports data to a secure CSV file.
 * @param {Array<Object>} devs - The data source array.
 * @param {Array<string>} headers - The column headers.
 */
export function exportCSV(devs, headers = []) {
  if (!Array.isArray(devs) || headers.length === 0) return;

  const rows = devs.map((d) =>
    headers
      .map((h) => {
        const cellValue = d ? d[h] : "";
        return csvCell(cellValue);
      })
      .join(",")
  );

  const csv = ["\uFEFF" + headers.map(csvCell).join(","), ...rows].join("\r\n");

  // Allow test environments (Node) to return the raw string instead of failing on DOM methods
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


/**
 * Exports data to a secure CSV file.
 * @param {Array<Object>} devs - The data source array.
 */
function exportCSV(devs) {
  // Ensure global columns fallback or fail gracefully
  const headers =
    typeof CSV_EXPORT_COLUMNS !== "undefined" ? CSV_EXPORT_COLUMNS : [];

  // FIX: Removed the devs.length === 0 check to restore original behavior.
  // Allowing empty arrays ensures users still download a clean header-only CSV when no matches are found.
  if (!Array.isArray(devs) || headers.length === 0) return;

  // Build rows dynamically and safely
  const rows = devs.map((d) =>
    headers
      .map((h) => {
        const cellValue = d ? d[h] : "";
        return csvCell(cellValue);
      })
      .join(","),
  );

  // Combine headers and rows with a UTF-8 BOM (\uFEFF) for Excel compatibility
  const csv = ["\uFEFF" + headers.map(csvCell).join(","), ...rows].join("\r\n");
  const blob = new Blob([csv], { type: "text/csv;charset=utf-8;" });
  const url = URL.createObjectURL(blob);

  // Trigger secure client-side download
  const a = document.createElement("a");
  a.href = url;
  a.download = `rankistan-leaderboard-${new Date().toISOString().slice(0, 10)}.csv`;
  a.style.display = "none";
  document.body.appendChild(a);
  a.click();

  // Instant DOM cleanup
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 100);
}