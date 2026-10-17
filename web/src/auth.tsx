import { onAuthStateChanged, signInWithPopup, signOut, type User } from "firebase/auth";
import { doc, onSnapshot } from "firebase/firestore";
import { createContext, useContext, useEffect, useState, type ReactNode } from "react";
import { auth, call, db, googleProvider } from "./firebase";
import type { Role } from "./lib/util";

interface Profile {
  name: string;
  email: string;
  role: Role;
  active: boolean;
}

interface AuthState {
  loading: boolean;
  user: User | null;
  profile: Profile | null;
  login: () => Promise<void>;
  logout: () => Promise<void>;
}

const Ctx = createContext<AuthState>(null!);
export const useAuth = () => useContext(Ctx);

export function AuthProvider({ children }: { children: ReactNode }) {
  const [user, setUser] = useState<User | null>(null);
  const [profile, setProfile] = useState<Profile | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(
    () =>
      onAuthStateChanged(auth, async (u) => {
        setUser(u);
        setProfile(null);
        if (!u) setLoading(false);
      }),
    []
  );

  useEffect(() => {
    if (!user) return;
    let triedOwner = false;
    let lastClaim = "";
    return onSnapshot(
      doc(db, "users", user.uid),
      async (snap) => {
        const p = snap.data() as Profile | undefined;
        if (!p && !triedOwner) {
          // The owner's / an engineer's very first login creates their account (server checks OWNER_EMAIL / ENGINEER_EMAILS).
          triedOwner = true;
          try {
            await call("claimOwner");
            return;
          } catch {
            /* not owner / engineer — needs an invite */
          }
        }
        // Role / active changed on the server → refresh the token so Firestore rules see the new claims.
        const claim = p ? `${p.role}:${p.active}` : "";
        if (p && claim !== lastClaim) {
          const t = await user.getIdTokenResult();
          if (t.claims.role !== p.role || t.claims.active !== p.active) await user.getIdToken(true);
          lastClaim = claim;
        }
        setProfile(p ?? null);
        setLoading(false);
      },
      () => setLoading(false)
    );
  }, [user]);

  const value: AuthState = {
    loading,
    user,
    profile,
    login: async () => {
      await signInWithPopup(auth, googleProvider);
    },
    logout: () => signOut(auth),
  };
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}
