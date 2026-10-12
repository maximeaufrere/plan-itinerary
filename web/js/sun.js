// Coucher du soleil, calculé sur l'appareil (équation du lever/coucher, précision de quelques minutes).

const RAD = Math.PI / 180;
const J2000 = 2451545.0009;

/**
 * Heure du coucher du soleil (Date) au point donné, le jour de `date` ; null s'il ne se couche pas
 * (ou ne se lève pas) ce jour-là, près des pôles.
 */
export function sunset([lat, lon], date = new Date()) {
  const julian = date.getTime() / 86_400_000 + 2440587.5;
  const west = -lon; // longitude ouest positive
  const n = Math.round(julian - J2000 - west / 360);
  const approx = J2000 + west / 360 + n;
  const meanAnomaly = (357.5291 + 0.98560028 * (approx - 2451545)) % 360;
  const m = meanAnomaly * RAD;
  const center = 1.9148 * Math.sin(m) + 0.02 * Math.sin(2 * m) + 0.0003 * Math.sin(3 * m);
  const lambda = ((meanAnomaly + center + 180 + 102.9372) % 360) * RAD;
  const declination = Math.asin(Math.sin(lambda) * Math.sin(23.4397 * RAD));
  // −0,83° : réfraction et rayon du disque solaire.
  const cosHour = (Math.sin(-0.83 * RAD) - Math.sin(lat * RAD) * Math.sin(declination)) / (Math.cos(lat * RAD) * Math.cos(declination));
  if (cosHour < -1 || cosHour > 1) return null;
  const hourAngle = Math.acos(cosHour) / RAD;
  const set = J2000 + (hourAngle + west) / 360 + n + 0.0053 * Math.sin(m) - 0.0069 * Math.sin(2 * lambda);
  return new Date((set - 2440587.5) * 86_400_000);
}

const timeFormat = new Intl.DateTimeFormat('fr-FR', { hour: '2-digit', minute: '2-digit' });
export const formatTime = (date) => timeFormat.format(date).replace(':', ' h ');

/**
 * Message sur la lumière du jour pour un départ maintenant, ou '' (rien à signaler).
 * @returns {{ text: string, warn: boolean } | null}
 */
export function daylightNote(start, durationSeconds, now = new Date()) {
  const set = sunset(start, now);
  if (!set) return null;
  const back = new Date(now.getTime() + durationSeconds * 1000);
  const minutesLeft = (set - now) / 60_000;
  if (minutesLeft <= 0) return { text: `Soleil couché depuis ${formatTime(set)} : prévoyez une lampe.`, warn: true };
  if (back > set) {
    const dark = Math.round((back - set) / 60_000);
    return { text: `Coucher du soleil à ${formatTime(set)} : en partant maintenant, environ ${dark} min de nuit à la fin.`, warn: true };
  }
  // Retour bien avant la nuit : l'heure du coucher suffit.
  if (set - back > 2 * 3_600_000) return { text: `Coucher du soleil à ${formatTime(set)}.`, warn: false };
  return { text: `Coucher du soleil à ${formatTime(set)} : retour vers ${formatTime(back)}, avant la nuit.`, warn: false };
}
