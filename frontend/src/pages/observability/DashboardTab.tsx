import type { CSSProperties } from "react";
import { useState } from "react";
import { useTranslation } from "react-i18next";

import { Panel, StatTile, useToast } from "../../components";
import type { ObsDashboard } from "../../lib/api";
import { api } from "../../lib/api";
import { fmtBucket, fmtCompact, fmtCost, fmtDuration } from "./format";

function TrafficChart({ data }: { data: ObsDashboard }) {
  const { t } = useTranslation();
  const series = data.series;
  const max = Math.max(1, ...series.map((b) => b.traces));
  const longRange = data.range === "7d";
  return (
    <Panel
      brk
      title={t("obs.charts.trafficTitle")}
      sub={t("obs.charts.trafficSub")}
      style={{ "--i": 5 } as CSSProperties}
    >
      {series.length === 0 ? (
        <div className="empty">{t("obs.charts.noData")}</div>
      ) : (
        <>
          <div className="obs-bars">
            {series.map((b) => (
              <div
                key={b.bucket}
                className="b"
                style={{ height: `${Math.max(2, (b.traces / max) * 100)}%` }}
                title={`${fmtBucket(b.bucket, longRange)} · ${b.traces} / ${b.errors}`}
              >
                {b.errors > 0 && (
                  <div className="e" style={{ height: `${(b.errors / b.traces) * 100}%` }} />
                )}
              </div>
            ))}
          </div>
          <div className="obs-axis">
            <span>{fmtBucket(series[0].bucket, longRange)}</span>
            {series.length > 2 && (
              <span>{fmtBucket(series[Math.floor(series.length / 2)].bucket, longRange)}</span>
            )}
            <span>{t("obs.charts.now")}</span>
          </div>
          <div className="obs-legend">
            <span>
              <i style={{ background: "var(--s1)" }} />
              {t("obs.legend.traces")}
            </span>
            <span>
              <i style={{ background: "var(--crit)" }} />
              {t("obs.legend.errors")}
            </span>
          </div>
        </>
      )}
    </Panel>
  );
}

function LatencyChart({ data }: { data: ObsDashboard }) {
  const { t } = useTranslation();
  const series = data.series;
  const max = Math.max(1, ...series.map((b) => b.p95_ms));
  const W = 560;
  const TOP = 10;
  const BASE = 110;
  const x = (i: number) => (series.length > 1 ? (i / (series.length - 1)) * W : W / 2);
  const y = (v: number) => BASE - (v / max) * (BASE - TOP);
  const points = (pick: (b: ObsDashboard["series"][number]) => number) =>
    series.map((b, i) => `${x(i).toFixed(1)},${y(pick(b)).toFixed(1)}`).join(" ");
  return (
    <Panel
      title={t("obs.charts.latencyTitle")}
      sub={t("obs.charts.latencySub")}
      className="obs-chart"
      style={{ "--i": 6 } as CSSProperties}
    >
      {series.length === 0 ? (
        <div className="empty">{t("obs.charts.noData")}</div>
      ) : (
        <>
          <svg viewBox="0 0 560 130" style={{ width: "100%", height: 120 }}>
            <line x1="0" y1={BASE} x2={W} y2={BASE} stroke="#232B27" />
            <line x1="0" y1="60" x2={W} y2="60" stroke="#212823" strokeDasharray="3 4" />
            <line x1="0" y1={TOP} x2={W} y2={TOP} stroke="#212823" strokeDasharray="3 4" />
            <text x="4" y={TOP + 8}>{fmtDuration(max)}</text>
            <text x="4" y={BASE - 4}>0s</text>
            <polyline
              fill="none"
              stroke="var(--s3)"
              strokeWidth="1.6"
              points={points((b) => b.p95_ms)}
            />
            <polyline
              fill="none"
              stroke="var(--s1)"
              strokeWidth="1.6"
              points={points((b) => b.p50_ms)}
            />
          </svg>
          <div className="obs-legend">
            <span>
              <i style={{ background: "var(--s1)" }} />
              {t("obs.legend.p50")} · {fmtDuration(data.tiles.latency.p50_ms)}
            </span>
            <span>
              <i style={{ background: "var(--s3)" }} />
              {t("obs.legend.p95")} · {fmtDuration(data.tiles.latency.p95_ms)}
            </span>
          </div>
        </>
      )}
    </Panel>
  );
}

function TokensByModel({
  data,
  onPricesRefreshed,
}: {
  data: ObsDashboard;
  onPricesRefreshed?: () => void;
}) {
  const { t } = useTranslation();
  const toast = useToast();
  const [busy, setBusy] = useState(false);
  const rows = data.tokens_by_model;
  const grand = Math.max(1, ...rows.map((r) => r.total));

  const refreshPrices = () => {
    setBusy(true);
    api
      .obsRefreshPrices()
      .then((res) => {
        toast(
          t("obs.prices.refreshed", {
            updated: res.meta.updated.length,
            added: res.meta.added.length,
          }),
          "good",
        );
        onPricesRefreshed?.();
      })
      .catch((err: unknown) => {
        toast(
          t("obs.loadFailed", { msg: err instanceof Error ? err.message : String(err) }),
          "crit",
        );
      })
      .finally(() => setBusy(false));
  };

  return (
    <Panel
      title={t("obs.charts.tokensTitle")}
      sub={t("obs.charts.tokensSub")}
      end={
        <button className="rowact" disabled={busy} onClick={refreshPrices}>
          ⟳ {busy ? "…" : t("obs.prices.update")}
        </button>
      }
      style={{ "--i": 7 } as CSSProperties}
    >
      {rows.length === 0 ? (
        <div className="empty">{t("obs.charts.noTokens")}</div>
      ) : (
        <>
          {rows.map((r) => (
            <div className="obs-hbar" key={r.model}>
              <div className="hb-l">
                <span title={r.model}>{r.model}</span>
                <b>
                  {fmtCompact(r.total)} · ≈{fmtCost(r.est_cost_usd)}
                </b>
              </div>
              <div className="track">
                <div
                  className="seg"
                  style={{ width: `${(r.input / grand) * 100}%`, background: "var(--s1)" }}
                />
                <div
                  className="seg"
                  style={{ width: `${(r.output / grand) * 100}%`, background: "var(--s2)" }}
                />
              </div>
            </div>
          ))}
          <div className="obs-legend">
            <span>
              <i style={{ background: "var(--s1)" }} />
              {t("obs.legend.input")}
            </span>
            <span>
              <i style={{ background: "var(--s2)" }} />
              {t("obs.legend.output")}
            </span>
            <span className="dim">
              {t("obs.charts.priceNote")}
              {data.prices_meta?.updated_at != null &&
                ` · ${t("obs.prices.updatedAt", {
                  date: data.prices_meta.updated_at.slice(0, 10),
                })}`}
            </span>
          </div>
        </>
      )}
    </Panel>
  );
}

function TopTools({ data }: { data: ObsDashboard }) {
  const { t } = useTranslation();
  const rows = data.top_tools;
  const max = Math.max(1, ...rows.map((r) => r.calls));
  return (
    <Panel
      title={t("obs.charts.toolsTitle")}
      sub={t("obs.charts.toolsSub")}
      style={{ "--i": 8 } as CSSProperties}
    >
      {rows.length === 0 ? (
        <div className="empty">{t("obs.charts.noTools")}</div>
      ) : (
        <>
          {rows.slice(0, 6).map((r) => (
            <div className="obs-hbar" key={r.tool}>
              <div className="hb-l">
                <span title={r.tool}>{r.tool}</span>
                <b>
                  {t("obs.charts.callCount", { count: r.calls })}
                  {r.success_rate != null && ` · ${r.success_rate}%`}
                </b>
              </div>
              <div className="track">
                <div
                  className="seg"
                  style={{
                    width: `${((r.calls - r.errors) / max) * 100}%`,
                    background: "var(--s2)",
                  }}
                />
                {r.errors > 0 && (
                  <div
                    className="seg"
                    style={{ width: `${(r.errors / max) * 100}%`, background: "var(--crit)" }}
                  />
                )}
              </div>
            </div>
          ))}
          <div className="obs-legend">
            <span>
              <i style={{ background: "var(--s2)" }} />
              {t("obs.legend.success")}
            </span>
            <span>
              <i style={{ background: "var(--crit)" }} />
              {t("obs.legend.error")}
            </span>
          </div>
        </>
      )}
    </Panel>
  );
}

export function DashboardTab({
  data,
  onPricesRefreshed,
}: {
  data: ObsDashboard;
  onPricesRefreshed?: () => void;
}) {
  const { t } = useTranslation();
  const { tiles } = data;
  const errPct = (tiles.error_rate * 100).toFixed(1);
  return (
    <>
      <div className="tiles five">
        <StatTile
          label={t("obs.tiles.traces")}
          value={String(tiles.traces.total)}
          foot={
            <>
              <b>{t("obs.tiles.okCount", { count: tiles.traces.ok })}</b>
              {" · "}
              {t("obs.tiles.errCount", { count: tiles.traces.error })}
            </>
          }
          style={{ "--i": 0 } as CSSProperties}
        />
        <StatTile
          label={t("obs.tiles.sessions")}
          value={String(tiles.sessions.total)}
          foot={<b>{t("obs.tiles.agentsActive", { count: tiles.sessions.agents })}</b>}
          style={{ "--i": 1 } as CSSProperties}
        />
        <div className={`tile${tiles.error_rate > 0.05 ? " crit" : ""}`}>
          <div className="t-label">{t("obs.tiles.errorRate")}</div>
          <div className="t-val">
            {errPct}
            <small>%</small>
          </div>
          <div className="t-foot">
            {t("obs.tiles.errorOf", {
              errors: tiles.traces.error,
              total: tiles.traces.total,
            })}
          </div>
        </div>
        <StatTile
          label={t("obs.tiles.latency")}
          value={fmtDuration(tiles.latency.p50_ms)}
          unit={` / ${fmtDuration(tiles.latency.p95_ms)}`}
          foot={t("obs.tiles.latencyFoot")}
          style={{ "--i": 3 } as CSSProperties}
        />
        <StatTile
          label={t("obs.tiles.tokens")}
          value={fmtCompact(tiles.tokens.total)}
          foot={
            <>
              <b>
                {t("obs.tiles.tokensInOut", {
                  in: fmtCompact(tiles.tokens.input),
                  out: fmtCompact(tiles.tokens.output),
                })}
              </b>
              {" · ≈ "}
              {fmtCost(tiles.tokens.est_cost_usd)}
            </>
          }
          style={{ "--i": 4 } as CSSProperties}
        />
      </div>
      <div className="obs-grid">
        <TrafficChart data={data} />
        <LatencyChart data={data} />
      </div>
      <div className="obs-grid" style={{ marginBottom: 0 }}>
        <TokensByModel data={data} onPricesRefreshed={onPricesRefreshed} />
        <TopTools data={data} />
      </div>
    </>
  );
}
