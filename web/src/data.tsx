import { collection, doc, onSnapshot, query, where } from "firebase/firestore";
import { createContext, useContext, useEffect, useMemo, useState, type ReactNode } from "react";
import { useAuth } from "./auth";
import { db } from "./firebase";
import type { ShopSettings, Variant } from "./types";

interface DataState {
  ready: boolean;
  variants: Variant[];
  byId: Map<string, Variant>;
  settings: ShopSettings;
}

const Ctx = createContext<DataState>({ ready: false, variants: [], byId: new Map(), settings: {} });
export const useData = () => useContext(Ctx);

/**
 * The whole active catalogue is kept live in memory (one listener per device):
 * search, filters and POS product cards then work instantly and offline.
 */
export function DataProvider({ children }: { children: ReactNode }) {
  const { profile } = useAuth();
  const [variants, setVariants] = useState<Variant[]>([]);
  const [settings, setSettings] = useState<ShopSettings>({});
  const [ready, setReady] = useState(false);
  const enabled = !!profile?.active;

  useEffect(() => {
    if (!enabled) return;
    const u1 = onSnapshot(query(collection(db, "variants"), where("active", "==", true)), (s) => {
      setVariants(s.docs.map((d) => ({ id: d.id, ...d.data() }) as Variant));
      setReady(true);
    });
    const u2 = onSnapshot(doc(db, "settings", "shop"), (s) => setSettings((s.data() as ShopSettings) ?? {}));
    return () => {
      u1();
      u2();
    };
  }, [enabled]);

  const byId = useMemo(() => new Map(variants.map((v) => [v.id, v])), [variants]);
  return <Ctx.Provider value={{ ready, variants, byId, settings }}>{children}</Ctx.Provider>;
}

export const variantName = (v: Pick<Variant, "productTitle" | "options">) => (v.options ? `${v.productTitle}（${v.options}）` : v.productTitle);

export function stockState(v: Variant, expiryDays = 30): "out" | "low" | "expiring" | "ok" {
  const s = v.shopStock ?? 0;
  if (s <= 0) return "out";
  if (v.safety > 0 && s <= v.safety) return "low";
  const limit = new Date(Date.now() + expiryDays * 86400_000).toISOString().slice(0, 10);
  if ((v.batches ?? []).some((b) => b.exp && b.exp <= limit)) return "expiring";
  return "ok";
}
