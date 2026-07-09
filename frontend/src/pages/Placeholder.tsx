import { useTranslation } from "react-i18next";

import { Chip, Panel, ViewHead } from "../components";

interface PlaceholderPageProps {
  ns: "create" | "registry" | "chat" | "evaluation" | "governance";
  phase: number;
}

export function PlaceholderPage({ ns, phase }: PlaceholderPageProps) {
  const { t } = useTranslation();
  return (
    <section>
      <ViewHead kicker={t(`${ns}.kicker`)} title={t(`${ns}.title`)} meta={t(`${ns}.meta`)} />
      <Panel
        brk
        title={t(`${ns}.placeholderTitle`)}
        end={
          <Chip tone="muted" icon="○">
            {t("common.phaseTag", { phase })}
          </Chip>
        }
      >
        <p style={{ color: "var(--ink-2)", fontSize: 13, lineHeight: 1.6 }}>
          {t(`${ns}.placeholderBody`)}
        </p>
      </Panel>
    </section>
  );
}
