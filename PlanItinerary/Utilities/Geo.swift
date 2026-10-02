import CoreLocation
import MapKit

enum Geo {
    static let earthRadius = 6_371_000.0

    static func distance(_ a: CLLocationCoordinate2D, _ b: CLLocationCoordinate2D) -> Double {
        CLLocation(latitude: a.latitude, longitude: a.longitude)
            .distance(from: CLLocation(latitude: b.latitude, longitude: b.longitude))
    }

    /// Point atteint en partant de `origin` sur `distance` mètres selon le cap `bearing` (degrés, 0 = nord).
    static func destination(from origin: CLLocationCoordinate2D, distance: Double, bearing: Double) -> CLLocationCoordinate2D {
        let angularDistance = distance / earthRadius
        let theta = bearing * .pi / 180
        let phi1 = origin.latitude * .pi / 180
        let lambda1 = origin.longitude * .pi / 180

        let phi2 = asin(sin(phi1) * cos(angularDistance) + cos(phi1) * sin(angularDistance) * cos(theta))
        let lambda2 = lambda1 + atan2(
            sin(theta) * sin(angularDistance) * cos(phi1),
            cos(angularDistance) - sin(phi1) * sin(phi2)
        )

        return CLLocationCoordinate2D(
            latitude: phi2 * 180 / .pi,
            longitude: (lambda2 * 180 / .pi + 540).truncatingRemainder(dividingBy: 360) - 180
        )
    }

    /// Ré-échantillonne une polyligne à intervalle régulier.
    /// Retourne chaque point avec sa distance cumulée depuis le départ.
    static func resample(_ coordinates: [CLLocationCoordinate2D], spacing: Double) -> [(coordinate: CLLocationCoordinate2D, distance: Double)] {
        guard let first = coordinates.first, spacing > 0 else { return [] }

        var samples = [(coordinate: first, distance: 0.0)]
        var travelled = 0.0
        var nextSampleAt = spacing

        for (a, b) in zip(coordinates, coordinates.dropFirst()) {
            let segment = distance(a, b)
            guard segment > 0 else { continue }
            while travelled + segment >= nextSampleAt {
                let fraction = (nextSampleAt - travelled) / segment
                let point = CLLocationCoordinate2D(
                    latitude: a.latitude + (b.latitude - a.latitude) * fraction,
                    longitude: a.longitude + (b.longitude - a.longitude) * fraction
                )
                samples.append((point, nextSampleAt))
                nextSampleAt += spacing
            }
            travelled += segment
        }

        if let last = coordinates.last, travelled - (samples.last?.distance ?? 0) > 1 {
            samples.append((last, travelled))
        }
        return samples
    }

    /// Dénivelés positif et négatif, avec un seuil d'hystérésis pour filtrer le bruit des données d'altitude.
    static func elevationGainAndLoss(_ altitudes: [Double], threshold: Double = 3) -> (gain: Double, loss: Double) {
        guard var reference = altitudes.first else { return (0, 0) }
        var gain = 0.0
        var loss = 0.0
        for altitude in altitudes.dropFirst() {
            let delta = altitude - reference
            if delta >= threshold {
                gain += delta
                reference = altitude
            } else if delta <= -threshold {
                loss -= delta
                reference = altitude
            }
        }
        return (gain, loss)
    }
}

extension MKPolyline {
    var coordinates: [CLLocationCoordinate2D] {
        var coordinates = [CLLocationCoordinate2D](repeating: kCLLocationCoordinate2DInvalid, count: pointCount)
        getCoordinates(&coordinates, range: NSRange(location: 0, length: pointCount))
        return coordinates
    }
}

extension MKMapRect {
    func padded(by ratio: Double) -> MKMapRect {
        insetBy(dx: -size.width * ratio, dy: -size.height * ratio)
    }
}
