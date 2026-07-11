import { useCallback, useEffect, useState } from "react";
import { useTranslation } from "react-i18next";

import { Btn } from "../../components";
import type { RegistryRecord } from "../Registry";

const NAME_RE = /^[a-z][a-z0-9-]{2,63}$/;

interface GitSkill {
  index: number;
  name: string;
  description: string;
  version: string;
  files: string[];
  skill_md_excerpt: string;
  valid: boolean;
  errors: string[];
}

interface InspectResponse {
  skills: GitSkill[];
  staging_id: string;
}

interface ImportResultItem {
  name: string;
  ok: boolean;
  record?: RegistryRecord;
  error?: string;
}

interface ImportResponse {
  records: ImportResultItem[];
}

interface ImportSelection {
  index: number;
  name: string;
  name_override?: string;
  description_override?: string;
}

interface GitCapabilities {
  available: boolean;
  version: string | null;
  fallback_hosts: string[];
  install: { auto_installable: boolean; package_manager: string | null; hint: string };
}

interface GitInstallResponse {
  ok: boolean;
  git_version?: string;
  error?: string;
  hint?: string;
}

interface GitSourcePanelProps {
  /** called after every selected skill imports successfully so the parent can reset + reload */
  onImported: (record: RegistryRecord | null, name: string) => void;
}

type RowResult = { ok: boolean; error?: string };

/** Git-source branch of the skill register form: scan a repo (single skill or a
 * monorepo with many SKILL.md), then batch-import the selected ones. Reports git
 * availability + archive-download fallback via the capabilities endpoint. */
export function GitSourcePanel({ onImported }: GitSourcePanelProps) {
  const { t } = useTranslation();

  const [url, setUrl] = useState("");
  const [ref, setRef] = useState("");
  const [subdir, setSubdir] = useState("");
  const [token, setToken] = useState("");

  const [scanning, setScanning] = useState(false);
  const [scanError, setScanError] = useState<string | null>(null);
  const [stagingId, setStagingId] = useState<string | null>(null);
  const [skills, setSkills] = useState<GitSkill[] | null>(null);
  const [checked, setChecked] = useState<Record<number, boolean>>({});
  const [names, setNames] = useState<Record<number, string>>({});
  const [results, setResults] = useState<Record<number, RowResult>>({});
  const [importing, setImporting] = useState(false);

  const [caps, setCaps] = useState<GitCapabilities | null>(null);
  const [installing, setInstalling] = useState(false);
  const [installMsg, setInstallMsg] = useState<{ ok: boolean; text: string } | null>(null);

  const loadCaps = useCallback(async () => {
    try {
      const res = await fetch("/api/registry/skills/capabilities");
      if (!res.ok) return;
      const body = (await res.json().catch(() => ({}))) as { git?: Partial<GitCapabilities> };
      if (body?.git) {
        setCaps({
          available: body.git.available ?? true,
          version: body.git.version ?? null,
          fallback_hosts: body.git.fallback_hosts ?? [],
          install: {
            auto_installable: body.git.install?.auto_installable ?? false,
            package_manager: body.git.install?.package_manager ?? null,
            hint: body.git.install?.hint ?? "",
          },
        });
      }
    } catch {
      /* capabilities unknown — leave banner hidden, scanning still allowed */
    }
  }, []);

  // git panel only mounts while the git source is selected, so a mount-time fetch
  // is enough; re-entering the source re-runs it.
  useEffect(() => {
    void loadCaps();
  }, [loadCaps]);

  const runScan = async () => {
    if (!url.trim()) return;
    setScanning(true);
    setScanError(null);
    setSkills(null);
    setStagingId(null);
    setResults({});
    try {
      const source: Record<string, string> = { kind: "git", url: url.trim() };
      if (ref.trim()) source.ref = ref.trim();
      if (subdir.trim()) source.subdir = subdir.trim();
      if (token.trim()) source.token = token.trim();
      const res = await fetch("/api/registry/skills/inspect", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ source }),
      });
      const body = (await res.json().catch(() => ({}))) as InspectResponse & { message?: string };
      if (!res.ok) {
        setScanError(body.message ?? `HTTP ${res.status}`);
        return;
      }
      const list = (body.skills ?? []).map((s, i) => ({ ...s, index: s.index ?? i }));
      if (list.length === 0) {
        setScanError(t("registry.register.gitNoSkill"));
        return;
      }
      setStagingId(body.staging_id);
      setSkills(list);
      setNames(Object.fromEntries(list.map((s) => [s.index, s.name])));
      setChecked({});
    } catch (err) {
      setScanError(String(err));
    } finally {
      setScanning(false);
    }
  };

  const selectableRows = (skills ?? []).filter((s) => s.valid && results[s.index]?.ok !== true);
  const targets = selectableRows.filter((s) => checked[s.index]);
  const namesValid = targets.every((s) => NAME_RE.test(names[s.index] ?? s.name));
  const canImport = !importing && targets.length > 0 && namesValid;

  const runImport = async () => {
    if (!stagingId || targets.length === 0) return;
    setImporting(true);
    try {
      const selections: ImportSelection[] = targets.map((s) => {
        const nm = names[s.index] ?? s.name;
        const sel: ImportSelection = { index: s.index, name: s.name };
        if (nm !== s.name) sel.name_override = nm;
        return sel;
      });
      const res = await fetch("/api/registry/skills/import", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ staging_id: stagingId, selections }),
      });
      if (res.status === 410) {
        setScanError(t("registry.register.previewExpired"));
        setSkills(null);
        setStagingId(null);
        return;
      }
      const body = (await res.json().catch(() => ({}))) as ImportResponse & { message?: string };
      if (!res.ok) {
        setScanError(body.message ?? `HTTP ${res.status}`);
        return;
      }
      const items = body.records ?? [];
      // response order mirrors the selections order → map back onto the sent targets
      const next: Record<number, RowResult> = { ...results };
      items.forEach((item, i) => {
        const target = targets[i];
        if (target) next[target.index] = { ok: item.ok, error: item.error };
      });
      setResults(next);
      // everything selected imported → hand off to the parent (reset + reload)
      if (items.length > 0 && items.every((r) => r.ok)) {
        const first = items.find((r) => r.record) ?? items[0];
        onImported(first.record ?? null, first.name);
      }
    } catch (err) {
      setScanError(String(err));
    } finally {
      setImporting(false);
    }
  };

  const runInstall = async () => {
    setInstalling(true);
    setInstallMsg(null);
    try {
      const res = await fetch("/api/registry/skills/capabilities/git-install", { method: "POST" });
      const body = (await res.json().catch(() => ({}))) as GitInstallResponse & { message?: string };
      if (body.ok) {
        setInstallMsg({
          ok: true,
          text: t("registry.register.gitInstallOk", { version: body.git_version ?? "" }),
        });
        await loadCaps();
      } else {
        const detail = body.error ?? body.hint ?? body.message ?? `HTTP ${res.status}`;
        setInstallMsg({ ok: false, text: t("registry.register.gitInstallFailed", { msg: detail }) });
      }
    } catch (err) {
      setInstallMsg({ ok: false, text: t("registry.register.gitInstallFailed", { msg: String(err) }) });
    } finally {
      setInstalling(false);
    }
  };

  const copyHint = () => {
    if (caps?.install.hint) void navigator.clipboard?.writeText(caps.install.hint).catch(() => {});
  };

  const allSelectableChecked =
    selectableRows.length > 0 && selectableRows.every((s) => checked[s.index]);

  return (
    <div style={{ marginTop: 14 }} data-testid="git-source-panel">
      {caps && !caps.available && (
        <div
          className="note"
          style={{ marginBottom: 14, color: "var(--warn)", borderColor: "var(--warn)" }}
          data-testid="git-capability-banner"
        >
          <span className="i">!</span>
          <div style={{ display: "flex", flexDirection: "column", gap: 8, flex: 1 }}>
            <span>
              {t("registry.register.gitNoGit")}
              {caps.fallback_hosts.length > 0 && (
                <> {t("registry.register.gitFallbackHint", { hosts: caps.fallback_hosts.join(", ") })}</>
              )}
            </span>
            {caps.install.auto_installable ? (
              <div style={{ display: "flex", alignItems: "center", gap: 9, flexWrap: "wrap" }}>
                <Btn disabled={installing} onClick={() => void runInstall()} data-testid="git-install-btn">
                  {installing
                    ? t("registry.register.gitInstalling")
                    : t("registry.register.gitAutoInstall")}
                </Btn>
                {installMsg && (
                  <span style={{ color: installMsg.ok ? "var(--good)" : "var(--crit)" }}>
                    {installMsg.text}
                  </span>
                )}
              </div>
            ) : (
              caps.install.hint && (
                <div>
                  <div style={{ marginBottom: 4 }}>{t("registry.register.gitInstallHint")}</div>
                  <code
                    className="code"
                    style={{ display: "block", cursor: "pointer" }}
                    onClick={copyHint}
                    data-testid="git-install-hint"
                  >
                    {caps.install.hint}
                  </code>
                </div>
              )
            )}
          </div>
        </div>
      )}

      <div className="field">
        <label htmlFor="git-url">{t("registry.register.gitUrl")}</label>
        <input
          id="git-url"
          className="input mono"
          value={url}
          onChange={(e) => setUrl(e.target.value)}
          placeholder="https://github.com/anthropics/skills"
          data-testid="git-url-input"
        />
      </div>
      <div className="field">
        <label htmlFor="git-ref">{t("registry.register.gitRef")}</label>
        <input
          id="git-ref"
          className="input mono"
          value={ref}
          onChange={(e) => setRef(e.target.value)}
          placeholder="main"
          data-testid="git-ref-input"
        />
      </div>
      <div className="field">
        <label htmlFor="git-subdir">{t("registry.register.gitSubdir")}</label>
        <input
          id="git-subdir"
          className="input mono"
          value={subdir}
          onChange={(e) => setSubdir(e.target.value)}
          placeholder="skills/"
          data-testid="git-subdir-input"
        />
      </div>
      <div className="field">
        <label htmlFor="git-token">{t("registry.register.gitToken")}</label>
        <input
          id="git-token"
          className="input mono"
          type="password"
          autoComplete="off"
          value={token}
          onChange={(e) => setToken(e.target.value)}
          placeholder="••••••••"
          data-testid="git-token-input"
        />
      </div>
      <div style={{ display: "flex", justifyContent: "flex-end", marginTop: 10 }}>
        <Btn
          primary
          disabled={scanning || !url.trim()}
          onClick={() => void runScan()}
          data-testid="git-scan-btn"
        >
          {scanning ? t("registry.register.gitScanning") : t("registry.register.gitScan")}
        </Btn>
      </div>

      {scanError && (
        <div
          className="note"
          style={{ marginTop: 10, color: "var(--crit)", borderColor: "var(--crit)" }}
          data-testid="git-scan-error"
        >
          <span className="i">!</span>
          <span>{scanError}</span>
        </div>
      )}

      {skills && (
        <div style={{ marginTop: 14 }} data-testid="git-skill-list">
          <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between" }}>
            <label>{t("registry.register.gitSkills", { n: skills.length })}</label>
            <label className="studio-check" style={{ cursor: "pointer" }}>
              <input
                type="checkbox"
                checked={allSelectableChecked}
                disabled={selectableRows.length === 0}
                data-testid="git-select-all"
                onChange={(e) => {
                  const on = e.target.checked;
                  setChecked((c) => {
                    const nextChecked = { ...c };
                    selectableRows.forEach((s) => {
                      nextChecked[s.index] = on;
                    });
                    return nextChecked;
                  });
                }}
              />
              <span>{t("registry.register.gitSelectAll")}</span>
            </label>
          </div>

          {skills.map((s) => {
            const nm = names[s.index] ?? s.name;
            const rowRes = results[s.index];
            const done = rowRes?.ok === true;
            const nmValid = NAME_RE.test(nm);
            const selectable = s.valid && !done;
            return (
              <div
                key={s.index}
                data-testid={`git-skill-row-${s.index}`}
                style={{
                  border: "1px solid var(--line-2)",
                  borderRadius: 8,
                  padding: 10,
                  marginTop: 8,
                  opacity: s.valid ? 1 : 0.65,
                }}
              >
                <label className="studio-check" style={{ alignItems: "flex-start" }}>
                  <input
                    type="checkbox"
                    checked={!!checked[s.index] || done}
                    disabled={!selectable}
                    data-testid={`git-skill-check-${s.index}`}
                    onChange={(e) =>
                      setChecked((c) => ({ ...c, [s.index]: e.target.checked }))
                    }
                  />
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                      <input
                        className="input mono"
                        value={nm}
                        disabled={done}
                        style={{ flex: 1 }}
                        data-testid={`git-name-input-${s.index}`}
                        onChange={(e) =>
                          setNames((n) => ({ ...n, [s.index]: e.target.value }))
                        }
                      />
                      {done && <span style={{ color: "var(--good)" }}>✓</span>}
                    </div>
                    {s.description && (
                      <div className="dim" style={{ marginTop: 4 }}>
                        {s.description}
                      </div>
                    )}
                    <div className="dim mono" style={{ marginTop: 4 }}>
                      {t("registry.register.zipVersion")}: {s.version || "—"} ·{" "}
                      {t("registry.register.zipFiles", { n: s.files.length })}
                    </div>
                    {!s.valid && s.errors.length > 0 && (
                      <div
                        className="note"
                        style={{ marginTop: 6, color: "var(--crit)", borderColor: "var(--crit)" }}
                      >
                        <span className="i">!</span>
                        <span>{s.errors.join("; ")}</span>
                      </div>
                    )}
                    {selectable && checked[s.index] && !nmValid && (
                      <div
                        className="note"
                        style={{ marginTop: 6, color: "var(--warn)", borderColor: "var(--warn)" }}
                      >
                        <span className="i">!</span>
                        <span>{t("registry.register.gitNameInvalid")}</span>
                      </div>
                    )}
                    {rowRes && !rowRes.ok && (
                      <div
                        className="note"
                        style={{ marginTop: 6, color: "var(--crit)", borderColor: "var(--crit)" }}
                        data-testid={`git-row-error-${s.index}`}
                      >
                        <span className="i">!</span>
                        <span>
                          {rowRes.error ?? t("registry.register.importFailed", { msg: "unknown" })}
                        </span>
                      </div>
                    )}
                  </div>
                </label>
              </div>
            );
          })}

          <div style={{ display: "flex", justifyContent: "flex-end", gap: 9, marginTop: 12 }}>
            <Btn
              primary
              disabled={!canImport}
              onClick={() => void runImport()}
              data-testid="git-import-btn"
            >
              ▲ {t("registry.register.gitImportSelected")}
            </Btn>
          </div>
        </div>
      )}
    </div>
  );
}
