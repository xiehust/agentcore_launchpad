import { type ChangeEvent, useCallback, useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";

import { Btn } from "../../components";
import type { RegistryRecord } from "../Registry";
import { GitSourcePanel } from "./GitSourcePanel";

export type RegSource = "inline" | "zip" | "git" | "url";

interface InspectedSkill {
  index?: number;
  name: string;
  description: string;
  version: string;
  files: string[];
  skill_md_excerpt: string;
  valid: boolean;
  errors: string[];
}

interface InspectResponse {
  skills: InspectedSkill[];
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

const NAME_RE = /^[a-z][a-z0-9-]{2,63}$/;
const URL_RE = /^https:\/\/.+/i;

interface SkillSourceFormProps {
  source: RegSource;
  onSourceChange: (s: RegSource) => void;
  /** inline SKILL.md content (kept in the parent so the inline submit path is unchanged) */
  md: string;
  onMdChange: (v: string) => void;
  /** called after a successful zip/git/url import so the parent can reset + reload like inline */
  onImported: (record: RegistryRecord | null, name: string) => void;
}

const SOURCES: { key: RegSource; labelKey: string; enabled: boolean }[] = [
  { key: "inline", labelKey: "registry.register.sourceInline", enabled: true },
  { key: "zip", labelKey: "registry.register.sourceZip", enabled: true },
  { key: "git", labelKey: "registry.register.sourceGit", enabled: true },
  { key: "url", labelKey: "registry.register.sourceUrl", enabled: true },
];

export function SkillSourceForm({
  source,
  onSourceChange,
  md,
  onMdChange,
  onImported,
}: SkillSourceFormProps) {
  const { t } = useTranslation();
  const fileRef = useRef<HTMLInputElement>(null);

  const [stagingId, setStagingId] = useState<string | null>(null);
  const [preview, setPreview] = useState<InspectedSkill | null>(null);
  const [editName, setEditName] = useState("");
  const [editDesc, setEditDesc] = useState("");
  const [inspecting, setInspecting] = useState(false);
  const [importing, setImporting] = useState(false);
  const [fileError, setFileError] = useState<string | null>(null);
  const [itemError, setItemError] = useState<string | null>(null);
  const [urlInput, setUrlInput] = useState("");

  const resetStaged = useCallback(() => {
    setStagingId(null);
    setPreview(null);
    setEditName("");
    setEditDesc("");
    setInspecting(false);
    setImporting(false);
    setFileError(null);
    setItemError(null);
    setUrlInput("");
    if (fileRef.current) fileRef.current.value = "";
  }, []);

  // switching source clears any staged preview so each branch starts fresh.
  // zip and url share the staging state + preview card, so leaving either
  // (or hopping between them) must reset before the next acquire.
  useEffect(() => {
    resetStaged();
  }, [source, resetStaged]);

  const handlePick = async (e: ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (fileRef.current) fileRef.current.value = "";
    if (!file) return;
    setFileError(null);
    setItemError(null);
    setPreview(null);
    setStagingId(null);
    setInspecting(true);
    try {
      const form = new FormData();
      form.append("file", file);
      const res = await fetch("/api/registry/skills/inspect", { method: "POST", body: form });
      if (res.status === 410) {
        setFileError(t("registry.register.previewExpired"));
        return;
      }
      const body = (await res.json().catch(() => ({}))) as InspectResponse & { message?: string };
      if (!res.ok) {
        setFileError(body.message ?? `HTTP ${res.status}`);
        return;
      }
      const skill = body.skills?.[0];
      if (!skill) {
        setFileError(t("registry.register.zipNoSkill"));
        return;
      }
      setStagingId(body.staging_id);
      setPreview(skill);
      setEditName(skill.name ?? "");
      setEditDesc(skill.description ?? "");
    } catch (err) {
      setFileError(String(err));
    } finally {
      setInspecting(false);
    }
  };

  const nameValid = NAME_RE.test(editName);

  const runImport = async () => {
    if (!stagingId || !preview) return;
    setImporting(true);
    setItemError(null);
    try {
      const selection: {
        index?: number;
        name: string;
        name_override?: string;
        description_override?: string;
      } = { index: preview.index ?? 0, name: preview.name };
      if (editName !== preview.name) selection.name_override = editName;
      if (editDesc !== preview.description) selection.description_override = editDesc;
      const res = await fetch("/api/registry/skills/import", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ staging_id: stagingId, selections: [selection] }),
      });
      if (res.status === 410) {
        setFileError(t("registry.register.previewExpired"));
        resetStaged();
        return;
      }
      const body = (await res.json().catch(() => ({}))) as ImportResponse & { message?: string };
      if (!res.ok) {
        setItemError(body.message ?? `HTTP ${res.status}`);
        return;
      }
      const result = body.records?.[0];
      if (!result || !result.ok) {
        setItemError(result?.error ?? t("registry.register.importFailed", { msg: "unknown" }));
        return;
      }
      onImported(result.record ?? null, editName);
    } catch (err) {
      setItemError(String(err));
    } finally {
      setImporting(false);
    }
  };

  // url branch: acquire a single skill from a raw SKILL.md or .zip URL, then
  // hand off to the exact same preview card + import flow as zip.
  const runUrlInspect = async () => {
    const u = urlInput.trim();
    if (!URL_RE.test(u)) return;
    setFileError(null);
    setItemError(null);
    setPreview(null);
    setStagingId(null);
    setInspecting(true);
    try {
      const res = await fetch("/api/registry/skills/inspect", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ source: { kind: "url", url: u } }),
      });
      if (res.status === 410) {
        setFileError(t("registry.register.previewExpired"));
        return;
      }
      const body = (await res.json().catch(() => ({}))) as InspectResponse & { message?: string };
      if (!res.ok) {
        setFileError(body.message ?? `HTTP ${res.status}`);
        return;
      }
      const skill = body.skills?.[0];
      if (!skill) {
        setFileError(t("registry.register.urlNoSkill"));
        return;
      }
      setStagingId(body.staging_id);
      setPreview(skill);
      setEditName(skill.name ?? "");
      setEditDesc(skill.description ?? "");
    } catch (err) {
      setFileError(String(err));
    } finally {
      setInspecting(false);
    }
  };

  const trimmedUrl = urlInput.trim();
  // backend/fetch error wins; else flag a locally-invalid (non-https) url
  const urlErrorMsg =
    fileError ?? (trimmedUrl && !URL_RE.test(trimmedUrl) ? t("registry.register.urlInvalid") : null);

  // shared preview card — reached from both the zip upload and the url fetch,
  // so its testids stay `zip-*`/`import-btn` for both flows
  const previewCard = preview && (
    <div data-testid="zip-preview">
      <div className="field">
        <label htmlFor="zip-name">{t("registry.register.name")}</label>
        <input
          id="zip-name"
          className="input mono"
          value={editName}
          onChange={(e) => setEditName(e.target.value)}
          data-testid="zip-name-input"
        />
      </div>
      <div className="field">
        <label htmlFor="zip-desc">{t("registry.register.description")}</label>
        <input
          id="zip-desc"
          className="input"
          value={editDesc}
          onChange={(e) => setEditDesc(e.target.value)}
          data-testid="zip-desc-input"
        />
      </div>
      <div className="kv">
        <span className="k">{t("registry.register.zipVersion")}</span>
        <span className="v">{preview.version || "—"}</span>
      </div>
      <div className="field" style={{ marginTop: 10 }}>
        <label>{t("registry.register.zipFiles", { n: preview.files.length })}</label>
        <div
          className="code"
          style={{ maxHeight: 160, overflowY: "auto" }}
          data-testid="zip-files"
        >
          {preview.files.join("\n")}
        </div>
      </div>
      {(!preview.valid || preview.errors.length > 0) && (
        <div
          className="note"
          style={{ color: "var(--crit)", borderColor: "var(--crit)" }}
          data-testid="zip-validation"
        >
          <span className="i">!</span>
          <span>{preview.errors.join("; ") || t("registry.register.invalidBundle")}</span>
        </div>
      )}
      {itemError && (
        <div
          className="note"
          style={{ marginTop: 10, color: "var(--crit)", borderColor: "var(--crit)" }}
          data-testid="import-error"
        >
          <span className="i">!</span>
          <span>{itemError}</span>
        </div>
      )}
      <div style={{ display: "flex", justifyContent: "flex-end", gap: 9, marginTop: 12 }}>
        <Btn disabled={importing} onClick={resetStaged} data-testid="zip-reset-btn">
          {t("registry.register.zipReset")}
        </Btn>
        <Btn
          primary
          disabled={importing || !preview.valid || !nameValid}
          onClick={() => void runImport()}
          data-testid="import-btn"
        >
          ▲ {t("registry.register.submit")}
        </Btn>
      </div>
    </div>
  );

  return (
    <div className="field" data-testid="skill-source-form">
      <label>{t("registry.register.source")}</label>
      <div className="selchips" data-testid="source-select">
        {SOURCES.map(({ key, labelKey, enabled }) => (
          <button
            key={key}
            type="button"
            className={`selchip${source === key ? " on" : ""}`}
            style={{ cursor: enabled ? "pointer" : "not-allowed", opacity: enabled ? 1 : 0.45 }}
            disabled={!enabled}
            title={enabled ? undefined : t("registry.register.comingSoon")}
            data-testid={`source-opt-${key}`}
            onClick={() => enabled && onSourceChange(key)}
          >
            {t(labelKey)}
            {!enabled && <span className="x">{t("registry.register.comingSoon")}</span>}
          </button>
        ))}
      </div>

      {source === "inline" && (
        <div style={{ marginTop: 14 }}>
          <label htmlFor="reg-md">{t("registry.register.skillMd")}</label>
          <textarea
            id="reg-md"
            className="input mono"
            style={{ minHeight: 160, resize: "vertical", marginTop: 7 }}
            value={md}
            onChange={(e) => onMdChange(e.target.value)}
            placeholder={"---\nname: report-writer\ndescription: …\n---\n# Instructions"}
          />
        </div>
      )}

      {source === "zip" && (
        <div style={{ marginTop: 14 }}>
          {!preview && (
            <div>
              <label className="btn" style={{ cursor: "pointer", justifyContent: "center" }}>
                {inspecting ? t("registry.register.zipInspecting") : t("registry.register.zipPick")}
                <input
                  ref={fileRef}
                  type="file"
                  accept=".zip"
                  style={{ display: "none" }}
                  disabled={inspecting}
                  data-testid="zip-file-input"
                  onChange={(e) => void handlePick(e)}
                />
              </label>
              {fileError && (
                <div
                  className="note"
                  style={{ marginTop: 10, color: "var(--crit)", borderColor: "var(--crit)" }}
                  data-testid="zip-error"
                >
                  <span className="i">!</span>
                  <span>{fileError}</span>
                </div>
              )}
            </div>
          )}
          {previewCard}
        </div>
      )}

      {source === "git" && <GitSourcePanel onImported={onImported} />}

      {source === "url" && (
        <div style={{ marginTop: 14 }}>
          {!preview && (
            <div>
              <div className="field">
                <label htmlFor="reg-url-src">{t("registry.register.urlInput")}</label>
                <input
                  id="reg-url-src"
                  className="input mono"
                  value={urlInput}
                  onChange={(e) => setUrlInput(e.target.value)}
                  onKeyDown={(e) => e.key === "Enter" && URL_RE.test(trimmedUrl) && void runUrlInspect()}
                  placeholder="https://example.com/SKILL.md · https://example.com/bundle.zip"
                  data-testid="url-input"
                />
              </div>
              <div style={{ display: "flex", justifyContent: "flex-end", marginTop: 10 }}>
                <Btn
                  primary
                  disabled={inspecting || !URL_RE.test(trimmedUrl)}
                  onClick={() => void runUrlInspect()}
                  data-testid="url-fetch-btn"
                >
                  {inspecting ? t("registry.register.urlFetching") : t("registry.register.urlFetch")}
                </Btn>
              </div>
              {urlErrorMsg && (
                <div
                  className="note"
                  style={{ marginTop: 10, color: "var(--crit)", borderColor: "var(--crit)" }}
                  data-testid="url-error"
                >
                  <span className="i">!</span>
                  <span>{urlErrorMsg}</span>
                </div>
              )}
            </div>
          )}
          {previewCard}
        </div>
      )}
    </div>
  );
}
