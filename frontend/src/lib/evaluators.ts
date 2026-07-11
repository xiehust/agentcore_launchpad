import type { TFunction } from "i18next";

// Localized display names for evaluators. Builtins translate through the
// evalPage.evaluatorNames.<Name> locale block (falling back to the bare id
// segment); custom judges keep their user-given name untouched.
export function evaluatorLabel(t: TFunction, id: string): string {
  if (!id.startsWith("Builtin.")) return id;
  const bare = id.slice("Builtin.".length);
  return t(`evalPage.evaluatorNames.${bare}`, { defaultValue: bare });
}
