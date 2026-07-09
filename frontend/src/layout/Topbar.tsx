import { useTranslation } from "react-i18next";

import type { HealthInfo } from "./useHealth";
import { LangSwitcher } from "./LangSwitcher";

interface TopbarProps {
  crumbKey: string;
  health: HealthInfo | null;
}

export function Topbar({ crumbKey, health }: TopbarProps) {
  const { t } = useTranslation();
  return (
    <div className="topbar">
      <div className="brand">
        <span className="glyph">▲</span>AGENTCORE<em>//</em>LAUNCHPAD
      </div>
      <div className="crumb">
        {t("topbar.console")} / <b>{t(crumbKey).toUpperCase()}</b>
      </div>
      <div className="right">
        <div className="syschip">
          <span className="led"></span>
          {t("topbar.allSystemsGo")}
        </div>
        <div className="syschip">{health?.region ?? "—"}</div>
        <div className="syschip">
          {t("topbar.acct")} {health?.account_id || "—"}
        </div>
        <LangSwitcher />
        <div className="avatar">
          <div className="pic">RX</div>
          <span>
            river · <b className="role">PLATFORM-ADMIN</b>
          </span>
        </div>
      </div>
    </div>
  );
}
