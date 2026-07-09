import type { ButtonHTMLAttributes } from "react";

interface BtnProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  primary?: boolean;
}

export function Btn({ primary = false, className = "", children, ...rest }: BtnProps) {
  return (
    <button
      className={["btn", primary ? "primary" : "", className].filter(Boolean).join(" ")}
      {...rest}
    >
      {children}
    </button>
  );
}
