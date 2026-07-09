import type { CSSProperties } from "react";
import { useCallback, useEffect, useState } from "react";
import { useTranslation } from "react-i18next";

import { Btn, Chip, Panel, ViewHead } from "../components";
import type { DeploymentInfo, JobInfo, StageInfo } from "../lib/api";
import { api, ApiError } from "../lib/api";

const DEFAULT_MODEL = "global.anthropic.claude-sonnet-4-6";
const BUILTIN_TOOLS = ["code-interpreter", "browser"] as const;
type StageKey = "generate" | "package" | "provision" | "deploy" | "register";

type Step = 1 | 2 | 3;

interface LaunchState {
  agentId: string;
  jobId: string;
}

export function CreateAgent() {
  const { t } = useTranslation();
  const [step, setStep] = useState<Step>(1);
  const [name, setName] = useState("");
  const [modelId, setModelId] = useState(DEFAULT_MODEL);
  const [systemPrompt, setSystemPrompt] = useState("");
  const [tools, setTools] = useState<string[]>([]);
  const [longTerm, setLongTerm] = useState(true);
  const [submitError, setSubmitError] = useState<string | null>(null);
  const [launch, setLaunch] = useState<LaunchState | null>(null);
  const [deployment, setDeployment] = useState<DeploymentInfo | null>(null);
  const [job, setJob] = useState<JobInfo | null>(null);
  const [agentStatus, setAgentStatus] = useState<string>("deploying");

  const poll = useCallback(async () => {
    if (!launch) return;
    try {
      const agent = await api.getAgent(launch.agentId);
      setAgentStatus(agent.status);
      setDeployment(agent.deployments?.[0] ?? null);
      setJob(await api.getJob(launch.jobId));
    } catch {
      /* transient poll errors are retried on the next tick */
    }
  }, [launch]);

  useEffect(() => {
    if (!launch || agentStatus === "active" || agentStatus === "failed") return;
    void poll();
    const timer = setInterval(() => void poll(), 2000);
    return () => clearInterval(timer);
  }, [launch, agentStatus, poll]);

  const submit = async () => {
    setSubmitError(null);
    try {
      const res = await api.createAgent({
        name,
        method: "harness",
        model_id: modelId,
        system_prompt: systemPrompt,
        tools: tools.map((n) => ({ type: "builtin", name: n })),
        memory: { short_term: true, long_term: longTerm },
      });
      setLaunch({ agentId: res.agent.id, jobId: res.job_id });
      setAgentStatus("deploying");
      setStep(3);
    } catch (err) {
      setSubmitError(
        err instanceof ApiError ? t(`apiErrors.${err.code}`, err.message) : String(err),
      );
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
          <div
            key={n}
            className={`step${step === n ? " now" : step > n ? " done" : ""}`}
          >
            <span className="n">{step > n ? "✓" : `0${n}`}</span>
            <b>{t(`create.steps.${n}`)}</b>
          </div>
        ))}
      </div>

      {step === 1 && (
        <>
          <div className="methods">
            <div className="method sel" style={{ "--i": 0 } as CSSProperties}>
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
            <div className="method" style={{ opacity: 0.55, "--i": 1 } as CSSProperties}>
              <div className="m-badge plain">{t("create.methods.claudeSdk.badge")}</div>
              <div className="m-icon">▣</div>
              <h3>{t("create.methods.claudeSdk.title")}</h3>
              <p>{t("create.methods.claudeSdk.desc")}</p>
              <div className="m-specs">
                <span>CodeBuild → ECR → Runtime</span>
                <span>CLAUDE_CODE_USE_BEDROCK=1</span>
              </div>
            </div>
            <div className="method" style={{ opacity: 0.55, "--i": 2 } as CSSProperties}>
              <div className="m-badge plain">{t("create.methods.studio.badge")}</div>
              <div className="m-icon">⬡</div>
              <h3>{t("create.methods.studio.title")}</h3>
              <p>{t("create.methods.studio.desc")}</p>
              <div className="m-specs">
                <span>pip (arm64) → zip → S3 → Runtime</span>
                <span>{t("create.methods.studio.spec2")}</span>
              </div>
            </div>
          </div>
          <div style={{ display: "flex", justifyContent: "flex-end" }}>
            <Btn primary onClick={() => setStep(2)}>
              {t("create.next")} ▸
            </Btn>
          </div>
        </>
      )}

      {step === 2 && (
        <div className="cfg-grid">
          <Panel
            brk
            title={t("create.configure.title")}
            sub={name ? `harnessName: ${name.replace(/-/g, "_")}` : undefined}
            style={{ "--i": 0 } as CSSProperties}
          >
            <div className="field">
              <label htmlFor="agent-name">{t("create.configure.name")}</label>
              <input
                id="agent-name"
                className="input"
                value={name}
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
              <label>{t("create.configure.tools")}</label>
              <div className="selchips">
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
                <span className="selchip" style={{ opacity: 0.5 }}>
                  {t("create.configure.gatewayToolsSoon")}
                </span>
              </div>
            </div>
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
            <Panel title={t("create.launchPanel.title")} sub={t("create.launchPanel.sub")}>
              <div className="kv">
                <span className="k">{t("create.launchPanel.sharedInfra")}</span>
                <span className="v">CDK · launchpad-base ✓</span>
              </div>
              <div className="kv">
                <span className="k">{t("create.launchPanel.agentResources")}</span>
                <span className="v">{t("create.launchPanel.agentResourcesV")}</span>
              </div>
              <div className="kv">
                <span className="k">{t("create.launchPanel.onSuccess")}</span>
                <span className="v">{t("create.launchPanel.onSuccessV")}</span>
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
                <Btn onClick={() => setStep(1)}>◂ {t("create.back")}</Btn>
                <Btn primary disabled={!configValid} onClick={() => void submit()}>
                  ▲ {t("create.launch")}
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
          onRestart={() => {
            setStep(1);
            setLaunch(null);
            setDeployment(null);
            setJob(null);
            setName("");
            setSystemPrompt("");
            setTools([]);
          }}
        />
      )}
    </section>
  );
}

function stageClass(stage: StageInfo): string {
  if (stage.status === "succeeded" || stage.status === "skipped") return " done";
  if (stage.status === "running") return " now";
  if (stage.status === "failed") return " fail";
  return "";
}

function stageNode(stage: StageInfo, index: number): string {
  if (stage.status === "succeeded" || stage.status === "skipped") return "✓";
  if (stage.status === "running") return "●";
  if (stage.status === "failed") return "✕";
  return String(index + 1);
}

function LaunchSequence({
  deployment,
  job,
  agentStatus,
  onRestart,
}: {
  deployment: DeploymentInfo | null;
  job: JobInfo | null;
  agentStatus: string;
  onRestart: () => void;
}) {
  const { t } = useTranslation();
  const stages = deployment?.stages ?? [];
  return (
    <div className="cfg-grid">
      <Panel
        brk
        title={t("create.sequence.title")}
        sub={job ? `job #${job.id.slice(0, 8)}` : undefined}
        end={
          agentStatus === "active" ? (
            <Chip tone="good" icon="●">
              {t("status.active")}
            </Chip>
          ) : agentStatus === "failed" ? (
            <Chip tone="crit" icon="✕">
              {t("status.failed")}
            </Chip>
          ) : (
            <Chip tone="warn" icon="◐">
              {t("status.deploying")}
            </Chip>
          )
        }
        pad={false}
      >
        <div className="pipeline">
          {stages.map((s, i) => (
            <div key={s.name} className={`pstage${stageClass(s)}`}>
              <div className="node">{stageNode(s, i)}</div>
              <div className="pn">{t(`create.stages.${s.name as StageKey}`)}</div>
              <div className="pt">{s.detail || "—"}</div>
            </div>
          ))}
        </div>
        {job?.error && (
          <div className="pbody" style={{ paddingTop: 0 }}>
            <div className="note" style={{ borderColor: "var(--crit)" }}>
              <span className="i" style={{ color: "var(--crit)" }}>
                [✕]
              </span>
              <span className="mono">{job.error}</span>
            </div>
          </div>
        )}
      </Panel>

      <div>
        <Panel title={t("create.sequence.logTitle")} pad={false}>
          <div
            className="code"
            style={{ border: 0, maxHeight: 320, overflowY: "auto", margin: 0 }}
            data-testid="job-log"
          >
            {(job?.events ?? []).map((e, i) => (
              <div key={i}>
                <span className="cm">{e.ts.slice(11, 19)}</span>{" "}
                <span className={e.level === "error" ? "k1" : "k2"}>{e.stage}</span> {e.msg}
              </div>
            ))}
            {!job?.events?.length && <span className="cm">{t("create.sequence.waiting")}</span>}
          </div>
        </Panel>
        <div style={{ height: 14 }} />
        <Panel>
          <div style={{ display: "flex", gap: 10, justifyContent: "flex-end" }}>
            <Btn onClick={onRestart}>{t("create.sequence.newAgent")}</Btn>
          </div>
        </Panel>
      </div>
    </div>
  );
}
