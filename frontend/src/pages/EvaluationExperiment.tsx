import type { CSSProperties } from "react";
import { useCallback, useEffect, useState } from "react";
import { useTranslation } from "react-i18next";

import { Btn, Chip, ConfirmDialog, Panel, useToast, ViewHead } from "../components";
import type { AgentInfo } from "../lib/api";
import { api } from "../lib/api";
import { evaluatorLabel } from "../lib/evaluators";

export interface ABMetric {
  label: string;
  control: { mean: number | null; sampleSize: number | null };
  variants: { name: string; mean: number | null; sampleSize: number | null;
    pValue?: number | null; isSignificant?: boolean }[];
}

export interface ExperimentInfo {
  id: string;
  name: string;
  agent_id: string;
  agent_name: string;
  status: string;
  stage: string;
  stages: string[];
  error: string | null;
  created_at: string | null;
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

// Mirrors backend STAGES (app/optimization/models.py) — the sidebar renders
// the loop even before any experiment exists, so the list is static here.
const LOOP_STAGES = [
  "recommend", "bundles", "gateway", "abtest", "traffic", "verdict",
  "promote", "canary", "ramp", "cleanup",
];

// status → chip tone, shared by the sub-page header and the dashboard row.
export function experimentTone(status: string): "good" | "warn" | "crit" | "muted" {
  if (status === "failed") return "crit";
  if (status === "cleaned") return "muted";
  if (status === "running") return "warn";
  return "good"; // ready | promoted
}

// The 10-segment rail: done ✓ / current highlighted (pulse while running,
// result color otherwise, ✕ on failure) / future grey, with a one-line hint
// under the current segment saying what is happening and how long it takes.
function StagePipeline({ exp }: { exp: ExperimentInfo }) {
  const { t } = useTranslation();
  const stages = exp.stages?.length ? exp.stages : LOOP_STAGES;
  const cur = stages.indexOf(exp.stage);
  const failed = exp.status === "failed";
  return (
    <div data-testid="stage-pipeline" style={{ marginBottom: 12 }}>
      {stages.map((s, i) => {
        const state = i < cur ? "done" : i === cur ? (failed ? "failed" : "current") : "future";
        const color =
          state === "done" ? "var(--good)"
            : state === "failed" ? "var(--crit)"
              : state === "current"
                ? exp.status === "running" ? "var(--warn)" : "var(--good)"
                : "var(--ink-3)";
        const icon =
          state === "done" ? "✓"
            : state === "failed" ? "✕"
              : state === "current" ? (exp.status === "running" ? "◐" : "●") : "·";
        return (
          <div key={s} data-testid={`stage-${s}`} data-state={state}>
            <div style={{ display: "flex", gap: 9, alignItems: "baseline" }}>
              <span className="mono" style={{ color, width: 12, textAlign: "center" }}>
                {icon}
              </span>
              <span
                className="mono"
                style={{
                  color,
                  fontSize: 10.5,
                  letterSpacing: ".1em",
                  fontWeight: state === "current" || state === "failed" ? 700 : 400,
                }}
              >
                {s.toUpperCase()}
              </span>
            </div>
            {(state === "current" || state === "failed") && (
              <div
                data-testid="stage-hint"
                className={failed ? "mono" : "dim"}
                style={{
                  fontSize: 10.5,
                  margin: "2px 0 4px 21px",
                  color: failed ? "var(--crit)" : undefined,
                }}
              >
                {failed
                  ? exp.error
                  : t(`evalPage.experiment.stageHint.${exp.status === "ready" ? "ready" : s}`)}
              </div>
            )}
          </div>
        );
      })}
    </div>
  );
}

export function ExperimentView({ onBack }: { onBack: () => void }) {
  const { t } = useTranslation();
  const toast = useToast();
  const [experiments, setExperiments] = useState<ExperimentInfo[]>([]);
  const [agents, setAgents] = useState<AgentInfo[]>([]);
  const [busy, setBusy] = useState(false);
  const [startAgentId, setStartAgentId] = useState("");
  const [startError, setStartError] = useState<string | null>(null);
  const [challengerId, setChallengerId] = useState("");
  const [confirmCleanup, setConfirmCleanup] = useState(false);

  const refresh = useCallback(async () => {
    try {
      const res = await fetch("/api/experiments");
      if (res.ok) {
        setExperiments(((await res.json()) as { experiments: ExperimentInfo[] }).experiments);
      }
    } catch {
      /* backend offline */
    }
  }, []);

  useEffect(() => {
    api
      .listAgents()
      .then((res) => {
        // Experiments target runtime-backed agents (zip_runtime / studio /
        // container) — harness agents are rejected by POST /api/experiments.
        const eligible = res.agents.filter(
          (a) => a.status === "active" && a.method !== "harness",
        );
        setAgents(eligible);
        setStartAgentId((prev) => prev || (eligible[0]?.id ?? ""));
      })
      .catch(() => {});
    void refresh();
    const timer = setInterval(() => void refresh(), 8000);
    return () => clearInterval(timer);
  }, [refresh]);

  const exp = experiments[0] ?? null;
  const verdict = exp?.artifacts.verdict;
  const canary = exp?.artifacts.canary;
  const canaryWeights = canary?.after_weights ?? canary?.weights;
  const insufficient = !!verdict?.verdict.includes("insufficient");
  // cleaned/failed experiments are over — controls that would fire actions
  // against torn-down resources collapse into a read-only summary.
  const terminal = exp?.status === "cleaned" || exp?.status === "failed";

  const onStart = async () => {
    setStartError(null);
    setBusy(true);
    try {
      const res = await fetch("/api/experiments", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ agent_id: startAgentId }),
      });
      if (!res.ok) {
        const body = (await res.json().catch(() => ({}))) as { message?: string };
        setStartError(body.message ?? `HTTP ${res.status}`);
        return;
      }
      void refresh();
    } catch (err) {
      setStartError(String(err));
    } finally {
      setBusy(false);
    }
  };

  const onAction = async (expId: string, action: string, challengerAgentId?: string) => {
    setBusy(true);
    try {
      const res = await fetch(`/api/experiments/${expId}/action`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action, challenger_agent_id: challengerAgentId }),
      });
      if (!res.ok) {
        const env = (await res.json().catch(() => ({}))) as { message?: string };
        toast(t("common.actionFailed", { msg: env.message ?? `HTTP ${res.status}` }));
      }
      void refresh();
    } catch (err) {
      toast(t("common.actionFailed", { msg: String(err) }));
    } finally {
      setBusy(false);
    }
  };

  const startForm = (label: string) => (
    <>
      <div className="field">
        <label>{t("evalPage.newRun.agent")}</label>
        <select
          className="input"
          value={startAgentId}
          data-testid="exp-agent-select"
          onChange={(e) => setStartAgentId(e.target.value)}
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
      {startError && (
        <div className="note" style={{ borderColor: "var(--crit)", marginBottom: 10 }}>
          <span className="i" style={{ color: "var(--crit)" }}>[✕]</span>
          <span>{startError}</span>
        </div>
      )}
      <div style={{ display: "flex", justifyContent: "flex-end" }}>
        <Btn
          primary
          disabled={busy || !startAgentId}
          data-testid="exp-start-btn"
          onClick={() => void onStart()}
        >
          ▸ {label}
        </Btn>
      </div>
    </>
  );

  return (
    <section>
      <ViewHead
        kicker={t("evaluation.kicker")}
        title={t("evalPage.experiment.title")}
        meta={t("evalPage.experiment.meta")}
      />
      <div style={{ marginBottom: 14 }}>
        <Btn onClick={onBack}>◂ {t("evalPage.backToRuns")}</Btn>
      </div>
      <div className="eval-grid">
        <Panel
          brk
          title={exp ? exp.name : t("expPage.start")}
          sub={exp ? t("expPage.sub") : t("expPage.startHint")}
          end={
            exp && (
              <Chip
                tone={experimentTone(exp.status)}
                icon={exp.status === "running" ? "◐" : "●"}
              >
                {exp.stage.toUpperCase()} · {exp.status.toUpperCase()}
              </Chip>
            )
          }
          style={{ "--i": 0 } as CSSProperties}
        >
          {experiments.length > 1 && (
            <div
              className="mono dim"
              data-testid="more-experiments"
              style={{ fontSize: 10, marginBottom: 8 }}
            >
              {t("evalPage.experiment.moreCount", { count: experiments.length })}
            </div>
          )}
          {!exp && startForm(t("expPage.start"))}

          {exp && terminal && (
            <>
              <div data-testid="exp-summary-card">
                {exp.status === "failed" && exp.error && (
                  <div
                    className="note"
                    style={{ borderColor: "var(--crit)", marginBottom: 10 }}
                    data-testid="exp-error"
                  >
                    <span className="i" style={{ color: "var(--crit)" }}>[✕]</span>
                    <span className="mono">{exp.error}</span>
                  </div>
                )}
                <div className="kv">
                  <span className="k mono">{t("evalPage.experiment.summary.agent")}</span>
                  <span className="v">{exp.agent_name}</span>
                </div>
                <div className="kv">
                  <span className="k mono">{t("evalPage.experiment.summary.verdict")}</span>
                  <span className="v mono">
                    {verdict ? verdict.verdict.toUpperCase() : "—"}
                    {exp.artifacts.promote &&
                      ` · ${t("expPage.promoted")} T1 ${
                        exp.artifacts.promote.after_weights?.T1 ?? 100}%`}
                  </span>
                </div>
                <div className="kv">
                  <span className="k mono">{t("evalPage.experiment.summary.created")}</span>
                  <span className="v mono">
                    {exp.created_at ? new Date(exp.created_at).toLocaleString() : "—"}
                  </span>
                </div>
                {exp.artifacts.promote && insufficient && (
                  <div
                    className="mono dim"
                    data-testid="promoted-context"
                    style={{ fontSize: 10.5, margin: "4px 0" }}
                  >
                    ⚠ {t("evalPage.experiment.insufficient.promotedContext")}
                  </div>
                )}
                <div className="note" style={{ marginTop: 8 }}>
                  <span className="i">[i]</span>
                  <span>
                    {exp.status === "cleaned"
                      ? t("evalPage.experiment.summary.cleaned")
                      : t("evalPage.experiment.summary.failed")}
                  </span>
                </div>
                {exp.status === "failed" && (
                  <div style={{ marginTop: 10 }}>
                    <Btn
                      disabled={busy}
                      data-testid="cleanup-btn"
                      onClick={() => setConfirmCleanup(true)}
                    >
                      {t("expPage.cleanup")}
                    </Btn>
                  </div>
                )}
                {exp.artifacts.cleanup && (
                  <div className="code" style={{ marginTop: 10, maxHeight: 120, overflowY: "auto" }}>
                    {exp.artifacts.cleanup
                      .map((row) => `${row.status.padEnd(8)} ${row.category}`)
                      .join("\n")}
                  </div>
                )}
              </div>
              <div
                data-testid="start-new"
                style={{ marginTop: 14, borderTop: "1px solid var(--line)", paddingTop: 12 }}
              >
                {startForm(t("evalPage.experiment.startNew"))}
              </div>
            </>
          )}

          {exp && !terminal && (
            <>
              <StagePipeline exp={exp} />

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
                        <span>{evaluatorLabel(t, metric.label)}</span>
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
              ) : exp.status === "running" ? (
                <div
                  className="mono dim"
                  data-testid="metrics-pending"
                  style={{ fontSize: 11, marginBottom: 8 }}
                >
                  {t("evalPage.experiment.metricsPending")}
                </div>
              ) : null}

              {verdict && (
                <>
                  <div
                    className="verdict"
                    style={
                      insufficient
                        ? { background: "rgba(250,178,25,.08)",
                            border: "1px solid rgba(250,178,25,.35)" }
                        : undefined
                    }
                  >
                    <span
                      className="vt"
                      style={insufficient ? { color: "var(--warn)" } : undefined}
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
                        data-testid="promote-btn"
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
                  {insufficient && exp.artifacts.promote && (
                    <div
                      className="mono dim"
                      data-testid="promoted-context"
                      style={{ fontSize: 10.5, margin: "4px 0 8px" }}
                    >
                      ⚠ {t("evalPage.experiment.insufficient.promotedContext")}
                    </div>
                  )}
                  {insufficient && !exp.artifacts.promote && (
                    <div
                      className="note"
                      style={{ borderColor: "var(--warn)", marginTop: 8 }}
                      data-testid="insufficient-note"
                    >
                      <span className="i" style={{ color: "var(--warn)" }}>[!]</span>
                      <span>
                        {t("evalPage.experiment.insufficient.reason")}
                        <br />· {t("evalPage.experiment.insufficient.a1")}
                        <br />· {t("evalPage.experiment.insufficient.a2")}
                        <br />· {t("evalPage.experiment.insufficient.a3")}
                      </span>
                    </div>
                  )}
                </>
              )}

              {exp.artifacts.promote && (
                <div style={{ marginTop: 14 }} data-testid="canary-section">
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
                      {(canary?.ramp_stage ?? 0) < 2 && (
                        <div style={{ marginTop: 8, display: "flex", gap: 9 }}>
                          <Btn
                            disabled={busy}
                            data-testid="ramp-btn"
                            onClick={() => void onAction(exp.id, "ramp")}
                          >
                            {t("expPage.ramp")} ▸
                          </Btn>
                        </div>
                      )}
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
                        disabled={busy || !challengerId}
                        onClick={() => void onAction(exp.id, "canary", challengerId)}
                      >
                        {t("expPage.startCanary")}
                      </Btn>
                    </div>
                  )}
                </div>
              )}

              <div style={{ marginTop: 14, display: "flex", gap: 9 }}>
                <Btn
                  disabled={busy}
                  data-testid="cleanup-btn"
                  onClick={() => setConfirmCleanup(true)}
                >
                  {t("expPage.cleanup")}
                </Btn>
              </div>

              {exp.artifacts.cleanup && (
                <div className="code" style={{ marginTop: 10, maxHeight: 120, overflowY: "auto" }}>
                  {exp.artifacts.cleanup
                    .map((row) => `${row.status.padEnd(8)} ${row.category}`)
                    .join("\n")}
                </div>
              )}
            </>
          )}
          {exp && (
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
          )}
        </Panel>

        <Panel
          title={t("evalPage.experiment.how.title")}
          sub={t("evalPage.experiment.how.sub")}
          style={{ "--i": 1 } as CSSProperties}
        >
          {LOOP_STAGES.map((stage, i) => (
            <div className="kv" key={stage}>
              <span className="k mono">{String(i + 1).padStart(2, "0")}</span>
              <span className="v" style={{ textAlign: "left", flex: 1, marginLeft: 12 }}>
                {t(`evalPage.experiment.how.${stage}`)}
              </span>
            </div>
          ))}
          <div className="note" style={{ marginTop: 10 }}>
            <span className="i">[i]</span>
            <span>{t("evalPage.experiment.how.note")}</span>
          </div>
        </Panel>
      </div>
    </section>
  );
}
