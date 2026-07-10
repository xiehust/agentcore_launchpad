import { useTranslation } from "react-i18next";

export const PAGE_SIZES = [20, 50, 100, 200] as const;
export const DEFAULT_PAGE_SIZE: number = PAGE_SIZES[1];

interface PagerProps {
  total: number;
  page: number; // 1-based, already clamped by the caller
  size: number;
  onPage: (page: number) => void;
  onSize: (size: number) => void;
}

/** Table footer pagination — hidden entirely while one page suffices. */
export function Pager({ total, page, size, onPage, onSize }: PagerProps) {
  const { t } = useTranslation();
  const pages = Math.max(1, Math.ceil(total / size));
  if (total <= PAGE_SIZES[0]) return null;
  return (
    <div className="pagerbar">
      <span className="mono dim">{t("obs.pager.total", { count: total })}</span>
      <span className="spacer" />
      <button className="fsel" disabled={page <= 1} onClick={() => onPage(page - 1)}>
        ‹ {t("obs.pager.prev")}
      </button>
      <span className="mono">{t("obs.pager.page", { page, pages })}</span>
      <button className="fsel" disabled={page >= pages} onClick={() => onPage(page + 1)}>
        {t("obs.pager.next")} ›
      </button>
      <select
        className="fsel"
        value={size}
        onChange={(e) => onSize(Number(e.target.value))}
        aria-label={t("obs.pager.sizeLabel")}
      >
        {PAGE_SIZES.map((s) => (
          <option key={s} value={s}>
            {t("obs.pager.perPage", { size: s })}
          </option>
        ))}
      </select>
    </div>
  );
}
