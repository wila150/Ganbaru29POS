import { onCall } from "firebase-functions/v2/https";
import { audit } from "./lib/audit";
import { requireRole } from "./lib/auth";
import { assert, db, FieldValue, str, taipeiDate, Timestamp } from "./lib/util";

/** 員工打卡：上班／下班用伺服器時間記錄；店長以上可補登或修正（留下操作紀錄）。 */

async function openRecord(uid: string) {
  const q = await db.collection("attendance").where("uid", "==", uid).where("open", "==", true).limit(1).get();
  return q.docs[0] ?? null;
}

export const clockIn = onCall(async (req) => {
  const actor = await requireRole(req, "staff");
  assert(!(await openRecord(actor.uid)), "你已經在上班中，請先打下班卡", "failed-precondition");
  const ref = await db.collection("attendance").add({
    uid: actor.uid,
    name: actor.name,
    date: taipeiDate(),
    inAt: FieldValue.serverTimestamp(),
    outAt: null,
    minutes: null,
    open: true,
    locationId: str(req.data?.locationId, "門市", { optional: true, max: 40 }) || null,
    device: str(req.data?.device, "裝置", { optional: true, max: 80 }) || null,
  });
  return { id: ref.id };
});

export const clockOut = onCall(async (req) => {
  const actor = await requireRole(req, "staff");
  const rec = await openRecord(actor.uid);
  assert(rec, "目前沒有上班紀錄，請先打上班卡", "failed-precondition");
  const inAt = (rec.data().inAt as Timestamp).toMillis();
  const minutes = Math.max(0, Math.round((Date.now() - inAt) / 60_000));
  await rec.ref.update({ outAt: FieldValue.serverTimestamp(), minutes, open: false });
  return { minutes };
});

/** 補登／修正：inAt、outAt 為 ISO 時間；id 空白 = 新增一筆 */
export const fixAttendance = onCall(async (req) => {
  const actor = await requireRole(req, "manager");
  const d = req.data ?? {};
  const inAt = new Date(String(d.inAt));
  const outAt = d.outAt ? new Date(String(d.outAt)) : null;
  assert(!isNaN(inAt.getTime()) && (!outAt || (!isNaN(outAt.getTime()) && outAt > inAt)), "時間不正確");
  const note = str(d.note, "原因", { max: 100 });
  const data = {
    inAt: Timestamp.fromDate(inAt),
    outAt: outAt ? Timestamp.fromDate(outAt) : null,
    minutes: outAt ? Math.round((outAt.getTime() - inAt.getTime()) / 60_000) : null,
    open: !outAt,
    date: taipeiDate(inAt),
    editedBy: actor.name,
    editNote: note,
    editedAt: FieldValue.serverTimestamp(),
  };
  if (d.id) {
    const ref = db.doc(`attendance/${str(d.id, "紀錄", { max: 40 })}`);
    const before = (await ref.get()).data();
    assert(before, "找不到紀錄", "not-found");
    await ref.update(data);
    await audit(actor, "attendance.fix", { id: d.id, name: before.name, before: { inAt: before.inAt?.toDate?.(), outAt: before.outAt?.toDate?.() }, after: { inAt, outAt }, note });
    return { id: d.id };
  }
  const uid = str(d.uid, "員工", { max: 128 });
  const u = (await db.doc(`users/${uid}`).get()).data();
  assert(u, "找不到員工", "not-found");
  const ref = await db.collection("attendance").add({ uid, name: u.name || u.email, ...data, locationId: null });
  await audit(actor, "attendance.add", { id: ref.id, name: u.name, inAt, outAt, note });
  return { id: ref.id };
});
