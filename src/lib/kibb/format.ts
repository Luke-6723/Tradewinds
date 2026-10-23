// Display helpers for kibb.io values: pence → Crowns, tons, bps, relative times, ids → names.

export function fmtCr(pence: number | null | undefined, digits = 0): string {
  if (pence === null || pence === undefined) return "—";
  return `${(pence / 100).toLocaleString("en-GB", { minimumFractionDigits: digits, maximumFractionDigits: digits })} Cr`;
}

export function fmtTons(tons: number | null | undefined, digits = 0): string {
  if (tons === null || tons === undefined) return "—";
  return `${tons.toLocaleString("en-GB", { minimumFractionDigits: digits, maximumFractionDigits: digits })} t`;
}

export function fmtBps(bps: number | null | undefined): string {
  if (bps === null || bps === undefined) return "—";
  return `${(bps / 100).toLocaleString("en-GB", { maximumFractionDigits: 2 })}%`;
}

function fmtSpan(ms: number): string {
  const s = Math.round(Math.abs(ms) / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ${s % 60}s`;
  const h = Math.floor(m / 60);
  if (h < 48) return `${h}h ${m % 60}m`;
  return `${Math.floor(h / 24)}d ${h % 24}h`;
}

/** "in 3m 12s", or "now" once passed. */
export function fmtIn(iso: string | null | undefined): string {
  if (!iso) return "—";
  const ms = Date.parse(iso) - Date.now();
  return ms <= 0 ? "now" : `in ${fmtSpan(ms)}`;
}

/** "3m 12s ago". */
export function fmtAgo(iso: string | null | undefined): string {
  if (!iso) return "—";
  return `${fmtSpan(Date.now() - Date.parse(iso))} ago`;
}

export function fmtAgeSeconds(seconds: number): string {
  return `${fmtSpan(seconds * 1000)} old`;
}

export function fmtTime(iso: string | null | undefined): string {
  if (!iso) return "—";
  return new Date(iso).toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit", second: "2-digit" });
}

/** `le_havre` → `Le Havre` when no catalog name is at hand. */
export function titleCase(id: string): string {
  return id.replace(/_/g, " ").replace(/\b\w/g, (c) => c.toUpperCase());
}

/** "23 Oct, 14:05:12" (local time). */
export function fmtDateTime(iso: string | null | undefined): string {
  if (!iso) return "—";
  return new Date(iso).toLocaleString("en-GB", { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit", second: "2-digit" });
}

/** Game hours as "2d 6h" / "14h" (1 game day = 24 game hours). */
export function fmtGameHours(hours: number | null | undefined): string {
  if (hours === null || hours === undefined) return "—";
  const d = Math.floor(hours / 24);
  const h = Math.round(hours % 24);
  return d ? `${d}d${h ? ` ${h}h` : ""} game` : `${h}h game`;
}
