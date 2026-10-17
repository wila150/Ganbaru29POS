import { setDeviceLocation, useDeviceLocation } from "../lib/location";

/** 多店時顯示：這台裝置在哪家門市／倉庫。 */
export function LocationSelect({ compact }: { compact?: boolean }) {
  const { multi, locationId, locations } = useDeviceLocation();
  if (!multi) return null;
  return (
    <select className={compact ? "loc-select compact" : "loc-select"} value={locationId ?? ""} onChange={(e) => setDeviceLocation(e.target.value)} aria-label="所在門市／倉庫">
      {locations.map((l) => (
        <option key={l.id} value={l.id}>
          📍 {l.name}
        </option>
      ))}
    </select>
  );
}
