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
                tone={exp.status === "failed" ? "crit" : exp.status === "ready" ? "good" : "warn"}
                icon={exp.status === "running" ? "◐" : "●"}
              >
                {exp.stage.toUpperCase()} · {exp.status.toUpperCase()}
              </Chip>
            )
          }
          style={{ "--i": 0 } as CSSProperties}
        >
          {!exp && (
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
                  ▸ {t("expPage.start")}
                </Btn>
              </div>
            </>
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
