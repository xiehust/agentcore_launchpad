/** Number/time formatting shared by the Observability tabs. */

export function fmtCompact(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(n >= 10_000_000 ? 0 : 1)}M`;
  if (n >= 1_000) return `${Math.round(n / 1_000)}K`;
  return String(Math.round(n));
}

export function fmtInt(n: number): string {
  return Math.round(n).toLocaleString("en-US");
}

/** "$0.019" — advisory estimate; null (unknown model) renders as "—". */
export function fmtCost(v: number | null | undefined): string {
  if (v == null) return "—";
  if (v >= 1) return `$${v.toFixed(2)}`;
  if (v >= 0.001) return `$${v.toFixed(3)}`;
  return `$${v.toFixed(4)}`;
}

export function fmtDuration(ms: number): string {
  if (ms < 1000) return `${Math.round(ms)}ms`;
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)}s`;
  return `${Math.floor(ms / 60_000)}m ${Math.round((ms % 60_000) / 1000)}s`;
}

export function shortId(id: string | null | undefined, chars = 8): string {
  if (!id) return "—";
  return id.length > chars ? `${id.slice(0, chars)}…` : id;
}

export function fmtClock(iso: string | null | undefined): string {
  if (!iso) return "—";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "—";
  return d.toLocaleTimeString("en-GB", { hour12: false });
}

export function fmtClockShort(iso: string | null | undefined): string {
  if (!iso) return "—";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "—";
  return d.toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit", hour12: false });
}

/** Logs Insights bin() buckets are UTC "YYYY-MM-DD HH:mm:ss.SSS" strings. */
export function bucketDate(bucket: string): Date {
  return new Date(`${bucket.replace(" ", "T")}Z`);
}

export function fmtBucket(bucket: string, longRange: boolean): string {
  const d = bucketDate(bucket);
  if (Number.isNaN(d.getTime())) return bucket;
  const hm = d.toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit", hour12: false });
  if (!longRange) return hm;
  const md = d.toLocaleDateString("en-GB", { month: "2-digit", day: "2-digit" });
  return `${md} ${hm}`;
}
