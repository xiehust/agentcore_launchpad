import { useEffect, useRef } from "react";
import { useTranslation } from "react-i18next";

import { Btn } from "./Btn";

interface Props {
  open: boolean;
  title: string;
  body: string;
  confirmLabel: string;
  onConfirm: () => void;
  onCancel: () => void;
}

export function ConfirmDialog({ open, title, body, confirmLabel, onConfirm, onCancel }: Props) {
  const { t } = useTranslation();
  const confirmRef = useRef<HTMLDivElement>(null);
  // callers pass inline handlers — a ref keeps the effect on [open] only, so
  // parent re-renders (poll timers) don't re-run it and yank focus back
  const cancelRef = useRef(onCancel);
  cancelRef.current = onCancel;

  useEffect(() => {
    if (!open) return;
    confirmRef.current?.querySelector("button")?.focus();
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") cancelRef.current();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open]);

  if (!open) return null;
  return (
    <div className="confirm-backdrop" onClick={onCancel}>
      <div
        className="confirm-box"
        role="alertdialog"
        aria-modal="true"
        aria-label={title}
        onClick={(e) => e.stopPropagation()}
      >
        <div className="confirm-title">▲ {title}</div>
        <p className="confirm-body">{body}</p>
        <div className="confirm-actions" ref={confirmRef}>
          <Btn onClick={onCancel}>{t("common.cancel")}</Btn>
          <Btn primary onClick={onConfirm}>
            {confirmLabel}
          </Btn>
        </div>
      </div>
    </div>
  );
}
