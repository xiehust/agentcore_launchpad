import type { CSSProperties } from "react";
import { useCallback, useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { useNavigate } from "react-router-dom";

import { Btn, Chip, ConfirmDialog, Panel, useToast, ViewHead } from "../components";
import type { ChipTone } from "../components";

type RecordType = "A2A" | "MCP" | "AGENT_SKILLS";

interface RegistryRecord {
  record_id: string;
  name: string;
  description: string;
  type: RecordType;
  status: string;
  version: string | null;
  descriptors?: Record<string, unknown>;
  updated_at: string | null;
}

const TABS: { key: RecordType; labelKey: string }[] = [
  { key: "A2A", labelKey: "registry.tabs.agents" },
  { key: "MCP", labelKey: "registry.tabs.tools" },
  { key: "AGENT_SKILLS", labelKey: "registry.tabs.skills" },
];

const STATUS_CHIP: Record<string, { tone: ChipTone; icon: string; labelKey: string }> = {
  DRAFT: { tone: "muted", icon: "○", labelKey: "registry.states.draft" },
  PENDING_APPROVAL: { tone: "warn", icon: "◍", labelKey: "registry.states.submitted" },
  APPROVED: { tone: "good", icon: "●", labelKey: "registry.states.published" },
  REJECTED: { tone: "crit", icon: "✕", labelKey: "registry.states.rejected" },
  DEPRECATED: { tone: "muted", icon: "✕", labelKey: "registry.states.disabled" },
};

function descriptorExcerpt(record: RegistryRecord): string {
  const d = record.descriptors ?? {};
  try {
    const raw = JSON.stringify(d);
    const parsed = JSON.parse(raw, (key, value) => {
      if (key === "inlineContent" && typeof value === "string") {
        try {
          return JSON.parse(value);
        } catch {
          return value.length > 400 ? value.slice(0, 400) + "…" : value;
        }
      }
      return value;
    });
    return JSON.stringify(parsed, null, 2).slice(0, 1800);
  } catch {
    return JSON.stringify(d, null, 2).slice(0, 1800);
  }
}

export function Registry() {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const toast = useToast();
  const [records, setRecords] = useState<RegistryRecord[] | null>(null);
  const [tab, setTab] = useState<RecordType>("A2A");
  const [selected, setSelected] = useState<RegistryRecord | null>(null);
  const [query, setQuery] = useState("");
  const [searching, setSearching] = useState(false);
  const [busy, setBusy] = useState(false);
  const [confirmDisable, setConfirmDisable] = useState<RegistryRecord | null>(null);

  const load = useCallback(async () => {
    try {
      const res = await fetch("/api/registry/records");
      if (!res.ok) {
        setRecords((prev) => prev ?? []);
        return;
      }
      const body = (await res.json()) as { records: RegistryRecord[] };
      setRecords(body.records);
    } catch {
      setRecords((prev) => prev ?? []); // backend offline — show empty state
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const runSearch = async () => {
    if (!query.trim()) {
      setSearching(false);
      void load();
      return;
    }
    setSearching(true);
    const res = await fetch(`/api/registry/records/search?q=${encodeURIComponent(query)}`);
    if (res.ok) {
      const body = (await res.json()) as { records: RegistryRecord[] };
      setRecords(body.records);
    }
  };

  const select = async (record: RegistryRecord) => {
    setSelected(record);
    try {
      const res = await fetch(`/api/registry/records/${record.record_id}`);
      if (res.ok) setSelected((await res.json()) as RegistryRecord);
    } catch {
      /* keep the summary row */
    }
  };

  const action = async (record: RegistryRecord, act: string) => {
    setBusy(true);
    try {
      const res = await fetch(`/api/registry/records/${record.record_id}/action`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: act }),
      });
      if (res.ok) {
        const updated = (await res.json()) as RegistryRecord;
        setSelected(updated);
        void load();
      } else {
        const env = (await res.json().catch(() => ({}))) as { message?: string };
        toast(t("common.actionFailed", { msg: env.message ?? `HTTP ${res.status}` }));
      }
    } catch (err) {
      toast(t("common.actionFailed", { msg: String(err) }));
    } finally {
      setBusy(false);
    }
  };

  const openInWizard = (record: RegistryRecord) => {
    if (record.type === "MCP") {
      navigate(`/create?gateway=${encodeURIComponent(record.name)}`);
      return;
    }
    if (record.type === "AGENT_SKILLS") {
      let path = record.name;
      try {
        const skills = record.descriptors?.agentSkills as
          | { skillDefinition?: { inlineContent?: string } }
          | undefined;
        const definition = JSON.parse(skills?.skillDefinition?.inlineContent ?? "{}") as {
          path?: string;
        };
        if (definition.path) path = definition.path;
      } catch {
        /* fall back to the record name */
      }
      navigate(`/create?skill=${encodeURIComponent(path)}`);
    }
  };

  const loading = records === null;
  const loaded = records ?? [];
  const visible = searching ? loaded : loaded.filter((r) => r.type === tab);
  const counts = (type: RecordType) => loaded.filter((r) => r.type === type).length;

  return (
    <section>
      <ViewHead
        kicker={t("registry.kicker")}
        title={t("registry.title")}
        meta={t("registry.metaLive")}
      />

      <Panel brk pad={false} style={{ "--i": 0, marginBottom: 14 } as CSSProperties}>
        <div className="phead" style={{ borderBottom: 0, paddingBottom: 0 }}>
          <div className="search" style={{ gap: 9 }}>
            ⌕
            <input
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              onKeyDown={(e) => e.key === "Enter" && void runSearch()}
              placeholder={t("registry.searchPlaceholder")}
              style={{
                background: "transparent",
                border: 0,
                outline: "none",
                color: "var(--ink)",
                flex: 1,
                font: "inherit",
              }}
            />
            <span style={{ color: "var(--line-2)" }}>SearchRegistryRecords</span>
          </div>
          <div className="end flowchips">
            <Chip tone="muted" icon="○">{t("registry.states.draft")}</Chip>
            <i>→</i>
            <Chip tone="warn" icon="◍">{t("registry.states.submitted")}</Chip>
            <i>→</i>
            <Chip tone="good" icon="●">{t("registry.states.published")}</Chip>
          </div>
        </div>
        <div className="tabs" style={{ padding: "0 16px" }}>
          {TABS.map(({ key, labelKey }) => (
            <button
              key={key}
              type="button"
              className={`tab${!searching && tab === key ? " active" : ""}`}
              onClick={() => {
                setSearching(false);
                setQuery("");
                setTab(key);
              }}
            >
              {t(labelKey)}
              <span className="cnt">{counts(key)}</span>
            </button>
          ))}
          {searching && <span className="tab active">{t("registry.searchResults")}</span>}
        </div>

        <div className="reg-grid" style={{ padding: 14 }}>
          <div>
            <table>
              <thead>
                <tr>
                  <th>{t("registry.cols.name")}</th>
                  <th>{t("registry.cols.type")}</th>
                  <th>{t("registry.cols.version")}</th>
                  <th>{t("registry.cols.state")}</th>
                </tr>
              </thead>
              <tbody>
                {visible.map((record) => {
                  const chip = STATUS_CHIP[record.status] ?? STATUS_CHIP.DRAFT;
                  return (
                    <tr
                      key={record.record_id}
                      onClick={() => void select(record)}
                      style={{
                        cursor: "pointer",
                        background:
                          selected?.record_id === record.record_id
                            ? "rgba(255,176,0,.045)"
                            : undefined,
                      }}
                    >
                      <td className="pri">{record.name}</td>
                      <td>
                        {record.type === "A2A" ? (
                          <Chip tone="amber" icon="◇">A2A</Chip>
                        ) : record.type === "MCP" ? (
                          <Chip tone="aqua" icon="⇄">GATEWAY · MCP</Chip>
                        ) : (
                          <Chip tone="muted" icon="❖">AGENT_SKILLS</Chip>
                        )}
                      </td>
                      <td className="mono">{record.version ?? "—"}</td>
                      <td>
                        <Chip tone={chip.tone} icon={chip.icon}>{t(chip.labelKey)}</Chip>
                      </td>
                    </tr>
                  );
                })}
                {loading && (
                  <tr>
                    <td colSpan={4} className="loading-line">
                      {t("common.loading")}
                    </td>
                  </tr>
                )}
                {!loading && visible.length === 0 && (
                  <tr>
                    <td colSpan={4} className="dim mono" style={{ textAlign: "center" }}>
                      {t("registry.empty")}
                    </td>
                  </tr>
                )}
              </tbody>
            </table>
          </div>

          <Panel
            className="drawer"
            title={selected?.name ?? "—"}
            end={
              selected &&
              (() => {
                const chip = STATUS_CHIP[selected.status] ?? STATUS_CHIP.DRAFT;
                return <Chip tone={chip.tone} icon={chip.icon}>{t(chip.labelKey)}</Chip>;
              })()
            }
            pad={false}
            style={{ borderColor: "var(--line-2)" }}
          >
            {selected && (
              <>
                <div className="sect">
                  <div className="kv">
                    <span className="k">{t("registry.drawer.type")}</span>
                    <span className="v">{selected.type}</span>
                  </div>
                  <div className="kv">
                    <span className="k">{t("registry.drawer.version")}</span>
                    <span className="v">{selected.version ?? "—"}</span>
                  </div>
                  <div className="kv">
                    <span className="k">{t("registry.drawer.recordId")}</span>
                    <span className="v">{selected.record_id}</span>
                  </div>
                  <div className="kv">
                    <span className="k">{t("registry.drawer.updated")}</span>
                    <span className="v">{selected.updated_at?.slice(0, 19) ?? "—"}</span>
                  </div>
                </div>
                <div className="sect">
                  <h4>{t("registry.drawer.descriptor")}</h4>
                  <div className="code" style={{ maxHeight: 260, overflowY: "auto" }}>
                    {descriptorExcerpt(selected)}
                  </div>
                </div>
                <div className="sect" style={{ display: "flex", gap: 9, borderBottom: 0, flexWrap: "wrap" }}>
                  {selected.type !== "A2A" && (
                    <Btn
                      primary
                      style={{ flex: 1, justifyContent: "center" }}
                      onClick={() => openInWizard(selected)}
                    >
                      {t("registry.drawer.useInNewAgent")}
                    </Btn>
                  )}
                  {selected.status === "DRAFT" && (
                    <Btn disabled={busy} onClick={() => void action(selected, "submit")}>
                      {t("registry.drawer.submit")}
                    </Btn>
                  )}
                  {selected.status === "PENDING_APPROVAL" && (
                    <Btn disabled={busy} onClick={() => void action(selected, "approve")}>
                      {t("registry.drawer.approve")}
                    </Btn>
                  )}
                  {selected.status === "APPROVED" && (
                    <Btn disabled={busy} onClick={() => setConfirmDisable(selected)}>
                      {t("registry.drawer.disable")}
                    </Btn>
                  )}
                </div>
              </>
            )}
          </Panel>
        </div>
      </Panel>

      <ConfirmDialog
        open={confirmDisable !== null}
        title={t("registry.confirmDisable.title")}
        body={t("registry.confirmDisable.body", { name: confirmDisable?.name ?? "" })}
        confirmLabel={t("registry.drawer.disable")}
        onConfirm={() => {
          if (confirmDisable) void action(confirmDisable, "disable");
          setConfirmDisable(null);
        }}
        onCancel={() => setConfirmDisable(null)}
      />
    </section>
  );
}
