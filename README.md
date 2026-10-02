# Plan Itinéraire

Génère des itinéraires de **course à pied** ou de **vélo** à partir de critères : distance, type de parcours
(boucle / aller-retour), profil de dénivelé, D+ maximal.

Le dépôt contient deux versions :

- **`web/` — app web multiplateforme** (iPhone, Android, ordinateur), basée sur OpenStreetMap et OpenRouteService.
  Aucun compte développeur ni Mac nécessaire.
- **`PlanItinerary/` — app iPhone native** (SwiftUI + MapKit / Apple Plans), décrite plus bas.

# App web (`web/`)

HTML/CSS/JavaScript sans étape de compilation ; la carte utilise [Leaflet](https://leafletjs.com) (copié dans
`web/vendor/`), les fonds de carte OpenStreetMap et l'API [OpenRouteService](https://openrouteservice.org).

## Fonctionnalités

- Départ depuis votre position (GPS du navigateur) ou un point touché sur la carte
- Activités : course (piéton), trail (randonnée), vélo de route, vélo, VTT — chacune avec son profil de calcul ORS
- Types de parcours :
  - **Boucle** (option `round_trip` d'ORS, longueur corrigée si l'écart dépasse 5 %)
  - **Aller-retour**
  - **A → B avec détour** : si le trajet direct est trop court, passage par un point placé sur une ellipse
    dont A et B sont les foyers (toutes ses positions donnent la même distance à vol d'oiseau)
- Critères : profil de dénivelé, D+ maximal, revêtement (bitume / chemins), éviter les grands axes
- Classement des propositions selon ces critères, avec une **pénalité pour les rues empruntées deux fois**
  (sauf en aller-retour)
- **Allure personnalisée** (min/km à pied, km/h à vélo) ; à pied, la durée utilise le kilomètre-effort
  (+1 km par 100 m de D+)
- Statistiques (distance, D+/D−, altitudes, durée, % de repassages, % de grands axes), répartition du revêtement,
  profil altimétrique
- **Favoris** enregistrés sur l'appareil (bouton ★), export GPX (feuille de partage sur mobile → Strava, Komoot…)
- Installable sur l'écran d'accueil (Safari ▸ Partager ▸ « Sur l'écran d'accueil »), mode sombre

## Clé OpenRouteService

L'app demande une clé API gratuite au premier calcul (bouton ⚙️) : créez un compte sur
[openrouteservice.org](https://openrouteservice.org/dev/#/signup) et copiez la clé de votre tableau de bord.
La clé est enregistrée **uniquement dans le navigateur** de l'appareil (jamais dans le dépôt). Offre gratuite :
environ 2 000 itinéraires par jour et 40 par minute ; une génération en consomme jusqu'à 2 par proposition
(+1 pour le trajet direct en mode A → B).

## Lancer en local

```bash
cd web
python3 -m http.server 8080   # ou : npm start
# puis http://localhost:8080
```

La géolocalisation du navigateur exige HTTPS (ou `localhost`) : pour tester le GPS sur un téléphone, il faut
passer par la version hébergée.

## Tests

```bash
cd web && npm test   # Node 20+, aucune dépendance à installer
```

## Hébergement

Site statique : il suffit de publier le dossier `web/`.

- **Netlify** : « Add new site ▸ Import from Git », choisir ce dépôt ; `netlify.toml` configure déjà le dossier.
- **Cloudflare Pages** : connecter le dépôt, commande de build vide, dossier de sortie `web`.
- **GitHub Pages** (utilisé actuellement) : `.github/workflows/pages.yml` publie `web/` à chaque modification.
  Adresse : https://maximeaufrere.github.io/plan-itinerary/

# App iPhone native (`PlanItinerary/`)

## Fonctionnalités de l'app native (v0.1)

- Départ depuis votre position ou n'importe quel point touché sur la carte
- Choix de l'activité : course à pied (itinéraires piétons) ou vélo (itinéraires cyclables, iOS 26+)
- Distance visée, boucle ou aller-retour
- Profil de dénivelé souhaité (plat, vallonné, montagneux) et D+ maximal
- Plusieurs propositions classées selon leur adéquation aux critères
- Fiche détaillée : distance, D+/D−, altitude min/max, durée estimée, profil altimétrique
- Export GPX (Strava, Garmin Connect, Komoot…)

## Lancer le projet

Prérequis : un Mac avec **Xcode 26** (le mode vélo de MapKit nécessite iOS 26).

```bash
brew install xcodegen
xcodegen            # génère PlanItinerary.xcodeproj à partir de project.yml
open PlanItinerary.xcodeproj
```

Dans Xcode, choisissez votre équipe de signature (onglet *Signing & Capabilities*) et changez
l'identifiant `com.example.planitinerary` si besoin. Dans le simulateur, définissez une position via
*Features ▸ Location* ou touchez simplement la carte pour choisir un départ.

## Comment fonctionne la génération

MapKit (`MKDirections`) ne sait calculer qu'un trajet d'un point A à un point B. Pour obtenir une boucle d'une
distance donnée (`Services/RouteGenerator.swift`) :

1. on place 3 points de passage sur un cercle passant par le départ, orienté dans une direction donnée ;
2. on enchaîne les trajets MapKit départ → P1 → P2 → P3 → départ ;
3. on corrige le rayon du cercle selon l'écart à la distance visée et on recalcule (tolérance ±5 %) ;
4. on répète pour plusieurs directions, on récupère l'altitude le long de chaque tracé ;
5. on attribue un score (écart de distance + écart au dénivelé souhaité + pénalité si D+ max dépassé)
   et on garde les meilleurs.

L'aller-retour suit le même principe avec un seul point de passage.

### Dénivelé

MapKit ne fournit **pas** l'altitude des itinéraires. Le tracé est ré-échantillonné (≤ 300 points) puis
l'altitude est demandée à l'[API d'élévation Open-Meteo](https://open-meteo.com/en/docs/elevation-api)
(gratuite, sans clé, **usage non commercial** ; offre payante pour un usage commercial). Le D+ est calculé avec
un seuil de 3 m pour filtrer le bruit.

## Limites connues

- **Quota MapKit** : Apple limite le nombre de requêtes d'itinéraire (~50/min par appareil). Chaque proposition
  coûte 4 à 8 requêtes ; au-delà de 5 propositions on risque l'erreur `loadingThrottled`.
- Le mode piéton de MapKit n'est pas pensé pour la course : il peut emprunter des escaliers ou éviter certains
  chemins de terre.
- Les itinéraires vélo d'Apple Plans ne sont pas disponibles dans tous les pays.
- Les boucles peuvent repasser par la même rue (pas encore de pénalité de « chevauchement »).

## Pistes pour la suite

- Pénaliser les tronçons parcourus deux fois et les demi-tours
- Itinéraire A → B avec distance minimale (détour volontaire)
- Choix de l'allure / vitesse moyenne
- Sauvegarde des itinéraires favoris (SwiftData) et envoi vers l'Apple Watch
- Surfaces (route / chemin) et préférences type « éviter les grands axes »

## Structure de l'app native

```
PlanItinerary/
├── App/            Point d'entrée SwiftUI
├── Models/         Critères (RouteCriteria) et itinéraire généré (GeneratedRoute)
├── Services/       RouteGenerator (MapKit), ElevationService (Open-Meteo), LocationManager
├── Utilities/      Calculs géographiques, export GPX
└── Views/          Carte principale, critères, détail avec profil altimétrique
PlanItineraryTests/ Tests de la logique géographique et du score
```
