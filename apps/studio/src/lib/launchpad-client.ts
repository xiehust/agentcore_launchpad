/**
 * Launchpad platform integration (Launchpad-specific addition, see LICENSE).
 *
 * Deploys studio-generated Strands code through the platform's unified
 * deployer (POST /api/agents, method=studio) so the agent lands in the
 * platform ledger, launch feed and registry — same pipeline as every other
 * creation method. The /launchpad-api prefix is proxied to the platform
 * backend (:8000) by vite.config.ts.
 */

export interface LaunchpadDeployResult {
  agent: { id: string; name: string; status: string };
  job_id: string;
  deployment_id: string;
}

export interface LaunchpadJobEvent {
  ts: string;
  stage: string;
  msg: string;
}

const BASE = "/launchpad-api";

export async function deployToLaunchpad(
  agentName: string,
  code: string,
  requirements: string[] = [],
): Promise<LaunchpadDeployResult> {
  const name = agentName
    .toLowerCase()
    .replace(/[^a-z0-9-]/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 48);
  const res = await fetch(`${BASE}/agents`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      name: name || "studio-agent",
      method: "studio",
      system_prompt: "Strands Studio generated agent",
      code,
      requirements,
      memory: { short_term: false, long_term: false },
    }),
  });
  const body = await res.json();
  if (!res.ok) {
    throw new Error(body?.message ?? `Launchpad deploy failed (${res.status})`);
  }
  return body as LaunchpadDeployResult;
}

export async function getLaunchpadAgent(agentId: string): Promise<{
  status: string;
  arn: string | null;
  deployments?: { stages: { name: string; status: string; detail: string }[] }[];
}> {
  const res = await fetch(`${BASE}/agents/${agentId}`);
  return res.json();
}

export async function getLaunchpadJob(jobId: string): Promise<{
  status: string;
  events: LaunchpadJobEvent[];
}> {
  const res = await fetch(`${BASE}/jobs/${jobId}`);
  return res.json();
}
