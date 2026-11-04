// Accent colour from an artist image: the most vivid hue, at a lightness that reads
// well on the dark background. Images are same-origin (proxied), so the canvas can
// read them.

/// A steady accent for an artist without an image, from their name.
export function accentForName(name: string): string {
  let h = 0;
  for (const ch of name) h = (h * 31 + ch.codePointAt(0)!) >>> 0;
  return `hsl(${h % 360} 70% 62%)`;
}

const cache = new Map<string, Promise<string | null>>();

export function accentFor(src: string): Promise<string | null> {
  let p = cache.get(src);
  if (!p) {
    p = compute(src).catch(() => null);
    cache.set(src, p);
  }
  return p;
}

async function compute(src: string): Promise<string | null> {
  const img = new Image();
  img.src = src;
  await img.decode();
  const size = 24;
  const canvas = document.createElement("canvas");
  canvas.width = canvas.height = size;
  const ctx = canvas.getContext("2d", { willReadFrequently: true });
  if (!ctx) return null;
  ctx.drawImage(img, 0, 0, size, size);
  const px = ctx.getImageData(0, 0, size, size).data;
  // Average hue as a vector, weighted by how vivid each pixel is.
  let x = 0, y = 0, weight = 0, sat = 0;
  for (let i = 0; i < px.length; i += 4) {
    const [h, s, l] = hsl(px[i], px[i + 1], px[i + 2]);
    const w = s * (1 - Math.abs(l - 0.5) * 2);
    x += Math.cos(h * 2 * Math.PI) * w;
    y += Math.sin(h * 2 * Math.PI) * w;
    sat += s * w;
    weight += w;
  }
  // Black-and-white artwork: keep the default accent.
  if (weight < size * size * 0.04) return null;
  const hue = ((Math.atan2(y, x) / (2 * Math.PI) + 1) % 1) * 360;
  const s = Math.min(90, Math.max(60, (sat / weight) * 100));
  return `hsl(${hue.toFixed(0)} ${s.toFixed(0)}% 62%)`;
}

const BACKDROP = 64; // px square; it is shown blurred, so this is plenty
const BLUR = 2; // px each side, per box blur pass at that size
const DIM = 0.16;
const SATURATE = 0.15;

/// The card's background from the artist image, as a data URL: cropped square,
/// blurred and darkened here, once, as `.bg`'s CSS filter would do on every frame.
export async function backdrop(src: string): Promise<string | null> {
  const img = new Image();
  img.src = src;
  await img.decode();
  const c = document.createElement("canvas");
  c.width = c.height = BACKDROP;
  const ctx = c.getContext("2d", { willReadFrequently: true });
  if (!ctx) return null;
  const side = Math.min(img.naturalWidth, img.naturalHeight);
  ctx.drawImage(img, (img.naturalWidth - side) / 2, (img.naturalHeight - side) / 2, side, side, 0, 0, BACKDROP, BACKDROP);
  const data = ctx.getImageData(0, 0, BACKDROP, BACKDROP);
  const px = data.data;
  // Three box passes each way come close to a gaussian.
  for (let pass = 0; pass < 3; pass++) {
    box(px, false);
    box(px, true);
  }
  for (let i = 0; i < px.length; i += 4) {
    const l = 0.2126 * px[i] + 0.7152 * px[i + 1] + 0.0722 * px[i + 2];
    for (let ch = 0; ch < 3; ch++) px[i + ch] = (l + (px[i + ch] - l) * SATURATE) * DIM;
    px[i + 3] = 255;
  }
  ctx.putImageData(data, 0, 0);
  return c.toDataURL();
}

/// One box blur pass over the backdrop's pixels, along rows or columns; the
/// edges repeat outwards.
function box(px: Uint8ClampedArray, columns: boolean): void {
  const src = px.slice();
  const n = BACKDROP;
  const along = columns ? n * 4 : 4;
  for (let line = 0; line < n; line++) {
    const start = (columns ? line : line * n) * 4;
    for (let i = 0; i < n; i++) {
      for (let ch = 0; ch < 3; ch++) {
        let sum = 0;
        for (let k = -BLUR; k <= BLUR; k++) sum += src[start + Math.min(n - 1, Math.max(0, i + k)) * along + ch];
        px[start + i * along + ch] = sum / (2 * BLUR + 1);
      }
    }
  }
}

function hsl(r: number, g: number, b: number): [number, number, number] {
  r /= 255;
  g /= 255;
  b /= 255;
  const max = Math.max(r, g, b), min = Math.min(r, g, b);
  const l = (max + min) / 2;
  if (max === min) return [0, 0, l];
  const d = max - min;
  const s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
  const h = max === r ? (g - b) / d + (g < b ? 6 : 0) : max === g ? (b - r) / d + 2 : (r - g) / d + 4;
  return [h / 6, s, l];
}
