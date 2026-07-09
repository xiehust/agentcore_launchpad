import type { CSSProperties } from "react";
import { useCallback, useEffect, useState } from "react";
import { useTranslation } from "react-i18next";

import { Btn, Chip, Panel, ViewHead } from "../components";
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

export function Evaluation() {
  const { t } = useTranslation();
  const [agents, setAgents] = useState<AgentInfo[]>([]);
  const [datasets, setDatasets] = useState<Dataset[]>([]);
  const [evaluators, setEvaluators] = useState<EvaluatorInfo[]>([]);
  const [runs, setRuns] = useState<RunInfo[]>([]);
  const [selectedRun, setSelectedRun] = useState<RunInfo | null>(null);
  const [queueLocked, setQueueLocked] = useState(false);
  const [agentId, setAgentId] = useState("");
  const [datasetId, setDatasetId] = useState("");
  const [chosenEvaluators, setChosenEvaluators] = useState<string[]>(DEFAULT_EVALUATORS);
  const [submitError, setSubmitError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    try {
      const [runsRes, queueRes] = await Promise.all([
        fetch("/api/eval/runs"),
        fetch("/api/eval/queue"),
      ]);
      if (runsRes.ok) {
        const body = (await runsRes.json()) as { runs: RunInfo[] };
        setRuns(body.runs);
        setSelectedRun(
          (prev) => body.runs.find((r) => r.id === prev?.id) ?? body.runs[0] ?? null,
        );
      }
      if (queueRes.ok) setQueueLocked(((await queueRes.json()) as { locked: boolean }).locked);
    } catch {
      /* backend offline */
    }
  }, []);

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

  const startRun = async (mode: "evaluators" | "insights") => {
    setSubmitError(null);
    const payload =
      mode === "insights"
        ? {
            agent_id: agentId,
            mode,
            session_ids: selectedRun?.session_ids?.length ? selectedRun.session_ids : undefined,
            dataset_id: selectedRun?.session_ids?.length ? undefined : datasetId,
            wait_seconds: selectedRun?.session_ids?.length ? 0 : 120,
          }
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

  return (
    <section>
      <ViewHead
        kicker={t("evaluation.kicker")}
        title={t("evaluation.title")}
        meta={t("evalPage.metaLive")}
      />

      <div className="eval-grid">
        <Panel
          brk
          title={t("evalPage.runs.title")}
          sub={t("evalPage.runs.sub")}
          end={
            queueLocked ? (
              <Chip tone="warn" icon="◐">{t("evalPage.acctLock")}</Chip>
            ) : (
              <Chip tone="good" icon="●">{t("evalPage.queueIdle")}</Chip>
            )
          }
          pad={false}
          style={{ "--i": 0 } as CSSProperties}
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

        <Panel
          title={t("evalPage.newRun.title")}
          sub={t("evalPage.newRun.sub")}
          style={{ "--i": 1 } as CSSProperties}
        >
          <div className="field">
            <label>{t("evalPage.newRun.agent")}</label>
            <select
              className="input"
              value={agentId}
              onChange={(e) => setAgentId(e.target.value)}
            >
              {agents.length === 0 && <option value="">{t("evalPage.newRun.noAgents")}</option>}
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
          <div className="field">
            <label>{t("evalPage.newRun.evaluators")}</label>
            <div className="selchips" style={{ maxHeight: 120, overflowY: "auto" }}>
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
          {submitError && (
            <div className="note" style={{ borderColor: "var(--crit)", marginBottom: 10 }}>
              <span className="i" style={{ color: "var(--crit)" }}>[✕]</span>
              <span>{submitError}</span>
            </div>
          )}
          <div style={{ display: "flex", gap: 9 }}>
            <Btn
              primary
              disabled={!agentId || !datasetId || chosenEvaluators.length === 0}
              onClick={() => void startRun("evaluators")}
            >
              ▸ {t("evalPage.newRun.start")}
            </Btn>
            <Btn
              disabled={!agentId || !selectedRun?.session_ids?.length}
              onClick={() => void startRun("insights")}
            >
              {t("evalPage.newRun.startInsights")}
            </Btn>
          </div>
        </Panel>
      </div>

      <div className="eval-grid">
        <Panel
          title={t("evalPage.scores.title")}
          sub={selectedRun ? `run-${selectedRun.id.slice(0, 6)} · ${selectedRun.agent_name}` : "—"}
          style={{ "--i": 2 } as CSSProperties}
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
          style={{ "--i": 3 } as CSSProperties}
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
          ) : (
            <div className="empty">{t("evalPage.insights.empty")}</div>
          )}
        </Panel>
      </div>
    </section>
  );
}
