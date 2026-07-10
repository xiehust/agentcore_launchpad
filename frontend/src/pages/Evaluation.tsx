import type { CSSProperties } from "react";
import { useCallback, useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { useSearchParams } from "react-router-dom";

import { Btn, Chip, ConfirmDialog, Panel, useToast, ViewHead } from "../components";
import type { AgentInfo } from "../lib/api";
import { api } from "../lib/api";

interface Dataset {
  id: string;
  name: string;
  locale: string;
  item_count: number;
}

interface EvaluatorInfo {
  id: string;
  level: string;
  source: "builtin" | "custom";
}

interface Score {
  evaluatorId: string;
  score: number;
}

interface RunInfo {
  id: string;
  agent_id: string;
  agent_name: string;
  dataset_name: string | null;
  mode: string;
  evaluators: string[];
  status: string;
  queue_position: number | null;
  scores: Score[];
  insights: {
    failures?: { category: string; percentage?: number; subCategories?: unknown[] }[];
    userIntents?: { intent?: string; userMessages?: string[] }[];
  };
  session_ids: string[];
  error: string | null;
}

const DEFAULT_EVALUATORS = ["Builtin.Correctness", "Builtin.Helpfulness"];

function ExperimentPanel({
  experiments,
  agents,
  busy,
  onAction,
  onStart,
}: {
  experiments: ExperimentInfo[];
  agents: AgentInfo[];
  busy: boolean;
  onAction: (expId: string, action: string, challengerId?: string) => Promise<void>;
  onStart: (agentId: string) => Promise<void>;
}) {
  const { t } = useTranslation();
  const exp = experiments[0] ?? null;
  const [challengerId, setChallengerId] = useState("");
  const [confirmCleanup, setConfirmCleanup] = useState(false);
  const verdict = exp?.artifacts.verdict;
  const canary = exp?.artifacts.canary;
  const canaryWeights = canary?.after_weights ?? canary?.weights;

  return (
    <Panel
      title={exp ? `EXPERIMENT ${exp.name}` : t("expPage.title")}
      sub={exp ? t("expPage.sub") : t("expPage.none")}
      end={
        exp && (
          <Chip
            tone={exp.status === "failed" ? "crit" : exp.status === "ready" ? "good" : "warn"}
            icon={exp.status === "running" ? "◐" : "●"}
          >
            {exp.stage.toUpperCase()} · {exp.status.toUpperCase()}
          </Chip>
        )
      }
      style={{ "--i": 3 } as CSSProperties}
    >
      {!exp && (
        <div style={{ display: "flex", gap: 9, alignItems: "center" }}>
          <span className="dim" style={{ fontSize: 12 }}>{t("expPage.startHint")}</span>
          <Btn
            primary
            disabled={busy || agents.length === 0}
            onClick={() => agents[0] && void onStart(agents[0].id)}
          >
            ▸ {t("expPage.start")}
          </Btn>
        </div>
      )}
      {exp && (
        <>
          {verdict?.metrics?.length ? (
            verdict.metrics.map((metric) => {
              const variant = metric.variants[0];
              const delta =
                metric.control.mean != null && variant?.mean != null
                  ? variant.mean - metric.control.mean
                  : null;
              return (
                <div className="ab-metric" key={metric.label}>
                  <div className="am-h">
                    <span>{metric.label.replace("Builtin.", "")}</span>
                    {delta != null && (
                      <span className="d">{delta >= 0 ? "+" : ""}{delta.toFixed(2)}</span>
                    )}
                  </div>
                  <div className="abbar">
                    <span className="an">CONTROL</span>
                    <div className="track">
                      <div className="fill" style={{
                        width: `${(metric.control.mean ?? 0) * 100}%`,
                        background: "var(--s1)",
                      }} />
                    </div>
                    <span className="av">{metric.control.mean?.toFixed(2) ?? "—"}</span>
                  </div>
                  <div className="abbar">
                    <span className="an">TREAT</span>
                    <div className="track">
                      <div className="fill" style={{
                        width: `${(variant?.mean ?? 0) * 100}%`,
                        background: "var(--s3)",
                      }} />
                    </div>
                    <span className="av">{variant?.mean?.toFixed(2) ?? "—"}</span>
                  </div>
                </div>
              );
            })
          ) : (
            <div className="mono dim" style={{ fontSize: 11, marginBottom: 8 }}>
              {exp.status === "running" ? t("expPage.running") : t("expPage.noMetrics")}
            </div>
          )}

          {verdict && (
            <div
              className="verdict"
              style={
                verdict.verdict.includes("insufficient")
                  ? { background: "rgba(250,178,25,.08)",
                      border: "1px solid rgba(250,178,25,.35)" }
                  : undefined
              }
            >
              <span
                className="vt"
                style={verdict.verdict.includes("insufficient")
                  ? { color: "var(--warn)" } : undefined}
              >
                ◎ {verdict.verdict.toUpperCase()}
              </span>
              <span className="vm">
                {verdict.avg_delta != null && `Δ ${verdict.avg_delta}`} · n={verdict.n ?? 0}
              </span>
              {exp.status === "ready" && !exp.artifacts.promote && (
                <Btn
                  primary
                  style={{ marginLeft: "auto" }}
                  disabled={busy}
                  onClick={() => void onAction(exp.id, "promote")}
                >
                  {t("expPage.promote")} ▸
                </Btn>
              )}
              {exp.artifacts.promote && (
                <Chip tone="good" icon="✓" style={{ marginLeft: "auto" }}>
                  {t("expPage.promoted")} · T1{" "}
                  {exp.artifacts.promote.after_weights?.T1 ?? 100}%
                </Chip>
              )}
            </div>
          )}

          <div style={{ marginTop: 14 }}>
            <div className="am-h" style={{ fontSize: 11, color: "var(--ink-3)" }}>
              <span className="mono">
                {t("expPage.canaryTitle")}
                {canary?.challenger_agent ? ` — ${canary.challenger_agent}` : ""}
              </span>
              <span className="mono">RAMP 10 → 50 → 100</span>
            </div>
            {canaryWeights ? (
              <>
                <div className="split">
                  <div style={{ flex: `0 0 ${canaryWeights.C ?? 90}%`,
                                background: "var(--s1)" }} />
                  <div style={{ flex: 1, background: "var(--s3)" }} />
                </div>
                <div className="mono dim" style={{ fontSize: 9.5 }}>
                  champion {canaryWeights.C}% · challenger {canaryWeights.T1}% — stage{" "}
                  {(canary?.ramp_stage ?? 0) + 1}/3
                </div>
                <div style={{ marginTop: 8, display: "flex", gap: 9 }}>
                  <Btn disabled={busy} onClick={() => void onAction(exp.id, "ramp")}>
                    {t("expPage.ramp")} ▸
                  </Btn>
                  <Btn disabled={busy} onClick={() => setConfirmCleanup(true)}>
                    {t("expPage.cleanup")}
                  </Btn>
                </div>
              </>
            ) : (
              <div style={{ display: "flex", gap: 9, alignItems: "center" }}>
                <select
                  className="input"
                  style={{ maxWidth: 220 }}
                  value={challengerId}
                  onChange={(e) => setChallengerId(e.target.value)}
                >
                  <option value="">{t("expPage.pickChallenger")}</option>
                  {agents
                    .filter((a) => a.id !== exp.agent_id)
                    .map((a) => (
                      <option key={a.id} value={a.id} style={{ background: "#141816" }}>
                        {a.name}
                      </option>
                    ))}
                </select>
                <Btn
                  disabled={busy || !challengerId || exp.status === "running"}
                  onClick={() => void onAction(exp.id, "canary", challengerId)}
                >
                  {t("expPage.startCanary")}
                </Btn>
              </div>
            )}
          </div>

          {exp.artifacts.cleanup && (
            <div className="code" style={{ marginTop: 10, maxHeight: 120, overflowY: "auto" }}>
              {exp.artifacts.cleanup
                .map((row) => `${row.status.padEnd(8)} ${row.category}`)
                .join("\n")}
            </div>
          )}
          <ConfirmDialog
            open={confirmCleanup}
            title={t("expPage.confirmCleanup.title")}
            body={t("expPage.confirmCleanup.body")}
            confirmLabel={t("expPage.cleanup")}
            onConfirm={() => {
              setConfirmCleanup(false);
              void onAction(exp.id, "cleanup");
            }}
            onCancel={() => setConfirmCleanup(false)}
          />
        </>
      )}
    </Panel>
  );
}

interface ABMetric {
  label: string;
  control: { mean: number | null; sampleSize: number | null };
  variants: { name: string; mean: number | null; sampleSize: number | null;
    pValue?: number | null; isSignificant?: boolean }[];
}

interface ExperimentInfo {
  id: string;
  name: string;
  agent_id: string;
  agent_name: string;
  status: string;
  stage: string;
  stages: string[];
  error: string | null;
  artifacts: {
    recommend?: { recommended_prompt: string };
    bundles?: { control: { arn: string }; treatment: { arn: string } };
    abtest?: { ab_test_id: string };
    traffic?: { sent: number; failed: number };
    verdict?: { verdict: string; avg_delta?: number; n?: number; metrics: ABMetric[] };
    promote?: { after_weights: Record<string, number> };
    canary?: {
      canary_ab_test_id: string;
      weights?: Record<string, number>;
      after_weights?: Record<string, number>;
      ramp_stage: number;
      challenger_agent?: string;
    };
    cleanup?: { category: string; status: string }[];
  };
}

export function Evaluation() {
  const { t } = useTranslation();
  const toast = useToast();
  // "?view=new" renders the New Run sub-page instead of the dashboard —
  // linkable, and the browser back button returns to the runs list.
  const [searchParams, setSearchParams] = useSearchParams();
  const creating = searchParams.get("view") === "new";
  const [agents, setAgents] = useState<AgentInfo[]>([]);
  const [datasets, setDatasets] = useState<Dataset[]>([]);
  const [evaluators, setEvaluators] = useState<EvaluatorInfo[]>([]);
  const [runs, setRuns] = useState<RunInfo[]>([]);
  const [selectedRun, setSelectedRun] = useState<RunInfo | null>(null);
  const [queueLocked, setQueueLocked] = useState(false);
  const [agentId, setAgentId] = useState("");
  const [datasetId, setDatasetId] = useState("");
  const [mode, setMode] = useState<"evaluators" | "insights">("evaluators");
  const [chosenEvaluators, setChosenEvaluators] = useState<string[]>(DEFAULT_EVALUATORS);
  const [submitError, setSubmitError] = useState<string | null>(null);
  const [experiments, setExperiments] = useState<ExperimentInfo[]>([]);
  const [expBusy, setExpBusy] = useState(false);

  const failedSeen = useRef<Set<string> | null>(null);
  const refresh = useCallback(async () => {
    try {
      const [runsRes, queueRes] = await Promise.all([
        fetch("/api/eval/runs"),
        fetch("/api/eval/queue"),
      ]);
      if (runsRes.ok) {
        const body = (await runsRes.json()) as { runs: RunInfo[] };
        const firstLoad = failedSeen.current === null;
        const seen = (failedSeen.current ??= new Set());
        body.runs.forEach((run) => {
          if (run.status !== "failed" || seen.has(run.id)) return;
          seen.add(run.id);
          if (!firstLoad) {
            toast(t("evalPage.runFailedToast", { agent: run.agent_name, msg: run.error ?? "" }));
          }
        });
        setRuns(body.runs);
        setSelectedRun(
          (prev) => body.runs.find((r) => r.id === prev?.id) ?? body.runs[0] ?? null,
        );
      }
      if (queueRes.ok) setQueueLocked(((await queueRes.json()) as { locked: boolean }).locked);
      const expRes = await fetch("/api/experiments");
      if (expRes.ok) {
        setExperiments(((await expRes.json()) as { experiments: ExperimentInfo[] }).experiments);
      }
    } catch {
      /* backend offline */
    }
  }, [t, toast]);

  useEffect(() => {
    api
      .listAgents()
      .then((res) => {
        const eligible = res.agents.filter(
          (a) => a.status === "active" && a.method !== "harness",
        );
        setAgents(eligible);
        if (eligible.length) setAgentId(eligible[0].id);
      })
      .catch(() => {});
    fetch("/api/eval/datasets")
      .then((res) => res.json())
      .then((d: { datasets: Dataset[] }) => {
        setDatasets(d.datasets);
        if (d.datasets.length) setDatasetId(d.datasets[0].id);
      })
      .catch(() => {});
    fetch("/api/eval/evaluators")
      .then((res) => res.json())
      .then((d: { evaluators: EvaluatorInfo[] }) => setEvaluators(d.evaluators))
      .catch(() => {});
    void refresh();
    const timer = setInterval(() => void refresh(), 8000);
    return () => clearInterval(timer);
  }, [refresh]);

  const startRun = async () => {
    setSubmitError(null);
    const payload =
      mode === "insights"
        ? { agent_id: agentId, mode, dataset_id: datasetId, wait_seconds: 120 }
        : {
            agent_id: agentId,
            dataset_id: datasetId,
            evaluators: chosenEvaluators,
            mode,
            wait_seconds: 120,
          };
    const res = await fetch("/api/eval/runs", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });
    if (!res.ok) {
      const body = (await res.json()) as { message?: string };
      setSubmitError(body.message ?? `http ${res.status}`);
      return;
    }
    toast(t("evalPage.newRun.submitted"));
    setSearchParams({}, { replace: true }); // back to the runs list
    void refresh();
  };

  // Contextual re-run from the dashboard: insights over the sessions a
  // completed run already produced (no re-invoke, so wait_seconds 0).
  const startInsightsOnRun = async (run: RunInfo) => {
    const res = await fetch("/api/eval/runs", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        agent_id: run.agent_id,
        mode: "insights",
        session_ids: run.session_ids,
        wait_seconds: 0,
      }),
    });
    if (!res.ok) {
      const body = (await res.json().catch(() => ({}))) as { message?: string };
      toast(t("common.actionFailed", { msg: body.message ?? `HTTP ${res.status}` }));
      return;
    }
    toast(t("evalPage.newRun.submitted"));
    void refresh();
  };

  const statusChip = (run: RunInfo) => {
    if (run.status === "completed")
      return <Chip tone="good" icon="●">{t("evalPage.status.completed")}</Chip>;
    if (run.status === "failed")
      return <Chip tone="crit" icon="✕">{t("evalPage.status.failed")}</Chip>;
    if (run.status === "queued" && (run.queue_position ?? 0) >= 1)
      return <Chip tone="muted" icon="◌">{t("evalPage.status.queued")}</Chip>;
    return <Chip tone="warn" icon="◐">{run.status.toUpperCase()}</Chip>;
  };

  const average = (run: RunInfo): string => {
    if (!run.scores.length) return "—";
    const mean = run.scores.reduce((acc, s) => acc + s.score, 0) / run.scores.length;
    return mean.toFixed(2);
  };

  // ── New Run sub-page (?view=new) ──────────────────────────────────────────
  if (creating) {
    return (
      <section>
        <ViewHead
          kicker={t("evaluation.kicker")}
          title={t("evalPage.newRun.title")}
          meta={t("evalPage.newRun.sub")}
        />
        <div style={{ marginBottom: 14 }}>
          <Btn onClick={() => setSearchParams({}, { replace: true })}>
            ◂ {t("evalPage.backToRuns")}
          </Btn>
        </div>
        <div className="eval-grid">
          <Panel
            brk
            title={t("evalPage.newRun.title")}
            sub={t("evalPage.newRun.sub")}
            style={{ "--i": 0 } as CSSProperties}
          >
            <div className="field">
              <label>{t("evalPage.newRun.mode")}</label>
              <div className="selchips">
                <button
                  type="button"
                  className={`selchip${mode === "evaluators" ? " on" : ""}`}
                  style={{ cursor: "pointer" }}
                  onClick={() => setMode("evaluators")}
                >
                  {t("evalPage.newRun.modeEvaluators")}
                </button>
                <button
                  type="button"
                  className={`selchip${mode === "insights" ? " on" : ""}`}
                  style={{ cursor: "pointer" }}
                  onClick={() => setMode("insights")}
                >
                  {t("evalPage.newRun.modeInsights")}
                </button>
              </div>
            </div>
            <div className="field">
              <label>{t("evalPage.newRun.agent")}</label>
              <select
                className="input"
                value={agentId}
                onChange={(e) => setAgentId(e.target.value)}
              >
                {agents.length === 0 && (
                  <option value="">{t("evalPage.newRun.noAgents")}</option>
                )}
                {agents.map((a) => (
                  <option key={a.id} value={a.id} style={{ background: "#141816" }}>
                    {a.name} · {a.method}
                  </option>
                ))}
              </select>
            </div>
            <div className="field">
              <label>{t("evalPage.newRun.dataset")}</label>
              <select
                className="input"
                value={datasetId}
                onChange={(e) => setDatasetId(e.target.value)}
              >
                {datasets.map((d) => (
                  <option key={d.id} value={d.id} style={{ background: "#141816" }}>
                    {d.name} · {d.item_count} ({d.locale})
                  </option>
                ))}
              </select>
            </div>
            {mode === "evaluators" ? (
              <div className="field">
                <label>{t("evalPage.newRun.evaluators")}</label>
                <div className="selchips" style={{ maxHeight: 140, overflowY: "auto" }}>
                  {evaluators
                    .filter((e) => e.source === "builtin")
                    .map((e) => (
                      <button
                        key={e.id}
                        type="button"
                        className={`selchip${chosenEvaluators.includes(e.id) ? " on" : ""}`}
                        style={{ cursor: "pointer" }}
                        onClick={() =>
                          setChosenEvaluators((prev) =>
                            prev.includes(e.id)
                              ? prev.filter((x) => x !== e.id)
                              : [...prev, e.id],
                          )
                        }
                      >
                        {e.id.replace("Builtin.", "")}
                      </button>
                    ))}
                </div>
              </div>
            ) : (
              <div className="note" style={{ marginBottom: 10 }}>
                <span className="i">[i]</span>
                <span>{t("evalPage.newRun.insightsHint")}</span>
              </div>
            )}
            {submitError && (
              <div className="note" style={{ borderColor: "var(--crit)", marginBottom: 10 }}>
                <span className="i" style={{ color: "var(--crit)" }}>[✕]</span>
                <span>{submitError}</span>
              </div>
            )}
            <div style={{ display: "flex", justifyContent: "flex-end" }}>
              <Btn
                primary
                disabled={
                  !agentId ||
                  !datasetId ||
                  (mode === "evaluators" && chosenEvaluators.length === 0)
                }
                onClick={() => void startRun()}
              >
                ▸ {t("evalPage.newRun.submit")}
              </Btn>
            </div>
          </Panel>

          <Panel
            title={t("evalPage.newRun.how.title")}
            sub={t("evalPage.newRun.how.sub")}
            style={{ "--i": 1 } as CSSProperties}
          >
            {(["s1", "s2", "s3", "s4"] as const).map((step, i) => (
              <div className="kv" key={step}>
                <span className="k mono">{`0${i + 1}`}</span>
                <span className="v" style={{ textAlign: "left", flex: 1, marginLeft: 12 }}>
                  {t(`evalPage.newRun.how.${step}`)}
                </span>
              </div>
            ))}
            <div className="note" style={{ marginTop: 10 }}>
              <span className="i">[i]</span>
              <span>{t("evalPage.newRun.how.note")}</span>
            </div>
          </Panel>
        </div>
      </section>
    );
  }

  // ── Dashboard: runs list + selected-run results + experiment ─────────────
  return (
    <section>
      <ViewHead
        kicker={t("evaluation.kicker")}
        title={t("evaluation.title")}
        meta={t("evalPage.metaLive")}
      />

      <Panel
        brk
        title={t("evalPage.runs.title")}
        sub={t("evalPage.runs.sub")}
        end={
          <>
            {queueLocked ? (
              <Chip tone="warn" icon="◐">{t("evalPage.acctLock")}</Chip>
            ) : (
              <Chip tone="good" icon="●">{t("evalPage.queueIdle")}</Chip>
            )}
            <Btn
              primary
              onClick={() => setSearchParams({ view: "new" })}
              data-testid="new-run-btn"
            >
              + {t("evalPage.newRun.title")}
            </Btn>
          </>
        }
        pad={false}
        style={{ "--i": 0, marginBottom: 14 } as CSSProperties}
      >
        <table>
          <thead>
            <tr>
              <th>{t("evalPage.runs.run")}</th>
              <th>{t("evalPage.runs.agent")}</th>
              <th>{t("evalPage.runs.dataset")}</th>
              <th>{t("evalPage.runs.evaluators")}</th>
              <th>{t("evalPage.runs.score")}</th>
              <th>{t("evalPage.runs.status")}</th>
            </tr>
          </thead>
          <tbody>
            {runs.map((run) => (
              <tr
                key={run.id}
                onClick={() => setSelectedRun(run)}
                style={{
                  cursor: "pointer",
                  background:
                    selectedRun?.id === run.id ? "rgba(255,176,0,.045)" : undefined,
                }}
              >
                <td className="mono">run-{run.id.slice(0, 6)}</td>
                <td className="pri">{run.agent_name}</td>
                <td className="mono dim">
                  {run.mode === "insights"
                    ? `insights · ${run.session_ids.length}`
                    : run.dataset_name ?? "—"}
                </td>
                <td className="mono dim">
                  {run.mode === "insights" ? "3" : run.evaluators.length}
                </td>
                <td
                  className="mono"
                  style={{ color: run.scores.length ? "var(--good)" : "var(--ink-3)" }}
                >
                  {average(run)}
                </td>
                <td>{statusChip(run)}</td>
              </tr>
            ))}
            {runs.length === 0 && (
              <tr>
                <td colSpan={6} className="dim mono" style={{ textAlign: "center" }}>
                  {t("evalPage.runs.empty")}
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </Panel>

      <div className="eval-grid">
        <Panel
          title={t("evalPage.scores.title")}
          sub={selectedRun ? `run-${selectedRun.id.slice(0, 6)} · ${selectedRun.agent_name}` : "—"}
          style={{ "--i": 1 } as CSSProperties}
        >
          {selectedRun?.scores.length ? (
            <>
              {selectedRun.scores.map((score) => (
                <div className="hbar" key={score.evaluatorId}>
                  <span className="hn">{score.evaluatorId.replace("Builtin.", "")}</span>
                  <div className="track">
                    <div className="fill" style={{ width: `${score.score * 100}%` }} />
                  </div>
                  <span className="hv">{score.score.toFixed(2)}</span>
                </div>
              ))}
              <div className="note" style={{ marginTop: 6 }}>
                <span className="i">[i]</span>
                <span>{t("evalPage.scores.note")}</span>
              </div>
            </>
          ) : (
            <div className="empty">{t("evalPage.scores.empty")}</div>
          )}
        </Panel>

        <Panel
          title={t("evalPage.insights.title")}
          sub={t("evalPage.insights.sub")}
          end={
            selectedRun && (
              <Btn
                disabled={(selectedRun.session_ids?.length ?? 0) < 3}
                title={
                  (selectedRun.session_ids?.length ?? 0) < 3
                    ? t("evalPage.insights.needSessions")
                    : undefined
                }
                onClick={() => void startInsightsOnRun(selectedRun)}
              >
                ↻ {t("evalPage.insights.runOnSessions")}
              </Btn>
            )
          }
          style={{ "--i": 2 } as CSSProperties}
        >
          {selectedRun?.insights?.failures?.length ? (
            selectedRun.insights.failures.slice(0, 4).map((f, i) => (
              <div className="insight" key={i}>
                <div className="ih">
                  <Chip tone="crit" icon="✕"> </Chip>
                  <b>{f.category}</b>
                  {typeof f.percentage === "number" && (
                    <span className="pct">{Math.round(f.percentage)}%</span>
                  )}
                </div>
                <div className="fix">{JSON.stringify(f).slice(0, 160)}</div>
              </div>
            ))
          ) : selectedRun?.insights?.userIntents?.length ? (
            selectedRun.insights.userIntents.slice(0, 4).map((intent, i) => (
              <div className="insight" key={i}>
                <div className="ih">
                  <Chip tone="aqua" icon="◈"> </Chip>
                  <b>{intent.intent ?? `intent ${i + 1}`}</b>
                </div>
                <div className="fix">
                  {(intent.userMessages ?? []).slice(0, 2).join(" · ").slice(0, 160)}
                </div>
              </div>
            ))
          ) : selectedRun?.error ? (
            // COMPLETED_WITH_ERRORS: the run finished but the service returned
            // no trees (e.g. under 3 sessions — clustering minimum). Show why.
            <div className="note" style={{ borderColor: "var(--warn)" }}>
              <span className="i" style={{ color: "var(--warn)" }}>[!]</span>
              <span>
                {t("evalPage.insights.partial")}{" "}
                <span className="mono">{selectedRun.error}</span>
              </span>
            </div>
          ) : (
            <div className="empty">{t("evalPage.insights.empty")}</div>
          )}
        </Panel>
      </div>

      <ExperimentPanel
        experiments={experiments}
        agents={agents}
        busy={expBusy}
        onAction={async (expId, action, challengerId) => {
          setExpBusy(true);
          try {
            const res = await fetch(`/api/experiments/${expId}/action`, {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({ action, challenger_agent_id: challengerId }),
            });
            if (!res.ok) {
              const env = (await res.json().catch(() => ({}))) as { message?: string };
              toast(t("common.actionFailed", { msg: env.message ?? `HTTP ${res.status}` }));
            }
            void refresh();
          } catch (err) {
            toast(t("common.actionFailed", { msg: String(err) }));
          } finally {
            setExpBusy(false);
          }
        }}
        onStart={async (agentIdForExp) => {
          setExpBusy(true);
          try {
            await fetch("/api/experiments", {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({ agent_id: agentIdForExp }),
            });
            void refresh();
          } finally {
            setExpBusy(false);
          }
        }}
      />
    </section>
  );
}
