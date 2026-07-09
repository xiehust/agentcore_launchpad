import type { ReactNode } from "react";

import { Kicker } from "./Kicker";

interface ViewHeadProps {
  kicker: ReactNode;
  title: ReactNode;
  meta?: ReactNode;
}

export function ViewHead({ kicker, title, meta }: ViewHeadProps) {
  return (
    <div className="vhead">
      <Kicker>{kicker}</Kicker>
      <h1>{title}</h1>
      {meta != null && <span className="meta">{meta}</span>}
    </div>
  );
}
