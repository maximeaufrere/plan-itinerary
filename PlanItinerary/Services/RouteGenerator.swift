import MapKit

enum RouteGenerationError: LocalizedError {
    case noRouteFound

    var errorDescription: String? {
        switch self {
        case .noRouteFound:
            "Aucun itinéraire trouvé autour de ce point. Essayez une autre distance ou un autre point de départ."
        }
    }
}

/// Génère des boucles ou des allers-retours avec Apple Plans (MapKit).
///
/// MapKit ne sait calculer qu'un trajet d'un point A à un point B. Pour obtenir une boucle d'une distance donnée :
/// 1. on place des points de passage sur un cercle qui passe par le départ, dans une direction donnée ;
/// 2. on enchaîne les trajets MapKit entre ces points ;
/// 3. on ajuste le rayon du cercle selon l'écart à la distance visée, puis on recommence ;
/// 4. on répète pour plusieurs directions, on récupère le dénivelé, et on garde les meilleurs candidats.
@MainActor
final class RouteGenerator {
    /// Rapport moyen entre distance par la route et distance à vol d'oiseau.
    private let detourFactor = 1.3
    /// Écart relatif à la distance visée considéré comme acceptable.
    private let distanceTolerance = 0.05
    /// MapKit limite le nombre de requêtes (~50/min) : on borne le nombre d'ajustements par candidat.
    private let maxAdjustments = 2
    private let loopWaypointCount = 3

    private let elevationService = ElevationService()

    func generate(from start: CLLocationCoordinate2D, criteria: RouteCriteria) async throws -> [GeneratedRoute] {
        // On explore un peu plus de directions que le nombre de propositions demandées.
        let candidateCount = criteria.numberOfProposals + 2
        let baseBearing = Double.random(in: 0..<360)
        var candidates: [GeneratedRoute] = []

        for index in 0..<candidateCount {
            try Task.checkCancellation()
            let bearing = baseBearing + Double(index) * 360 / Double(candidateCount)
            do {
                var route = try await buildRoute(from: start, bearing: bearing, criteria: criteria)
                await addElevation(to: &route)
                route.score = score(route, criteria: criteria)
                candidates.append(route)
            } catch let error as MKError where error.code == .loadingThrottled {
                // Quota MapKit atteint : on s'arrête avec ce qu'on a déjà.
                if candidates.isEmpty { throw error }
                break
            } catch is CancellationError {
                throw CancellationError()
            } catch {
                // Direction impossible (mer, zone sans route…) : on passe à la suivante.
                continue
            }
        }

        guard !candidates.isEmpty else { throw RouteGenerationError.noRouteFound }
        return Array(candidates.sorted { $0.score < $1.score }.prefix(criteria.numberOfProposals))
    }

    // MARK: - Construction d'un candidat

    private func buildRoute(from start: CLLocationCoordinate2D, bearing: Double, criteria: RouteCriteria) async throws -> GeneratedRoute {
        let target = criteria.targetDistanceMeters
        var radius: Double = switch criteria.shape {
        case .loop: target / (2 * .pi * detourFactor)
        case .outAndBack: target / (2 * detourFactor)
        }

        var best: GeneratedRoute?
        for _ in 0..<maxAdjustments {
            let waypoints = makeWaypoints(from: start, radius: radius, bearing: bearing, shape: criteria.shape)
            let route = try await route(through: [start] + waypoints + [start], transportType: criteria.activity.transportType)

            if best.map({ abs($0.distanceMeters - target) > abs(route.distanceMeters - target) }) ?? true {
                best = route
            }
            if abs(route.distanceMeters - target) / target <= distanceTolerance || route.distanceMeters <= 0 {
                break
            }
            radius *= target / route.distanceMeters
        }

        guard let best else { throw RouteGenerationError.noRouteFound }
        return best
    }

    private func makeWaypoints(from start: CLLocationCoordinate2D, radius: Double, bearing: Double, shape: RouteShape) -> [CLLocationCoordinate2D] {
        switch shape {
        case .outAndBack:
            return [Geo.destination(from: start, distance: radius, bearing: bearing)]
        case .loop:
            // Le départ est sur le cercle ; les points de passage sont répartis régulièrement sur ce cercle.
            let center = Geo.destination(from: start, distance: radius, bearing: bearing)
            let startAngle = bearing + 180
            let step = 360 / Double(loopWaypointCount + 1)
            return (1...loopWaypointCount).map { index in
                Geo.destination(from: center, distance: radius, bearing: startAngle + Double(index) * step)
            }
        }
    }

    private func route(through points: [CLLocationCoordinate2D], transportType: MKDirectionsTransportType) async throws -> GeneratedRoute {
        var coordinates: [CLLocationCoordinate2D] = []
        var distance = 0.0

        for (from, to) in zip(points, points.dropFirst()) {
            try Task.checkCancellation()
            let request = MKDirections.Request()
            request.source = MKMapItem(location: CLLocation(latitude: from.latitude, longitude: from.longitude), address: nil)
            request.destination = MKMapItem(location: CLLocation(latitude: to.latitude, longitude: to.longitude), address: nil)
            request.transportType = transportType
            request.requestsAlternateRoutes = false

            let response = try await MKDirections(request: request).calculate()
            guard let leg = response.routes.first else { throw RouteGenerationError.noRouteFound }

            let legCoordinates = leg.polyline.coordinates
            coordinates += coordinates.isEmpty ? legCoordinates : Array(legCoordinates.dropFirst())
            distance += leg.distance
        }

        return GeneratedRoute(coordinates: coordinates, distanceMeters: distance)
    }

    // MARK: - Dénivelé et score

    private func addElevation(to route: inout GeneratedRoute) async {
        // ~300 points maximum par itinéraire, tous les 50 m au mieux.
        let spacing = max(50, route.distanceMeters / 300)
        let samples = Geo.resample(route.coordinates, spacing: spacing)
        guard let altitudes = try? await elevationService.elevations(for: samples.map(\.coordinate)) else {
            return // L'itinéraire reste utilisable sans profil altimétrique.
        }

        route.elevationProfile = zip(samples, altitudes).map { ElevationSample(distance: $0.distance, altitude: $1) }
        let (gain, loss) = Geo.elevationGainAndLoss(altitudes)
        route.elevationGain = gain
        route.elevationLoss = loss
    }

    func score(_ route: GeneratedRoute, criteria: RouteCriteria) -> Double {
        let target = criteria.targetDistanceMeters
        // 1 point par % d'écart à la distance visée.
        var score = abs(route.distanceMeters - target) / target * 100

        if let gain = route.elevationGain {
            if let targetGainPerKm = criteria.elevation.targetGainPerKm {
                let gainPerKm = gain / max(route.distanceMeters / 1000, 0.1)
                score += abs(gainPerKm - targetGainPerKm) * 2
            }
            if let maxGain = criteria.maxElevationGain, gain > maxGain {
                score += 50 + (gain - maxGain) / 10
            }
        }
        return score
    }
}
