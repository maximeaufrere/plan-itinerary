import CoreLocation
import Testing
@testable import PlanItinerary

struct GeoTests {
    private let paris = CLLocationCoordinate2D(latitude: 48.8566, longitude: 2.3522)

    @Test func destinationIsAtRequestedDistance() {
        for bearing in stride(from: 0.0, to: 360, by: 45) {
            let point = Geo.destination(from: paris, distance: 5_000, bearing: bearing)
            #expect(abs(Geo.distance(paris, point) - 5_000) < 20)
        }
    }

    @Test func resampleKeepsTotalDistance() {
        let end = Geo.destination(from: paris, distance: 1_000, bearing: 90)
        let total = Geo.distance(paris, end)
        let samples = Geo.resample([paris, end], spacing: 100)

        #expect(samples.first?.distance == 0)
        // Points réguliers tous les 100 m, plus éventuellement le point d'arrivée exact.
        for (a, b) in zip(samples, samples.dropFirst()) {
            #expect(b.distance - a.distance <= 100 + 1e-6)
        }
        #expect(abs((samples.last?.distance ?? 0) - total) < 1)
    }

    @Test func elevationGainIgnoresNoise() {
        let altitudes: [Double] = [100, 101, 100, 102, 110, 120, 119, 120, 105]
        let (gain, loss) = Geo.elevationGainAndLoss(altitudes)
        #expect(gain == 20)
        #expect(loss == 15)
    }

    @MainActor
    @Test func scorePrefersRoutesMatchingCriteria() {
        var criteria = RouteCriteria()
        criteria.targetDistanceKm = 10
        criteria.elevation = .flat

        var flat = GeneratedRoute(coordinates: [], distanceMeters: 10_000)
        flat.elevationGain = 10
        var hilly = GeneratedRoute(coordinates: [], distanceMeters: 10_000)
        hilly.elevationGain = 300

        let generator = RouteGenerator()
        #expect(generator.score(flat, criteria: criteria) < generator.score(hilly, criteria: criteria))
    }
}
