import type { ReactNode } from "react";
import { useCallback, useRef, useState } from "react";

import type { ToastTone } from "./toast-context";
import { ToastContext } from "./toast-context";

interface ToastItem {
  id: number;
  tone: ToastTone;
  text: string;
}

export function ToastProvider({ children }: { children: ReactNode }) {
  const [items, setItems] = useState<ToastItem[]>([]);
  const nextId = useRef(1);

  const push = useCallback((text: string, tone: ToastTone = "crit") => {
    const id = nextId.current++;
    setItems((prev) => [...prev.slice(-3), { id, tone, text }]);
    window.setTimeout(() => setItems((prev) => prev.filter((t) => t.id !== id)), 7000);
  }, []);

  return (
    <ToastContext.Provider value={push}>
      {children}
      <div className="toasts" role="status" aria-live="polite">
        {items.map((item) => (
          <div key={item.id} className={`toast ${item.tone}`}>
            <span className="toast-icon">
              {item.tone === "crit" ? "✕" : item.tone === "warn" ? "◐" : "✓"}
            </span>
            <span>{item.text}</span>
            <button
              className="toast-x"
              aria-label="dismiss"
              onClick={() => setItems((prev) => prev.filter((t) => t.id !== item.id))}
            >
              ✕
            </button>
          </div>
        ))}
      </div>
    </ToastContext.Provider>
  );
}
