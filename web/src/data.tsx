import { collection, doc, onSnapshot, query, where } from "firebase/firestore";
import { createContext, useContext, useEffect, useMemo, useState, type ReactNode } from "react";
import { useAuth } from "./auth";
import { db } from "./firebase";
import type { Promotion } from "./lib/promo";
import type { ShopSettings, Variant } from "./types";

interface DataState {
  ready: boolean;
  variants: Variant[];
  byId: Map<string, Variant>;
  settings: ShopSettings;
  /** active promotions (date range is checked by the engine) */
  promotions: Promotion[];
}

const Ctx = createContext<DataState>({ ready: false, variants: [], byId: new Map(), settings: {}, promotions: [] });
export const useData = () => useContext(Ctx);

/**
 * The whole active catalogue is kept live in memory (one listener per device):
 * search, filters and POS product cards then work instantly and offline.
 */
export function DataProvider({ children }: { children: ReactNode }) {
  const { profile } = useAuth();
  const [variants, setVariants] = useState<Variant[]>([]);
  const [settings, setSettings] = useState<ShopSettings>({});
  const [promotions, setPromotions] = useState<Promotion[]>([]);
  const [ready, setReady] = useState(false);
  const enabled = !!profile?.active;

  useEffect(() => {
    if (!enabled) return;
    const u1 = onSnapshot(query(collection(db, "variants"), where("active", "==", true)), (s) => {
      setVariants(s.docs.map((d) => ({ id: d.id, ...d.data() }) as Variant));
      setReady(true);
    });
    const u2 = onSnapshot(doc(db, "settings", "shop"), (s) => setSettings((s.data() as ShopSettings) ?? {}));
    const u3 = onSnapshot(query(collection(db, "promotions"), where("active", "==", true)), (s) => setPromotions(s.docs.map((d) => ({ id: d.id, ...d.data() }) as Promotion)));
    return () => {
      u1();
      u2();
      u3();
    };
  }, [enabled]);

  const byId = useMemo(() => new Map(variants.map((v) => [v.id, v])), [variants]);
  return <Ctx.Provider value={{ ready, variants, byId, settings, promotions }}>{children}</Ctx.Provider>;
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

const DAY = 86400_000;
export function daysSince(t: { toMillis(): number } | null | undefined): number | null {
  return t ? Math.max(0, Math.floor((Date.now() - t.toMillis()) / DAY)) : null;
}

/** 庫齡：最早一批還在庫的進貨距今幾天；沒有批次紀錄時，用 meepShop 上架（建立款式）日起算。 */
export function stockAge(v: Variant): { days: number; basis: "batch" | "listed" } | null {
  if ((v.shopStock ?? 0) <= 0) return null;
  const batches = (v.batches ?? []).filter((b) => b.qty > 0 && b.receivedAt);
  if (batches.length) return { days: daysSince(batches.reduce((a, b) => (a.receivedAt.toMillis() < b.receivedAt.toMillis() ? a : b)).receivedAt)!, basis: "batch" };
  const listed = daysSince(v.shopCreatedAt);
  return listed === null ? null : { days: listed, basis: "listed" };
}

/** 滯銷：有庫存，但 N 天內門市與網店都沒賣出 */
export const SLOW_DAYS = 60;
export function isSlow(v: Variant): boolean {
  if ((v.shopStock ?? 0) <= 0 || !v.statsAt) return false;
  const d = daysSince(v.lastSoldAt);
  return d === null || d >= SLOW_DAYS;
}
