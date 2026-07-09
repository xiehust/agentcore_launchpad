export interface NavEntry {
  idx: string;
  to: string;
  labelKey: string;
  end?: boolean;
}

export const NAV_ENTRIES: NavEntry[] = [
  { idx: "01", to: "/", labelKey: "nav.overview", end: true },
  { idx: "02", to: "/create", labelKey: "nav.createAgent" },
  { idx: "03", to: "/registry", labelKey: "nav.registry" },
  { idx: "04", to: "/chat", labelKey: "nav.chat" },
  { idx: "05", to: "/evaluation", labelKey: "nav.evaluation" },
  { idx: "06", to: "/governance", labelKey: "nav.governance" },
];

export const PLATFORM_COUNT = 4;
