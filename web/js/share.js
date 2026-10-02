/**
 * Propose un fichier à l'utilisateur : feuille de partage sur mobile (Strava, Fichiers, AirDrop…),
 * téléchargement classique sinon.
 */
export async function shareOrDownload(file, title) {
  if (navigator.canShare?.({ files: [file] })) {
    try {
      await navigator.share({ files: [file], title });
      return;
    } catch (error) {
      if (error.name === 'AbortError') return; // partage annulé par l'utilisateur
    }
  }
  const url = URL.createObjectURL(file);
  const link = Object.assign(document.createElement('a'), { href: url, download: file.name });
  document.body.append(link);
  link.click();
  link.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
