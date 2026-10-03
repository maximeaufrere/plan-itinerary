// Miniature d'un parcours (SVG), pour les listes de favoris et de sorties.

const escapeAttr = (text) => String(text).replace(/"/g, '&quot;');

/** Tracé ramené dans un carré de `size` pixels, en conservant ses proportions. */
export function routeThumbnail(coordinates, { size = 56, padding = 8, label = '' } = {}) {
  if (!coordinates?.length) return '';
  const step = Math.max(1, Math.floor(coordinates.length / 80));
  const sample = coordinates.filter((_, i) => i % step === 0);
  sample.push(coordinates.at(-1));
  const cos = Math.cos((sample[0][0] * Math.PI) / 180);
  const xs = sample.map(([, lon]) => lon * cos);
  const ys = sample.map(([lat]) => -lat);
  const [minX, maxX, minY, maxY] = [Math.min(...xs), Math.max(...xs), Math.min(...ys), Math.max(...ys)];
  const span = Math.max(maxX - minX, maxY - minY) || 1;
  const inner = size - padding * 2;
  const offsetX = padding + (inner - ((maxX - minX) / span) * inner) / 2;
  const offsetY = padding + (inner - ((maxY - minY) / span) * inner) / 2;
  const toX = (x) => (offsetX + ((x - minX) / span) * inner).toFixed(1);
  const toY = (y) => (offsetY + ((y - minY) / span) * inner).toFixed(1);
  const path = xs.map((x, i) => `${i ? 'L' : 'M'}${toX(x)},${toY(ys[i])}`).join('');
  return `<svg class="thumbnail" viewBox="0 0 ${size} ${size}" width="${size}" height="${size}" ${label ? `role="img" aria-label="${escapeAttr(label)}"` : 'aria-hidden="true"'}>
    <rect width="${size}" height="${size}" rx="14" class="thumbnail-bg"/>
    <path d="${path}" class="thumbnail-route"/>
    <circle cx="${toX(xs[0])}" cy="${toY(ys[0])}" r="4" class="thumbnail-start"/>
  </svg>`;
}
