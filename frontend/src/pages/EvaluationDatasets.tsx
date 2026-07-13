import type { CSSProperties } from "react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { useSearchParams } from "react-router-dom";

import { Btn, Chip, ConfirmDialog, Panel, useToast, ViewHead } from "../components";

interface CloudBlob {
  dataset_id: string;
  arn?: string | null;
  status: string;
  synced_at?: string | null;
  failure_reason?: string | null;
}

interface DatasetRow {
  id: string;
  name: string;
  kind: string;
  locale: string;
  description: string;
  item_count: number;
  items: Record<string, unknown>[];
  cloud: CloudBlob | null;
  has_ground_truth: boolean;
}

interface CloudRow {
  datasetId: string;
  name: string | null;
  status: string | null;
  schemaType: string | null;
  exampleCount: number | null;
  updatedAt: string | null;
}

interface TurnDraft {
  input: string;
  expected_response: string;
}

interface ScenarioDraft {
  scenario_id: string;
  turns: TurnDraft[];
  assertions: string[];
  expected_trajectory: string; // comma-separated tool names
}

// Same "cloud:" id encoding as the New Run scope dropdown / runs-list rows.
const CLOUD_PREFIX = "cloud:";

type Selection =
  | { kind: "local"; row: DatasetRow }
  | { kind: "cloud"; row: CloudRow }
  | null;

const emptyScenario = (index: number): ScenarioDraft => ({
  scenario_id: `scenario_${index}`,
  turns: [{ input: "", expected_response: "" }],
  assertions: [],
  expected_trajectory: "",
});

// 3-scenario math sample with ground truth (expected_trajectory names the
// zip template's real `calculator` tool) — sync-ready for dataset runs.
const SAMPLE_SCENARIOS = (): ScenarioDraft[] => [
  {
    scenario_id: "add_two_numbers",
    turns: [{ input: "What is 17 + 25? Use your calculator tool.", expected_response: "42" }],
    assertions: ["The agent returns the exact sum 42"],
    expected_trajectory: "calculator",
  },
  {
    scenario_id: "multiply_then_add",
    turns: [
      { input: "Multiply 6 by 7 with your calculator tool.", expected_response: "42" },
      { input: "Now add 8 to that result.", expected_response: "50" },
    ],
    assertions: ["The agent keeps the running result across turns"],
    expected_trajectory: "calculator",
  },
  {
    scenario_id: "plain_greeting",
    turns: [{ input: "Say hello in one short sentence.", expected_response: "" }],
    assertions: [],
    expected_trajectory: "",
  },
];

// Any stored item (legacy prompt or devguide scenario) → editor draft.
function toDrafts(items: Record<string, unknown>[]): ScenarioDraft[] {
  return items.map((item, i) => {
    if ("turns" in item) {
      const turns = (item.turns as Record<string, unknown>[]).map((turn) => {
        const raw = turn.input;
        const input =
          typeof raw === "object" && raw !== null
            ? String(
                (raw as Record<string, unknown>).content ??
                  (raw as Record<string, unknown>).prompt ??
                  "",
              )
            : String(raw ?? "");
        return { input, expected_response: String(turn.expected_response ?? "") };
      });
      return {
        scenario_id: String(item.scenario_id ?? `scenario_${i + 1}`),
        turns,
        assertions: ((item.assertions as string[] | undefined) ?? []).map(String),
        expected_trajectory: ((item.expected_trajectory as string[] | undefined) ?? []).join(", "),
      };
    }
    return {
      scenario_id: `item_${i + 1}`,
      turns: [
        { input: String(item.prompt ?? ""), expected_response: String(item.expected ?? "") },
      ],
      assertions: [],
      expected_trajectory: "",
    };
  });
}

// Editor drafts → items to store. Legacy datasets keep their shape when the
// content still fits it (kind is immutable server-side).
function toItems(scenarios: ScenarioDraft[], kind: string): Record<string, unknown>[] {
  const fitsLegacy = scenarios.every(
    (s) =>
      s.turns.length === 1 &&
      !s.assertions.some((a) => a.trim()) &&
      !s.expected_trajectory.trim(),
  );
  if (kind === "legacy" && fitsLegacy) {
    return scenarios.map((s) => ({
      prompt: s.turns[0].input,
      ...(s.turns[0].expected_response.trim()
        ? { expected: s.turns[0].expected_response.trim() }
        : {}),
    }));
  }
  return scenarios.map((s) => {
    const assertions = s.assertions.map((a) => a.trim()).filter(Boolean);
    const trajectory = s.expected_trajectory
      .split(",")
      .map((x) => x.trim())
      .filter(Boolean);
    return {
      scenario_id: s.scenario_id.trim(),
      turns: s.turns.map((turn) => ({
        input: turn.input,
        ...(turn.expected_response.trim()
          ? { expected_response: turn.expected_response.trim() }
          : {}),
      })),
      ...(assertions.length ? { assertions } : {}),
      ...(trajectory.length ? { expected_trajectory: trajectory } : {}),
    };
  });
}

export function DatasetsView({ onBack }: { onBack: () => void }) {
  const { t } = useTranslation();
  const toast = useToast();
  const [rows, setRows] = useState<DatasetRow[]>([]);
  const [cloudRows, setCloudRows] = useState<CloudRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [cloudError, setCloudError] = useState(false);
  const [syncingId, setSyncingId] = useState<string | null>(null);
  const [syncError, setSyncError] = useState<string | null>(null);
  const [confirmLocal, setConfirmLocal] = useState<DatasetRow | null>(null);
  const [confirmCloud, setConfirmCloud] = useState<CloudRow | null>(null);

  // editor state
  const [editorMode, setEditorMode] = useState<"form" | "import">("form");
  const [editingKind, setEditingKind] = useState("predefined");
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [scenarios, setScenarios] = useState<ScenarioDraft[]>([emptyScenario(1)]);
  const [importText, setImportText] = useState("");
  const [busy, setBusy] = useState(false);
  const [formError, setFormError] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const res = await fetch("/api/eval/datasets");
      if (res.ok) {
        setRows(((await res.json()) as { datasets: DatasetRow[] }).datasets);
      }
    } catch {
      /* backend offline */
    } finally {
      setLoading(false);
    }
    try {
      const res = await fetch("/api/eval/datasets/cloud");
      if (!res.ok) throw new Error(`http ${res.status}`);
      setCloudRows(((await res.json()) as { datasets: CloudRow[] }).datasets);
      setCloudError(false);
    } catch {
      setCloudError(true);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  // "?ds=<id>" selects a local row, "?ds=cloud:<datasetId>" a cloud-only row,
  // "?ds=new" the create form (linkable, back-button friendly).
  const [searchParams, setSearchParams] = useSearchParams();
  const dsParam = searchParams.get("ds");
  const creatingNew = dsParam === "new";
  const selectDs = (id: string | null) => {
    setSearchParams(id ? { view: "datasets", ds: id } : { view: "datasets" });
  };

  // Cloud rows that are the synced copy of a local dataset render as that
  // row's CLOUD chip — only cloud-ONLY snapshots get their own table row.
  const cloudOnly = useMemo(
    () => cloudRows.filter((c) => !rows.some((r) => r.cloud?.dataset_id === c.datasetId)),
    [cloudRows, rows],
  );

  const selection = useMemo<Selection>(() => {
    if (creatingNew) return null;
    if (dsParam?.startsWith(CLOUD_PREFIX)) {
      // no local fallback while the cloud list loads — hydrating the editor
      // with an unrelated local row would be worse than a brief empty panel
      const id = dsParam.slice(CLOUD_PREFIX.length);
      const row = cloudRows.find((r) => r.datasetId === id);
      return row ? { kind: "cloud", row } : null;
    }
    const row = (dsParam ? rows.find((r) => r.id === dsParam) : undefined) ?? rows[0];
    return row ? { kind: "local", row } : null;
  }, [creatingNew, dsParam, rows, cloudRows]);

  const local = selection?.kind === "local" ? selection.row : null;
  const cloud = selection?.kind === "cloud" ? selection.row : null;
  const editingId = local?.id ?? null;

  // Editor hydration keys off the selected KEY, not the row object: sync()
  // and save() both re-load(), which replaces row identities — re-hydrating
  // then would wipe unsaved edits. The ref carries the current row into the
  // effect without widening its dependency list.
  const selKey =
    selection === null
      ? "new"
      : selection.kind === "local"
        ? `local:${selection.row.id}`
        : `cloud:${selection.row.datasetId}`;
  const selRef = useRef<Selection>(null);
  selRef.current = selection;
  useEffect(() => {
    const sel = selRef.current;
    setEditorMode("form");
    setFormError(null);
    setSyncError(null);
    if (sel?.kind === "local") {
      setEditingKind(sel.row.kind);
      setName(sel.row.name);
      setDescription(sel.row.description ?? "");
      setScenarios(toDrafts(sel.row.items));
    } else {
      setEditingKind("predefined");
      setName("");
      setDescription("");
      setScenarios([emptyScenario(1)]);
      setImportText("");
    }
  }, [selKey]);

  const importPreview = useMemo((): { items: Record<string, unknown>[]; error: string | null } => {
    const trimmed = importText.trim();
    if (!trimmed) return { items: [], error: null };
    // Whole-document JSON first: {scenarios:[...]}, a bare array, or one
    // object. Legacy JSONL also starts with "{" but fails this parse on the
    // second line, so it falls through to the per-line branch below.
    try {
      const parsed: unknown = JSON.parse(trimmed);
      if (Array.isArray(parsed)) return { items: parsed as Record<string, unknown>[], error: null };
      if (parsed && typeof parsed === "object") {
        const scen = (parsed as { scenarios?: unknown }).scenarios;
        if (Array.isArray(scen)) return { items: scen as Record<string, unknown>[], error: null };
        if (scen !== undefined) {
          return { items: [], error: t("evalPage.datasets.importNoScenarios") };
        }
        return { items: [parsed as Record<string, unknown>], error: null };
      }
      return { items: [], error: t("evalPage.datasets.importNoScenarios") };
    } catch {
      /* not a single JSON document — try JSONL */
    }
    const items: Record<string, unknown>[] = [];
    const lines = trimmed.split("\n");
    for (let i = 0; i < lines.length; i++) {
      if (!lines[i].trim()) continue;
      try {
        items.push(JSON.parse(lines[i]) as Record<string, unknown>);
      } catch {
        return { items: [], error: t("evalPage.datasets.importBadLine", { line: i + 1 }) };
      }
    }
    return { items, error: null };
  }, [importText, t]);

  const patchScenario = (index: number, patch: Partial<ScenarioDraft>) => {
    setScenarios((prev) => prev.map((s, i) => (i === index ? { ...s, ...patch } : s)));
  };

  const save = async () => {
    setFormError(null);
    if (!name.trim()) {
      setFormError(t("evalPage.datasets.nameRequired"));
      return;
    }
    const items =
      editorMode === "import" ? importPreview.items : toItems(scenarios, editingId ? editingKind : "predefined");
    if (editorMode === "import" && (importPreview.error || items.length === 0)) {
      setFormError(importPreview.error ?? t("evalPage.datasets.importEmpty"));
      return;
    }
    setBusy(true);
    try {
      const res = editingId
        ? await fetch(`/api/eval/datasets/${editingId}`, {
            method: "PUT",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ name: name.trim(), description, items }),
          })
        : await fetch("/api/eval/datasets", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ name: name.trim(), description, items }),
          });
      if (!res.ok) {
        const env = (await res.json().catch(() => ({}))) as { message?: string };
        setFormError(env.message ?? `HTTP ${res.status}`);
        return;
      }
      if (editingId) {
        toast(t("evalPage.datasets.updated"));
        await load(); // selKey unchanged — the saved edits stay on screen
      } else {
        toast(t("evalPage.datasets.created"));
        const created = (await res.json()) as { id: string };
        await load();
        selectDs(created.id);
      }
    } finally {
      setBusy(false);
    }
  };

  const sync = async (row: DatasetRow) => {
    setSyncingId(row.id);
    setSyncError(null);
    try {
      const res = await fetch(`/api/eval/datasets/${row.id}/sync-to-aws`, { method: "POST" });
      if (!res.ok) {
        const env = (await res.json().catch(() => ({}))) as { message?: string };
        setSyncError(env.message ?? `HTTP ${res.status}`);
      } else {
        toast(t("evalPage.datasets.synced"));
      }
      await load();
    } finally {
      setSyncingId(null);
    }
  };

  const deleteLocal = async (row: DatasetRow) => {
    const res = await fetch(`/api/eval/datasets/${row.id}`, { method: "DELETE" });
    if (!res.ok) {
      const env = (await res.json().catch(() => ({}))) as { message?: string };
      toast(t("common.actionFailed", { msg: env.message ?? `HTTP ${res.status}` }));
      return;
    }
    toast(t("evalPage.datasets.deleted"));
    if (dsParam === row.id) selectDs(null);
    await load();
  };

  const deleteCloud = async (row: CloudRow) => {
    const res = await fetch(`/api/eval/datasets/cloud/${row.datasetId}`, { method: "DELETE" });
    if (!res.ok) {
      const env = (await res.json().catch(() => ({}))) as { message?: string };
      toast(t("common.actionFailed", { msg: env.message ?? `HTTP ${res.status}` }));
      return;
    }
    toast(t("evalPage.datasets.cloudDeleted"));
    if (dsParam === CLOUD_PREFIX + row.datasetId) selectDs(null);
    await load();
  };

  const cloudChip = (row: DatasetRow) => {
    if (!row.cloud) return <Chip tone="muted">{t("evalPage.datasets.notSynced")}</Chip>;
    if (row.cloud.status === "ACTIVE") return <Chip tone="good" icon="●">ACTIVE</Chip>;
    if (row.cloud.status === "deleted")
      return <Chip tone="muted">{t("evalPage.datasets.cloudGone")}</Chip>;
    return <Chip tone="crit" icon="✕">{row.cloud.status}</Chip>;
  };

  const scenarioEditor = (
    <>
      {scenarios.map((scenario, si) => (
        <div
          key={si}
          style={{
            border: "1px solid rgba(255,255,255,.08)",
            borderRadius: 4,
            padding: "10px 12px",
            marginBottom: 10,
          }}
        >
          <div style={{ display: "flex", gap: 6, alignItems: "center", marginBottom: 8 }}>
            <input
              className="input mono"
              value={scenario.scenario_id}
              aria-label={t("evalPage.datasets.scenarioId")}
              style={{ maxWidth: 220 }}
              onChange={(e) => patchScenario(si, { scenario_id: e.target.value })}
            />
            <Btn
              disabled={scenarios.length <= 1}
              style={{ marginLeft: "auto" }}
              title={t("evalPage.datasets.removeScenario")}
              onClick={() => setScenarios((prev) => prev.filter((_, i) => i !== si))}
            >
              ✕
            </Btn>
          </div>
          {scenario.turns.map((turn, ti) => (
            <div key={ti} style={{ display: "flex", gap: 6, marginBottom: 6 }}>
              <span className="mono dim" style={{ fontSize: 9.5, paddingTop: 8 }}>
                T{ti + 1}
              </span>
              <textarea
                className="input"
                rows={1}
                placeholder={t("evalPage.datasets.turnInput")}
                value={turn.input}
                style={{ flex: 2, resize: "vertical", fontSize: 11.5 }}
                onChange={(e) =>
                  patchScenario(si, {
                    turns: scenario.turns.map((x, i) =>
                      i === ti ? { ...x, input: e.target.value } : x,
                    ),
                  })
                }
              />
              <input
                className="input"
                placeholder={t("evalPage.datasets.turnExpected")}
                value={turn.expected_response}
                style={{ flex: 1, fontSize: 11.5 }}
                onChange={(e) =>
                  patchScenario(si, {
                    turns: scenario.turns.map((x, i) =>
                      i === ti ? { ...x, expected_response: e.target.value } : x,
                    ),
                  })
                }
              />
              <Btn
                disabled={scenario.turns.length <= 1}
                title={t("evalPage.datasets.removeTurn")}
                onClick={() =>
                  patchScenario(si, {
                    turns: scenario.turns.filter((_, i) => i !== ti),
                  })
                }
              >
                ✕
              </Btn>
            </div>
          ))}
          <Btn
            onClick={() =>
              patchScenario(si, {
                turns: [...scenario.turns, { input: "", expected_response: "" }],
              })
            }
          >
            + {t("evalPage.datasets.addTurn")}
          </Btn>
          <div className="field" style={{ marginTop: 8 }}>
            <label>{t("evalPage.datasets.assertions")}</label>
            {scenario.assertions.map((assertion, ai) => (
              <div key={ai} style={{ display: "flex", gap: 6, marginBottom: 4 }}>
                <input
                  className="input"
                  value={assertion}
                  style={{ fontSize: 11.5 }}
                  onChange={(e) =>
                    patchScenario(si, {
                      assertions: scenario.assertions.map((x, i) =>
                        i === ai ? e.target.value : x,
                      ),
                    })
                  }
                />
                <Btn
                  title={t("evalPage.datasets.removeAssertion")}
                  onClick={() =>
                    patchScenario(si, {
                      assertions: scenario.assertions.filter((_, i) => i !== ai),
                    })
                  }
                >
                  ✕
                </Btn>
              </div>
            ))}
            <Btn
              onClick={() =>
                patchScenario(si, { assertions: [...scenario.assertions, ""] })
              }
            >
              + {t("evalPage.datasets.addAssertion")}
            </Btn>
          </div>
          <div className="field" style={{ marginBottom: 0 }}>
            <label>{t("evalPage.datasets.trajectory")}</label>
            <input
              className="input mono"
              placeholder="calculator, current_time"
              value={scenario.expected_trajectory}
              style={{ fontSize: 11 }}
              onChange={(e) =>
                patchScenario(si, { expected_trajectory: e.target.value })
              }
            />
          </div>
        </div>
      ))}
      <Btn
        onClick={() => setScenarios((prev) => [...prev, emptyScenario(prev.length + 1)])}
      >
        + {t("evalPage.datasets.addScenario")}
      </Btn>
    </>
  );

  return (
    <section>
      <ViewHead
        kicker={t("evaluation.kicker")}
        title={t("evalPage.datasets.title")}
        meta={t("evalPage.datasets.meta")}
      />
      <div style={{ marginBottom: 14 }}>
        <Btn onClick={onBack}>◂ {t("evalPage.backToRuns")}</Btn>
      </div>

      <Panel
        brk
        pad={false}
        title={t("evalPage.datasets.listTitle")}
        sub={t("evalPage.datasets.listSub")}
        end={
          <Btn primary data-testid="new-dataset-btn" onClick={() => selectDs("new")}>
            + {t("evalPage.datasets.new")}
          </Btn>
        }
        style={{ "--i": 0, marginBottom: 14 } as CSSProperties}
      >
        <table>
          <thead>
            <tr>
              <th>{t("evalPage.datasets.col.name")}</th>
              <th>{t("evalPage.datasets.col.items")}</th>
              <th>{t("evalPage.datasets.col.kind")}</th>
              <th>{t("evalPage.datasets.col.gt")}</th>
              <th>{t("evalPage.datasets.col.cloud")}</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((row) => (
              <tr
                key={row.id}
                data-testid={`dataset-row-${row.id}`}
                onClick={() => selectDs(row.id)}
                style={{
                  cursor: "pointer",
                  background:
                    local?.id === row.id ? "rgba(255,176,0,.045)" : undefined,
                }}
              >
                <td className="pri">{row.name}</td>
                <td className="mono dim">{row.item_count}</td>
                <td className="mono dim">{row.kind}</td>
                <td>
                  {row.has_ground_truth ? (
                    <Chip tone="aqua" icon="◆">{t("evalPage.datasets.gt")}</Chip>
                  ) : (
                    <span className="mono dim">—</span>
                  )}
                </td>
                <td>{cloudChip(row)}</td>
              </tr>
            ))}
            {cloudOnly.map((row) => (
              <tr
                key={row.datasetId}
                data-testid={`dataset-row-cloud-${row.datasetId}`}
                onClick={() => selectDs(CLOUD_PREFIX + row.datasetId)}
                style={{
                  cursor: "pointer",
                  background:
                    cloud?.datasetId === row.datasetId ? "rgba(255,176,0,.045)" : undefined,
                }}
              >
                <td className="mono">☁ {row.name ?? row.datasetId}</td>
                <td className="mono dim">{row.exampleCount ?? "—"}</td>
                <td className="mono dim">
                  {(row.schemaType ?? "").replace("AGENTCORE_EVALUATION_", "")}
                </td>
                <td className="mono dim">—</td>
                <td>
                  <Chip tone={row.status === "ACTIVE" ? "good" : "warn"}>{row.status}</Chip>
                </td>
              </tr>
            ))}
            {loading && (
              <tr>
                <td colSpan={5} className="dim mono" style={{ textAlign: "center" }}>
                  {t("common.loading")}
                </td>
              </tr>
            )}
            {!loading && rows.length === 0 && cloudOnly.length === 0 && !cloudError && (
              <tr>
                <td colSpan={5} className="dim mono" style={{ textAlign: "center" }}>
                  {t("evalPage.datasets.empty")}
                </td>
              </tr>
            )}
            {cloudError && (
              <tr>
                <td colSpan={5} className="dim mono" style={{ textAlign: "center" }}>
                  {t("evalPage.datasets.cloudUnavailable")}
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </Panel>

      <div className="eval-grid">
        <Panel
          brk
          title={
            local
              ? t("evalPage.datasets.formTitleEdit")
              : cloud
                ? `☁ ${cloud.name ?? cloud.datasetId}`
                : t("evalPage.datasets.formTitleCreate")
          }
          sub={
            local
              ? `${local.id} · ${local.kind}`
              : cloud
                ? (cloud.schemaType ?? "").replace("AGENTCORE_EVALUATION_", "")
                : t("evalPage.datasets.formSub")
          }
          end={
            local ? (
              <>
                <Btn
                  disabled={syncingId !== null}
                  onClick={() => void sync(local)}
                  data-testid={`sync-${local.name}`}
                >
                  {syncingId === local.id
                    ? `◐ ${t("evalPage.datasets.syncing")}`
                    : t("evalPage.datasets.sync")}
                </Btn>
                <Btn onClick={() => setConfirmLocal(local)}>
                  {t("evalPage.datasets.delete")}
                </Btn>
              </>
            ) : cloud ? (
              <Btn onClick={() => setConfirmCloud(cloud)}>
                {t("evalPage.datasets.delete")}
              </Btn>
            ) : (
              <Btn
                onClick={() => {
                  setEditorMode("form");
                  setName("math-gt-sample");
                  setDescription("3 scenarios with ground truth (calculator trajectory)");
                  setScenarios(SAMPLE_SCENARIOS());
                }}
              >
                {t("evalPage.datasets.prefill")}
              </Btn>
            )
          }
          style={{ "--i": 1 } as CSSProperties}
        >
          {cloud ? (
            <>
              <div className="kv">
                <span className="k mono">{t("evalPage.datasets.detail.id")}</span>
                <span className="v mono">{cloud.datasetId}</span>
              </div>
              <div className="kv">
                <span className="k mono">{t("evalPage.datasets.detail.schema")}</span>
                <span className="v mono">{cloud.schemaType ?? "—"}</span>
              </div>
              <div className="kv">
                <span className="k mono">{t("evalPage.datasets.detail.examples")}</span>
                <span className="v mono">{cloud.exampleCount ?? "—"}</span>
              </div>
              <div className="kv">
                <span className="k mono">{t("evalPage.datasets.detail.status")}</span>
                <span className="v">
                  <Chip tone={cloud.status === "ACTIVE" ? "good" : "warn"}>{cloud.status}</Chip>
                </span>
              </div>
              <div className="kv">
                <span className="k mono">{t("evalPage.datasets.detail.updated")}</span>
                <span className="v mono">
                  {cloud.updatedAt ? new Date(cloud.updatedAt).toLocaleString() : "—"}
                </span>
              </div>
              <div className="note" style={{ marginTop: 10 }}>
                <span className="i">[i]</span>
                <span>{t("evalPage.datasets.cloudReadonly")}</span>
              </div>
            </>
          ) : (
            <>
              {/* import stays create-only: kind is inferred once at creation */}
              {!local && (
                <div className="field">
                  <div className="selchips">
                    <button
                      type="button"
                      className={`selchip${editorMode === "form" ? " on" : ""}`}
                      style={{ cursor: "pointer" }}
                      onClick={() => setEditorMode("form")}
                    >
                      {t("evalPage.datasets.modeForm")}
                    </button>
                    <button
                      type="button"
                      className={`selchip${editorMode === "import" ? " on" : ""}`}
                      style={{ cursor: "pointer" }}
                      onClick={() => setEditorMode("import")}
                    >
                      {t("evalPage.datasets.modeImport")}
                    </button>
                  </div>
                </div>
              )}
              <div className="field">
                <label>{t("evalPage.datasets.name")}</label>
                <input className="input" value={name} onChange={(e) => setName(e.target.value)} />
              </div>
              <div className="field">
                <label>{t("evalPage.datasets.description")}</label>
                <input
                  className="input"
                  value={description}
                  onChange={(e) => setDescription(e.target.value)}
                />
              </div>

              {editorMode === "import" && !local ? (
                <div className="field">
                  <label>{t("evalPage.datasets.importLabel")}</label>
                  <textarea
                    className="input mono"
                    rows={9}
                    style={{ fontSize: 10.5, lineHeight: 1.5, resize: "vertical" }}
                    placeholder={'{"scenarios": [...]}  |  {"prompt": "...", "expected": "..."} per line'}
                    value={importText}
                    onChange={(e) => setImportText(e.target.value)}
                  />
                  {importPreview.error ? (
                    <div className="note" style={{ borderColor: "var(--crit)", marginTop: 6 }}>
                      <span className="i" style={{ color: "var(--crit)" }}>[✕]</span>
                      <span className="mono" style={{ fontSize: 10.5 }}>{importPreview.error}</span>
                    </div>
                  ) : (
                    <div className="mono dim" style={{ fontSize: 10, marginTop: 6 }}>
                      {t("evalPage.datasets.importPreview", { count: importPreview.items.length })}
                    </div>
                  )}
                </div>
              ) : (
                scenarioEditor
              )}

              {local?.cloud?.failure_reason && (
                <div className="note" style={{ borderColor: "var(--crit)", marginTop: 10 }}>
                  <span className="i" style={{ color: "var(--crit)" }}>[✕]</span>
                  <span className="mono" style={{ fontSize: 10 }}>
                    {local.cloud.failure_reason}
                  </span>
                </div>
              )}
              {syncError && (
                <div className="note" style={{ borderColor: "var(--crit)", marginTop: 10 }}>
                  <span className="i" style={{ color: "var(--crit)" }}>[✕]</span>
                  <span>{syncError}</span>
                </div>
              )}
              {formError && (
                <div className="note" style={{ borderColor: "var(--crit)", margin: "10px 0" }}>
                  <span className="i" style={{ color: "var(--crit)" }}>[✕]</span>
                  <span>{formError}</span>
                </div>
              )}
              <div style={{ display: "flex", justifyContent: "flex-end", gap: 8, marginTop: 10 }}>
                <Btn primary disabled={busy || !name.trim()} onClick={() => void save()}>
                  ▸ {local ? t("evalPage.datasets.save") : t("evalPage.datasets.create")}
                </Btn>
              </div>
            </>
          )}
        </Panel>

        <Panel
          title={t("evalPage.datasets.how.title")}
          sub={t("evalPage.datasets.how.sub")}
          style={{ "--i": 2 } as CSSProperties}
        >
          {(["s1", "s2", "s3", "s4"] as const).map((step, i) => (
            <div className="kv" key={step}>
              <span className="k mono">{`0${i + 1}`}</span>
              <span className="v" style={{ textAlign: "left", flex: 1, marginLeft: 12 }}>
                {t(`evalPage.datasets.how.${step}`)}
              </span>
            </div>
          ))}
          <div className="note" style={{ marginTop: 10 }}>
            <span className="i">[i]</span>
            <span>{t("evalPage.datasets.how.note")}</span>
          </div>
        </Panel>
      </div>

      <ConfirmDialog
        open={confirmLocal !== null}
        title={t("evalPage.datasets.confirmDelete.title")}
        body={t("evalPage.datasets.confirmDelete.body", { name: confirmLocal?.name ?? "" })}
        confirmLabel={t("evalPage.datasets.delete")}
        onConfirm={() => {
          const row = confirmLocal;
          setConfirmLocal(null);
          if (row) void deleteLocal(row);
        }}
        onCancel={() => setConfirmLocal(null)}
      />
      <ConfirmDialog
        open={confirmCloud !== null}
        title={t("evalPage.datasets.confirmCloudDelete.title")}
        body={t("evalPage.datasets.confirmCloudDelete.body", {
          name: confirmCloud?.name ?? confirmCloud?.datasetId ?? "",
        })}
        confirmLabel={t("evalPage.datasets.delete")}
        onConfirm={() => {
          const row = confirmCloud;
          setConfirmCloud(null);
          if (row) void deleteCloud(row);
        }}
        onCancel={() => setConfirmCloud(null)}
      />
    </section>
  );
}
