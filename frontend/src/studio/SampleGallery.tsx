import { useCallback, useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { Link } from "react-router-dom";

import { Btn, Chip } from "../components";
import {
  SAMPLE_FLOWS,
  type SampleFlow,
  type SampleSkillDefinition,
} from "./lib/sample-flows";

interface Props {
  onClose: () => void;
  onLoadSample: (sample: SampleFlow) => void;
}

// APPROVED AGENT_SKILLS registry record — the availability gate for skill nodes.
interface AttachableSkill {
  name: string;
  description: string;
}

// A sample's required skill is imported into launchpad's registry as an
// AGENT_SKILLS record: a SKILL.md with name/description frontmatter and the
// sample's instructions as the body (mirrors samples/skills/*/SKILL.md).
function buildSkillMd(skill: SampleSkillDefinition): string {
  return [
    "---",
    `name: ${skill.name}`,
    `description: ${JSON.stringify(skill.description)}`,
    "version: 1.0.0",
    "---",
    "",
    `# ${skill.name}`,
    "",
    skill.instructions,
    "",
  ].join("\n");
}

async function postAction(recordId: string, action: string): Promise<Response> {
  return fetch(`/api/registry/records/${recordId}/action`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ action }),
  });
}

// Register a sample's skill and drive it to APPROVED so the picker/zip can use
// it: POST /records (DRAFT) → submit → approve. A name clash means the record
// already exists — look it up and push it forward (or accept it if approved).
async function approveSkill(skill: SampleSkillDefinition): Promise<void> {
  let recordId: string | null = null;
  const regRes = await fetch("/api/registry/records", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      type: "AGENT_SKILLS",
      name: skill.name,
      description: skill.description,
      skill_md: buildSkillMd(skill),
    }),
  });
  if (regRes.ok) {
    const rec = (await regRes.json()) as { record_id?: string };
    recordId = rec.record_id ?? null;
  } else {
    const errBody = (await regRes.json().catch(() => ({}))) as { message?: string };
    const listRes = await fetch("/api/registry/records?type=AGENT_SKILLS");
    const found = listRes.ok
      ? (
          (await listRes.json()) as {
            records?: { name: string; record_id: string; status?: string }[];
          }
        ).records?.find((r) => r.name === skill.name)
      : undefined;
    if (found?.status === "APPROVED") return; // already usable
    recordId = found?.record_id ?? null;
    if (!recordId) throw new Error(errBody.message ?? `HTTP ${regRes.status}`);
  }
  if (!recordId) throw new Error(`registry did not return a record id for ${skill.name}`);
  // submit is best-effort (the record may already be past DRAFT); the attachables
  // re-check is the real success gate, but a failing approve is surfaced.
  await postAction(recordId, "submit").catch(() => undefined);
  const approveRes = await postAction(recordId, "approve");
  if (!approveRes.ok) {
    const env = (await approveRes.json().catch(() => ({}))) as { message?: string };
    throw new Error(env.message ?? `HTTP ${approveRes.status}`);
  }
}

export function SampleGallery({ onClose, onLoadSample }: Props) {
  const { t } = useTranslation();
  // null = not loaded yet; a required skill missing from the list blocks Load.
  const [available, setAvailable] = useState<string[] | null>(null);
  const [registeringId, setRegisteringId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  // bust=true forces the backend past its 60s attachables cache — required right
  // after register→approve, or a freshly approved skill stays "missing" for a minute.
  const refreshSkills = useCallback(async (bust = false) => {
    try {
      const res = await fetch(bust ? "/api/registry/attachables?refresh=1" : "/api/registry/attachables");
      const data = res.ok
        ? ((await res.json()) as { skills?: AttachableSkill[] })
        : { skills: [] };
      setAvailable((data.skills ?? []).map((s) => s.name));
    } catch {
      setAvailable([]); // registry unreachable — required skills show the register path
    }
  }, []);

  useEffect(() => {
    void refreshSkills();
  }, [refreshSkills]);

  const missingSkills = (sample: SampleFlow): SampleSkillDefinition[] => {
    if (!sample.requiredSkills?.length) return [];
    return sample.requiredSkills.filter((s) => !(available ?? []).includes(s.name));
  };

  const registerMissing = async (sample: SampleFlow) => {
    setRegisteringId(sample.id);
    setError(null);
    try {
      for (const skill of missingSkills(sample)) {
        await approveSkill(skill);
      }
      await refreshSkills(true);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setRegisteringId(null);
    }
  };

  const renderCard = (sample: SampleFlow) => {
    const missing = missingSkills(sample);
    const registering = registeringId === sample.id;
    const loadable = missing.length === 0;
    return (
      <div key={sample.id} className="studio-sample-card">
        <div className="studio-sample-head">
          <span className="studio-sample-nm">{sample.name}</span>
          <Chip tone={sample.level === "advanced" ? "amber" : "muted"}>
            {t(`studio.samples.level.${sample.level}`)}
          </Chip>
        </div>
        <p className="studio-sample-desc">{sample.description}</p>
        <div className="studio-sample-meta">
          {t("studio.samples.counts", {
            nodes: sample.nodes.length,
            edges: sample.edges.length,
          })}
          {sample.graphMode ? ` · ${t("studio.samples.graphMode")}` : ""}
        </div>
        {missing.length > 0 && (
          <div className="studio-sample-skillrow">
            <span className="studio-warn" style={{ marginTop: 0, flex: 1 }}>
              {t("studio.samples.requiresSkill", {
                names: missing.map((s) => s.name).join(", "),
              })}
            </span>
            <Btn onClick={() => void registerMissing(sample)} disabled={registering}>
              {registering ? (
                <span className="studio-spin">◠</span>
              ) : (
                t("studio.samples.registerSkill")
              )}
            </Btn>
          </div>
        )}
        <div className="studio-sample-foot">
          <Btn primary disabled={!loadable} onClick={() => onLoadSample(sample)}>
            {t("studio.samples.load")}
          </Btn>
        </div>
      </div>
    );
  };

  const basic = SAMPLE_FLOWS.filter((s) => s.level === "basic");
  const advanced = SAMPLE_FLOWS.filter((s) => s.level === "advanced");

  return (
    <div className="confirm-backdrop" onClick={onClose}>
      <div
        className="confirm-box studio-samples-box"
        role="dialog"
        aria-modal="true"
        aria-label={t("studio.samples.title")}
        onClick={(e) => e.stopPropagation()}
      >
        <div className="confirm-title">▦ {t("studio.samples.title")}</div>
        <div className="studio-note">{t("studio.samples.sub")}</div>

        {error && (
          <div className="note" style={{ borderColor: "var(--crit)", marginBottom: 12 }}>
            <span className="i" style={{ color: "var(--crit)" }}>
              [✕]
            </span>
            <span>
              {error} <Link to="/registry">{t("studio.samples.openRegistry")}</Link>
            </span>
          </div>
        )}

        <div className="studio-samples-scroll">
          <div className="studio-samples-seclbl">
            {t("studio.samples.basic")} ({basic.length})
          </div>
          <div className="studio-samples-grid">{basic.map(renderCard)}</div>
          <div className="studio-samples-seclbl amber">
            {t("studio.samples.advanced")} ({advanced.length})
          </div>
          <div className="studio-samples-grid">{advanced.map(renderCard)}</div>
        </div>

        <div className="confirm-actions" style={{ marginTop: 14 }}>
          <Btn onClick={onClose}>{t("common.cancel")}</Btn>
        </div>
      </div>
    </div>
  );
}
