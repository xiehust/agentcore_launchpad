import type { CSSProperties, ReactNode } from "react";

interface StatTileProps {
  label: ReactNode;
  value: ReactNode;
  unit?: ReactNode;
  foot?: ReactNode;
  style?: CSSProperties;
}

export function StatTile({ label, value, unit, foot, style }: StatTileProps) {
  return (
    <div className="tile" style={style}>
      <div className="t-label">{label}</div>
      <div className="t-val">
        {value}
        {unit != null && <small>{unit}</small>}
      </div>
      {foot != null && <div className="t-foot">{foot}</div>}
    </div>
  );
}
