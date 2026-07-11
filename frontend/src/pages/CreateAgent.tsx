import type { CSSProperties } from "react";
import { useCallback, useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { Link, useNavigate, useSearchParams } from "react-router-dom";

import { Btn, Chip, ConfirmDialog, LaunchSequence, Panel, useToast, ViewHead } from "../components";
import type { AgentInfo, DeploymentInfo, JobInfo } from "../lib/api";
import { api, ApiError } from "../lib/api";

const DEFAULT_MODEL = "global.anthropic.claude-sonnet-4-6";
const BUILTIN_TOOLS = ["code-interpreter", "browser"] as const;

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
  memory?: { long_term?: boolean };
  env?: Record<string, string>;
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
  const [longTerm, setLongTerm] = useState(true);
  const [mcpServers, setMcpServers] = useState("");
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
    setSkills([]);
    setLongTerm(true);
    setMcpServers("");
    setSubmitError(null);
  };

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
        : [],
    memory: { short_term: true, long_term: longTerm },
    ...(method === "harness" && skills.length ? { skills } : {}),
    ...(method === "container" && mcpServers.trim()
      ? { env: { LAUNCHPAD_MCP_SERVERS: mcpServers.trim() } }
      : {}),
  });

  const submit = async () => {
    setSubmitError(null);
    try {
      const spec = buildSpec();
      const res = editing
        ? await api.redeployAgent(editing.id, spec)
        : await api.createAgent(spec);
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
    setSkills(spec.skills ?? []);
    setLongTerm(spec.memory?.long_term ?? true);
    setMcpServers(spec.env?.LAUNCHPAD_MCP_SERVERS ?? "");
    setSubmitError(null);
    setStep(2);
  };

  const openDetails = (agent: AgentInfo) => {
    const jobId = agent.deployment?.job_id;
    if (!jobId) return;
    setEditing(null);
    setDetailsMode(true);
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

  const configValid = /^[a-z][a-z0-9-]{2,47}$/.test(name) && systemPrompt.trim().length > 0;

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
                    <span className="selchip on">fact-checker · .claude/agents ✓</span>
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
            {method === "harness" && (skillCatalog.length > 0 || skills.length > 0) && (
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
                    .map((skill) => (
                      <button
                        key={skill}
                        type="button"
                        className="selchip on"
                        style={{ cursor: "pointer" }}
                        onClick={() => setSkills((prev) => prev.filter((s) => s !== skill))}
                      >
                        {skill} · registry ✕
                      </button>
                    ))}
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

