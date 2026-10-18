import { collection, onSnapshot } from "firebase/firestore";
import { useEffect, useMemo, useState } from "react";
import { Badge, Empty, useAction } from "../../components/ui";
import { useData } from "../../data";
import { call, db } from "../../firebase";
import { downloadCsv, money } from "../../lib/util";
import type { Variant } from "../../types";

/**
 * 商品成本（老闆）：現有庫存沒有進貨紀錄，成本是空的 → 報表的毛利、庫存總值都是 0。
 * 這裡可以：每款直接填、依售價百分比一次設定、匯出／匯入 Excel（CSV）。
 * 同一款商品各尺寸顏色成本通常一樣，所以預設「整款一起設」，需要時再展開個別設定。
 */
interface Group {
  productId: string;
  title: string;
  image: string | null;
  variants: Variant[];
}

export function Costs() {
  const { variants } = useData();
  const [saved, setSaved] = useState<Map<string, number | null>>(new Map());
  const [edit, setEdit] = useState<Map<string, string>>(new Map()); // variantId → 輸入中的成本
  const [q, setQ] = useState("");
  const [only, setOnly] = useState<"all" | "unset" | "set">("unset");
  const [open, setOpen] = useState<Set<string>>(new Set());
  const [pct, setPct] = useState("40");
  const { busy, run } = useAction();

  useEffect(
    () =>
      onSnapshot(collection(db, "costs"), (s) => {
        const m = new Map<string, number | null>();
        s.docs.forEach((d) => m.set(d.id, d.data().avgCost ?? null));
        setSaved(m);
      }),
    []
  );

  const costOf = (v: Variant): number | null => {
    const e = edit.get(v.id);
    if (e !== undefined) return e === "" ? null : Number(e);
    return saved.get(v.id) ?? null;
  };
  const groups = useMemo(() => {
    const map = new Map<string, Group>();
    for (const v of variants) {
      const g = map.get(v.productId) ?? { productId: v.productId, title: v.productTitle, image: v.thumbUrl || v.imageUrl, variants: [] };
      g.variants.push(v);
      map.set(v.productId, g);
    }
    const t = q.trim().toLowerCase();
    return [...map.values()]
      .map((g) => ({ ...g, variants: g.variants.sort((a, b) => a.variantIndex - b.variantIndex) }))
      .filter((g) => !t || g.title.toLowerCase().includes(t))
      .filter((g) => {
        const set = g.variants.every((v) => (saved.get(v.id) ?? null) !== null);
        return only === "all" || (only === "set" ? set : !set);
      })
      .sort((a, b) => a.title.localeCompare(b.title, "zh-Hant"));
  }, [variants, q, only, saved]);

  const totals = useMemo(() => {
    let set = 0;
    let stockValue = 0;
    for (const v of variants) {
      const c = saved.get(v.id) ?? null;
      if (c !== null) {
        set++;
        stockValue += c * Math.max(0, v.shopStock ?? 0);
      }
    }
    return { set, all: variants.length, stockValue };
  }, [variants, saved]);

  const setMany = (vs: Variant[], value: string) =>
    setEdit((m) => {
      const n = new Map(m);
      vs.forEach((v) => n.set(v.id, value));
      return n;
    });
  const changed = [...edit.entries()].filter(([id, val]) => (val === "" ? null : Number(val)) !== (saved.get(id) ?? null));
  const save = () =>
    run(async () => {
      const items = changed.map(([variantId, val]) => ({ variantId, cost: val === "" ? null : Number(val) }));
      if (items.some((x) => x.cost !== null && !(x.cost >= 0))) throw new Error("成本要是數字");
      for (let i = 0; i < items.length; i += 500) await call("setCosts", { items: items.slice(i, i + 500) });
      setEdit(new Map());
    }, `已儲存 ${changed.length} 個款式的成本`);

  /** 沒設定成本的，依售價 × % 填入（不會覆蓋已設定的） */
  const fillByPct = () => {
    const p = Number(pct);
    if (!(p > 0 && p < 100)) return alert("請輸入 1～99 的百分比");
    const targets = variants.filter((v) => costOf(v) === null && (v.price ?? 0) > 0);
    if (!targets.length) return alert("沒有還沒設定成本的商品");
    if (!confirm(`把 ${targets.length} 個沒有成本的款式，成本設成「售價 × ${p}%」？（按儲存才會生效）`)) return;
    setEdit((m) => {
      const n = new Map(m);
      targets.forEach((v) => n.set(v.id, String(Math.round(((v.price ?? 0) * p) / 100))));
      return n;
    });
    setOnly("all");
  };

  const exportCsv = () =>
    downloadCsv(`商品成本_${new Date().toISOString().slice(0, 10)}.csv`, [
      ["款式ID（不要改）", "商品", "規格", "售價", "成本"],
      ...variants.map((v) => [v.id, v.productTitle, v.options, v.price ?? 0, saved.get(v.id) ?? ""]),
    ]);
  const importFile = (file: File) =>
    run(async () => {
      const rows = await readTable(file);
      const byId = new Map(variants.map((v) => [v.id, v]));
      const byName = new Map(variants.map((v) => [`${v.productTitle}|${v.options}`, v]));
      // 找標題列：本系統匯出的「款式ID／商品／規格／售價／成本」，或 meepShop「商品大量更新」的「ID(勿改)／商品名稱(勿改)／規格(勿改)／…／成本」
      const hi = rows.findIndex((r) => r.some((c) => String(c).trim() === "成本"));
      if (hi < 0) throw new Error("找不到「成本」欄位：請用本頁匯出的成本表，或 meepShop「商品大量更新」匯出的 Excel");
      const head = rows[hi].map((c) => String(c ?? "").trim());
      const col = (re: RegExp) => head.findIndex((h) => re.test(h));
      const cId = col(/^(款式ID|ID)/);
      const cTitle = col(/^商品(名稱)?/);
      const cOpt = col(/^規格/);
      const cCost = head.indexOf("成本");
      let ok = 0;
      let zero = 0;
      const miss: string[] = [];
      const n = new Map(edit);
      for (const r of rows.slice(hi + 1)) {
        const get = (i: number) => (i >= 0 ? String(r[i] ?? "").trim() : "");
        const id = get(cId);
        const title = get(cTitle);
        const cost = get(cCost);
        if (!cost) continue;
        const v = byId.get(id) ?? byName.get(`${title}|${get(cOpt)}`);
        if (!v || isNaN(Number(cost))) {
          if (id || title) miss.push(title || id);
          continue;
        }
        if (Number(cost) === 0) {
          zero++; // meepShop 沒填成本的是 0，不要蓋掉已經設定的
          continue;
        }
        if (Number(cost) >= (v.price ?? 0) && (v.price ?? 0) > 0) miss.push(`${v.productTitle} ${v.options}：成本 ${cost} 高於售價 ${v.price}，請確認`);
        n.set(v.id, String(Number(cost)));
        ok++;
      }
      setEdit(n);
      setOnly("all");
      if (miss.length) alert(`請確認以下 ${miss.length} 筆：\n${miss.slice(0, 12).join("\n")}${zero ? `\n\n另外 ${zero} 筆成本是 0，沒有匯入。` : ""}`);
      if (!ok) throw new Error("檔案裡沒有可以匯入的成本");
    }, "已讀入，確認後按「儲存」");

  return (
    <div className="page">
      <div className="page-head">
        <div>
          <h1>商品成本</h1>
          <div className="muted small">
            已設定 {totals.set}／{totals.all} 個款式　庫存成本總值 {money(Math.round(totals.stockValue))}。成本只有老闆看得到；設定後報表的毛利、庫存總值才會正確。之後掃碼進貨有填進貨單價，會自動用加權平均更新。
          </div>
        </div>
        <button className="btn btn-primary" disabled={busy || !changed.length} onClick={save}>
          儲存（{changed.length}）
        </button>
      </div>

      <div className="card cost-tools">
        <div className="inline-form">
          <span>沒有成本的，一次用</span>
          <span className="addon-input">
            <span>售價 ×</span>
            <input inputMode="numeric" value={pct} onChange={(e) => setPct(e.target.value.replace(/\D/g, ""))} />
            <span>%</span>
          </span>
          <button className="btn" onClick={fillByPct}>
            填入
          </button>
        </div>
        <div className="inline-form">
          <button className="btn" onClick={exportCsv}>
            匯出成本表（Excel 可開）
          </button>
          <label className="btn">
            匯入成本表
            <input type="file" accept=".csv,.xlsx" hidden onChange={(e) => (e.target.files?.[0] && importFile(e.target.files[0]), (e.target.value = ""))} />
          </label>
          <span className="muted small">可以匯入 meepShop「商品大量更新」匯出的 Excel（會讀「成本」欄），或本頁匯出的成本表</span>
        </div>
      </div>

      <div className="filters">
        <input placeholder="搜尋商品" value={q} onChange={(e) => setQ(e.target.value)} />
        <div className="chips">
          {(
            [
              ["unset", "還沒設定"],
              ["set", "已設定"],
              ["all", "全部"],
            ] as const
          ).map(([k, l]) => (
            <button key={k} className={`chip ${only === k ? "active" : ""}`} onClick={() => setOnly(k)}>
              {l}
            </button>
          ))}
        </div>
      </div>

      {groups.length === 0 ? (
        <Empty>{only === "unset" ? "全部商品都設定好成本了 🎉" : "沒有商品"}</Empty>
      ) : (
        <div className="table-wrap">
          <table className="table">
            <thead>
              <tr>
                <th>商品</th>
                <th className="num">售價</th>
                <th className="num">成本</th>
                <th className="num">毛利率</th>
              </tr>
            </thead>
            <tbody>
              {groups.slice(0, 300).map((g) => {
                const costs = g.variants.map(costOf);
                const same = costs.every((c) => c === costs[0]);
                const price = Math.min(...g.variants.map((v) => v.price ?? 0));
                const c0 = costs[0];
                const expanded = open.has(g.productId) || !same;
                const margin = (p: number, c: number | null) => (c === null || !p ? "—" : `${Math.round(((p - c) / p) * 100)}%`);
                return [
                  <tr key={g.productId} className="cost-head">
                    <td>
                      {g.image && <img src={g.image} alt="" className="thumb-sm" />} <strong>{g.title}</strong>
                      {g.variants.length > 1 && (
                        <button
                          className="link-btn small"
                          onClick={() =>
                            setOpen((s) => {
                              const n = new Set(s);
                              if (n.has(g.productId)) n.delete(g.productId);
                              else n.add(g.productId);
                              return n;
                            })
                          }
                        >
                          {expanded ? "收起" : `各規格（${g.variants.length}）`}
                        </button>
                      )}
                      {costs.some((c) => c === null) && <Badge tone="warn">未設定</Badge>}
                    </td>
                    <td className="num">{money(price)}</td>
                    <td className="num">
                      {same ? (
                        <input className="cost-input" inputMode="decimal" placeholder="成本" value={c0 === null ? "" : String(c0)} onChange={(e) => setMany(g.variants, e.target.value.replace(/[^\d.]/g, ""))} />
                      ) : (
                        <span className="muted small">各規格不同</span>
                      )}
                    </td>
                    <td className="num">{same ? margin(price, c0) : ""}</td>
                  </tr>,
                  ...(expanded && g.variants.length > 1
                    ? g.variants.map((v) => (
                        <tr key={v.id} className="cost-sub">
                          <td>　└ {v.options || "單一規格"}</td>
                          <td className="num">{money(v.price ?? 0)}</td>
                          <td className="num">
                            <input className="cost-input" inputMode="decimal" placeholder="成本" value={costOf(v) === null ? "" : String(costOf(v))} onChange={(e) => setMany([v], e.target.value.replace(/[^\d.]/g, ""))} />
                          </td>
                          <td className="num">{margin(v.price ?? 0, costOf(v))}</td>
                        </tr>
                      ))
                    : []),
                ];
              })}
            </tbody>
          </table>
          {groups.length > 300 && <p className="muted center">只顯示前 300 款，請用搜尋縮小範圍</p>}
        </div>
      )}
    </div>
  );
}

/** 讀 CSV 或 xlsx 的第一個工作表 → 二維陣列 */
async function readTable(file: File): Promise<string[][]> {
  if (/\.csv$/i.test(file.name)) {
    const text = (await file.text()).replace(/^﻿/, "");
    const rows: string[][] = [];
    let row: string[] = [];
    let cur = "";
    let quoted = false;
    for (let i = 0; i < text.length; i++) {
      const ch = text[i];
      if (quoted) {
        if (ch === '"' && text[i + 1] === '"') (cur += '"'), i++;
        else if (ch === '"') quoted = false;
        else cur += ch;
      } else if (ch === '"') quoted = true;
      else if (ch === ",") row.push(cur), (cur = "");
      else if (ch === "\n" || ch === "\r") {
        if (ch === "\r" && text[i + 1] === "\n") i++;
        row.push(cur);
        rows.push(row);
        row = [];
        cur = "";
      } else cur += ch;
    }
    if (cur || row.length) row.push(cur), rows.push(row);
    return rows;
  }
  const { default: JSZip } = await import("jszip");
  const zip = await JSZip.loadAsync(await file.arrayBuffer());
  const strs: string[] = [];
  const ss = await zip.file("xl/sharedStrings.xml")?.async("string");
  const dom = new DOMParser();
  if (ss) dom.parseFromString(ss, "application/xml").querySelectorAll("si").forEach((si) => strs.push(si.textContent ?? ""));
  const sheet = await zip.file("xl/worksheets/sheet1.xml")?.async("string");
  if (!sheet) throw new Error("讀不到工作表");
  const col = (ref: string) => ref.replace(/\d+/g, "").split("").reduce((n, c) => n * 26 + c.charCodeAt(0) - 64, 0) - 1;
  const out: string[][] = [];
  dom
    .parseFromString(sheet, "application/xml")
    .querySelectorAll("row")
    .forEach((r) => {
      const row: string[] = [];
      r.querySelectorAll("c").forEach((c) => {
        const t = c.getAttribute("t");
        const v = c.querySelector("v")?.textContent ?? c.querySelector("is t")?.textContent ?? "";
        row[col(c.getAttribute("r") ?? "A")] = t === "s" ? strs[Number(v)] ?? "" : v;
      });
      out.push(Array.from(row, (x) => x ?? ""));
    });
  return out;
}
