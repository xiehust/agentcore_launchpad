import { useEffect, useState } from "react";

export interface HealthInfo {
  status: string;
  version: string;
  region: string;
  account_id?: string;
}

export function useHealth(): HealthInfo | null {
  const [health, setHealth] = useState<HealthInfo | null>(null);
  useEffect(() => {
    let cancelled = false;
    fetch("/api/health")
      .then((res) => (res.ok ? res.json() : null))
      .then((data: HealthInfo | null) => {
        if (!cancelled && data) setHealth(data);
      })
      .catch(() => {
        /* backend not running — chips fall back to placeholders */
      });
    return () => {
      cancelled = true;
    };
  }, []);
  return health;
}
