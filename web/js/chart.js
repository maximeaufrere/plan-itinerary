import { downsample } from './geo.js';

const WIDTH = 600;
const HEIGHT = 160;

/** Classes de pente (montées) : au-dessous de 3 %, le terrain est compté comme plat (descentes comprises). */
export const SLOPE_CLASSES = [
  { key: 'flat', min: -Infinity, label: '< 3 %' },
  { key: 's1', min: 0.03, label: '3–6 %' },
  { key: 's2', min: 0.06, label: '6–10 %' },
  { key: 's3', min: 0.1, label: '> 10 %' },
];
const slopeClass = (grade) => SLOPE_CLASSES.findLast((c) => grade >= c.min).key;

/** Altitude à une distance donnée, par interpolation dans le profil. */
export function elevationAt(profile, at) {
  const i = profile.findIndex((p) => p.distance >= at);
  if (i <= 0) return (i === 0 ? profile[0] : profile.at(-1)).elevation;
  const [a, b] = [profile[i - 1], profile[i]];
  const t = b.distance > a.distance ? (at - a.distance) / (b.distance - a.distance) : 0;
  return a.elevation + (b.elevation - a.elevation) * t;
}

/**
 * Découpe le profil en tranches d'au moins 100 m et classe chacune selon sa pente ;
 * les tranches voisines de même classe sont fusionnées.
 * @returns {{ from: number, to: number, grade: number, key: string }[]}  `grade` : pente la plus forte du morceau
 */
export function slopeSegments(profile) {
  if (profile.length < 2) return [];
  const total = profile.at(-1).distance;
  if (total <= 0) return [];
  const count = Math.max(1, Math.round(total / Math.max(100, total / 60)));
  const step = total / count;
  const segments = [];
  for (let k = 0; k < count; k++) {
    const [from, to] = [k * step, (k + 1) * step];
    const grade = (elevationAt(profile, to) - elevationAt(profile, from)) / step;
    const key = slopeClass(grade);
    const last = segments.at(-1);
    if (last?.key === key) {
      last.to = to;
      last.grade = Math.max(last.grade, grade);
    } else segments.push({ from, to, grade, key });
  }
  return segments;
}

/** Pente moyenne autour d'une distance (sur 100 m), pour le curseur du profil. */
export function gradeAt(profile, at) {
  const total = profile.at(-1)?.distance ?? 0;
  if (total < 20) return 0;
  const from = Math.max(0, Math.min(at - 50, total - 100));
  const to = Math.min(total, from + 100);
  return (elevationAt(profile, to) - elevationAt(profile, from)) / (to - from);
}

/** Texte d'une pente : « 8 % », « −4 % ». */
export const formatGrade = (grade) => `${Math.round(grade * 100)} %`.replace('-', '−');

/** Profil altimétrique en SVG : aire colorée selon la pente, ligne, étiquettes min/max et légende. */
export function elevationChart(profile) {
  if (profile.length < 2) return '';
  const points = downsample(profile, 400);
  const totalDistance = points.at(-1).distance || 1;
  const elevations = points.map((p) => p.elevation);
  const min = Math.min(...elevations);
  const max = Math.max(...elevations);
  const margin = Math.max((max - min) * 0.1, 10);
  const low = min - margin;
  const high = max + margin;

  const x = (d) => ((d / totalDistance) * WIDTH).toFixed(1);
  const y = (e) => (HEIGHT - ((e - low) / (high - low)) * HEIGHT).toFixed(1);
  const line = points.map((p, i) => `${i ? 'L' : 'M'}${x(p.distance)},${y(p.elevation)}`).join('');
  const area = `${line}L${WIDTH},${HEIGHT}L0,${HEIGHT}Z`;

  // Aire découpée par tranche de pente : chaque tranche suit la ligne du profil jusqu'au sol.
  const segments = slopeSegments(profile);
  const slopeAreas = segments
    .filter((segment) => segment.key !== 'flat')
    .map(({ from, to, key }) => {
      const inside = points.filter((p) => p.distance > from && p.distance < to);
      const edge = [{ distance: from, elevation: elevationAt(points, from) }, ...inside, { distance: to, elevation: elevationAt(points, to) }];
      const top = edge.map((p, i) => `${i ? 'L' : 'M'}${x(p.distance)},${y(p.elevation)}`).join('');
      return `<path d="${top}L${x(to)},${HEIGHT}L${x(from)},${HEIGHT}Z" class="slope-${key}"/>`;
    })
    .join('');
  const present = SLOPE_CLASSES.filter((c) => segments.some((s) => s.key === c.key));
  const steepest = Math.max(...segments.map((s) => s.grade));
  const legend =
    present.length > 1
      ? `<div class="slope-legend">
          ${present.map((c) => `<span><i class="slope-${c.key}"></i>${c.label}</span>`).join('')}
          ${steepest >= 0.03 ? `<span class="legend-extra">Pente max ${formatGrade(steepest)}</span>` : ''}
        </div>`
      : '';

  return `
    <figure class="chart">
      <div class="chart-plot">
        <svg viewBox="0 0 ${WIDTH} ${HEIGHT}" preserveAspectRatio="none" role="img"
             aria-label="Profil altimétrique : de ${Math.round(min)} à ${Math.round(max)} mètres">
          <path d="${area}" class="chart-area"/>
          ${slopeAreas}
          <path d="${line}" class="chart-line" vector-effect="non-scaling-stroke"/>
        </svg>
        <span class="chart-label chart-max">${Math.round(max)} m</span>
        <span class="chart-label chart-min">${Math.round(min)} m</span>
        <div class="chart-cursor" hidden><span class="chart-tip"></span></div>
      </div>
      <figcaption class="chart-axis"><span>0 km</span><span>${(totalDistance / 1000).toFixed(1).replace('.', ',')} km</span></figcaption>
      ${legend}
    </figure>`;
}

/** Mini-courbe d'altitude pour les cartes de propositions. */
export function sparkline(profile, { width = 120, height = 28 } = {}) {
  if (profile.length < 2) return '';
  const points = downsample(profile, 40);
  const total = points.at(-1).distance || 1;
  const elevations = points.map((p) => p.elevation);
  const min = Math.min(...elevations);
  const range = Math.max(Math.max(...elevations) - min, 20);
  const path = points
    .map((p, i) => `${i ? 'L' : 'M'}${((p.distance / total) * width).toFixed(1)},${(height - 2 - ((p.elevation - min) / range) * (height - 4)).toFixed(1)}`)
    .join('');
  return `<svg class="sparkline" viewBox="0 0 ${width} ${height}" preserveAspectRatio="none" aria-hidden="true">
    <path d="${path}L${width},${height}L0,${height}Z" class="sparkline-area"/>
    <path d="${path}" class="sparkline-line" vector-effect="non-scaling-stroke"/>
  </svg>`;
}
