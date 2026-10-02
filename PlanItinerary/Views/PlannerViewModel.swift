import MapKit
import Observation

@MainActor
@Observable
final class PlannerViewModel {
    var criteria = RouteCriteria()
    /// Point de départ choisi en touchant la carte (sinon : position de l'utilisateur).
    var customStart: CLLocationCoordinate2D?
    private(set) var routes: [GeneratedRoute] = []
    var selectedRouteID: GeneratedRoute.ID?
    private(set) var isGenerating = false
    var errorMessage: String?

    @ObservationIgnored private let generator = RouteGenerator()
    @ObservationIgnored private var generationTask: Task<Void, Never>?

    var selectedRoute: GeneratedRoute? {
        routes.first { $0.id == selectedRouteID } ?? routes.first
    }

    func generate(from start: CLLocationCoordinate2D) {
        generationTask?.cancel()
        isGenerating = true
        errorMessage = nil

        generationTask = Task {
            defer {
                // Une génération annulée ne doit pas masquer celle qui l'a remplacée.
                if !Task.isCancelled { isGenerating = false }
            }
            do {
                let routes = try await generator.generate(from: start, criteria: criteria)
                self.routes = routes
                selectedRouteID = routes.first?.id
            } catch is CancellationError {
                // Génération remplacée par une nouvelle.
            } catch {
                errorMessage = error.localizedDescription
            }
        }
    }

    func cancel() {
        generationTask?.cancel()
        isGenerating = false
    }
}
