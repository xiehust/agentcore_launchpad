/** Typed client for the Launchpad backend. */

export interface StageInfo {
  name: string;
  status: "pending" | "running" | "succeeded" | "skipped" | "failed";
  detail: string;
  started_at?: string;
  ended_at?: string;
}

export interface DeploymentInfo {
  id: string;
  agent_id: string;
  job_id: string | null;
  status: "running" | "succeeded" | "failed";
  stages: StageInfo[];
  started_at: string | null;
  ended_at: string | null;
}

export interface AgentInfo {
  id: string;
  name: string;
  method: "harness" | "zip_runtime" | "container" | "studio";
  status: "draft" | "deploying" | "active" | "failed" | "deleted";
  arn: string | null;
  resource_id: string | null;
  version: string | null;
  owner: string;
  error: string | null;
  spec: Record<string, unknown>;
  created_at: string | null;
  updated_at: string | null;
  deployment?: DeploymentInfo;
  deployments?: DeploymentInfo[];
  revision?: number;
}

export interface JobEvent {
  ts: string;
  stage: string;
  level: string;
  msg: string;
}

export interface JobInfo {
  id: string;
  type: string;
  status: "queued" | "running" | "succeeded" | "failed";
  error: string | null;
  events: JobEvent[];
}

export interface AgentSpecInput {
  name: string;
  method: string;
  model_id?: string;
  system_prompt: string;
  tools?: { type: string; name: string; config?: Record<string, unknown> }[];
  skills?: string[];
  memory?: { short_term: boolean; long_term: boolean };
  code?: string;
  requirements?: string[];
  env?: Record<string, string>;
  studio_flow?: { nodes: unknown[]; edges: unknown[]; graphMode: boolean };
}

export class ApiError extends Error {
  code: string;
  detail: unknown;
  constructor(code: string, message: string, detail: unknown) {
    super(message);
    this.code = code;
    this.detail = detail;
  }
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(path, {
    headers: { "Content-Type": "application/json" },
    ...init,
  });
  const body = await res.json().catch(() => null);
  if (!res.ok) {
    const env = (body ?? {}) as { code?: string; message?: string; detail?: unknown };
    throw new ApiError(env.code ?? `http.${res.status}`, env.message ?? res.statusText, env.detail);
  }
  return body as T;
}

/* ── observability ─────────────────────────────────────────────────────── */

export interface ObsCache {
  hit: boolean;
  age_seconds: number;
}

export interface ObsTokens {
  input: number;
  output: number;
  total: number;
  cache_read?: number;
  cache_write?: number;
}

export interface ObsPricesMeta {
  updated_at?: string;
  source?: string;
  source_models?: number;
  updated?: string[];
  added?: string[];
}

export interface ObsDashboard {
  range: string;
  prices_meta?: ObsPricesMeta | null;
  tiles: {
    traces: { total: number; ok: number; error: number };
    sessions: { total: number; agents: number };
    error_rate: number;
    latency: { p50_ms: number; p95_ms: number };
    tokens: { input: number; output: number; total: number; est_cost_usd: number | null };
  };
  series: { bucket: string; traces: number; errors: number; p50_ms: number; p95_ms: number }[];
  tokens_by_model: {
    model: string;
    input: number;
    output: number;
    total: number;
    est_cost_usd: number | null;
  }[];
  top_tools: { tool: string; calls: number; errors: number; success_rate: number | null }[];
  cache: ObsCache;
}

export interface ObsTraceRow {
  trace_id: string;
  time: string | null;
  root_operation: string;
  service: string | null;
  agent: string;
  session_id: string | null;
  duration_ms: number;
  span_count: number;
  llm_count: number;
  error_count: number;
  status: "ok" | "error";
  model: string | null;
  multi_model: boolean;
  tokens: ObsTokens;
  est_cost_usd: number | null;
}

export interface ObsTraces {
  range: string;
  traces: ObsTraceRow[];
  count: number;
  limit: number;
  cache: ObsCache;
}

export interface ObsSpan {
  span_id: string | null;
  parent_span_id: string | null;
  name: string;
  category: "llm" | "tool" | "memory" | "gateway" | "http" | "agent" | "other";
  kind: string | null;
  status: string;
  start_offset_ms: number;
  duration_ms: number;
  offset_pct: number;
  width_pct: number;
  model: string | null;
  finish_reason: string | string[] | null;
  tool_name: string | null;
  tokens: { input: number; output: number; cache_read: number; cache_write: number } | null;
  est_cost_usd: number | null;
}

export interface ObsSpanNode extends ObsSpan {
  depth: number;
  children: ObsSpanNode[];
}

export interface ObsMessageBlock {
  type: "text" | "tool_use" | "tool_result" | "other";
  text?: string;
  name?: string | null;
  input?: string;
  status?: string | null;
}

export interface ObsSpanMessage {
  role: string | null;
  finish_reason?: string;
  blocks: ObsMessageBlock[];
}

export interface ObsSpanMessages {
  input?: ObsSpanMessage[];
  output?: ObsSpanMessage[];
}

export interface ObsTraceDetail {
  trace_id: string;
  range: string;
  meta: {
    root_operation: string | null;
    service: string | null;
    agent: string;
    session_id: string | null;
    start: string | null;
    duration_ms: number;
    span_count: number;
    llm_count: number;
    status: "ok" | "error";
    tokens: ObsTokens;
    est_cost_usd: number | null;
  };
  tree: ObsSpanNode[];
  spans: (ObsSpan & {
    attributes: Record<string, unknown>;
    messages?: ObsSpanMessages | null;
  })[];
  cache: ObsCache;
}

export interface ObsSessionRow {
  session_id: string;
  service: string | null;
  agent: string;
  traces: number;
  llm_calls: number;
  errors: number;
  tokens: ObsTokens;
  est_cost_usd: number | null;
  first: string | null;
  last: string | null;
  platform: boolean;
}

export interface ObsSessions {
  range: string;
  sessions: ObsSessionRow[];
  count: number;
  limit: number;
  cache: ObsCache;
}

export interface ObsTranscriptTurn {
  role: string;
  text: string;
  at: string;
}

export interface ObsTranscript {
  available: boolean;
  reason?: string;
  detail?: string;
  actor_id?: string;
  agent_id?: string;
  agent_name?: string | null;
  turns?: ObsTranscriptTurn[];
  long_term_records?: number | null;
}

export interface ObsSessionDetail {
  session_id: string;
  range: string;
  summary: {
    agent: string | null;
    traces: number;
    llm_calls: number;
    errors: number;
    tokens: ObsTokens;
    est_cost_usd: number | null;
    first: string | null;
    last: string | null;
  };
  traces: ObsTraceRow[];
  transcript: ObsTranscript;
  cache: ObsCache;
}

function obsQuery(range: string, force: boolean): string {
  return `range=${encodeURIComponent(range)}${force ? "&force=true" : ""}`;
}

export interface OverviewInfo {
  registry_assets: { agents: number; tools: number; skills: number; total: number };
  active_sessions: number;
  eval_pass_rate: number | null;
  eval_runs: number;
  services: Record<string, boolean>;
  service_detail: Record<string, string>;
}

export const api = {
  createAgent: (spec: AgentSpecInput) =>
    request<{ agent: AgentInfo; job_id: string; deployment_id: string }>("/api/agents", {
      method: "POST",
      body: JSON.stringify(spec),
    }),
  listAgents: () => request<{ agents: AgentInfo[] }>("/api/agents"),
  redeployAgent: (id: string, spec: AgentSpecInput) =>
    request<{ agent: AgentInfo; job_id: string; deployment_id: string }>(
      `/api/agents/${id}/redeploy`,
      { method: "POST", body: JSON.stringify(spec) },
    ),
  getOverview: () => request<OverviewInfo>("/api/overview"),
  getAgent: (id: string) => request<AgentInfo>(`/api/agents/${id}`),
  getJob: (id: string) => request<JobInfo>(`/api/jobs/${id}`),
  invokeAgent: (id: string, prompt: string, sessionId?: string) =>
    request<{ text: string; session_id: string; latency_ms: number }>(
      `/api/agents/${id}/invoke`,
      { method: "POST", body: JSON.stringify({ prompt, session_id: sessionId }) },
    ),
  deleteAgent: (id: string) =>
    request<{ deleted: boolean }>(`/api/agents/${id}`, { method: "DELETE" }),
  obsDashboard: (range: string, force = false) =>
    request<ObsDashboard>(`/api/observability/dashboard?${obsQuery(range, force)}`),
  obsTraces: (range: string, force = false) =>
    request<ObsTraces>(`/api/observability/traces?${obsQuery(range, force)}`),
  obsTrace: (traceId: string, range: string, force = false) =>
    request<ObsTraceDetail>(
      `/api/observability/traces/${encodeURIComponent(traceId)}?${obsQuery(range, force)}`,
    ),
  obsSessions: (range: string, force = false) =>
    request<ObsSessions>(`/api/observability/sessions?${obsQuery(range, force)}`),
  obsSession: (sessionId: string, range: string, force = false) =>
    request<ObsSessionDetail>(
      `/api/observability/sessions/${encodeURIComponent(sessionId)}?${obsQuery(range, force)}`,
    ),
  obsRefreshPrices: () =>
    request<{ prices: Record<string, unknown>; meta: Required<ObsPricesMeta> }>(
      "/api/observability/prices/refresh",
      { method: "POST" },
    ),
};
