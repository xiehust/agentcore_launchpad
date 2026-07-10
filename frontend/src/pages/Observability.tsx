import { useCallback, useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { useSearchParams } from "react-router-dom";

import { Btn, Panel, useToast, ViewHead } from "../components";
import type { ObsDashboard, ObsSessions, ObsTraces } from "../lib/api";
import { api } from "../lib/api";
import { DashboardTab } from "./observability/DashboardTab";
import { SessionDetailView } from "./observability/SessionDetailView";
import { SessionsTab } from "./observability/SessionsTab";
import { TraceDetailView } from "./observability/TraceDetailView";
import { TracesTab } from "./observability/TracesTab";

const RANGES = ["1h", "6h", "24h", "7d"] as const;
type RangeKey = (typeof RANGES)[number];
const TABS = ["dashboard", "sessions", "traces"] as const;
type TabKey = (typeof TABS)[number];

export function Observability() {
  const { t } = useTranslation();
  const toast = useToast();
  const [params, setParams] = useSearchParams();
  const traceId = params.get("trace");
  const selectedSession = params.get("session");
  const tabParam = params.get("tab") as TabKey | null;
  // Deep links: ?trace= implies the traces tab, ?session= the sessions tab.
  const tab: TabKey =
    tabParam && TABS.includes(tabParam)
      ? tabParam
      : traceId
        ? "traces"
        : selectedSession
          ? "sessions"
          : "dashboard";

  const [range, setRange] = useState<RangeKey>("24h");
  const [dashboard, setDashboard] = useState<ObsDashboard | null>(null);
  const [traces, setTraces] = useState<ObsTraces | null>(null);
  const [sessions, setSessions] = useState<ObsSessions | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [cacheAge, setCacheAge] = useState<number | null>(null);
  const [fetchedAt, setFetchedAt] = useState<number | null>(null);
  const [now, setNow] = useState(() => Date.now());
  const seq = useRef(0);

  const load = useCallback(
    (force: boolean) => {
      const id = ++seq.current;
      setLoading(true);
      setError(null);
      const ok = (age: number) => {
        if (id !== seq.current) return false;
        setCacheAge(age);
        setFetchedAt(Date.now());
        setLoading(false);
        return true;
      };
      const fail = (err: unknown) => {
        if (id !== seq.current) return;
        const msg = err instanceof Error ? err.message : String(err);
        setError(msg);
        setLoading(false);
        toast(t("obs.loadFailed", { msg }), "crit");
      };
      if (tab === "dashboard") {
        api
          .obsDashboard(range, force)
          .then((res) => ok(res.cache.age_seconds) && setDashboard(res))
          .catch(fail);
      } else if (tab === "traces") {
        api
          .obsTraces(range, force)
          .then((res) => ok(res.cache.age_seconds) && setTraces(res))
          .catch(fail);
      } else {
        api
          .obsSessions(range, force)
          .then((res) => ok(res.cache.age_seconds) && setSessions(res))
          .catch(fail);
      }
    },
    [tab, range, t, toast],
  );

  useEffect(() => {
    if (traceId) return; // waterfall view owns its own fetch
    load(false);
  }, [load, traceId]);

  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, []);

  const switchTab = (next: TabKey) => {
    setParams((prev) => {
      const p = new URLSearchParams(prev);
      p.set("tab", next);
      p.delete("trace");
      if (next !== "sessions") p.delete("session");
      return p;
    });
  };

  const openSession = (sessionId: string) => {
    setParams((prev) => {
      const p = new URLSearchParams(prev);
      p.set("tab", "sessions");
      p.set("session", sessionId);
      p.delete("trace");
      return p;
    });
  };

  const openTrace = (id: string) => {
    setParams((prev) => {
      const p = new URLSearchParams(prev);
      p.set("tab", "traces");
      p.set("trace", id);
      return p;
    });
  };

  const activeData =
    tab === "dashboard" ? dashboard : tab === "traces" ? traces : sessions;
  const ageSeconds =
    cacheAge != null && fetchedAt != null
      ? Math.max(0, Math.round(cacheAge + (now - fetchedAt) / 1000))
      : null;

  if (traceId != null) {
    return (
      <section>
        <ViewHead kicker={t("obs.kicker")} title={t("obs.title")} meta={t("obs.meta")} />
        <TraceDetailView
          traceId={traceId}
          range={range}
          onBack={() => switchTab("traces")}
          onOpenSession={openSession}
        />
      </section>
    );
  }

  return (
    <section>
      <ViewHead kicker={t("obs.kicker")} title={t("obs.title")} meta={t("obs.meta")} />

      <div className="obs-bar">
        {TABS.map((key) => (
          <button
            key={key}
            className={`obs-tab${tab === key ? " active" : ""}`}
            onClick={() => switchTab(key)}
          >
            {t(`obs.tabs.${key}`)}
          </button>
        ))}
        <span className="spacer" />
        <span className="cachehint">
          {loading
            ? t("common.loading")
            : ageSeconds != null
              ? t("obs.cachedAgo", { s: ageSeconds })
              : ""}
        </span>
        <button className="refresh" onClick={() => load(true)}>
          ⟳ {t("obs.refresh")}
        </button>
        <div className="range" role="group" aria-label={t("obs.rangeLabel")}>
          {RANGES.map((key) => (
            <button
              key={key}
              className={range === key ? "on" : ""}
              onClick={() => setRange(key)}
            >
              {key.toUpperCase()}
            </button>
          ))}
        </div>
      </div>

      {error != null ? (
        <Panel brk>
          <div className="obs-error">
            <span>{t("obs.loadFailed", { msg: error })}</span>
            <Btn onClick={() => load(true)}>{t("obs.retry")}</Btn>
          </div>
        </Panel>
      ) : activeData == null ? (
        <Panel brk>
          <div className="loading-line">{t("common.loading")}</div>
        </Panel>
      ) : tab === "dashboard" && dashboard ? (
        <DashboardTab data={dashboard} />
      ) : tab === "traces" && traces ? (
        <TracesTab data={traces} onOpenSession={openSession} onOpenTrace={openTrace} />
      ) : tab === "sessions" && sessions ? (
        <SessionsTab data={sessions} selected={selectedSession} onSelect={openSession} />
      ) : null}
      {tab === "sessions" && selectedSession != null && (
        <SessionDetailView sessionId={selectedSession} range={range} onOpenTrace={openTrace} />
      )}
    </section>
  );
}
