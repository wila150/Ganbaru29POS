import { useEffect, useMemo, useRef, useState } from "react";
import { useData } from "../data";
import { call } from "../firebase";
import { useAction } from "./ui";

/**
 * LINE 圖文選單編輯：選版型（4／5／6 格）→ 每格選功能、文字、顏色 → 預覽 → 套用。
 * 圖片在瀏覽器用 canvas 畫（街頭風：Bebas Neue 英文大字＋思源黑體中文），也可以改用自己上傳的圖。
 */

type Action = "card" | "new" | "sale" | "promo" | "store" | "foryou" | "prefs" | "service" | "url" | "ig";
type Color = "photo" | "brown" | "gray" | "purple" | "igGrad" | "igMilk";
interface Cell {
  action: Action;
  en: string;
  zh: string;
  sub: string;
  color: Color;
  url?: string;
  /** 這一格自己上傳的照片（data URL）；沒有就用共用的商品照片 */
  photo?: string;
  /** 只放這張圖、不疊文字（客人自己做好的格子圖） */
  plain?: boolean;
  /** 字放在最下面，不遮到圖中間（例如 logo 底圖） */
  low?: boolean;
  /** 上傳圖的位置：縮放 100~300（%）、左右 / 上下 -100~100（往右 / 往下為正） */
  zoom?: number;
  px?: number;
  py?: number;
}

const ACTIONS: Record<Action, { name: string; en: string; zh: string; sub: string }> = {
  new: { name: "最新商品", en: "NEW ARRIVALS", zh: "最新商品", sub: "本季新品・搶先看" },
  card: { name: "會員卡", en: "VIP CLUB", zh: "會員卡", sub: "購物金・消費紀錄" },
  sale: { name: "特價商品", en: "ON SALE", zh: "限時特惠", sub: "零碼出清・把握機會" },
  promo: { name: "本月活動", en: "EVENT", zh: "本月活動", sub: "優惠・限時特惠" },
  store: { name: "門市資訊", en: "STORE", zh: "門市資訊", sub: "地址・營業時間" },
  foryou: { name: "為你推薦", en: "FOR YOU", zh: "為你推薦", sub: "依你的喜好挑選" },
  prefs: { name: "我的喜好", en: "MY STYLE", zh: "我的喜好", sub: "新品・特價通知" },
  service: { name: "一對一客服", en: "SERVICE", zh: "一對一客服", sub: "尺寸諮詢・訂單進度" },
  ig: { name: "Instagram", en: "INSTAGRAM", zh: "追蹤 IG", sub: "穿搭・新品搶先看" },
  url: { name: "打開網址", en: "SHOP", zh: "逛官網", sub: "ganbaru29.com" },
};
const COLORS: Record<Color, { name: string; bg: string; fg: string; bar: string }> = {
  photo: { name: "商品照片", bg: "#3a2a20", fg: "#ffffff", bar: "#ffffff" },
  brown: { name: "大地咖", bg: "#4a3b32", fg: "#eae3da", bar: "#c9ae90" },
  gray: { name: "水泥灰", bg: "#e5e5e5", fg: "#4a3b32", bar: "#4a3b32" },
  purple: { name: "洗舊紫灰", bg: "#6c636b", fg: "#f1ecef", bar: "#e5e5e5" },
  igGrad: { name: "IG 漸層（紫粉橘）", bg: "#8134af", fg: "#ffffff", bar: "#ffffff" },
  igMilk: { name: "IG 漸層（咖啡奶茶）", bg: "#4a3b32", fg: "#ffffff", bar: "#f3e6d6" },
};
/** IG 風格漸層底：左下 → 右上，再壓一層暗色讓字比較有質感 */
const GRADS: Partial<Record<Color, string[]>> = {
  igGrad: ["#feda75", "#fa7e1e", "#d62976", "#962fbf", "#4f5bd5"],
  igMilk: ["#d9b99b", "#a9805f", "#6e4f3c", "#3a2b23"],
};
const BOXES: Record<string, { x: number; y: number; w: number; h: number }[]> = {
  "4": [
    { x: 0, y: 0, w: 1250, h: 843 },
    { x: 1250, y: 0, w: 1250, h: 843 },
    { x: 0, y: 843, w: 1250, h: 843 },
    { x: 1250, y: 843, w: 1250, h: 843 },
  ],
  "5": [
    { x: 0, y: 0, w: 1250, h: 843 },
    { x: 1250, y: 0, w: 1250, h: 843 },
    { x: 0, y: 843, w: 833, h: 843 },
    { x: 833, y: 843, w: 834, h: 843 },
    { x: 1667, y: 843, w: 833, h: 843 },
  ],
  "6": [
    { x: 0, y: 0, w: 833, h: 843 },
    { x: 833, y: 0, w: 834, h: 843 },
    { x: 1667, y: 0, w: 833, h: 843 },
    { x: 0, y: 843, w: 833, h: 843 },
    { x: 833, y: 843, w: 834, h: 843 },
    { x: 1667, y: 843, w: 833, h: 843 },
  ],
};
const DEFAULTS: Record<string, [Action, Color][]> = {
  "4": [["new", "photo"], ["card", "brown"], ["promo", "gray"], ["url", "purple"]],
  "5": [["new", "photo"], ["card", "brown"], ["promo", "gray"], ["store", "purple"], ["url", "brown"]],
  "6": [["new", "photo"], ["card", "brown"], ["sale", "gray"], ["promo", "purple"], ["store", "gray"], ["ig", "brown"]],
};
const mk = (a: Action, color: Color): Cell => ({ action: a, en: ACTIONS[a].en, zh: ACTIONS[a].zh, sub: ACTIONS[a].sub, color, url: a === "url" ? "https://www.ganbaru29.com" : a === "ig" ? "https://www.instagram.com/" : undefined });

function loadImg(src: string): Promise<HTMLImageElement> {
  return new Promise((ok, bad) => {
    const i = new Image();
    i.onload = () => ok(i);
    i.onerror = bad;
    i.src = src;
  });
}

/** 字太長就縮小，塞得進格子 */
/** 把圖蓋滿格子（cover），再依縮放、左右、上下調整位置；defFy＝沒調整時上下停在哪（0 頂、1 底） */
function placeImg(ctx: CanvasRenderingContext2D, im: HTMLImageElement, c: Cell, x: number, y: number, w: number, h: number, defFy: number | ((ih: number) => number)) {
  const s = Math.max(w / im.width, h / im.height) * ((c.zoom ?? 100) / 100);
  const iw = im.width * s,
    ih = im.height * s;
  const clamp = (v: number) => Math.min(1, Math.max(0, v));
  const fy0 = typeof defFy === "function" ? defFy(ih) : defFy;
  const fx = clamp(0.5 - (c.px ?? 0) / 200);
  const fy = clamp(fy0 - (c.py ?? 0) / 200);
  ctx.drawImage(im, x + (w - iw) * fx, y + (h - ih) * fy, iw, ih);
  return { ew: iw - w, eh: ih - h };
}

/** 拖拉用：每格上傳圖比格子多出來的寬高（可移動的範圍） */
const geo: Record<number, { ew: number; eh: number }> = {};

function fitText(ctx: CanvasRenderingContext2D, t: string, font: (px: number) => string, start: number, maxW: number) {
  let px = start;
  ctx.font = font(px);
  while (px > 20 && ctx.measureText(t).width > maxW) ctx.font = font((px -= 4));
  return px;
}

/** 滑鼠在畫面上的位置 → 畫布座標（畫布 2500×1686 縮小顯示） */
function toCanvas(e: { clientX: number; clientY: number; currentTarget: HTMLCanvasElement }) {
  const r = e.currentTarget.getBoundingClientRect();
  return { x: ((e.clientX - r.left) / r.width) * 2500, y: ((e.clientY - r.top) / r.height) * 1686 };
}

export function RichMenuEditor() {
  const { settings, variants } = useData();
  const saved = settings.lineBot?.richMenuConfig as { layout: string; cells: { action: Action; url?: string | null; label?: string | null }[] } | undefined;
  const [layout, setLayout] = useState<string>(saved?.layout && BOXES[saved.layout] ? saved.layout : "5");
  const [cells, setCells] = useState<Cell[]>(() =>
    (saved?.layout && BOXES[saved.layout] ? saved.cells.map((c, i) => ({ ...mk(c.action, DEFAULTS[saved.layout][i]?.[1] ?? "brown"), url: c.url ?? mk(c.action, "brown").url })) : DEFAULTS["5"].map(([a, c]) => mk(a, c)))
  );
  const [photoUrl, setPhotoUrl] = useState<string>(""); // 商品照片（data URL）
  const [photoPick, setPhotoPick] = useState("");
  const [own, setOwn] = useState<string | null>(null); // 自己上傳的整張選單圖
  const [ready, setReady] = useState(false);
  const canvas = useRef<HTMLCanvasElement>(null);
  const drag = useRef<{ i: number; sx: number; sy: number; px: number; py: number } | null>(null);
  const live = useRef({ cells: [] as Cell[], layout: "5", own: false });
  const { busy, run } = useAction();

  const products = useMemo(() => {
    const m = new Map<string, { title: string; url: string }>();
    for (const v of variants) if (v.productStatus === "LISTED" && v.imageUrl && !m.has(v.productId)) m.set(v.productId, { title: v.productTitle, url: v.imageUrl });
    return [...m.entries()].map(([id, x]) => ({ id, ...x }));
  }, [variants]);

  // 載入字型（Google Fonts）
  useEffect(() => {
    if (!document.getElementById("rm-fonts")) {
      const l = document.createElement("link");
      l.id = "rm-fonts";
      l.rel = "stylesheet";
      l.href = "https://fonts.googleapis.com/css2?family=Bebas+Neue&family=Noto+Sans+TC:wght@400;500&display=block";
      document.head.appendChild(l);
    }
    Promise.all([document.fonts.load('100px "Bebas Neue"'), document.fonts.load('60px "Noto Sans TC"'), document.fonts.load('500 60px "Noto Sans TC"')])
      .catch(() => undefined)
      .finally(() => setReady(true));
  }, []);

  // 商品照片：預設用最新商品；圖片伺服器不給瀏覽器直接讀，請後端代抓
  useEffect(() => {
    const url = photoPick || products[0]?.url;
    if (!url) return;
    call<{ dataUrl: string }>("richMenuPhoto", { url }).then((r) => setPhotoUrl(r.dataUrl)).catch(() => setPhotoUrl(""));
  }, [photoPick, products.length]); // eslint-disable-line react-hooks/exhaustive-deps

  const changeLayout = (l: string) => {
    setLayout(l);
    setCells(DEFAULTS[l].map(([a, c], i) => (cells[i] ? { ...cells[i], color: cells[i].color ?? c } : mk(a, c))));
  };
  live.current = { cells, layout, own: !!own };
  // 滾輪縮放：要能擋掉整頁捲動，只能用原生 listener（React 的 onWheel 是 passive）
  useEffect(() => {
    const el = canvas.current;
    if (!el) return;
    const onWheel = (e: WheelEvent) => {
      const { cells: cs, layout: l, own: o } = live.current;
      if (o) return;
      const r = el.getBoundingClientRect();
      const x = ((e.clientX - r.left) / r.width) * 2500,
        y = ((e.clientY - r.top) / r.height) * 1686;
      const i = BOXES[l].findIndex((b) => x >= b.x && x < b.x + b.w && y >= b.y && y < b.y + b.h);
      if (i < 0 || !cs[i]?.photo) return;
      e.preventDefault();
      setCells((all) => all.map((c, j) => (j === i ? { ...c, zoom: Math.min(300, Math.max(100, Math.round((c.zoom ?? 100) - e.deltaY * 0.2))) } : c)));
    };
    el.addEventListener("wheel", onWheel, { passive: false });
    return () => el.removeEventListener("wheel", onWheel);
  }, []);
  const upd = (i: number, patch: Partial<Cell>) => setCells((cs) => cs.map((c, j) => (j === i ? { ...c, ...patch } : c)));

  // 畫預覽（也是要送出的圖）
  useEffect(() => {
    const cv = canvas.current;
    if (!cv || !ready) return;
    const ctx = cv.getContext("2d")!;
    let alive = true;
    (async () => {
      if (own) {
        const im = await loadImg(own);
        if (!alive) return;
        const s = Math.max(2500 / im.width, 1686 / im.height);
        ctx.drawImage(im, (2500 - im.width * s) / 2, (1686 - im.height * s) / 2, im.width * s, im.height * s);
        return;
      }
      const photo = photoUrl ? await loadImg(photoUrl).catch(() => null) : null;
      const cellPics = await Promise.all(cells.map((c) => (c.photo ? loadImg(c.photo).catch(() => null) : Promise.resolve(null))));
      const igDark = await loadImg("/rm-ig-dark.png").catch(() => null);
      const igLight = await loadImg("/rm-ig-light.png").catch(() => null);
      if (!alive) return;
      ctx.fillStyle = "#2f2722";
      ctx.fillRect(0, 0, 2500, 1686);
      BOXES[layout].forEach((b, i) => {
        const c = cells[i];
        if (!c) return;
        const col = COLORS[c.color];
        const g = 4; // 格線
        const x = b.x + g,
          y = b.y + g,
          w = b.w - g * 2,
          h = b.h - g * 2;
        ctx.save();
        ctx.beginPath();
        ctx.rect(x, y, w, h);
        ctx.clip();
        ctx.fillStyle = col.bg;
        ctx.fillRect(x, y, w, h);
        const stops = GRADS[c.color];
        if (stops) {
          const gr = ctx.createLinearGradient(x, y + h, x + w, y);
          stops.forEach((st, k) => gr.addColorStop(k / (stops.length - 1), st));
          ctx.fillStyle = gr;
          ctx.fillRect(x, y, w, h);
          const shade = ctx.createLinearGradient(0, y, 0, y + h);
          shade.addColorStop(0, "rgba(0,0,0,0.05)");
          shade.addColorStop(1, "rgba(0,0,0,0.3)");
          ctx.fillStyle = shade;
          ctx.fillRect(x, y, w, h);
        }
        const pic = cellPics[i] ?? photo;
        if (c.plain && cellPics[i]) {
          geo[i] = placeImg(ctx, cellPics[i]!, c, x, y, w, h, 0.5);
          ctx.restore();
          return;
        }
        if (c.low && cellPics[i]) {
          // 圖中間對在格子 40% 高的位置，字全部放到下方
          geo[i] = placeImg(ctx, cellPics[i]!, c, x, y, w, h, (ih) => (ih > h ? (ih / 2 - h * 0.4) / (ih - h) : 0.5));
          const gr = ctx.createLinearGradient(0, y + h * 0.6, 0, y + h);
          gr.addColorStop(0, "rgba(30,22,18,0)");
          gr.addColorStop(1, "rgba(30,22,18,0.55)");
          ctx.fillStyle = gr;
          ctx.fillRect(x, y, w, h);
          const cx = x + w / 2;
          const zhY = y + h - 92;
          const enY = zhY - 74;
          ctx.textAlign = "left";
          ctx.textBaseline = "alphabetic";
          const enPx = fitText(ctx, c.en, (p) => `${p}px "Bebas Neue", Impact, sans-serif`, 120, w * 0.6);
          const tw = ctx.measureText(c.en).width;
          const ig = c.action === "ig";
          const sz = ig ? enPx * 0.95 : 0;
          const gap = ig ? 28 : 0;
          const left = cx - (sz + gap + tw) / 2;
          if (ig) {
            // IG 彩色圓角方塊＋白色相機，一看就知道是 IG
            const by = enY - enPx * 0.8;
            const g2 = ctx.createLinearGradient(left, by + sz, left + sz, by);
            ["#feda75", "#fa7e1e", "#d62976", "#962fbf", "#4f5bd5"].forEach((st, k) => g2.addColorStop(k / 4, st));
            ctx.fillStyle = g2;
            ctx.beginPath();
            ctx.roundRect(left, by, sz, sz, sz * 0.24);
            ctx.fill();
            ctx.strokeStyle = "#fff";
            ctx.lineWidth = sz * 0.075;
            ctx.beginPath();
            ctx.roundRect(left + sz * 0.22, by + sz * 0.22, sz * 0.56, sz * 0.56, sz * 0.16);
            ctx.stroke();
            ctx.beginPath();
            ctx.arc(left + sz / 2, by + sz / 2, sz * 0.13, 0, Math.PI * 2);
            ctx.stroke();
            ctx.fillStyle = "#fff";
            ctx.beginPath();
            ctx.arc(left + sz * 0.66, by + sz * 0.34, sz * 0.04, 0, Math.PI * 2);
            ctx.fill();
          }
          ctx.fillStyle = "#fff";
          ctx.font = `${enPx}px "Bebas Neue", Impact, sans-serif`;
          ctx.fillText(c.en, left + sz + gap, enY);
          ctx.textAlign = "center";
          fitText(ctx, c.zh, (p) => `500 ${p}px "Noto Sans TC", sans-serif`, 56, w * 0.86);
          ctx.fillText(c.zh, cx, zhY);
          ctx.globalAlpha = 0.75;
          fitText(ctx, c.sub, (p) => `${p}px "Noto Sans TC", sans-serif`, 36, w * 0.86);
          ctx.fillText(c.sub, cx, zhY + 52);
          ctx.globalAlpha = 1;
          ctx.restore();
          return;
        }
        if (c.color === "photo" && pic) {
          if (cellPics[i]) geo[i] = placeImg(ctx, pic, cellPics[i] ? c : { ...c, zoom: undefined, px: undefined, py: undefined }, x, y, w, h, 0.3);
          const gr = ctx.createLinearGradient(0, y, 0, y + h);
          gr.addColorStop(0, "rgba(40,30,24,0.15)");
          gr.addColorStop(1, "rgba(40,30,24,0.65)");
          ctx.fillStyle = gr;
          ctx.fillRect(x, y, w, h);
        }
        const cx = x + w / 2;
        let top = y + h * 0.5;
        // IG 圖示
        if (c.action === "ig") {
          const ic = c.color === "gray" ? igDark : igLight;
          if (ic) {
            const sz = Math.min(w, h) * 0.28;
            ctx.drawImage(ic, cx - sz / 2, y + h * 0.12, sz, sz);
          }
          top = y + h * 0.6;
        }
        ctx.fillStyle = col.fg;
        ctx.textAlign = "center";
        ctx.textBaseline = "alphabetic";
        const enPx = fitText(ctx, c.en, (p) => `${p}px "Bebas Neue", Impact, sans-serif`, w > 1000 ? 200 : 168, w * 0.86);
        const words = c.en.length > 11 && w < 1000 ? c.en.split(" ") : [c.en];
        const lines = words.length > 1 ? words : [c.en];
        const lh = enPx * 0.92;
        const enTop = top - (lines.length - 1) * lh - 60;
        lines.forEach((t, k) => ctx.fillText(t, cx, enTop + k * lh));
        ctx.fillStyle = col.bar;
        ctx.fillRect(cx - 45, enTop + 34, 90, 6);
        ctx.fillStyle = col.fg;
        fitText(ctx, c.zh, (p) => `500 ${p}px "Noto Sans TC", sans-serif`, w > 1000 ? 70 : 60, w * 0.86);
        ctx.fillText(c.zh, cx, enTop + 34 + 92);
        ctx.globalAlpha = 0.72;
        fitText(ctx, c.sub, (p) => `${p}px "Noto Sans TC", sans-serif`, 40, w * 0.86);
        ctx.fillText(c.sub, cx, enTop + 34 + 152);
        ctx.globalAlpha = 1;
        if (i === 0 && c.color === "photo") {
          ctx.textAlign = "left";
          ctx.globalAlpha = 0.6;
          ctx.font = '56px "Bebas Neue", Impact, sans-serif';
          ctx.fillText("29 STUDIO", x + 50, y + 90);
          ctx.globalAlpha = 1;
        }
        ctx.restore();
      });
    })();
    return () => {
      alive = false;
    };
  }, [cells, layout, photoUrl, own, ready]);

  const apply = () =>
    run(async () => {
      const bad = cells.findIndex((c) => (c.action === "url" || c.action === "ig") && !/^https?:\/\/\S+/.test(c.url ?? ""));
      if (bad >= 0) throw new Error(`第 ${bad + 1} 格請填網址`);
      const image = canvas.current!.toDataURL("image/jpeg", 0.88);
      await call("applyRichMenu", { layout, image, cells: cells.map((c) => ({ action: c.action, url: c.url ?? null, label: c.zh })) });
    }, "新選單已經換上，客人重新打開聊天室就會看到");

  return (
    <div className="rm-editor">
      <h3>選單編輯</h3>
      <div className="chips">
        {["4", "5", "6"].map((l) => (
          <button key={l} className={`chip ${layout === l ? "active" : ""}`} onClick={() => changeLayout(l)}>
            {l} 格
          </button>
        ))}
      </div>
      <canvas
        ref={canvas}
        width={2500}
        height={1686}
        className={`rm-canvas${!own && cells.some((c) => c.photo) ? " rm-drag" : ""}`}
        onPointerDown={(e) => {
          if (own) return;
          const p = toCanvas(e);
          const i = BOXES[layout].findIndex((b) => p.x >= b.x && p.x < b.x + b.w && p.y >= b.y && p.y < b.y + b.h);
          if (i < 0 || !cells[i]?.photo) return;
          e.currentTarget.setPointerCapture(e.pointerId);
          drag.current = { i, sx: p.x, sy: p.y, px: cells[i].px ?? 0, py: cells[i].py ?? 0 };
        }}
        onPointerMove={(e) => {
          const d = drag.current;
          if (!d) return;
          const p = toCanvas(e);
          const g = geo[d.i] ?? { ew: 0, eh: 0 };
          const lim = (v: number) => Math.round(Math.min(100, Math.max(-100, v)));
          // 往右拖 = 圖往右移；多出來的寬度越大，拖同樣距離改變越少
          upd(d.i, {
            px: g.ew > 1 ? lim(d.px + ((p.x - d.sx) * 200) / g.ew) : d.px,
            py: g.eh > 1 ? lim(d.py + ((p.y - d.sy) * 200) / g.eh) : d.py,
          });
        }}
        onPointerUp={() => (drag.current = null)}
        onPointerCancel={() => (drag.current = null)}
      />
      {!own && cells.some((c) => c.photo) && <p className="muted small">上傳的圖可以直接在預覽上拖拉移動位置；滑鼠滾輪（或觸控板兩指上下）放大縮小。</p>}
      <p className="muted small">上面就是客人會看到的選單（點格子的位置跟下面設定的順序一樣：先上排、左到右）。</p>
      <div className="rm-own">
        <label className="btn btn-sm">
          {own ? "換一張自己的圖" : "改用自己做的整張圖（2500×1686）"}
          <input type="file" accept="image/*" hidden onChange={(e) => {
            const f = e.target.files?.[0];
            if (!f) return;
            const r = new FileReader();
            r.onload = () => setOwn(String(r.result));
            r.readAsDataURL(f);
          }} />
        </label>
        {own && (
          <button className="btn btn-sm btn-ghost" onClick={() => setOwn(null)}>
            改回系統產生的圖
          </button>
        )}
        {!own && cells.some((c) => c.color === "photo") && (
          <select value={photoPick} onChange={(e) => setPhotoPick(e.target.value)} title="照片格要用哪件商品">
            <option value="">沒上傳相片的照片格：用最新商品</option>
            {products.slice(0, 80).map((p) => (
              <option key={p.id} value={p.url}>
                沒上傳相片的照片格：用「{p.title}」
              </option>
            ))}
          </select>
        )}
      </div>
      <div className="rm-cells">
        {cells.map((c, i) => (
          <div key={i} className="rm-cell">
            <b>第 {i + 1} 格</b>
            {!own && (
              <span className="rm-photo">
                <label className="btn btn-sm btn-primary">
                  📷 {c.photo ? "換相片" : "上傳相片"}
                  <input
                    type="file"
                    accept="image/*"
                    hidden
                    onChange={(e) => {
                      const f = e.target.files?.[0];
                      if (!f) return;
                      // 縮到 1250px 再放進預覽（手機大圖不會讓頁面變慢）；上傳後這格自動改成照片底
                      const r = new FileReader();
                      r.onload = async () => {
                        const im = await loadImg(String(r.result));
                        const k = Math.min(1, 1250 / Math.max(im.width, im.height));
                        const cv = document.createElement("canvas");
                        cv.width = Math.round(im.width * k);
                        cv.height = Math.round(im.height * k);
                        cv.getContext("2d")!.drawImage(im, 0, 0, cv.width, cv.height);
                        upd(i, { photo: cv.toDataURL("image/jpeg", 0.88), color: "photo" });
                      };
                      r.readAsDataURL(f);
                    }}
                  />
                </label>
                {c.photo && (
                  <>
                    <label className="check small">
                      <input type="checkbox" checked={!!c.plain} onChange={(e) => upd(i, { plain: e.target.checked, low: false })} /> 只用這張圖（不疊文字）
                    </label>
                    <label className="check small">
                      <input type="checkbox" checked={!!c.low} onChange={(e) => upd(i, { low: e.target.checked, plain: false })} /> 字放下面（不遮到圖中間的 logo）
                    </label>
                    <span className="rm-pos">
                      <label>
                        縮放 <input type="range" min={100} max={300} value={c.zoom ?? 100} onChange={(e) => upd(i, { zoom: +e.target.value })} />
                      </label>
                      <label>
                        左右 <input type="range" min={-100} max={100} value={c.px ?? 0} onChange={(e) => upd(i, { px: +e.target.value })} />
                      </label>
                      <label>
                        上下 <input type="range" min={-100} max={100} value={c.py ?? 0} onChange={(e) => upd(i, { py: +e.target.value })} />
                      </label>
                      <button className="link-btn small" onClick={() => upd(i, { zoom: undefined, px: undefined, py: undefined })}>
                        重設位置
                      </button>
                    </span>
                    <button className="link-btn small" onClick={() => upd(i, { photo: undefined, plain: false, zoom: undefined, px: undefined, py: undefined })}>
                      移除相片
                    </button>
                  </>
                )}
              </span>
            )}
            <select value={c.action} onChange={(e) => upd(i, { ...mk(e.target.value as Action, c.color), color: c.color, photo: c.photo })}>
              {(Object.keys(ACTIONS) as Action[]).map((a) => (
                <option key={a} value={a}>
                  {ACTIONS[a].name}
                </option>
              ))}
            </select>
            {!own && !c.plain && (
              <>
                <input value={c.en} onChange={(e) => upd(i, { en: e.target.value.toUpperCase() })} placeholder="英文大字" />
                <input value={c.zh} onChange={(e) => upd(i, { zh: e.target.value })} placeholder="中文" />
                <input value={c.sub} onChange={(e) => upd(i, { sub: e.target.value })} placeholder="小字說明" />
                <select value={c.color} onChange={(e) => upd(i, { color: e.target.value as Color })}>
                  {(Object.keys(COLORS) as Color[]).map((k) => (
                    <option key={k} value={k}>
                      {COLORS[k].name}
                    </option>
                  ))}
                </select>
              </>
            )}
            {(c.action === "url" || c.action === "ig") && <input value={c.url ?? ""} onChange={(e) => upd(i, { url: e.target.value.trim() })} placeholder={c.action === "ig" ? "https://www.instagram.com/你的帳號" : "https://"} />}
          </div>
        ))}
      </div>
      <button className="btn btn-primary" disabled={busy || !ready} onClick={() => confirm("確定套用新選單？所有好友會立刻看到。") && apply()}>
        {busy ? "套用中…" : "套用到 LINE"}
      </button>
    </div>
  );
}
