import MapKit

struct ElevationSample: Identifiable {
    /// Distance depuis le départ, en mètres.
    let distance: Double
    let altitude: Double

    var id: Double { distance }
}

struct GeneratedRoute: Identifiable {
    let id = UUID()
    let coordinates: [CLLocationCoordinate2D]
    let distanceMeters: Double
    var elevationProfile: [ElevationSample] = []
    var elevationGain: Double?
    var elevationLoss: Double?
    /// Plus le score est bas, plus l'itinéraire correspond aux critères.
    var score: Double = 0

    var polyline: MKPolyline {
        MKPolyline(coordinates: coordinates, count: coordinates.count)
    }

    var minAltitude: Double? { elevationProfile.map(\.altitude).min() }
    var maxAltitude: Double? { elevationProfile.map(\.altitude).max() }

    func estimatedDuration(for activity: Activity) -> TimeInterval {
        distanceMeters / (activity.averageSpeedKmh / 3.6)
    }
}
