import type { ReactNode } from "react";

interface StageCardProps {
  id: string;
  index: number;
  title: string;
  active: boolean;
  done: boolean;
  children: ReactNode;
}

export function StageCard({
  id,
  index,
  title,
  active,
  done,
  children,
}: StageCardProps) {
  return (
    <div
      data-testid={`card-${id}`}
      style={{
        border: "1px solid var(--line)",
        borderLeft: `3px solid ${
          active ? "var(--warn)" : done ? "var(--good)" : "var(--line)"}`,
        borderRadius: 4,
        padding: "10px 12px",
        marginBottom: 10,
      }}
    >
      <div
        className="mono"
        style={{
          fontSize: 11,
          fontWeight: 700,
          letterSpacing: ".08em",
          marginBottom: 8,
          color: active ? "var(--warn)" : done ? "var(--good)" : "var(--ink-3)",
        }}
      >
        {String(index).padStart(2, "0")} · {title}{done ? " ✓" : ""}
      </div>
      {children}
    </div>
  );
}
