import { doc, getDoc } from "firebase/firestore";
import { db } from "../firebase";
import type { Variant } from "../types";
import { codeKey } from "./util";

/**
 * Scan → variant. Our own QR labels hold the meepShop variant id; other codes are
 * barcode / SKU / bound codes. The in-memory catalogue answers almost every scan;
 * the codes/{code} doc is the fallback (and the source of truth for bindings).
 */
export async function resolveCode(raw: string, byId: Map<string, Variant>): Promise<Variant | null> {
  const code = raw.trim();
  if (!code) return null;
  const direct = byId.get(code);
  if (direct) return direct;
  for (const v of byId.values()) {
    if (v.barcode === code || v.sku === code || v.storeCode === code || v.extraCodes?.includes(code)) return v;
  }
  try {
    const snap = await getDoc(doc(db, "codes", codeKey(code)));
    if (snap.exists()) return byId.get(snap.data().variantId) ?? null;
  } catch {
    /* offline */
  }
  return null;
}

export function searchVariants(list: Variant[], q: string): Variant[] {
  const terms = q.toLowerCase().trim().split(/\s+/).filter(Boolean);
  if (!terms.length) return list;
  return list.filter((v) => {
    const hay = `${v.searchText ?? ""} ${v.productTitle} ${v.options} ${v.location ?? ""} ${v.sku ?? ""} ${v.barcode ?? ""}`.toLowerCase();
    return terms.every((t) => hay.includes(t));
  });
}
