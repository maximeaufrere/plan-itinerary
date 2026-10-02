import { downsample } from './geo.js';

const WIDTH = 600;
const HEIGHT = 160;

/** Profil altimétrique en SVG (aire + ligne), avec étiquettes min/max. */
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

  return `
    <figure class="chart">
      <div class="chart-plot">
        <svg viewBox="0 0 ${WIDTH} ${HEIGHT}" preserveAspectRatio="none" role="img"
             aria-label="Profil altimétrique : de ${Math.round(min)} à ${Math.round(max)} mètres">
          <path d="${area}" class="chart-area"/>
          <path d="${line}" class="chart-line" vector-effect="non-scaling-stroke"/>
        </svg>
        <span class="chart-label chart-max">${Math.round(max)} m</span>
        <span class="chart-label chart-min">${Math.round(min)} m</span>
      </div>
      <figcaption class="chart-axis"><span>0 km</span><span>${(totalDistance / 1000).toFixed(1).replace('.', ',')} km</span></figcaption>
    </figure>`;
}
