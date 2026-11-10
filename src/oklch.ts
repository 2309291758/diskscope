// sRGB <-> OKLab, plus a "same lightness, different hue" tint used by the treemap.
const enc = (x: number) => (x <= 0.0031308 ? 12.92 * x : 1.055 * Math.pow(x, 1 / 2.4) - 0.055);
const dec = (x: number) => (x <= 0.04045 ? x / 12.92 : Math.pow((x + 0.055) / 1.055, 2.4));

function hexToRgb(hex: string): [number, number, number] {
  const h = hex.replace("#", "");
  const s = h.length === 3 ? h.split("").map((c) => c + c).join("") : h;
  const n = parseInt(s, 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}

function rgbToOklab(r: number, g: number, b: number) {
  const [R, G, B] = [dec(r / 255), dec(g / 255), dec(b / 255)];
  const l = Math.cbrt(0.4122214708 * R + 0.5363325363 * G + 0.0514459929 * B);
  const m = Math.cbrt(0.2119034982 * R + 0.6806995451 * G + 0.1073969566 * B);
  const s = Math.cbrt(0.0883024619 * R + 0.2817188376 * G + 0.6299787005 * B);
  return [
    0.2104542553 * l + 0.793617785 * m - 0.0040720468 * s,
    1.9779984951 * l - 2.428592205 * m + 0.4505937099 * s,
    0.0259040371 * l + 0.7827717662 * m - 0.808675766 * s
  ] as [number, number, number];
}

function oklabToRgb(L: number, a: number, b: number): [number, number, number] | null {
  const l_ = L + 0.3963377774 * a + 0.2158037573 * b;
  const m_ = L - 0.1055613458 * a - 0.0638541728 * b;
  const s_ = L - 0.0894841775 * a - 1.291485548 * b;
  const l = l_ ** 3, m = m_ ** 3, s = s_ ** 3;
  const r = 4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s;
  const g = -1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s;
  const bl = -0.0041960863 * l - 0.7034186147 * m + 1.707614701 * s;
  const clampOk = (x: number) => x >= -0.0015 && x <= 1.0015;
  if (!clampOk(r) || !clampOk(g) || !clampOk(bl)) return null;
  const to255 = (x: number) => Math.round(Math.min(1, Math.max(0, enc(x))) * 255);
  return [to255(r), to255(g), to255(bl)];
}

/** OKLCH -> hex, walking the chroma down until it lands inside sRGB. */
function oklchHex(L: number, C: number, hue: number): string {
  const rad = (hue * Math.PI) / 180;
  let c = C;
  for (let i = 0; i < 40; i++) {
    const out = oklabToRgb(L, c * Math.cos(rad), c * Math.sin(rad));
    if (out) return "#" + out.map((v) => v.toString(16).padStart(2, "0")).join("");
    c *= 0.9;
  }
  return "#e9eff8";
}

/**
 * Continuous "how much of the parent" ramp. A linear percent would crowd every
 * real row against the pale end — a disk is never evenly divided — so the curve
 * is eased: 3% already reads as tinted, 12% as solid. Chroma grows with lightness
 * so the big rows are saturated rather than merely dark.
 */
export function shareRamp(pct: number): { bar: string; ink: string } {
  const t = Math.pow(Math.min(1, Math.max(0, pct / 100)), 0.34);
  return {
    bar: oklchHex(0.93 - 0.44 * t, 0.012 + 0.16 * t, 258),
    ink: oklchHex(0.55 - 0.33 * t, 0.02 + 0.16 * t, 258)
  };
}

/**
 * Re-render a category colour at a fixed OKLCH lightness.
 * All treemap tiles then carry the same visual weight, so the eye reads the
 * hue as "which kind" and the *area* as "how big" — never the other way round.
 */
export function tintToLightness(hex: string, L: number, chromaScale = 1): string {
  const [r, g, b] = hexToRgb(hex);
  const [, A, B] = rgbToOklab(r, g, b);
  let a = A * chromaScale;
  let bb = B * chromaScale;
  let out = oklabToRgb(L, a, bb);
  // Near-white targets can sit outside sRGB for saturated hues; walk the chroma
  // down until it lands back inside the gamut.
  for (let i = 0; i < 40 && !out; i++) {
    a *= 0.9;
    bb *= 0.9;
    out = oklabToRgb(L, a, bb);
  }
  const [rr, gg, bbb] = out ?? [255, 255, 255];
  return "#" + [rr, gg, bbb].map((v) => v.toString(16).padStart(2, "0")).join("");
}
