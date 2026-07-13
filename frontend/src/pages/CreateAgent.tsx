import type { CSSProperties } from "react";
import { useCallback, useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { Link, useNavigate, useSearchParams } from "react-router-dom";

import { Btn, Chip, ConfirmDialog, LaunchSequence, Panel, useToast, ViewHead } from "../components";
import type { AgentInfo, DeploymentInfo, InspectedSkill, JobInfo } from "../lib/api";
import { api, ApiError } from "../lib/api";

const DEFAULT_MODEL = "global.anthropic.claude-sonnet-4-6";
const BUILTIN_TOOLS = ["code-interpreter", "browser"] as const;
// AgentCore mount-path contract: exactly one level under /mnt
const MOUNT_RE = /^\/mnt\/[a-zA-Z0-9._-]+$/;
const DEFAULT_SESSION_MOUNT = "/mnt/workspace";

const splitIds = (s: string) => s.split(/[\s,]+/).filter(Boolean);
const skillNameFromPath = (path: string) => path.replace(/\/+$/, "").split("/").pop() ?? path;

type Step = 1 | 2 | 3;

interface LaunchState {
  agentId: string;
  jobId: string;
}

type Method = "harness" | "zip_runtime" | "container";

// Spec fields we read back when loading an existing agent into the wizard.
interface StoredSpec {
  model_id?: string;
  system_prompt?: string;
  tools?: { type: string; name: string; config?: { url?: string } }[];
  skills?: string[];
  knowledge_bases?: KbRef[];
  memory?: { long_term?: boolean };
  env?: Record<string, string>;
  filesystem?: {
    session_storage?: { mount_path?: string } | null;
    s3_files?: { access_point_arn?: string; mount_path?: string }[];
    efs?: { access_point_arn?: string; mount_path?: string }[];
  };
  network?: { subnets?: string[]; security_groups?: string[] };
}

interface MountRow {
  arn: string;
  path: string;
}

// APPROVED registry records the wizard offers for mounting.
interface AttachableMcp {
  name: string;
  description: string;
  url: string;
  gateway: boolean;
}
interface AttachableSkill {
  name: string;
  description: string;
  path: string;
}
// A managed KB offered by the catalog (only ACTIVE + MANAGED are selectable).
interface AttachableKb {
  kb_id: string;
  name: string;
  description?: string;
  status?: string;
  type?: string;
}
// The redundant KB reference stored in the agent spec (name/description carried
// so the wizard can still render a chip if the KB later leaves the catalog).
interface KbRef {
  kb_id: string;
  name: string;
  description: string;
}

export function CreateAgent() {
  const { t } = useTranslation();
  const toast = useToast();
  const navigate = useNavigate();
  const [params] = useSearchParams();
  const prefillGateway = params.get("gateway");
  const prefillSkill = params.get("skill");
  const [step, setStep] = useState<Step>(prefillGateway || prefillSkill ? 2 : 1);
  const [method, setMethod] = useState<Method>("harness");
  const [skills, setSkills] = useState<string[]>(prefillSkill ? [prefillSkill] : []);
  const [name, setName] = useState("");
  const [modelId, setModelId] = useState(DEFAULT_MODEL);
  const [systemPrompt, setSystemPrompt] = useState("");
  const [tools, setTools] = useState<string[]>([]);
  const [gatewayTargets, setGatewayTargets] = useState<string[]>([]);
  const [remoteMcp, setRemoteMcp] = useState<AttachableMcp[]>([]);
  const [skillCatalog, setSkillCatalog] = useState<AttachableSkill[]>([]);
  const [selectedGateway, setSelectedGateway] = useState<string[]>(
    prefillGateway ? [prefillGateway] : [],
  );
  const [selectedMcp, setSelectedMcp] = useState<string[]>([]);
  const [kbCatalog, setKbCatalog] = useState<AttachableKb[]>([]);
  const [selectedKbs, setSelectedKbs] = useState<string[]>([]);
  // KB refs carried in the loaded spec — name fallback for KBs no longer in the catalog.
  const [specKbs, setSpecKbs] = useState<KbRef[]>([]);
  // KBs shown read-only on the step-3 detail view (viewed agent or just-published).
  const [detailKbs, setDetailKbs] = useState<KbRef[]>([]);
  const [longTerm, setLongTerm] = useState(true);
  const [mcpServers, setMcpServers] = useState("");
  // custom skill sources attached without a registry record (name shown on the chip)
  const [customSkills, setCustomSkills] = useState<{ name: string; path: string }[]>([]);
  const [pendingSkills, setPendingSkills] = useState<{
    stagingId: string;
    skills: InspectedSkill[];
    picked: number[];
  } | null>(null);
  const [gitOpen, setGitOpen] = useState(false);
  const [gitUrl, setGitUrl] = useState("");
  const [srcBusy, setSrcBusy] = useState(false);
  const skillFileRef = useRef<HTMLInputElement>(null);
  // AgentCore Runtime filesystem configuration (container method only)
  const [sessionFs, setSessionFs] = useState(true);
  const [sessionMount, setSessionMount] = useState(DEFAULT_SESSION_MOUNT);
  const [s3Mounts, setS3Mounts] = useState<MountRow[]>([]);
  const [efsMounts, setEfsMounts] = useState<MountRow[]>([]);
  const [vpcSubnets, setVpcSubnets] = useState("");
  const [vpcSgs, setVpcSgs] = useState("");
  // when set, the wizard edits an existing agent and the launch button re-publishes it
  const [editing, setEditing] = useState<{ id: string; name: string; method: Method } | null>(null);
  const [detailsMode, setDetailsMode] = useState(false);

  useEffect(() => {
    // Mountable assets come from the registry catalog: only APPROVED records
    // are offered, so the registry lifecycle gates availability.
    fetch("/api/registry/attachables")
      .then((res) => (res.ok ? res.json() : { mcp_servers: [], skills: [] }))
      .then((d: { mcp_servers: AttachableMcp[]; skills: AttachableSkill[] }) => {
        setGatewayTargets(d.mcp_servers.filter((m) => m.gateway).map((m) => m.name));
        setRemoteMcp(d.mcp_servers.filter((m) => !m.gateway));
        setSkillCatalog(d.skills);
      })
      .catch(() => {
        /* registry not bootstrapped — chips stay hidden */
      });
    // Managed KB catalog — only MANAGED KBs are attachable (gateway connector
    // constraint); failures are tolerated: an empty catalog just leaves the
    // Knowledge section empty and never blocks the wizard.
    fetch("/api/knowledge-bases?type=MANAGED")
      .then((res) => (res.ok ? res.json() : { items: [] }))
      .then((d: { items: AttachableKb[] }) => setKbCatalog(d.items ?? []))
      .catch(() => {
        /* KB catalog unavailable — section stays empty */
      });
  }, []);

  const [agents, setAgents] = useState<AgentInfo[]>([]);
  const reloadAgents = useCallback(() => {
    void api
      .listAgents()
      .then((res) => setAgents(res.agents))
      .catch(() => {
        /* list is best-effort — a fetch blip shouldn't blank the page */
      });
  }, []);
  useEffect(() => reloadAgents(), [reloadAgents]);

  // KBs are harness-only; drop any selection when the method changes away from it.
  useEffect(() => {
    if (method !== "harness") setSelectedKbs([]);
  }, [method]);

  const [submitError, setSubmitError] = useState<string | null>(null);
  const [launch, setLaunch] = useState<LaunchState | null>(null);
  const [deployment, setDeployment] = useState<DeploymentInfo | null>(null);
  const [job, setJob] = useState<JobInfo | null>(null);
  const [agentStatus, setAgentStatus] = useState<string>("deploying");
  const [confirm, setConfirm] = useState<
    { kind: "republish" } | { kind: "delete"; id: string; name: string } | null
  >(null);

  const failureToasted = useRef(false);
  const poll = useCallback(async () => {
    if (!launch) return;
    try {
      const agent = await api.getAgent(launch.agentId);
      setDeployment(agent.deployments?.[0] ?? null);
      setJob(await api.getJob(launch.jobId));
      if (agent.status === "failed" && !failureToasted.current) {
        failureToasted.current = true;
        const failedStage = (agent.deployments?.[0]?.stages ?? []).find(
          (s) => s.status === "failed",
        );
        toast(
          t("create.launchFailedToast", {
            stage: failedStage?.name ?? "deploy",
            msg: (failedStage?.detail ?? "").slice(0, 120),
          }),
        );
      }
      setAgentStatus(agent.status);
    } catch {
      /* transient poll errors are retried on the next tick */
    }
  }, [launch, t, toast]);

  useEffect(() => {
    if (!launch) return;
    void poll(); // always load once (covers read-only "details" of a finished deploy)
    if (agentStatus === "active" || agentStatus === "failed") return;
    const timer = setInterval(() => void poll(), 2000);
    return () => clearInterval(timer);
  }, [launch, agentStatus, poll]);

  const resetForm = () => {
    setEditing(null);
    setDetailsMode(false);
    setName("");
    setModelId(DEFAULT_MODEL);
    setSystemPrompt("");
    setTools([]);
    setSelectedGateway([]);
    setSelectedMcp([]);
    setSelectedKbs([]);
    setSpecKbs([]);
    setDetailKbs([]);
    setSkills([]);
    setLongTerm(true);
    setMcpServers("");
    setCustomSkills([]);
    setPendingSkills(null);
    setGitOpen(false);
    setGitUrl("");
    setSessionFs(true);
    setSessionMount(DEFAULT_SESSION_MOUNT);
    setS3Mounts([]);
    setEfsMounts([]);
    setVpcSubnets("");
    setVpcSgs("");
    setSubmitError(null);
  };

  const byoMounts = s3Mounts.length > 0 || efsMounts.length > 0;

  // Resolve a KB id to its name/description, preferring the live catalog and
  // falling back to the loaded spec so out-of-catalog KBs keep their label.
  const kbInfo = (id: string): KbRef => {
    const cat = kbCatalog.find((k) => k.kb_id === id);
    if (cat) return { kb_id: id, name: cat.name, description: cat.description ?? "" };
    const stored = specKbs.find((k) => k.kb_id === id);
    return { kb_id: id, name: stored?.name ?? id, description: stored?.description ?? "" };
  };

  // Only ACTIVE managed KBs are selectable; the catalog may already exclude
  // non-managed KBs, so the type guard is defensive.
  const activeKbs = kbCatalog.filter(
    (k) => k.status === "ACTIVE" && (k.type == null || k.type === "MANAGED"),
  );

  const buildSpec = () => ({
    name,
    method,
    model_id: modelId,
    system_prompt: systemPrompt,
    tools:
      method === "harness"
        ? [
            ...tools.map((n) => ({ type: "builtin", name: n })),
            ...selectedGateway.map((n) => ({ type: "gateway", name: n })),
            ...selectedMcp.flatMap((n) => {
              const server = remoteMcp.find((m) => m.name === n);
              return server ? [{ type: "mcp", name: n, config: { url: server.url } }] : [];
            }),
          ]
        : method === "container"
          ? selectedMcp.flatMap((n) => {
              const server = remoteMcp.find((m) => m.name === n);
              return server ? [{ type: "mcp", name: n, config: { url: server.url } }] : [];
            })
          : [],
    memory: { short_term: true, long_term: longTerm },
    ...(method === "harness" && selectedKbs.length
      ? { knowledge_bases: selectedKbs.map(kbInfo) }
      : {}),
    ...((method === "harness" || method === "container") && skills.length ? { skills } : {}),
    ...(method === "container" && mcpServers.trim()
      ? { env: { LAUNCHPAD_MCP_SERVERS: mcpServers.trim() } }
      : {}),
    ...(method === "container"
      ? {
          filesystem: {
            session_storage: sessionFs ? { mount_path: sessionMount } : null,
            s3_files: s3Mounts.map((m) => ({ access_point_arn: m.arn, mount_path: m.path })),
            efs: efsMounts.map((m) => ({ access_point_arn: m.arn, mount_path: m.path })),
          },
          ...(byoMounts
            ? { network: { subnets: splitIds(vpcSubnets), security_groups: splitIds(vpcSgs) } }
            : {}),
        }
      : {}),
  });

  const submit = async () => {
    setSubmitError(null);
    try {
      const spec = buildSpec();
      const res = editing
        ? await api.redeployAgent(editing.id, spec)
        : await api.createAgent(spec);
      setDetailKbs((spec as { knowledge_bases?: KbRef[] }).knowledge_bases ?? []);
      failureToasted.current = false;
      setLaunch({ agentId: res.agent.id, jobId: res.job_id });
      setAgentStatus("deploying");
      setDetailsMode(false);
      setStep(3);
      reloadAgents();
    } catch (err) {
      setSubmitError(
        err instanceof ApiError ? t(`apiErrors.${err.code}`, err.message) : String(err),
      );
    }
  };

  const startEdit = (agent: AgentInfo) => {
    const spec = (agent.spec ?? {}) as StoredSpec;
    setEditing({ id: agent.id, name: agent.name, method: agent.method as Method });
    setDetailsMode(false);
    setMethod(agent.method as Method);
    setName(agent.name);
    setModelId(spec.model_id ?? DEFAULT_MODEL);
    setSystemPrompt(spec.system_prompt ?? "");
    setTools((spec.tools ?? []).filter((x) => x.type === "builtin").map((x) => x.name));
    setSelectedGateway((spec.tools ?? []).filter((x) => x.type === "gateway").map((x) => x.name));
    setSelectedMcp((spec.tools ?? []).filter((x) => x.type === "mcp").map((x) => x.name));
    setSelectedKbs((spec.knowledge_bases ?? []).map((k) => k.kb_id));
    setSpecKbs(spec.knowledge_bases ?? []);
    setSkills(spec.skills ?? []);
    setLongTerm(spec.memory?.long_term ?? true);
    setMcpServers(spec.env?.LAUNCHPAD_MCP_SERVERS ?? "");
    // custom (non-registry) skill paths get their chip name from the path tail
    setCustomSkills(
      (spec.skills ?? [])
        .filter((p) => p.includes("/agent-skills/"))
        .map((p) => ({ name: skillNameFromPath(p), path: p })),
    );
    setPendingSkills(null);
    const fs = spec.filesystem;
    setSessionFs(fs ? fs.session_storage != null : true);
    setSessionMount(fs?.session_storage?.mount_path ?? DEFAULT_SESSION_MOUNT);
    setS3Mounts(
      (fs?.s3_files ?? []).map((m) => ({ arn: m.access_point_arn ?? "", path: m.mount_path ?? "" })),
    );
    setEfsMounts(
      (fs?.efs ?? []).map((m) => ({ arn: m.access_point_arn ?? "", path: m.mount_path ?? "" })),
    );
    setVpcSubnets((spec.network?.subnets ?? []).join(", "));
    setVpcSgs((spec.network?.security_groups ?? []).join(", "));
    setSubmitError(null);
    setStep(2);
  };

  const openDetails = (agent: AgentInfo) => {
    const jobId = agent.deployment?.job_id;
    if (!jobId) return;
    setEditing(null);
    setDetailsMode(true);
    setDetailKbs(((agent.spec ?? {}) as StoredSpec).knowledge_bases ?? []);
    failureToasted.current = true; // don't re-toast an old failure when merely viewing
    setDeployment(agent.deployment ?? null);
    setJob(null);
    setLaunch({ agentId: agent.id, jobId });
    setAgentStatus(agent.status);
    setStep(3);
  };

  const doDelete = async (id: string) => {
    try {
      await api.deleteAgent(id);
      toast(t("create.list.deleted"));
      reloadAgents();
    } catch (err) {
      toast(err instanceof ApiError ? t(`apiErrors.${err.code}`, err.message) : String(err));
    }
  };

  const toggleTool = (tool: string) =>
    setTools((prev) => (prev.includes(tool) ? prev.filter((x) => x !== tool) : [...prev, tool]));

  const toggleKb = (id: string) =>
    setSelectedKbs((prev) => (prev.includes(id) ? prev.filter((x) => x !== id) : [...prev, id]));

  /* ── custom skill sources: inspect (zip/git) → pick → attach ──────────── */

  const apiMsg = (err: unknown) =>
    err instanceof ApiError ? t(`apiErrors.${err.code}`, err.message) : String(err);

  const attachStaged = useCallback(
    async (stagingId: string, indices: number[]) => {
      const res = await api.attachSkillSources(
        stagingId,
        indices.map((index) => ({ index })),
      );
      const attached = res.skills.filter((s) => s.ok && s.path);
      const failed = res.skills.filter((s) => !s.ok);
      if (attached.length) {
        setSkills((prev) => [...prev, ...attached.map((s) => s.path as string)]);
        setCustomSkills((prev) => [
          ...prev,
          ...attached.map((s) => ({ name: s.name, path: s.path as string })),
        ]);
      }
      for (const item of failed) toast(`${item.name}: ${item.error ?? "attach failed"}`);
      return failed.length === 0;
    },
    [toast],
  );

  const inspectSource = async (input: File | { url: string }) => {
    setSrcBusy(true);
    try {
      const res =
        input instanceof File
          ? await api.inspectSkillZip(input)
          : await api.inspectSkillGit(input.url);
      const valid = res.skills.filter((s) => s.valid);
      if (valid.length === 1 && res.skills.length === 1) {
        // single-skill source (typical zip) — attach straight away
        if (await attachStaged(res.staging_id, [valid[0].index])) {
          setGitOpen(false);
          setGitUrl("");
        }
      } else {
        // monorepo — let the user pick which skills to attach
        setPendingSkills({ stagingId: res.staging_id, skills: res.skills, picked: [] });
      }
    } catch (err) {
      toast(apiMsg(err));
    } finally {
      setSrcBusy(false);
    }
  };

  const attachPicked = async () => {
    if (!pendingSkills || pendingSkills.picked.length === 0) return;
    setSrcBusy(true);
    try {
      if (await attachStaged(pendingSkills.stagingId, pendingSkills.picked)) {
        setPendingSkills(null);
        setGitOpen(false);
        setGitUrl("");
      }
    } catch (err) {
      toast(apiMsg(err));
    } finally {
      setSrcBusy(false);
    }
  };

  /* ── filesystem validation (container) ────────────────────────────────── */

  const fsPaths = [
    ...(sessionFs ? [sessionMount] : []),
    ...s3Mounts.map((m) => m.path),
    ...efsMounts.map((m) => m.path),
  ];
  const fsValid =
    method !== "container" ||
    ((!sessionFs || MOUNT_RE.test(sessionMount)) &&
      [...s3Mounts, ...efsMounts].every((m) => m.arn.trim().length > 0 && MOUNT_RE.test(m.path)) &&
      new Set(fsPaths).size === fsPaths.length &&
      (!byoMounts || (splitIds(vpcSubnets).length > 0 && splitIds(vpcSgs).length > 0)));

  const configValid =
    /^[a-z][a-z0-9-]{2,47}$/.test(name) && systemPrompt.trim().length > 0 && fsValid;

  return (
    <section>
      <ViewHead kicker={t("create.kicker")} title={t("create.title")} meta={t("create.meta")} />

      <div className="steps">
        {([1, 2, 3] as const).map((n) => (
          <div key={n} className={`step${step === n ? " now" : step > n ? " done" : ""}`}>
            <span className="n">{step > n ? "✓" : `0${n}`}</span>
            <b>{t(`create.steps.${n}`)}</b>
          </div>
        ))}
      </div>

      {step === 1 && (
        <>
          <div className="methods">
            <div
              className={`method${method === "harness" ? " sel" : ""}`}
              style={{ "--i": 0 } as CSSProperties}
              onClick={() => setMethod("harness")}
              data-method="harness"
            >
              <div className="m-badge">{t("create.methods.harness.badge")}</div>
              <div className="m-icon">◇</div>
              <h3>{t("create.methods.harness.title")}</h3>
              <p>{t("create.methods.harness.desc")}</p>
              <div className="m-specs">
                <span>CreateHarness · InvokeHarness</span>
                <span>{t("create.methods.harness.spec2")}</span>
                <span>{t("create.methods.harness.spec3")}</span>
              </div>
            </div>
            <div
              className={`method${method === "container" ? " sel" : ""}`}
              style={{ "--i": 1 } as CSSProperties}
              onClick={() => setMethod("container")}
              data-method="container"
            >
              <div className="m-badge">{t("create.methods.claudeSdk.badge")}</div>
              <div className="m-icon">▣</div>
              <h3>{t("create.methods.claudeSdk.title")}</h3>
              <p>{t("create.methods.claudeSdk.desc")}</p>
              <div className="m-specs">
                <span>CodeBuild → ECR → Runtime</span>
                <span>CLAUDE_CODE_USE_BEDROCK=1</span>
                <span>{t("create.methods.claudeSdk.spec3")}</span>
              </div>
            </div>
            <div
              className={`method${method === "zip_runtime" ? " sel" : ""}`}
              style={{ "--i": 2 } as CSSProperties}
              onClick={() => setMethod("zip_runtime")}
              data-method="zip_runtime"
            >
              <div className="m-badge">{t("create.methods.studio.badge")}</div>
              <div className="m-icon">⬡</div>
              <h3>{t("create.methods.studio.title")}</h3>
              <p>{t("create.methods.studio.desc")}</p>
              <div className="m-specs">
                <span>pip (arm64) → zip → S3 → Runtime</span>
                <span>{t("create.methods.studio.spec2")}</span>
                <span>{t("create.methods.studio.spec3")}</span>
              </div>
              <Link
                className="studio-link"
                to="/create/studio"
                onClick={(e) => e.stopPropagation()}
              >
                {t("create.methods.studio.open")}
              </Link>
            </div>
          </div>
          <div style={{ display: "flex", justifyContent: "flex-end" }}>
            <Btn primary onClick={() => setStep(2)}>
              {t("create.next")} ▸
            </Btn>
          </div>

          <div style={{ height: 18 }} />
          <AgentList
            agents={agents}
            onEdit={(a) =>
              a.method === "studio" ? navigate(`/create/studio?agent=${a.id}`) : startEdit(a)
            }
            onDetails={openDetails}
            onDelete={(id, name) => setConfirm({ kind: "delete", id, name })}
          />
        </>
      )}

      {step === 2 && (
        <div className="cfg-grid">
          <Panel
            brk
            title={t(
              method === "harness"
                ? "create.configure.title"
                : method === "container"
                  ? "create.configure.titleContainer"
                  : "create.configure.titleZip",
            )}
            sub={
              name
                ? method === "harness"
                  ? `harnessName: ${name.replace(/-/g, "_")}`
                  : `runtime: ${name.replace(/-/g, "_")}_*`
                : undefined
            }
            style={{ "--i": 0 } as CSSProperties}
          >
            {editing && (
              <div className="note" style={{ borderColor: "var(--amber)", marginBottom: 12 }}>
                <span className="i" style={{ color: "var(--amber)" }}>
                  [⟳]
                </span>
                <span>{t("create.editing", { name: editing.name })}</span>
              </div>
            )}
            <div className="field">
              <label htmlFor="agent-name">{t("create.configure.name")}</label>
              <input
                id="agent-name"
                className="input"
                value={name}
                disabled={!!editing}
                onChange={(e) => setName(e.target.value)}
                placeholder="hr-assistant-v3"
              />
            </div>
            <div className="field">
              <label htmlFor="agent-model">{t("create.configure.model")}</label>
              <input
                id="agent-model"
                className="input mono"
                value={modelId}
                onChange={(e) => setModelId(e.target.value)}
              />
            </div>
            <div className="field">
              <label htmlFor="agent-prompt">{t("create.configure.systemPrompt")}</label>
              <textarea
                id="agent-prompt"
                className="input mono"
                style={{ minHeight: 88, resize: "vertical" }}
                value={systemPrompt}
                onChange={(e) => setSystemPrompt(e.target.value)}
                placeholder={t("create.configure.systemPromptPlaceholder")}
              />
            </div>
            <div className="field">
              <label>
                {method === "harness"
                  ? t("create.configure.tools")
                  : method === "container"
                    ? t("create.configure.sdkTools")
                    : t("create.configure.templateTools")}
              </label>
              <div className="selchips">
                {method === "harness" ? (
                  <>
                    {BUILTIN_TOOLS.map((tool) => (
                      <button
                        key={tool}
                        type="button"
                        className={`selchip${tools.includes(tool) ? " on" : ""}`}
                        style={{ cursor: "pointer" }}
                        onClick={() => toggleTool(tool)}
                      >
                        {tool} · builtin {tools.includes(tool) ? "✓" : "+"}
                      </button>
                    ))}
                    {gatewayTargets.map((target) => (
                      <button
                        key={target}
                        type="button"
                        className={`selchip${selectedGateway.includes(target) ? " on" : ""}`}
                        style={{ cursor: "pointer" }}
                        onClick={() =>
                          setSelectedGateway((prev) =>
                            prev.includes(target)
                              ? prev.filter((x) => x !== target)
                              : [...prev, target],
                          )
                        }
                      >
                        {target} · gateway {selectedGateway.includes(target) ? "✓" : "+"}
                      </button>
                    ))}
                    {remoteMcp.map((server) => (
                      <button
                        key={server.name}
                        type="button"
                        className={`selchip${selectedMcp.includes(server.name) ? " on" : ""}`}
                        style={{ cursor: "pointer" }}
                        title={server.url}
                        onClick={() =>
                          setSelectedMcp((prev) =>
                            prev.includes(server.name)
                              ? prev.filter((x) => x !== server.name)
                              : [...prev, server.name],
                          )
                        }
                      >
                        {server.name} · mcp {selectedMcp.includes(server.name) ? "✓" : "+"}
                      </button>
                    ))}
                  </>
                ) : method === "container" ? (
                  <>
                    <span className="selchip on">Task · subagents ✓</span>
                    {remoteMcp.map((server) => (
                      <button
                        key={server.name}
                        type="button"
                        className={`selchip${selectedMcp.includes(server.name) ? " on" : ""}`}
                        style={{ cursor: "pointer" }}
                        title={server.url}
                        onClick={() =>
                          setSelectedMcp((prev) =>
                            prev.includes(server.name)
                              ? prev.filter((x) => x !== server.name)
                              : [...prev, server.name],
                          )
                        }
                      >
                        {server.name} · mcp {selectedMcp.includes(server.name) ? "✓" : "+"}
                      </button>
                    ))}
                  </>
                ) : (
                  <>
                    <span className="selchip on">calculator · template ✓</span>
                    <span className="selchip on">current_utc_time · template ✓</span>
                  </>
                )}
                {method !== "harness" && (
                  <span className="selchip" style={{ opacity: 0.5 }}>
                    {t("create.configure.gatewayToolsSoon")}
                  </span>
                )}
              </div>
            </div>
            {method === "container" && (
              <div className="field">
                <label htmlFor="agent-mcp">{t("create.configure.mcpServers")}</label>
                <textarea
                  id="agent-mcp"
                  className="input mono"
                  style={{ minHeight: 56, resize: "vertical" }}
                  value={mcpServers}
                  onChange={(e) => setMcpServers(e.target.value)}
                  placeholder='{"docs": {"command": "uvx", "args": ["mcp-server-docs"]}}'
                />
              </div>
            )}
            {(method === "harness" || method === "container") && (
              <div className="field">
                <label>{t("create.configure.skills")}</label>
                <div className="selchips">
                  {skillCatalog.map((skill) => (
                    <button
                      key={skill.path}
                      type="button"
                      className={`selchip${skills.includes(skill.path) ? " on" : ""}`}
                      style={{ cursor: "pointer" }}
                      title={skill.description || skill.path}
                      onClick={() =>
                        setSkills((prev) =>
                          prev.includes(skill.path)
                            ? prev.filter((s) => s !== skill.path)
                            : [...prev, skill.path],
                        )
                      }
                    >
                      {skill.name} · skill {skills.includes(skill.path) ? "✓" : "+"}
                    </button>
                  ))}
                  {skills
                    .filter((path) => !skillCatalog.some((s) => s.path === path))
                    .map((path) => {
                      const custom = customSkills.find((c) => c.path === path);
                      return (
                        <button
                          key={path}
                          type="button"
                          className="selchip on"
                          style={{ cursor: "pointer" }}
                          title={path}
                          onClick={() => {
                            setSkills((prev) => prev.filter((s) => s !== path));
                            setCustomSkills((prev) => prev.filter((c) => c.path !== path));
                          }}
                        >
                          {custom
                            ? `${custom.name} · custom ✕`
                            : `${skillNameFromPath(path)} · registry ✕`}
                        </button>
                      );
                    })}
                  <button
                    type="button"
                    className="selchip"
                    style={{ cursor: "pointer" }}
                    disabled={srcBusy}
                    onClick={() => skillFileRef.current?.click()}
                  >
                    ⬆ {t("create.configure.skillsUploadZip")}
                  </button>
                  <button
                    type="button"
                    className={`selchip${gitOpen ? " on" : ""}`}
                    style={{ cursor: "pointer" }}
                    disabled={srcBusy}
                    onClick={() => setGitOpen((v) => !v)}
                  >
                    ⇣ {t("create.configure.skillsFromGit")}
                  </button>
                  <input
                    ref={skillFileRef}
                    type="file"
                    accept=".zip"
                    style={{ display: "none" }}
                    onChange={(e) => {
                      const file = e.target.files?.[0];
                      e.target.value = "";
                      if (file) void inspectSource(file);
                    }}
                  />
                </div>
                {gitOpen && (
                  <div style={{ display: "flex", gap: 8, marginTop: 8 }}>
                    <input
                      className="input mono"
                      style={{ flex: 1 }}
                      value={gitUrl}
                      onChange={(e) => setGitUrl(e.target.value)}
                      placeholder="https://github.com/org/repo[/subdir][@ref]"
                    />
                    <Btn
                      disabled={srcBusy || !gitUrl.trim().startsWith("https://")}
                      onClick={() => void inspectSource({ url: gitUrl.trim() })}
                    >
                      {srcBusy ? "…" : t("create.configure.skillsGitFetch")}
                    </Btn>
                  </div>
                )}
                {pendingSkills && (
                  <div style={{ marginTop: 8 }}>
                    <label>{t("create.configure.skillsPending")}</label>
                    <div className="selchips">
                      {pendingSkills.skills.map((s) => (
                        <button
                          key={s.index}
                          type="button"
                          className={`selchip${pendingSkills.picked.includes(s.index) ? " on" : ""}`}
                          style={{ cursor: s.valid ? "pointer" : "not-allowed", opacity: s.valid ? 1 : 0.4 }}
                          title={s.valid ? s.description : s.errors.join("; ")}
                          disabled={!s.valid}
                          onClick={() =>
                            setPendingSkills((prev) =>
                              prev && {
                                ...prev,
                                picked: prev.picked.includes(s.index)
                                  ? prev.picked.filter((i) => i !== s.index)
                                  : [...prev.picked, s.index],
                              },
                            )
                          }
                        >
                          {s.name} {pendingSkills.picked.includes(s.index) ? "✓" : "+"}
                        </button>
                      ))}
                      <Btn
                        disabled={srcBusy || pendingSkills.picked.length === 0}
                        onClick={() => void attachPicked()}
                      >
                        {t("create.configure.skillsAttach", { n: pendingSkills.picked.length })}
                      </Btn>
                      <Btn onClick={() => setPendingSkills(null)}>✕</Btn>
                    </div>
                  </div>
                )}
              </div>
            )}
            <div className="field" data-testid="kb-picker">
              <label>{t("create.configure.kbLabel")}</label>
              <div className="selchips">
                {method === "harness" ? (
                  <>
                    {activeKbs.map((kb) => (
                      <button
                        key={kb.kb_id}
                        type="button"
                        className={`selchip${selectedKbs.includes(kb.kb_id) ? " on" : ""}`}
                        style={{ cursor: "pointer" }}
                        title={kb.description || kb.name}
                        onClick={() => toggleKb(kb.kb_id)}
                      >
                        {kb.name} · kb {selectedKbs.includes(kb.kb_id) ? "✓" : "+"}
                      </button>
                    ))}
                    {selectedKbs
                      .filter((id) => !activeKbs.some((k) => k.kb_id === id))
                      .map((id) => {
                        const info = kbInfo(id);
                        return (
                          <button
                            key={id}
                            type="button"
                            className="selchip on"
                            style={{ cursor: "pointer" }}
                            title={info.description || info.name}
                            onClick={() => toggleKb(id)}
                          >
                            {info.name} · kb ✓
                          </button>
                        );
                      })}
                    {activeKbs.length === 0 && selectedKbs.length === 0 && (
                      <span className="selchip" style={{ opacity: 0.5 }}>
                        {t("create.configure.kbEmpty")}
                      </span>
                    )}
                  </>
                ) : (
                  <span className="selchip" style={{ opacity: 0.5 }}>
                    {t("create.configure.kbSoon")}
                  </span>
                )}
              </div>
              {method === "harness" && (
                <div className="note" style={{ marginTop: 8 }}>
                  <span className="i">[i]</span>
                  <span>{t("create.configure.kbNote")}</span>
                </div>
              )}
            </div>
            {method === "container" && (
              <div className="field" data-testid="fs-config">
                <label>{t("create.configure.filesystem")}</label>
                <div className="selchips">
                  <button
                    type="button"
                    className={`selchip${sessionFs ? " on" : ""}`}
                    style={{ cursor: "pointer" }}
                    onClick={() => setSessionFs((v) => !v)}
                  >
                    {t("create.configure.fsSession")} {sessionFs ? "✓" : "+"}
                  </button>
                  <button
                    type="button"
                    className="selchip"
                    style={{ cursor: "pointer", opacity: s3Mounts.length >= 2 ? 0.4 : 1 }}
                    disabled={s3Mounts.length >= 2}
                    onClick={() => setS3Mounts((prev) => [...prev, { arn: "", path: "" }])}
                  >
                    {t("create.configure.fsAddS3")}
                  </button>
                  <button
                    type="button"
                    className="selchip"
                    style={{ cursor: "pointer", opacity: efsMounts.length >= 2 ? 0.4 : 1 }}
                    disabled={efsMounts.length >= 2}
                    onClick={() => setEfsMounts((prev) => [...prev, { arn: "", path: "" }])}
                  >
                    {t("create.configure.fsAddEfs")}
                  </button>
                </div>
                {sessionFs && (
                  <input
                    className="input mono"
                    style={{ marginTop: 8 }}
                    value={sessionMount}
                    onChange={(e) => setSessionMount(e.target.value)}
                    placeholder={DEFAULT_SESSION_MOUNT}
                    aria-label={t("create.configure.fsSessionMount")}
                  />
                )}
                {[
                  { kind: "s3" as const, rows: s3Mounts, set: setS3Mounts },
                  { kind: "efs" as const, rows: efsMounts, set: setEfsMounts },
                ].map(({ kind, rows, set }) =>
                  rows.map((row, i) => (
                    <div key={`${kind}-${i}`} style={{ display: "flex", gap: 8, marginTop: 8 }}>
                      <span className="selchip on" style={{ alignSelf: "center" }}>
                        {kind === "s3" ? "S3 FILES" : "EFS"}
                      </span>
                      <input
                        className="input mono"
                        style={{ flex: 2 }}
                        value={row.arn}
                        onChange={(e) =>
                          set((prev) =>
                            prev.map((r, j) => (j === i ? { ...r, arn: e.target.value } : r)),
                          )
                        }
                        placeholder={t(
                          kind === "s3"
                            ? "create.configure.fsS3ArnPlaceholder"
                            : "create.configure.fsEfsArnPlaceholder",
                        )}
                      />
                      <input
                        className="input mono"
                        style={{ flex: 1 }}
                        value={row.path}
                        onChange={(e) =>
                          set((prev) =>
                            prev.map((r, j) => (j === i ? { ...r, path: e.target.value } : r)),
                          )
                        }
                        placeholder="/mnt/data"
                      />
                      <Btn onClick={() => set((prev) => prev.filter((_, j) => j !== i))}>✕</Btn>
                    </div>
                  )),
                )}
                {byoMounts && (
                  <div style={{ marginTop: 8 }}>
                    <label>{t("create.configure.fsVpc")}</label>
                    <div style={{ display: "flex", gap: 8 }}>
                      <input
                        className="input mono"
                        style={{ flex: 1 }}
                        value={vpcSubnets}
                        onChange={(e) => setVpcSubnets(e.target.value)}
                        placeholder="subnet-0abc, subnet-0def"
                        aria-label={t("create.configure.fsSubnets")}
                      />
                      <input
                        className="input mono"
                        style={{ flex: 1 }}
                        value={vpcSgs}
                        onChange={(e) => setVpcSgs(e.target.value)}
                        placeholder="sg-0abc"
                        aria-label={t("create.configure.fsSgs")}
                      />
                    </div>
                  </div>
                )}
                <div className="note" style={{ marginTop: 8 }}>
                  <span className="i">[i]</span>
                  <span>
                    {byoMounts ? t("create.configure.fsNoteByo") : t("create.configure.fsNote")}
                  </span>
                </div>
              </div>
            )}
            <div className="field">
              <label>{t("create.configure.memory")}</label>
              <div className="selchips">
                <span className="selchip on">{t("create.configure.memoryShort")} ✓</span>
                <button
                  type="button"
                  className={`selchip${longTerm ? " on" : ""}`}
                  style={{ cursor: "pointer" }}
                  onClick={() => setLongTerm((v) => !v)}
                >
                  {t("create.configure.memoryLong")} {longTerm ? "✓" : "+"}
                </button>
              </div>
            </div>
            <div className="note">
              <span className="i">[i]</span>
              <span>{t("create.configure.note")}</span>
            </div>
          </Panel>

          <div>
            <Panel
              title={t(editing ? "create.republishPanel.title" : "create.launchPanel.title")}
              sub={t(editing ? "create.republishPanel.sub" : "create.launchPanel.sub")}
            >
              <div className="kv">
                <span className="k">{t("create.launchPanel.sharedInfra")}</span>
                <span className="v">CDK · launchpad-base ✓</span>
              </div>
              <div className="kv">
                <span className="k">{t("create.launchPanel.agentResources")}</span>
                <span className="v">{t("create.launchPanel.agentResourcesV")}</span>
              </div>
              <div className="kv">
                <span className="k">
                  {t(editing ? "create.republishPanel.effect" : "create.launchPanel.onSuccess")}
                </span>
                <span className="v">
                  {t(editing ? "create.republishPanel.effectV" : "create.launchPanel.onSuccessV")}
                </span>
              </div>
            </Panel>
            <div style={{ height: 14 }} />
            {submitError && (
              <div className="note" style={{ borderColor: "var(--crit)", marginBottom: 14 }}>
                <span className="i" style={{ color: "var(--crit)" }}>
                  [✕]
                </span>
                <span>{submitError}</span>
              </div>
            )}
            <Panel>
              <div style={{ display: "flex", gap: 10, justifyContent: "flex-end" }}>
                <Btn
                  onClick={() => {
                    setStep(1);
                    resetForm();
                  }}
                >
                  ◂ {t("create.back")}
                </Btn>
                <Btn
                  primary
                  disabled={!configValid}
                  onClick={() => (editing ? setConfirm({ kind: "republish" }) : void submit())}
                >
                  {editing ? `⟳ ${t("create.republish")}` : `▲ ${t("create.launch")}`}
                </Btn>
              </div>
            </Panel>
          </div>
        </div>
      )}

      {step === 3 && (
        <>
          <LaunchSequence
            deployment={deployment}
            job={job}
            agentStatus={agentStatus}
            detailsMode={detailsMode}
            onRestart={() => {
              setStep(1);
              setLaunch(null);
              setDeployment(null);
              setJob(null);
              resetForm();
              reloadAgents();
            }}
          />
          {detailKbs.length > 0 && (
            <>
              <div style={{ height: 14 }} />
              <Panel title={t("create.configure.kbMountedTitle")}>
                <div className="selchips">
                  {detailKbs.map((kb) => (
                    <span key={kb.kb_id} className="selchip on" title={kb.description || kb.name}>
                      {kb.name} · kb
                    </span>
                  ))}
                </div>
              </Panel>
            </>
          )}
        </>
      )}

      <ConfirmDialog
        open={confirm?.kind === "republish"}
        title={t("create.republishConfirm.title")}
        body={t("create.republishConfirm.body", { name })}
        confirmLabel={t("create.republish")}
        onConfirm={() => {
          setConfirm(null);
          void submit();
        }}
        onCancel={() => setConfirm(null)}
      />
      <ConfirmDialog
        open={confirm?.kind === "delete"}
        title={t("create.list.confirmDeleteTitle")}
        body={t("create.list.confirmDelete", {
          name: confirm?.kind === "delete" ? confirm.name : "",
        })}
        confirmLabel={t("create.list.delete")}
        onConfirm={() => {
          if (confirm?.kind === "delete") void doDelete(confirm.id);
          setConfirm(null);
        }}
        onCancel={() => setConfirm(null)}
      />
    </section>
  );
}

const STATUS_TONE: Record<string, "good" | "warn" | "crit" | "muted"> = {
  active: "good",
  deploying: "warn",
  failed: "crit",
};

function AgentList({
  agents,
  onEdit,
  onDetails,
  onDelete,
}: {
  agents: AgentInfo[];
  onEdit: (a: AgentInfo) => void;
  onDetails: (a: AgentInfo) => void;
  onDelete: (id: string, name: string) => void;
}) {
  const { t } = useTranslation();
  return (
    <Panel title={t("create.list.title")} sub={t("create.list.sub")} pad={false}>
      <table>
        <thead>
          <tr>
            <th>{t("create.list.colName")}</th>
            <th>{t("create.list.colMethod")}</th>
            <th>{t("create.list.colStatus")}</th>
            <th>{t("create.list.colRev")}</th>
            <th>{t("create.list.colUpdated")}</th>
            <th style={{ textAlign: "right" }}>{t("create.list.colActions")}</th>
          </tr>
        </thead>
        <tbody>
          {agents.map((a) => (
            <tr key={a.id}>
              <td className="pri">{a.name}</td>
              <td className="mono dim">{a.method}</td>
              <td>
                <Chip
                  tone={STATUS_TONE[a.status] ?? "muted"}
                  icon={a.status === "active" ? "●" : a.status === "failed" ? "✕" : "◐"}
                >
                  {t(`status.${a.status}`, a.status.toUpperCase())}
                </Chip>
              </td>
              <td className="mono">{a.revision ?? "—"}</td>
              <td className="mono dim">{(a.updated_at ?? "").replace("T", " ").slice(0, 16)}</td>
              <td>
                <div style={{ display: "flex", gap: 6, justifyContent: "flex-end", flexWrap: "wrap" }}>
                  <button
                    type="button"
                    className="rowact"
                    disabled={a.status === "deploying"}
                    style={a.status === "deploying" ? { opacity: 0.35 } : undefined}
                    onClick={() => onEdit(a)}
                  >
                    {t("create.list.edit")}
                  </button>
                  {a.status === "active" && (
                    <Link className="rowact" to={`/chat?agent=${a.id}`}>
                      {t("create.list.chat")}
                    </Link>
                  )}
                  {a.deployment && (
                    <button type="button" className="rowact" onClick={() => onDetails(a)}>
                      {t("create.list.details")}
                    </button>
                  )}
                  <button
                    type="button"
                    className="rowact"
                    onClick={() => onDelete(a.id, a.name)}
                  >
                    {t("create.list.delete")}
                  </button>
                </div>
              </td>
            </tr>
          ))}
          {agents.length === 0 && (
            <tr>
              <td colSpan={6} className="dim mono" style={{ textAlign: "center" }}>
                {t("create.list.empty")}
              </td>
            </tr>
          )}
        </tbody>
      </table>
    </Panel>
  );
}

