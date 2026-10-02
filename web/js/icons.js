// Icônes au trait (24 × 24), colorées par `currentColor`.
const svg = (body, { fill = 'none' } = {}) =>
  `<svg class="icon" viewBox="0 0 24 24" fill="${fill}" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${body}</svg>`;

const STAR = '<path d="M12 3l2.7 5.6 6.1.9-4.4 4.3 1 6.1L12 17l-5.4 2.9 1-6.1L3.2 9.5l6.1-.9z"/>';

export const icons = {
  star: svg(STAR),
  starFilled: svg(STAR, { fill: 'currentColor' }),
  download: svg('<path d="M12 4v11M7 10l5 5 5-5M5 20h14"/>'),
  share: svg('<path d="M12 3v12M7 8l5-5 5 5M5 13v6a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2v-6"/>'),
  check: svg('<path d="M4 12.5l5 5L20 6.5"/>'),
  trash: svg('<path d="M4 7h16M10 11v6M14 11v6M6 7l1 13h10l1-13M9 7V4h6v3"/>'),
};
