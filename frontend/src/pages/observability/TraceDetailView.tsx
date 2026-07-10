import type { CSSProperties } from "react";
import { useEffect, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";

import { Btn, Chip, Panel } from "../../components";
import type { ObsSpan, ObsSpanNode, ObsTraceDetail } from "../../lib/api";
import { api, ApiError } from "../../lib/api";
import { fmtCost, fmtDuration, fmtInt, shortId } from "./format";

export const TRACE_ID_RE = /^[0-9a-f]{32}$/;

const CAT_CLASS: Record<string, string> = {
  llm: "llm",
  tool: "tool",
  memory: "mem",
  gateway: "gw",
  http: "http",
  agent: "agent",
  other: "other",
};

const LEGEND: { cat: string; tone: "llm" | "tool" | "mem" | "gw" | "muted" }[] = [
  { cat: "llm", tone: "llm" },
  { cat: "tool", tone: "tool" },
  { cat: "memory", tone: "mem" },
  { cat: "gateway", tone: "gw" },
  { cat: "http", tone: "muted" },
];

function flattenTree(nodes: ObsSpanNode[]): ObsSpanNode[] {
  const out: ObsSpanNode[] = [];
  const walk = (node: ObsSpanNode) => {
    out.push(node);
    node.children.forEach(walk);
  };
  nodes.forEach(walk);
  return out;
}

function SpanDrawer({
  span,
  attributes,
}: {
  span: ObsSpan;
  attributes: Record<string, unknown>;
}) {
  const { t } = useTranslation();
  const attrs = Object.entries(attributes);
  const toolAttrs = attrs.filter(([k]) => k.startsWith("gen_ai.tool."));
  const operation = (attributes["gen_ai.operation.name"] as string) ?? span.name;
  const provider =
    (attributes["gen_ai.system"] as string) ??
    (attributes["gen_ai.provider.name"] as string) ??
    null;
  const finish = Array.isArray(span.finish_reason)
    ? span.finish_reason.join(", ")
    : span.finish_reason;
  const httpStatus =
    (attributes["http.response.status_code"] as number) ??
    (attributes["http.status_code"] as number) ??
    null;
  return (
    <Panel
      className="obs-drawer"
      pad={false}
      title={t("obs.drawer.title")}
      sub={`${operation} · ${span.kind ?? "—"}`}
      end={
        <Chip
          tone={
            (["llm", "tool", "mem", "gw"].includes(CAT_CLASS[span.category])
              ? CAT_CLASS[span.category]
              : "muted") as never
          }
          icon="■"
        >
          {t(`obs.categories.${span.category}`)}
        </Chip>
      }
      style={{ "--i": 1 } as CSSProperties}
    >
      <div className="obs-sect">
        <div className="kv">
          <span className="k">{t("obs.drawer.operation")}</span>
          <span className="v hl">{operation}</span>
        </div>
        {span.model != null && (
          <div className="kv">
            <span className="k">{t("obs.drawer.model")}</span>
            <span className="v">{span.model}</span>
          </div>
        )}
        {provider != null && (
          <div className="kv">
            <span className="k">{t("obs.drawer.provider")}</span>
            <span className="v">{provider}</span>
          </div>
        )}
        {finish != null && (
          <div className="kv">
            <span className="k">{t("obs.drawer.finishReason")}</span>
            <span className="v">{finish}</span>
          </div>
        )}
        <div className="kv">
          <span className="k">{t("obs.drawer.duration")}</span>
          <span className="v hl">{fmtDuration(span.duration_ms)}</span>
        </div>
        <div className="kv">
          <span className="k">{t("obs.drawer.status")}</span>
          <span
            className="v"
            style={{ color: span.status === "ERROR" ? "var(--crit-text)" : "var(--good)" }}
          >
            {span.status}
            {httpStatus != null ? ` · http ${httpStatus}` : ""}
          </span>
        </div>
      </div>
      {span.tokens != null && (
        <div className="obs-sect">
          <h4>{t("obs.drawer.tokenUsage")}</h4>
          <div className="kv">
            <span className="k">{t("obs.drawer.input")}</span>
            <span className="v hl">{fmtInt(span.tokens.input)}</span>
          </div>
          <div className="kv">
            <span className="k">{t("obs.drawer.output")}</span>
            <span className="v hl">{fmtInt(span.tokens.output)}</span>
          </div>
          <div className="kv">
            <span className="k">{t("obs.drawer.cacheRw")}</span>
            <span className="v">
              {fmtInt(span.tokens.cache_read)} / {fmtInt(span.tokens.cache_write)}
            </span>
          </div>
          <div className="kv">
            <span className="k">{t("obs.drawer.estCost")}</span>
            <span className="v hl">{fmtCost(span.est_cost_usd)}</span>
          </div>
        </div>
      )}
      {(span.tool_name != null || toolAttrs.length > 0) && (
        <div className="obs-sect">
          <h4>{t("obs.drawer.tool")}</h4>
          {span.tool_name != null && (
            <div className="kv">
              <span className="k">{t("obs.drawer.toolName")}</span>
              <span className="v hl">{span.tool_name}</span>
            </div>
          )}
          <div className="kv">
            <span className="k">{t("obs.drawer.toolStatus")}</span>
            <span
              className="v"
              style={{ color: span.status === "ERROR" ? "var(--crit-text)" : "var(--good)" }}
            >
              {span.status}
            </span>
          </div>
          {toolAttrs
            .filter(([k]) => k !== "gen_ai.tool.name")
            .slice(0, 4)
            .map(([k, v]) => (
              <div className="kv" key={k}>
                <span className="k">{k.replace("gen_ai.tool.", "")}</span>
                <span className="v">{String(v).slice(0, 80)}</span>
              </div>
            ))}
        </div>
      )}
      <div className="obs-sect">
        <h4>{t("obs.drawer.rawAttrs", { count: attrs.length })}</h4>
        <div className="code">
          {attrs.slice(0, 12).map(([k, v]) => (
            <div key={k}>
              "<span className="k2">{k}</span>": {JSON.stringify(v)?.slice(0, 60)}
            </div>
          ))}
          {attrs.length > 12 && <div>…</div>}
        </div>
      </div>
    </Panel>
  );
}

interface TraceDetailViewProps {
  traceId: string;
  range: string;
  onBack: () => void;
  onOpenSession: (sessionId: string) => void;
}

export function TraceDetailView({ traceId, range, onBack, onOpenSession }: TraceDetailViewProps) {
  const { t } = useTranslation();
  const [detail, setDetail] = useState<ObsTraceDetail | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [invalid, setInvalid] = useState(false);
  const [selected, setSelected] = useState<string | null>(null);

  useEffect(() => {
    setDetail(null);
    setError(null);
    setSelected(null);
    if (!TRACE_ID_RE.test(traceId)) {
      setInvalid(true);
      return;
    }
    setInvalid(false);
    // Guard against out-of-order responses when traceId changes while mounted
    // (e.g. browser back/forward between two trace deep links).
    let alive = true;
    api
      .obsTrace(traceId, range)
      .then((res) => {
        if (alive) setDetail(res);
      })
      .catch((err: unknown) => {
        if (!alive) return;
        if (err instanceof ApiError && err.code === "validation.invalid_request") {
          setInvalid(true);
        } else {
          setError(err instanceof Error ? err.message : String(err));
        }
      });
    return () => {
      alive = false;
    };
  }, [traceId, range]);

  const rows = useMemo(() => (detail ? flattenTree(detail.tree) : []), [detail]);
  const attrsBySpan = useMemo(() => {
    const map = new Map<string, Record<string, unknown>>();
    detail?.spans.forEach((s) => {
      if (s.span_id) map.set(s.span_id, s.attributes);
    });
    return map;
  }, [detail]);

  const selectedSpan =
    rows.find((r) => r.span_id === selected) ??
    rows.find((r) => r.category === "llm") ??
    rows[0] ??
    null;

  if (invalid || (detail && detail.meta.span_count === 0)) {
    return (
      <>
        <div className="obs-bar">
          <button className="obs-tab" onClick={onBack}>
            {t("obs.waterfall.back")}
          </button>
          <span className="mono" style={{ color: "var(--ink)" }}>
            {t("obs.waterfall.traceLabel")} {shortId(traceId, 16)}
          </span>
        </div>
        <Panel brk>
          <div className="empty">{t("obs.waterfall.notFound")}</div>
        </Panel>
      </>
    );
  }

  if (error != null) {
    return (
      <Panel brk>
        <div className="obs-error">
          <span>{t("obs.loadFailed", { msg: error })}</span>
          <Btn onClick={onBack}>{t("obs.waterfall.back")}</Btn>
        </div>
      </Panel>
    );
  }

  if (detail == null) {
    return (
      <Panel brk>
        <div className="loading-line">{t("common.loading")}</div>
      </Panel>
    );
  }

  const { meta } = detail;
  return (
    <>
      <div className="obs-bar">
        <button className="obs-tab" onClick={onBack}>
          {t("obs.waterfall.back")}
        </button>
        <span className="mono" style={{ color: "var(--ink)" }}>
          {t("obs.waterfall.traceLabel")} {detail.trace_id}
        </span>
        {meta.status === "ok" ? (
          <Chip tone="good" icon="●">
            {t("obs.status.ok")}
          </Chip>
        ) : (
          <Chip tone="crit" icon="✕">
            {t("obs.status.error")}
          </Chip>
        )}
        <span className="spacer" />
        <Chip tone="muted">{meta.agent}</Chip>
        {meta.session_id != null && (
          <Chip tone="muted">
            {t("obs.waterfall.sessionLabel")}{" "}
            <button
              className="sid"
              style={{ marginLeft: 4 }}
              onClick={() => onOpenSession(meta.session_id as string)}
              title={meta.session_id}
            >
              {shortId(meta.session_id)}
            </button>
          </Chip>
        )}
        <Chip tone="muted">
          {fmtDuration(meta.duration_ms)} · {meta.span_count} spans · {meta.llm_count} llm ·{" "}
          {fmtInt(meta.tokens.total)} tok · ≈{fmtCost(meta.est_cost_usd)}
        </Chip>
      </div>
      <div className="grid-31">
        <Panel
          brk
          pad={false}
          title={t("obs.waterfall.title")}
          sub={t("obs.waterfall.sub", { dur: fmtDuration(meta.duration_ms) })}
          end={
            <>
              {LEGEND.map(({ cat, tone }) => (
                <Chip key={cat} tone={tone as never} icon="■">
                  {t(`obs.categories.${cat}`)}
                </Chip>
              ))}
            </>
          }
          style={{ "--i": 0 } as CSSProperties}
        >
          <div className="wf">
            <div className="wf-h">{t("obs.waterfall.cols.span")}</div>
            <div className="wf-h">{t("obs.waterfall.cols.timeline")}</div>
            <div className="wf-h" style={{ textAlign: "right" }}>
              {t("obs.waterfall.cols.dur")}
            </div>
            {rows.map((row) => {
              const sel = selectedSpan?.span_id === row.span_id ? " sel" : "";
              const cat = CAT_CLASS[row.category] ?? "other";
              const pick = () => setSelected(row.span_id);
              return (
                <div style={{ display: "contents" }} key={row.span_id}>
                  <button
                    className={`nm${sel} ind${Math.min(row.depth, 4)}`}
                    onClick={pick}
                    title={row.name}
                  >
                    <span className={`cat ${cat}`} />
                    {row.name}
                  </button>
                  <div
                    className={`lane${sel}`}
                    onClick={pick}
                    role="presentation"
                  >
                    <div
                      className={`bar ${cat}`}
                      style={{
                        left: `${row.offset_pct}%`,
                        width: `${Math.max(row.width_pct, 0.4)}%`,
                      }}
                    />
                  </div>
                  <div className={`dur${sel}`} onClick={pick} role="presentation">
                    {fmtDuration(row.duration_ms)}
                  </div>
                </div>
              );
            })}
          </div>
        </Panel>
        {selectedSpan != null && (
          <SpanDrawer
            span={selectedSpan}
            attributes={attrsBySpan.get(selectedSpan.span_id ?? "") ?? {}}
          />
        )}
      </div>
    </>
  );
}
