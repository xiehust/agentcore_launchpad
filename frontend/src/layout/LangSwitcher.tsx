import { useTranslation } from "react-i18next";

export function LangSwitcher() {
  const { i18n } = useTranslation();
  const lang = i18n.resolvedLanguage ?? "en";
  return (
    <div className="langswitch" data-testid="lang-switcher">
      <button
        type="button"
        className={lang === "en" ? "on" : ""}
        onClick={() => void i18n.changeLanguage("en")}
      >
        EN
      </button>
      <button
        type="button"
        className={lang.startsWith("zh") ? "on" : ""}
        onClick={() => void i18n.changeLanguage("zh-CN")}
      >
        中文
      </button>
    </div>
  );
}
