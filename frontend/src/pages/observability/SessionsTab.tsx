import type { CSSProperties } from "react";
import { useTranslation } from "react-i18next";

import { Chip, DataTable, Panel, useToast } from "../../components";
import type { ObsSessions } from "../../lib/api";
import { fmtClockShort, fmtCost, fmtInt, shortId } from "./format";

interface SessionsTabProps {
  data: ObsSessions;
  selected: string | null;
  onSelect: (sessionId: string) => void;
}

export function SessionsTab({ data, selected, onSelect }: SessionsTabProps) {
  const { t } = useTranslation();
  const toast = useToast();

  const copyId = (id: string) => {
    try {
      // navigator.clipboard is undefined in non-secure contexts (http LAN)
      navigator.clipboard
        .writeText(id)
        .then(() => toast(t("obs.sessions.copied"), "good"))
        .catch(() => toast(t("obs.sessions.copyFailed"), "warn"));
    } catch {
      toast(t("obs.sessions.copyFailed"), "warn");
    }
  };

  return (
    <Panel brk pad={false} style={{ "--i": 0 } as CSSProperties}>
      <DataTable
        columns={[
          { key: "session", label: t("obs.sessions.cols.session") },
          { key: "agent", label: t("obs.sessions.cols.agent") },
          { key: "traces", label: t("obs.sessions.cols.traces") },
          { key: "llm", label: t("obs.sessions.cols.llmCalls") },
          { key: "tokens", label: t("obs.sessions.cols.tokensCost") },
          { key: "first", label: t("obs.sessions.cols.first") },
          { key: "last", label: t("obs.sessions.cols.last") },
          { key: "errors", label: t("obs.sessions.cols.errors") },
        ]}
        isEmpty={data.sessions.length === 0}
        empty={t("obs.sessions.empty")}
      >
        {data.sessions.map((r) => (
          <tr
            key={r.session_id}
            className={`rowlink${selected === r.session_id ? " sel" : ""}`}
            onClick={() => onSelect(r.session_id)}
          >
            <td>
              <span className="sid" title={r.session_id}>
                {shortId(r.session_id, 20)}
              </span>{" "}
              <button
                className="sid"
                aria-label={t("obs.sessions.copy")}
                title={t("obs.sessions.copy")}
                onClick={(e) => {
                  e.stopPropagation();
                  copyId(r.session_id);
                }}
              >
                ⧉
              </button>
            </td>
            <td className="mono">{r.agent}</td>
            <td className="mono">{r.traces}</td>
            <td className="mono dim">{r.llm_calls}</td>
            <td className="mono">
              {r.tokens.total > 0
                ? `${fmtInt(r.tokens.total)} · ${fmtCost(r.est_cost_usd)}`
                : "— · —"}
            </td>
            <td className="mono dim">{fmtClockShort(r.first)}</td>
            <td className="mono dim">{fmtClockShort(r.last)}</td>
            <td>
              {r.errors > 0 ? (
                <Chip tone="crit" icon="✕">
                  {r.errors}
                </Chip>
              ) : (
                <Chip tone="good" icon="●">
                  0
                </Chip>
              )}
            </td>
          </tr>
        ))}
      </DataTable>
    </Panel>
  );
}
