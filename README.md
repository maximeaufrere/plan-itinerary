# Plan Itinéraire

Application iPhone (SwiftUI + MapKit / Apple Plans) qui génère des itinéraires de **course à pied** ou de **vélo**
à partir de critères : distance, type de parcours (boucle / aller-retour), profil de dénivelé, D+ maximal.

## Fonctionnalités (v0.1)

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

## Structure

```
PlanItinerary/
├── App/            Point d'entrée SwiftUI
├── Models/         Critères (RouteCriteria) et itinéraire généré (GeneratedRoute)
├── Services/       RouteGenerator (MapKit), ElevationService (Open-Meteo), LocationManager
├── Utilities/      Calculs géographiques, export GPX
└── Views/          Carte principale, critères, détail avec profil altimétrique
PlanItineraryTests/ Tests de la logique géographique et du score
```
