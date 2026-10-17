import { useEffect, useState } from "react";
import { useData } from "../data";

/** 這台裝置在哪家門市／倉庫（存在裝置上；多店時掃碼、POS、退貨都記在這個地點）。 */
const KEY = "g29.location";
const listeners = new Set<(v: string | null) => void>();

function read(): string | null {
  try {
    return localStorage.getItem(KEY);
  } catch {
    return null;
  }
}

export function setDeviceLocation(id: string | null) {
  try {
    if (id) localStorage.setItem(KEY, id);
    else localStorage.removeItem(KEY);
  } catch {
    /* ignore */
  }
  listeners.forEach((l) => l(id));
}

/** Returns the device's location id when the shop has locations set up (null otherwise). */
export function useDeviceLocation() {
  const { settings } = useData();
  const list = settings.locations ?? [];
  const [id, setId] = useState<string | null>(read);
  useEffect(() => {
    listeners.add(setId);
    return () => {
      listeners.delete(setId);
    };
  }, []);
  const valid = list.find((l) => l.id === id) ? id : list[0]?.id ?? null;
  // Remember the default so event handlers (getDeviceLocationId) see the same location.
  useEffect(() => {
    if (valid && valid !== id) setDeviceLocation(valid);
  }, [valid, id]);
  return { multi: list.length > 0, locationId: list.length ? valid : null, locations: list, name: list.find((l) => l.id === valid)?.name ?? "" };
}

/** Non-hook access for event handlers (the server falls back to the order's own location). */
export function getDeviceLocationId(): string | null {
  return read();
}
