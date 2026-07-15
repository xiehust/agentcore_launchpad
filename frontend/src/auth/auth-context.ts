import { createContext, useContext } from "react";

export interface AuthContextValue {
  authRequired: boolean;
  username: string | null;
  logout: () => Promise<void>;
}

export const AuthContext = createContext<AuthContextValue>({
  authRequired: false,
  username: null,
  logout: async () => undefined,
});

export function useAuth() {
  return useContext(AuthContext);
}
