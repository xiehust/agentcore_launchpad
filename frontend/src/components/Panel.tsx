import type { CSSProperties, ReactNode } from "react";

interface PanelProps {
  title?: ReactNode;
  sub?: ReactNode;
  end?: ReactNode;
  brk?: boolean;
  pad?: boolean;
  className?: string;
  style?: CSSProperties;
  children?: ReactNode;
}

export function Panel({
  title,
  sub,
  end,
  brk = false,
  pad = true,
  className = "",
  style,
  children,
}: PanelProps) {
  return (
    <div className={["panel", brk ? "brk" : "", className].filter(Boolean).join(" ")} style={style}>
      {(title || sub || end) && (
        <div className="phead">
          {title != null && <h2>{title}</h2>}
          {sub != null && <span className="sub">{sub}</span>}
          {end != null && <div className="end">{end}</div>}
        </div>
      )}
      {pad ? <div className="pbody">{children}</div> : children}
    </div>
  );
}
