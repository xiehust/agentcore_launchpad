import type { CSSProperties, ReactNode } from "react";

export type ChipTone = "good" | "warn" | "crit" | "muted" | "amber" | "blue" | "aqua";

interface ChipProps {
  tone?: ChipTone;
  icon?: ReactNode;
  className?: string;
  style?: CSSProperties;
  children?: ReactNode;
}

export function Chip({ tone, icon, className = "", style, children }: ChipProps) {
  return (
    <span className={["chip", tone ?? "", className].filter(Boolean).join(" ")} style={style}>
      {icon != null && <i>{icon}</i>}
      {children}
    </span>
  );
}
