// Fonds de carte disponibles (tous basés sur les données OpenStreetMap).
export const BASE_LAYERS = {
  standard: {
    label: 'Standard',
    description: 'Carte OpenStreetMap classique',
    url: 'https://tile.openstreetmap.org/{z}/{x}/{y}.png',
    maxZoom: 19,
    attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a>',
  },
  topo: {
    label: 'Topographique',
    description: 'Courbes de niveau et relief, idéal pour le trail',
    url: 'https://{s}.tile.opentopomap.org/{z}/{x}/{y}.png',
    maxZoom: 17,
    attribution:
      '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a>, SRTM · style <a href="https://opentopomap.org">OpenTopoMap</a> (CC-BY-SA)',
  },
  cycle: {
    label: 'Vélo',
    description: 'Pistes cyclables et revêtements (CyclOSM)',
    url: 'https://{s}.tile-cyclosm.openstreetmap.fr/cyclosm/{z}/{x}/{y}.png',
    maxZoom: 20,
    attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> · style <a href="https://www.cyclosm.org">CyclOSM</a>',
  },
};

export const DEFAULT_BASE_LAYER = 'standard';
