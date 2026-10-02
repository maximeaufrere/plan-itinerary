import MapKit
import SwiftUI

struct ContentView: View {
    @State private var location = LocationManager()
    @State private var model = PlannerViewModel()
    @State private var cameraPosition: MapCameraPosition = .userLocation(fallback: .automatic)
    @State private var showCriteria = false

    private var startPoint: CLLocationCoordinate2D? {
        model.customStart ?? location.location
    }

    /// Itinéraire sélectionné dessiné en dernier pour apparaître au-dessus des autres.
    private var routesForDrawing: [GeneratedRoute] {
        let selectedID = model.selectedRoute?.id
        return model.routes.filter { $0.id != selectedID } + model.routes.filter { $0.id == selectedID }
    }

    var body: some View {
        NavigationStack {
            MapReader { proxy in
                Map(position: $cameraPosition) {
                    UserAnnotation()
                    if let start = model.customStart {
                        Marker("Départ", systemImage: "flag.fill", coordinate: start)
                            .tint(.green)
                    }
                    ForEach(routesForDrawing) { route in
                        let isSelected = route.id == model.selectedRoute?.id
                        MapPolyline(coordinates: route.coordinates)
                            .stroke(isSelected ? Color.blue : Color.gray.opacity(0.6), lineWidth: isSelected ? 6 : 4)
                    }
                }
                .mapControls {
                    MapUserLocationButton()
                    MapCompass()
                    MapScaleView()
                }
                .onTapGesture { position in
                    if let coordinate = proxy.convert(position, from: .local) {
                        model.customStart = coordinate
                    }
                }
            }
            .safeAreaInset(edge: .bottom) { bottomPanel }
            .navigationTitle("Plan Itinéraire")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .topBarTrailing) {
                    Button("Critères", systemImage: "slider.horizontal.3") { showCriteria = true }
                }
                if model.customStart != nil {
                    ToolbarItem(placement: .topBarLeading) {
                        Button("Ma position", systemImage: "location") { model.customStart = nil }
                    }
                }
            }
            .sheet(isPresented: $showCriteria) {
                CriteriaView(criteria: $model.criteria)
            }
            .navigationDestination(for: GeneratedRoute.ID.self) { id in
                if let route = model.routes.first(where: { $0.id == id }) {
                    RouteDetailView(route: route, activity: model.criteria.activity)
                }
            }
            .onAppear { location.requestLocation() }
            .onChange(of: model.selectedRoute?.id) {
                guard let route = model.selectedRoute else { return }
                withAnimation {
                    cameraPosition = .rect(route.polyline.boundingMapRect.padded(by: 0.25))
                }
            }
        }
    }

    private var bottomPanel: some View {
        VStack(spacing: 12) {
            if !model.routes.isEmpty {
                ScrollView(.horizontal, showsIndicators: false) {
                    HStack(spacing: 10) {
                        ForEach(Array(model.routes.enumerated()), id: \.element.id) { index, route in
                            RouteCard(
                                title: "Proposition \(index + 1)",
                                route: route,
                                activity: model.criteria.activity,
                                isSelected: route.id == model.selectedRoute?.id
                            )
                            .onTapGesture { model.selectedRouteID = route.id }
                        }
                    }
                    .padding(.horizontal)
                }
            }

            if let message = model.errorMessage {
                Text(message)
                    .font(.footnote)
                    .foregroundStyle(.red)
                    .padding(.horizontal)
            } else if startPoint == nil {
                Text(location.isDenied
                     ? "Localisation refusée : touchez la carte pour choisir un départ."
                     : "Recherche de votre position… ou touchez la carte pour choisir un départ.")
                    .font(.footnote)
                    .foregroundStyle(.secondary)
                    .padding(.horizontal)
            }

            HStack {
                Label(
                    "\(model.criteria.activity.label) · \(Int(model.criteria.targetDistanceKm)) km · \(model.criteria.shape.label)",
                    systemImage: model.criteria.activity.systemImage
                )
                .font(.subheadline)
                .lineLimit(1)

                Spacer()

                if let route = model.selectedRoute {
                    NavigationLink(value: route.id) {
                        Image(systemName: "info.circle")
                    }
                    .buttonStyle(.bordered)
                }

                if model.isGenerating {
                    Button("Annuler", role: .cancel) { model.cancel() }
                        .buttonStyle(.bordered)
                } else {
                    Button("Générer") {
                        if let startPoint { model.generate(from: startPoint) }
                    }
                    .buttonStyle(.borderedProminent)
                    .disabled(startPoint == nil)
                }
            }
            .padding(.horizontal)

            if model.isGenerating {
                ProgressView("Calcul des itinéraires…")
                    .font(.footnote)
            }
        }
        .padding(.vertical, 12)
        .background(.regularMaterial)
    }
}

private struct RouteCard: View {
    let title: String
    let route: GeneratedRoute
    let activity: Activity
    let isSelected: Bool

    var body: some View {
        VStack(alignment: .leading, spacing: 4) {
            Text(title).font(.caption).foregroundStyle(.secondary)
            Text(Format.distance(route.distanceMeters)).font(.headline)
            Label(Format.elevation(route.elevationGain), systemImage: "arrow.up.right")
                .font(.caption)
            Label(Format.duration(route.estimatedDuration(for: activity)), systemImage: "clock")
                .font(.caption)
        }
        .padding(10)
        .frame(width: 130, alignment: .leading)
        .background(isSelected ? Color.blue.opacity(0.15) : Color(.secondarySystemBackground), in: .rect(cornerRadius: 12))
        .overlay {
            RoundedRectangle(cornerRadius: 12)
                .stroke(isSelected ? Color.blue : .clear, lineWidth: 2)
        }
    }
}

#Preview {
    ContentView()
}
