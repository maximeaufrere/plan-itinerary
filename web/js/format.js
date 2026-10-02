const oneDecimal = new Intl.NumberFormat('fr-FR', { minimumFractionDigits: 1, maximumFractionDigits: 1 });

export const formatDistance = (meters) => `${oneDecimal.format(meters / 1000)} km`;

export const formatElevation = (meters) => (meters == null ? '– m' : `${Math.round(meters)} m`);

export function formatDuration(seconds) {
  const totalMinutes = Math.round(seconds / 60);
  const hours = Math.floor(totalMinutes / 60);
  const minutes = totalMinutes % 60;
  if (hours === 0) return `${minutes} min`;
  return `${hours} h ${String(minutes).padStart(2, '0')}`;
}

/** Allure en min/km à partir d'une vitesse en km/h, ex. 10,9 km/h → « 5'30/km ». */
export function formatPace(speedKmh) {
  const seconds = Math.round(3600 / speedKmh / 5) * 5;
  return `${Math.floor(seconds / 60)}'${String(seconds % 60).padStart(2, '0')}/km`;
}

export const formatPercent = (share) => `${Math.round(share * 100)} %`;
