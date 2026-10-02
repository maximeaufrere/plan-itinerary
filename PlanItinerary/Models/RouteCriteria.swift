import MapKit

enum Activity: String, CaseIterable, Identifiable {
    case running
    case cycling

    var id: Self { self }

    var label: String {
        switch self {
        case .running: "Course à pied"
        case .cycling: "Vélo"
        }
    }

    var systemImage: String {
        switch self {
        case .running: "figure.run"
        case .cycling: "bicycle"
        }
    }

    /// MapKit n'a pas de mode « course » : on utilise les itinéraires piétons.
    /// Le mode vélo est disponible depuis iOS 26.
    var transportType: MKDirectionsTransportType {
        switch self {
        case .running: .walking
        case .cycling: .cycling
        }
    }

    /// Vitesse moyenne utilisée pour estimer la durée (MapKit estime une durée à pied, pas en courant).
    var averageSpeedKmh: Double {
        switch self {
        case .running: 10
        case .cycling: 20
        }
    }

    var distanceRangeKm: ClosedRange<Double> {
        switch self {
        case .running: 1...50
        case .cycling: 5...200
        }
    }

    var defaultDistanceKm: Double {
        switch self {
        case .running: 10
        case .cycling: 40
        }
    }
}

enum RouteShape: String, CaseIterable, Identifiable {
    case loop
    case outAndBack

    var id: Self { self }

    var label: String {
        switch self {
        case .loop: "Boucle"
        case .outAndBack: "Aller-retour"
        }
    }
}

enum ElevationPreference: String, CaseIterable, Identifiable {
    case any
    case flat
    case rolling
    case hilly

    var id: Self { self }

    var label: String {
        switch self {
        case .any: "Peu importe"
        case .flat: "Plat"
        case .rolling: "Vallonné"
        case .hilly: "Montagneux"
        }
    }

    /// Dénivelé positif visé, en mètres par kilomètre.
    var targetGainPerKm: Double? {
        switch self {
        case .any: nil
        case .flat: 0
        case .rolling: 10
        case .hilly: 25
        }
    }
}

struct RouteCriteria {
    var activity: Activity = .running {
        didSet {
            guard activity != oldValue else { return }
            targetDistanceKm = activity.defaultDistanceKm
        }
    }
    var targetDistanceKm: Double = Activity.running.defaultDistanceKm
    var shape: RouteShape = .loop
    var elevation: ElevationPreference = .any
    /// Dénivelé positif maximal accepté (nil = pas de limite).
    var maxElevationGain: Double?
    var numberOfProposals = 3

    var targetDistanceMeters: Double { targetDistanceKm * 1000 }
}
