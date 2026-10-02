import Charts
import MapKit
import SwiftUI

struct RouteDetailView: View {
    let route: GeneratedRoute
    let activity: Activity

    @State private var gpxURL: URL?

    var body: some View {
        List {
            Section {
                Map(initialPosition: .rect(route.polyline.boundingMapRect.padded(by: 0.2))) {
                    MapPolyline(coordinates: route.coordinates)
                        .stroke(.blue, lineWidth: 5)
                    if let start = route.coordinates.first {
                        Marker("Départ", systemImage: "flag.fill", coordinate: start)
                            .tint(.green)
                    }
                }
                .frame(height: 260)
                .listRowInsets(EdgeInsets())
            }

            Section("Statistiques") {
                LabeledContent("Distance", value: Format.distance(route.distanceMeters))
                LabeledContent("Dénivelé positif", value: Format.elevation(route.elevationGain))
                LabeledContent("Dénivelé négatif", value: Format.elevation(route.elevationLoss))
                LabeledContent("Altitude min / max", value: "\(Format.elevation(route.minAltitude)) / \(Format.elevation(route.maxAltitude))")
                LabeledContent("Durée estimée", value: Format.duration(route.estimatedDuration(for: activity)))
            }

            if !route.elevationProfile.isEmpty {
                Section("Profil altimétrique") {
                    ElevationChart(profile: route.elevationProfile)
                        .frame(height: 180)
                        .padding(.vertical, 8)
                }
            }

            if let gpxURL {
                Section {
                    ShareLink(item: gpxURL) {
                        Label("Exporter en GPX", systemImage: "square.and.arrow.up")
                    }
                } footer: {
                    Text("Le fichier GPX peut être importé dans Strava, Garmin Connect, Komoot, etc.")
                }
            }
        }
        .navigationTitle("Itinéraire")
        .navigationBarTitleDisplayMode(.inline)
        .task {
            let name = "\(activity.label) \(Format.distance(route.distanceMeters))"
            gpxURL = try? GPXExporter.writeTemporaryFile(for: route, name: name)
        }
    }
}

private struct ElevationChart: View {
    let profile: [ElevationSample]

    private var altitudeDomain: ClosedRange<Double> {
        let altitudes = profile.map(\.altitude)
        let low = altitudes.min() ?? 0
        let high = altitudes.max() ?? 0
        let margin = max((high - low) * 0.1, 10)
        return (low - margin)...(high + margin)
    }

    var body: some View {
        Chart(profile) { sample in
            AreaMark(
                x: .value("Distance (km)", sample.distance / 1000),
                yStart: .value("Plancher", altitudeDomain.lowerBound),
                yEnd: .value("Altitude (m)", sample.altitude)
            )
            .foregroundStyle(.blue.opacity(0.2))
            LineMark(
                x: .value("Distance (km)", sample.distance / 1000),
                y: .value("Altitude (m)", sample.altitude)
            )
            .foregroundStyle(.blue)
        }
        .chartYScale(domain: altitudeDomain)
        .chartXAxisLabel("km")
        .chartYAxisLabel("m")
    }
}
