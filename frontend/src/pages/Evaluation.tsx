import type { CSSProperties } from "react";
import { useCallback, useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { useSearchParams } from "react-router-dom";

import { Btn, Chip, Panel, useToast, ViewHead } from "../components";
import type { AgentInfo } from "../lib/api";
import { api } from "../lib/api";
import { evaluatorLabel } from "../lib/evaluators";
import { DatasetsView } from "./EvaluationDatasets";
import { EvaluatorsView } from "./EvaluationEvaluators";
import type { ExperimentInfo } from "./EvaluationExperiment";
import { ExperimentView } from "./EvaluationExperiment";

interface Dataset {
  id: string;
  name: string;
  locale: string;
  item_count: number;
  has_ground_truth?: boolean;
}

interface EvaluatorInfo {
  id: string;
  name?: string | null;
  level: string;
  source: "builtin" | "custom";
  requires_ground_truth?: boolean;
}

interface Score {
  evaluatorId: string;
  score: number;
}

// One cluster of any of the three insight trees (fields verified against a
// live get_batch_evaluation result — names/messages nest under
// affectedSessions, NOT at the top level).
interface InsightCluster {
  clusterId?: number;
  name?: string;
  category?: string; // legacy fallback for failures
  description?: string;
  percentage?: number;
  affectedSessionCount?: number;
  affectedSessions?: {
    sessionId?: string;
    userMessages?: string[];
    approachTaken?: string;
    finalOutcome?: string;
  }[];
  subCategories?: {
    name?: string;
    rootCauses?: { name?: string; recommendation?: string }[];
  }[];
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
    failures?: InsightCluster[];
    userIntents?: InsightCluster[];
    executionSummaries?: InsightCluster[];
  };
  session_ids: string[];
  error: string | null;
}

const DEFAULT_EVALUATORS = ["Builtin.Correctness", "Builtin.Helpfulness"];

const INSIGHT_TYPES = [
  "Builtin.Insight.FailureAnalysis",
  "Builtin.Insight.UserIntent",
  "Builtin.Insight.ExecutionSummary",
];

const INSIGHT_LABEL_KEYS: Record<string, string> = {
  "Builtin.Insight.FailureAnalysis": "failureAnalysis",
  "Builtin.Insight.UserIntent": "userIntent",
  "Builtin.Insight.ExecutionSummary": "executionSummary",
};

const WINDOW_PRESETS = [1, 6, 24, 72, 168];

const LEVEL_BADGE: Record<string, { label: string; color: string }> = {
  SESSION: { label: "SESSION", color: "var(--warn)" },
  TRACE: { label: "TRACE", color: "var(--aqua)" },
  TOOL_CALL: { label: "TOOL", color: "var(--good)" },
};

// "window:24h" (backend scope encoding) → "window · 24h" for the runs table.
function scopeLabel(run: RunInfo): string {
  if (run.dataset_name?.startsWith("window:")) {
    return `window · ${run.dataset_name.slice("window:".length)}`;
  }
  if (run.mode === "insights") return `insights · ${run.session_ids.length}`;
  return run.dataset_name ?? "—";
}

function InsightSection({
  label,
  tone,
  icon,
  clusters,
  detail,
}: {
  label: string;
  tone: "crit" | "aqua" | "good";
  icon: string;
  clusters: InsightCluster[];
  detail: (c: InsightCluster) => string | undefined;
}) {
  const { t } = useTranslation();
  if (!clusters.length) return null;
  return (
    <>
      <div
        className="mono dim"
        style={{ fontSize: 9.5, letterSpacing: ".12em", margin: "10px 0 6px" }}
      >
        {label} · {clusters.length}
      </div>
      {clusters.slice(0, 3).map((c, i) => {
        const extra = detail(c);
        return (
          <div className="insight" key={c.clusterId ?? i}>
            <div className="ih">
              <Chip tone={tone} icon={icon}> </Chip>
              <b>{c.name ?? c.category ?? `#${i + 1}`}</b>
              <span className="pct">
                {typeof c.percentage === "number"
                  ? `${Math.round(c.percentage)}%`
                  : t("evalPage.insights.sessions", {
                      count: c.affectedSessionCount ?? c.affectedSessions?.length ?? 0,
                    })}
              </span>
            </div>
            {c.description && <div className="fix">{c.description.slice(0, 220)}</div>}
            {extra && (
              <div className="fix mono" style={{ color: "var(--ink-3)" }}>
                {extra.slice(0, 150)}
              </div>
            )}
          </div>
        );
      })}
    </>
  );
}

export function Evaluation() {
  const { t } = useTranslation();
  const toast = useToast();
  // "?view=new|evaluators" renders a sub-page instead of the dashboard —
  // linkable, and the browser back button returns to the runs list.
  const [searchParams, setSearchParams] = useSearchParams();
  const view = searchParams.get("view");
  const creating = view === "new";
  const [agents, setAgents] = useState<AgentInfo[]>([]);
  const [datasets, setDatasets] = useState<Dataset[]>([]);
  const [evaluators, setEvaluators] = useState<EvaluatorInfo[]>([]);
  const [runs, setRuns] = useState<RunInfo[]>([]);
  const [selectedRun, setSelectedRun] = useState<RunInfo | null>(null);
  const [queueLocked, setQueueLocked] = useState(false);
  const [agentId, setAgentId] = useState("");
  const [datasetId, setDatasetId] = useState("");
  const [mode, setMode] = useState<"evaluators" | "insights">("evaluators");
  const [scope, setScope] = useState<"dataset" | "window">("dataset");
  const [lookbackHours, setLookbackHours] = useState(24);
  const [chosenEvaluators, setChosenEvaluators] = useState<string[]>(DEFAULT_EVALUATORS);
  const [chosenInsights, setChosenInsights] = useState<string[]>(INSIGHT_TYPES);
  const [submitError, setSubmitError] = useState<string | null>(null);
  const [experiments, setExperiments] = useState<ExperimentInfo[]>([]);

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

  // Trajectory matchers score against expected_trajectory ground truth — only
  // dataset runs whose selected dataset carries it can use them.
  const selectedDataset = datasets.find((d) => d.id === datasetId);
  const trajectoryAllowed = scope === "dataset" && !!selectedDataset?.has_ground_truth;
  useEffect(() => {
    if (!trajectoryAllowed) {
      setChosenEvaluators((prev) => prev.filter((id) => !id.startsWith("Builtin.Trajectory")));
    }
  }, [trajectoryAllowed]);

  const startRun = async () => {
    setSubmitError(null);
    const base = {
      agent_id: agentId,
      mode,
      // window runs are passive (no invoke) — nothing to wait for
      wait_seconds: scope === "window" ? 0 : 120,
      ...(scope === "window"
        ? { lookback_hours: lookbackHours }
        : { dataset_id: datasetId }),
    };
    const payload =
      mode === "insights"
        ? { ...base, insights: chosenInsights }
        : { ...base, evaluators: chosenEvaluators };
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

  // ── Evaluators management sub-page (?view=evaluators) ────────────────────
  if (view === "evaluators") {
    return <EvaluatorsView onBack={() => setSearchParams({}, { replace: true })} />;
  }

  // ── Datasets management sub-page (?view=datasets) ─────────────────────────
  if (view === "datasets") {
    return <DatasetsView onBack={() => setSearchParams({}, { replace: true })} />;
  }

  // ── Experiment sub-page (?view=experiment) ────────────────────────────────
  if (view === "experiment") {
    return <ExperimentView onBack={() => setSearchParams({}, { replace: true })} />;
  }

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
              <label>{t("evalPage.newRun.scope")}</label>
              <div className="selchips">
                <button
                  type="button"
                  className={`selchip${scope === "dataset" ? " on" : ""}`}
                  style={{ cursor: "pointer" }}
                  onClick={() => setScope("dataset")}
                >
                  {t("evalPage.newRun.scopeDataset")}
                </button>
                <button
                  type="button"
                  className={`selchip${scope === "window" ? " on" : ""}`}
                  style={{ cursor: "pointer" }}
                  data-testid="scope-window"
                  onClick={() => setScope("window")}
                >
                  {t("evalPage.newRun.scopeWindow")}
                </button>
              </div>
            </div>
            {scope === "dataset" ? (
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
                      {d.has_ground_truth ? " ◆" : ""}
                    </option>
                  ))}
                </select>
              </div>
            ) : (
              <div className="field">
                <label>{t("evalPage.newRun.window")}</label>
                <div className="selchips" style={{ alignItems: "center" }}>
                  {WINDOW_PRESETS.map((h) => (
                    <button
                      key={h}
                      type="button"
                      className={`selchip${lookbackHours === h ? " on" : ""}`}
                      style={{ cursor: "pointer" }}
                      onClick={() => setLookbackHours(h)}
                    >
                      {h}h
                    </button>
                  ))}
                  <input
                    className="input"
                    type="number"
                    min={1}
                    max={336}
                    value={lookbackHours}
                    style={{ width: 92 }}
                    aria-label={t("evalPage.newRun.windowCustom")}
                    onChange={(e) =>
                      setLookbackHours(
                        Math.min(336, Math.max(1, Number(e.target.value) || 1)),
                      )
                    }
                  />
                </div>
                <div className="note" style={{ marginTop: 8 }}>
                  <span className="i">[i]</span>
                  <span>{t("evalPage.newRun.windowHint")}</span>
                </div>
              </div>
            )}
            {mode === "evaluators" ? (
              <div className="field">
                <div
                  style={{
                    display: "flex",
                    justifyContent: "space-between",
                    alignItems: "baseline",
                  }}
                >
                  <label>{t("evalPage.newRun.evaluators")}</label>
                  <button
                    type="button"
                    className="mono"
                    style={{
                      background: "none",
                      border: "none",
                      color: "var(--aqua)",
                      cursor: "pointer",
                      fontSize: 10,
                      letterSpacing: ".08em",
                      padding: 0,
                    }}
                    onClick={() => setSearchParams({ view: "evaluators" })}
                  >
                    {t("evalPage.newRun.manageEvaluators")} ▸
                  </button>
                </div>
                <div className="selchips" style={{ maxHeight: 168, overflowY: "auto" }}>
                  {evaluators.map((e) => {
                    const gated = e.requires_ground_truth && !trajectoryAllowed;
                    const badge = LEVEL_BADGE[e.level];
                    return (
                      <button
                        key={e.id}
                        type="button"
                        className={`selchip${chosenEvaluators.includes(e.id) ? " on" : ""}`}
                        style={{ cursor: gated ? "not-allowed" : "pointer",
                                 opacity: gated ? 0.4 : undefined }}
                        disabled={gated}
                        title={
                          gated
                            ? t("evalPage.newRun.trajectoryNeedsGt")
                            : e.source === "custom"
                              ? t("evalPage.newRun.customTitle")
                              : e.id
                        }
                        onClick={() =>
                          setChosenEvaluators((prev) =>
                            prev.includes(e.id)
                              ? prev.filter((x) => x !== e.id)
                              : [...prev, e.id],
                          )
                        }
                      >
                        {e.source === "custom" ? (e.name ?? e.id) : evaluatorLabel(t, e.id)}
                        {(e.source === "custom" || e.requires_ground_truth) && badge && (
                          <span
                            className="mono"
                            style={{ fontSize: 8.5, marginLeft: 6, color: badge.color,
                                     letterSpacing: ".08em" }}
                          >
                            {e.source === "custom" ? `◆ ${badge.label}` : badge.label}
                          </span>
                        )}
                      </button>
                    );
                  })}
                </div>
              </div>
            ) : (
              <>
                <div className="field">
                  <label>{t("evalPage.newRun.insightTypes")}</label>
                  <div className="selchips">
                    {INSIGHT_TYPES.map((id) => (
                      <button
                        key={id}
                        type="button"
                        className={`selchip${chosenInsights.includes(id) ? " on" : ""}`}
                        style={{ cursor: "pointer" }}
                        onClick={() =>
                          setChosenInsights((prev) =>
                            prev.includes(id)
                              ? prev.filter((x) => x !== id)
                              : [...prev, id],
                          )
                        }
                      >
                        {t(`evalPage.newRun.insightType.${INSIGHT_LABEL_KEYS[id]}`)}
                      </button>
                    ))}
                  </div>
                </div>
                <div className="note" style={{ marginBottom: 10 }}>
                  <span className="i">[i]</span>
                  <span>
                    {scope === "window"
                      ? t("evalPage.newRun.insightsWindowHint")
                      : t("evalPage.newRun.insightsHint")}
                  </span>
                </div>
              </>
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
                  (scope === "dataset" && !datasetId) ||
                  (mode === "evaluators" && chosenEvaluators.length === 0) ||
                  (mode === "insights" && chosenInsights.length === 0)
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
              onClick={() => setSearchParams({ view: "datasets" })}
              data-testid="datasets-btn"
            >
              ▤ {t("evalPage.datasets.title")}
            </Btn>
            <Btn
              onClick={() => setSearchParams({ view: "evaluators" })}
              data-testid="evaluators-btn"
            >
              ◆ {t("evalPage.evaluators.title")}
            </Btn>
            <Btn
              onClick={() => setSearchParams({ view: "experiment" })}
              data-testid="experiment-btn"
            >
              ⚗ {t("evalPage.experiment.title")}
            </Btn>
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
                <td className="mono dim">{scopeLabel(run)}</td>
                <td className="mono dim">{run.evaluators.length}</td>
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
                  <span className="hn" title={score.evaluatorId}>
                    {evaluatorLabel(t, score.evaluatorId)}
                  </span>
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
          {selectedRun &&
          ((selectedRun.insights?.failures?.length ?? 0) > 0 ||
            (selectedRun.insights?.userIntents?.length ?? 0) > 0 ||
            (selectedRun.insights?.executionSummaries?.length ?? 0) > 0) ? (
            <div style={{ maxHeight: 460, overflowY: "auto" }}>
              <InsightSection
                label={t("evalPage.insights.secFailures")}
                tone="crit"
                icon="✕"
                clusters={selectedRun.insights.failures ?? []}
                detail={(c) => {
                  const rec = c.subCategories
                    ?.flatMap((s) => s.rootCauses ?? [])
                    .find((r) => r.recommendation)?.recommendation;
                  return rec ? `⌁ ${rec}` : undefined;
                }}
              />
              <InsightSection
                label={t("evalPage.insights.secIntents")}
                tone="aqua"
                icon="◈"
                clusters={selectedRun.insights.userIntents ?? []}
                detail={(c) => {
                  const msg = c.affectedSessions?.flatMap((s) => s.userMessages ?? [])[0];
                  return msg ? `“${msg}”` : undefined;
                }}
              />
              <InsightSection
                label={t("evalPage.insights.secSummaries")}
                tone="good"
                icon="●"
                clusters={selectedRun.insights.executionSummaries ?? []}
                detail={(c) => c.affectedSessions?.find((s) => s.finalOutcome)?.finalOutcome}
              />
            </div>
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

      <Panel
        title={t("evalPage.experiment.title")}
        sub={t("expPage.sub")}
        style={{ "--i": 3 } as CSSProperties}
      >
        {experiments[0] ? (
          <div
            data-testid="experiment-row"
            style={{ display: "flex", gap: 10, alignItems: "center", cursor: "pointer" }}
            onClick={() => setSearchParams({ view: "experiment" })}
          >
            <span className="pri">{experiments[0].name}</span>
            <Chip
              tone={
                experiments[0].status === "failed"
                  ? "crit"
                  : experiments[0].status === "cleaned"
                    ? "muted"
                    : experiments[0].status === "running"
                      ? "warn"
                      : "good"
              }
              icon={experiments[0].status === "running" ? "◐" : "●"}
            >
              {experiments[0].status.toUpperCase()}
            </Chip>
            <span className="mono dim" style={{ fontSize: 11 }}>
              {experiments[0].stage.toUpperCase()}
            </span>
            <Btn style={{ marginLeft: "auto" }}>{t("evalPage.experiment.open")} ▸</Btn>
          </div>
        ) : (
          <div
            data-testid="experiment-row"
            style={{ display: "flex", gap: 10, alignItems: "center", cursor: "pointer" }}
            onClick={() => setSearchParams({ view: "experiment" })}
          >
            <span className="dim" style={{ fontSize: 12 }}>{t("evalPage.experiment.none")}</span>
          </div>
        )}
      </Panel>
    </section>
  );
}
