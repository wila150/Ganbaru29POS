/**
 * 結帳音效。內建音效用 Web Audio 即時合成（不用下載檔案）；自訂音效是後台上傳的音檔。
 * iPad／iPhone 規定聲音要在使用者點擊時「解鎖」：第一次點畫面時就先解鎖，之後結帳完成（非同步）也能出聲。
 */
export type SoundPreset = "chime" | "coin" | "bell" | "success" | "custom";
/** 一種聲音：內建或自訂音檔 */
export interface SoundChoice {
  preset: SoundPreset;
  customUrl?: string | null;
  customName?: string | null;
}

/** 條件音效：符合條件就改播這個聲音（由上到下，第一個符合的生效） */
export type SoundWhen = "birthday_today" | "birthday_month" | "group" | "min_total" | "member";
export interface SoundRule extends SoundChoice {
  when: SoundWhen;
  /** group：群組名稱；min_total：金額 */
  value?: string | number | null;
}

export interface CheckoutSound extends SoundChoice {
  enabled: boolean;
  volume?: number; // 0–1
  rules?: SoundRule[];
}

export const SOUND_WHEN_LABEL: Record<SoundWhen, string> = {
  birthday_today: "今天是會員生日",
  birthday_month: "本月壽星",
  group: "會員群組是",
  min_total: "結帳金額滿",
  member: "有帶會員",
};

/** 結帳當下的情況 */
export interface SoundContext {
  isMember: boolean;
  birthDate?: string | null; // YYYY/MM/DD 或 YYYY-MM-DD
  /** 只有生日月份時（"01"～"12"）也能判斷本月壽星 */
  birthMonth?: string | null;
  group?: string | null;
  total: number;
  today: string; // YYYY-MM-DD
}

export function ruleMatches(r: SoundRule, c: SoundContext) {
  const md = (c.birthDate ?? "").replace(/\//g, "-").slice(5, 10); // MM-DD
  switch (r.when) {
    case "birthday_today":
      return !!md && md === c.today.slice(5, 10);
    case "birthday_month": {
      const mm = md ? md.slice(0, 2) : String(c.birthMonth ?? "").padStart(2, "0");
      return !!mm && mm !== "00" && mm === c.today.slice(5, 7);
    }
    case "group":
      return !!c.group && c.group === r.value;
    case "min_total":
      return c.total >= Number(r.value ?? 0);
    case "member":
      return c.isMember;
  }
}

/** 依條件選出要播的聲音 */
export function pickSound(cfg: CheckoutSound, c: SoundContext): SoundChoice {
  return (cfg.rules ?? []).find((r) => ruleMatches(r, c)) ?? cfg;
}

export const SOUND_PRESETS: { key: Exclude<SoundPreset, "custom">; label: string }[] = [
  { key: "chime", label: "叮咚" },
  { key: "coin", label: "投幣（叮鈴）" },
  { key: "bell", label: "收銀機鈴聲" },
  { key: "success", label: "上升音階" },
];

export const DEFAULT_SOUND: CheckoutSound = { enabled: true, preset: "chime", volume: 0.6 };

let ctx: AudioContext | null = null;
const custom = new Map<string, HTMLAudioElement>();

function audioCtx() {
  if (!ctx) {
    const AC = window.AudioContext || (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
    ctx = new AC();
  }
  if (ctx.state === "suspended") ctx.resume().catch(() => undefined);
  return ctx;
}

/** 第一次點畫面時解鎖聲音（含自訂音檔） */
export function unlockAudio(customUrl?: string | null | (string | null | undefined)[]): () => void {
  const run = () => {
    try {
      const c = audioCtx();
      const b = c.createBuffer(1, 1, 22050);
      const s = c.createBufferSource();
      s.buffer = b;
      s.connect(c.destination);
      s.start(0);
    } catch {
      /* no audio */
    }
    for (const url of [customUrl].flat()) {
      if (!url) continue;
      const a = customAudio(url);
      a.muted = true;
      a.play().then(() => {
        a.pause();
        a.currentTime = 0;
        a.muted = false;
      }).catch(() => (a.muted = false));
    }
  };
  window.addEventListener("pointerdown", run, { once: true, capture: true });
  window.addEventListener("keydown", run, { once: true, capture: true });
  return () => {
    window.removeEventListener("pointerdown", run, { capture: true });
    window.removeEventListener("keydown", run, { capture: true });
  };
}

function customAudio(url: string) {
  let a = custom.get(url);
  if (!a) {
    a = new Audio(url);
    a.preload = "auto";
    custom.set(url, a);
  }
  return a;
}

/** 一個音：頻率、開始時間、長度、波形 */
function tone(c: AudioContext, out: AudioNode, freq: number, at: number, dur: number, type: OscillatorType = "sine", peak = 1) {
  const o = c.createOscillator();
  const g = c.createGain();
  o.type = type;
  o.frequency.setValueAtTime(freq, at);
  g.gain.setValueAtTime(0.0001, at);
  g.gain.exponentialRampToValueAtTime(peak, at + 0.01);
  g.gain.exponentialRampToValueAtTime(0.0001, at + dur);
  o.connect(g).connect(out);
  o.start(at);
  o.stop(at + dur + 0.05);
}

function synth(preset: Exclude<SoundPreset, "custom">, volume: number) {
  const c = audioCtx();
  const out = c.createGain();
  out.gain.value = 0.35 * volume;
  out.connect(c.destination);
  const t = c.currentTime + 0.02;
  switch (preset) {
    case "chime":
      tone(c, out, 1318.5, t, 0.5); // E6
      tone(c, out, 1046.5, t + 0.18, 0.7); // C6
      break;
    case "coin":
      tone(c, out, 987.8, t, 0.09, "square", 0.5); // B5
      tone(c, out, 1318.5, t + 0.08, 0.45, "square", 0.5); // E6
      break;
    case "bell":
      for (const [f, p] of [[2093, 1], [4186, 0.4], [5274, 0.25]] as const) tone(c, out, f, t, 0.9, "sine", p);
      tone(c, out, 2093, t + 0.12, 0.8, "sine", 0.6);
      break;
    case "success":
      [523.3, 659.3, 784, 1046.5].forEach((f, i) => tone(c, out, f, t + i * 0.09, 0.35, "triangle", 0.8));
      break;
  }
}

/** 播放結帳音效（設定關閉時不出聲）。有傳 context 就依條件選聲音。 */
export function playCheckoutSound(cfg?: CheckoutSound | null, force = false, context?: SoundContext) {
  const base = cfg ?? DEFAULT_SOUND;
  if (!base.enabled && !force) return;
  const volume = Math.min(1, Math.max(0, base.volume ?? 0.6));
  const s = context ? pickSound(base, context) : base;
  try {
    if (s.preset === "custom" && s.customUrl) {
      const a = customAudio(s.customUrl);
      a.volume = volume;
      a.currentTime = 0;
      a.play().catch(() => synth("chime", volume));
    } else {
      synth(s.preset === "custom" ? "chime" : s.preset, volume);
    }
  } catch {
    /* no audio */
  }
}
