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
  bookmark: svg('<path d="M6 3h12v18l-6-4-6 4z"/>'),
  bookmarkFilled: svg('<path d="M6 3h12v18l-6-4-6 4z"/>', { fill: 'currentColor' }),
  chevronRight: svg('<path d="M9 6l6 6-6 6"/>'),
};

/** Pictogrammes des activités (clés de ACTIVITIES). */
export const activityIcons = {
  running: svg('<circle cx="14" cy="4.5" r="2"/><path d="M7 21l3-6 3 3v4M5 12l4-3 4 1 2.5 3 3 1M10 15l-1.5-3"/>'),
  trail: svg('<path d="M2.5 20l6.5-11 4.5 7 3-4.5 5 8.5z"/>'),
  road: svg('<circle cx="5.5" cy="16" r="3.5"/><circle cx="18.5" cy="16" r="3.5"/><path d="M5.5 16l4.5-8h6l2.5 8M10 8l2.5 8M14 5h3"/>'),
  bike: svg('<circle cx="5.5" cy="16" r="3.5"/><circle cx="18.5" cy="16" r="3.5"/><path d="M5.5 16l5-7 3 7h5M9 6h3M13.5 9h4"/>'),
  mtb: svg('<circle cx="5.5" cy="17" r="3.5"/><circle cx="18.5" cy="17" r="3.5"/><path d="M5.5 17l4-7h6l3 7M12 10l-1-3M3 6l3-3 3 3 3-3"/>'),
};
