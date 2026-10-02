import CoreLocation
import Foundation

/// MapKit ne fournit pas l'altitude des itinéraires : on interroge l'API d'élévation d'Open-Meteo
/// (modèle numérique de terrain Copernicus, ~90 m de résolution, gratuite pour un usage non commercial).
struct ElevationService {
    private static let endpoint = URL(string: "https://api.open-meteo.com/v1/elevation")!
    private static let maxCoordinatesPerRequest = 100

    func elevations(for coordinates: [CLLocationCoordinate2D]) async throws -> [Double] {
        var result: [Double] = []
        result.reserveCapacity(coordinates.count)

        for start in stride(from: 0, to: coordinates.count, by: Self.maxCoordinatesPerRequest) {
            let chunk = coordinates[start..<min(start + Self.maxCoordinatesPerRequest, coordinates.count)]
            var components = URLComponents(url: Self.endpoint, resolvingAgainstBaseURL: false)!
            components.queryItems = [
                URLQueryItem(name: "latitude", value: chunk.map { String(format: "%.5f", $0.latitude) }.joined(separator: ",")),
                URLQueryItem(name: "longitude", value: chunk.map { String(format: "%.5f", $0.longitude) }.joined(separator: ",")),
            ]

            let (data, response) = try await URLSession.shared.data(from: components.url!)
            guard (response as? HTTPURLResponse)?.statusCode == 200 else {
                throw URLError(.badServerResponse)
            }
            let decoded = try JSONDecoder().decode(Response.self, from: data)
            guard decoded.elevation.count == chunk.count else {
                throw URLError(.cannotParseResponse)
            }
            result += decoded.elevation
        }
        return result
    }

    private struct Response: Decodable {
        let elevation: [Double]
    }
}
