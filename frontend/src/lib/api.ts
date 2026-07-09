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
  tools?: { type: string; name: string }[];
  skills?: string[];
  memory?: { short_term: boolean; long_term: boolean };
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
};
