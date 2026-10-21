// Caption fonts. Variable fonts carry CWI intonation fully, because each
// word's weight can be anything in the font's range. Display fonts have one
// weight, so bolder words are drawn thicker and thinner words stay regular.

export const FONTS = [
  { id: 'roboto-flex', name: 'Roboto Flex', family: 'Roboto Flex', axes: 'opsz,wght@8..144,100..1000', min: 100, max: 1000, hint: 'The official CWI typeface' },
  { id: 'inter', name: 'Inter', family: 'Inter', axes: 'wght@100..900', min: 100, max: 900, hint: 'Clean and very readable' },
  { id: 'montserrat', name: 'Montserrat', family: 'Montserrat', axes: 'wght@100..900', min: 100, max: 900, hint: 'The classic creator look' },
  { id: 'outfit', name: 'Outfit', family: 'Outfit', axes: 'wght@100..900', min: 100, max: 900, hint: 'Round and friendly' },
  { id: 'unbounded', name: 'Unbounded', family: 'Unbounded', axes: 'wght@200..900', min: 200, max: 900, hint: 'Wide and loud' },
  { id: 'archivo', name: 'Archivo', family: 'Archivo', axes: 'wght@100..900', min: 100, max: 900, hint: 'Sturdy grotesque' },
  { id: 'oswald', name: 'Oswald', family: 'Oswald', axes: 'wght@200..700', min: 200, max: 700, hint: 'Tall and condensed' },
  { id: 'sora', name: 'Sora', family: 'Sora', axes: 'wght@100..800', min: 100, max: 800, hint: 'Techy geometric' },
  { id: 'bricolage', name: 'Bricolage', family: 'Bricolage Grotesque', axes: 'opsz,wght@12..96,200..800', min: 200, max: 800, hint: 'Quirky, characterful' },
  { id: 'recursive', name: 'Recursive', family: 'Recursive', axes: 'wght@300..1000', min: 300, max: 1000, hint: 'Casual and warm' },
  { id: 'fraunces', name: 'Fraunces', family: 'Fraunces', axes: 'opsz,wght@9..144,100..900', min: 100, max: 900, hint: 'Soft serif for stories' },
  { id: 'playfair', name: 'Playfair', family: 'Playfair Display', axes: 'wght@400..900', min: 400, max: 900, hint: 'Elegant, cinematic' },
  { id: 'bebas', name: 'Bebas Neue', family: 'Bebas Neue', axes: '', min: 400, max: 400, fixed: true, hint: 'Poster caps' },
  { id: 'anton', name: 'Anton', family: 'Anton', axes: '', min: 400, max: 400, fixed: true, hint: 'Heavy impact' },
  { id: 'luckiest', name: 'Luckiest Guy', family: 'Luckiest Guy', axes: '', min: 400, max: 400, fixed: true, hint: 'Cartoon bold' },
  { id: 'marker', name: 'Permanent Marker', family: 'Permanent Marker', axes: '', min: 400, max: 400, fixed: true, hint: 'Handwritten' },
];

export const DEFAULT_FONT = 'roboto-flex';
const byId = new Map(FONTS.map((f) => [f.id, f]));
export const getFont = (id) => byId.get(id) || byId.get(DEFAULT_FONT);

/** CSS font-family stack for canvas and CSS. */
export const familyStack = (font) => `"${font.family}", system-ui, sans-serif`;

/**
 * Map a CWI weight (100–900, 400 = regular) into this font's own range,
 * keeping 400 at the font's regular weight so neutral words stay neutral.
 */
export function fontWeight(font, cwiWeight) {
  if (font.fixed) return font.min;
  const regular = Math.min(Math.max(400, font.min), font.max);
  const w = cwiWeight;
  const out = w <= 400
    ? font.min + ((w - 100) / 300) * (regular - font.min)
    : regular + ((w - 400) / 500) * (font.max - regular);
  return Math.round(Math.min(font.max, Math.max(font.min, out)));
}

/** Extra stroke (in px) that stands in for weight in single-weight fonts. */
export function fauxBold(font, cwiWeight, px) {
  return font.fixed && cwiWeight > 400 ? px * 0.05 * ((cwiWeight - 400) / 500) : 0;
}

/** Google Fonts stylesheet URL for one or more fonts. `text` subsets for previews. */
export function cssUrl(fonts, text) {
  const fam = fonts.map((f) => `family=${f.family.replace(/ /g, '+')}${f.axes ? `:${f.axes}` : ''}`).join('&');
  return `https://fonts.googleapis.com/css2?${fam}&display=swap${text ? `&text=${encodeURIComponent(text)}` : ''}`;
}

const loaded = new Map();
/** Load a font's files and wait until canvas can draw with it. */
export function ensureFont(font) {
  if (typeof document === 'undefined') return Promise.resolve();
  if (loaded.has(font.id)) return loaded.get(font.id);
  const link = document.createElement('link');
  link.rel = 'stylesheet';
  link.href = cssUrl([font]);
  document.head.append(link);
  const ready = new Promise((res) => { link.onload = res; link.onerror = res; })
    .then(() => Promise.all([font.min, fontWeight(font, 400), font.max].map((w) => document.fonts.load(`${w} 40px "${font.family}"`))))
    .catch(() => {});
  loaded.set(font.id, ready);
  return ready;
}
