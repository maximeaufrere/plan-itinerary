import Foundation

enum Format {
    static func distance(_ meters: Double) -> String {
        String(format: "%.1f km", meters / 1000)
    }

    static func elevation(_ meters: Double?) -> String {
        guard let meters else { return "– m" }
        return "\(Int(meters.rounded())) m"
    }

    static func duration(_ seconds: TimeInterval) -> String {
        Duration.seconds(seconds).formatted(.units(allowed: [.hours, .minutes], width: .abbreviated))
    }
}
