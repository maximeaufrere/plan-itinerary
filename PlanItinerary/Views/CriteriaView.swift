import SwiftUI

struct CriteriaView: View {
    @Binding var criteria: RouteCriteria
    @Environment(\.dismiss) private var dismiss

    private var limitsElevation: Binding<Bool> {
        Binding(
            get: { criteria.maxElevationGain != nil },
            set: { criteria.maxElevationGain = $0 ? (criteria.maxElevationGain ?? 200) : nil }
        )
    }

    var body: some View {
        NavigationStack {
            Form {
                Section("Activité") {
                    Picker("Activité", selection: $criteria.activity) {
                        ForEach(Activity.allCases) { activity in
                            Label(activity.label, systemImage: activity.systemImage).tag(activity)
                        }
                    }
                    .pickerStyle(.segmented)
                }

                Section("Distance") {
                    LabeledContent("Distance visée", value: "\(Int(criteria.targetDistanceKm)) km")
                    Slider(
                        value: $criteria.targetDistanceKm,
                        in: criteria.activity.distanceRangeKm,
                        step: 1
                    )
                    Picker("Type de parcours", selection: $criteria.shape) {
                        ForEach(RouteShape.allCases) { Text($0.label).tag($0) }
                    }
                }

                Section("Dénivelé") {
                    Picker("Profil", selection: $criteria.elevation) {
                        ForEach(ElevationPreference.allCases) { Text($0.label).tag($0) }
                    }
                    Toggle("Limiter le dénivelé positif", isOn: limitsElevation)
                    if let maxGain = criteria.maxElevationGain {
                        Stepper(
                            "D+ max : \(Int(maxGain)) m",
                            value: Binding(
                                get: { maxGain },
                                set: { criteria.maxElevationGain = $0 }
                            ),
                            in: 0...5000,
                            step: 50
                        )
                    }
                }

                Section {
                    Stepper("Propositions : \(criteria.numberOfProposals)", value: $criteria.numberOfProposals, in: 1...5)
                } footer: {
                    Text("Chaque proposition part dans une direction différente. Plus il y en a, plus la génération est longue.")
                }
            }
            .navigationTitle("Critères")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .confirmationAction) {
                    Button("OK") { dismiss() }
                }
            }
        }
        .presentationDetents([.medium, .large])
    }
}
