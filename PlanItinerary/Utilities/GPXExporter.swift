import Foundation

enum GPXExporter {
    static func gpx(for route: GeneratedRoute, name: String) -> String {
        let points = route.coordinates
            .map { String(format: "      <trkpt lat=\"%.6f\" lon=\"%.6f\"/>", $0.latitude, $0.longitude) }
            .joined(separator: "\n")

        return """
        <?xml version="1.0" encoding="UTF-8"?>
        <gpx version="1.1" creator="PlanItinerary" xmlns="http://www.topografix.com/GPX/1/1">
          <trk>
            <name>\(name)</name>
            <trkseg>
        \(points)
            </trkseg>
          </trk>
        </gpx>
        """
    }

    static func writeTemporaryFile(for route: GeneratedRoute, name: String) throws -> URL {
        let url = FileManager.default.temporaryDirectory
            .appendingPathComponent(name.replacingOccurrences(of: " ", with: "-"))
            .appendingPathExtension("gpx")
        try gpx(for: route, name: name).write(to: url, atomically: true, encoding: .utf8)
        return url
    }
}
