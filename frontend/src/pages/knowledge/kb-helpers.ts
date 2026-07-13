import type { ChipTone } from "../../components";

/** sessionStorage key holding the source to replay once a slow-creating KB
 *  turns ACTIVE (the create endpoint returns before the data source exists). */
export const pendingSourceKey = (kbId: string) => `kb-pending-source:${kbId}`;

/** Tone for data-source / ingestion-job statuses (raw AWS enum values). */
export function resourceTone(status: string): ChipTone {
  const s = status.toUpperCase();
  if (["AVAILABLE", "COMPLETE", "COMPLETED", "READY", "ACTIVE"].includes(s)) return "good";
  if (["FAILED"].includes(s)) return "crit";
  if (["CREATING", "IN_PROGRESS", "STARTING", "SYNCING", "STOPPING"].includes(s)) return "warn";
  return "muted";
}

/** Pull a human message out of an error body ({code,message,detail} envelope or
 *  a FastAPI {detail} shape). */
export function kbErrorMessage(body: unknown, status: number): string {
  const b = (body ?? {}) as { message?: unknown; detail?: unknown };
  if (typeof b.message === "string") return b.message;
  if (typeof b.detail === "string") return b.detail;
  if (b.detail && typeof b.detail === "object") {
    const d = b.detail as { message?: unknown };
    if (typeof d.message === "string") return d.message;
  }
  return `HTTP ${status}`;
}

/** Agent names carried by a DELETE 409 (attached & not forced). Tolerant of
 *  either a top-level `agents` or a nested `detail.agents`. */
export function extractConflictAgents(body: unknown): string[] {
  const b = (body ?? {}) as { agents?: unknown; detail?: { agents?: unknown } };
  const raw = Array.isArray(b.agents)
    ? b.agents
    : Array.isArray(b.detail?.agents)
      ? b.detail?.agents
      : [];
  return (raw as unknown[]).filter((x): x is string => typeof x === "string");
}
