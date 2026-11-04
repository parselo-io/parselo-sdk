import Foundation
import Capacitor
import Vision
import UIKit

@objc(Pdf417Plugin)
public class Pdf417Plugin: CAPPlugin, CAPBridgedPlugin {
    public let identifier = "Pdf417Plugin"
    public let jsName = "Pdf417"
    public let pluginMethods: [CAPPluginMethod] = [
        CAPPluginMethod(name: "decodePdf417", returnType: CAPPluginReturnPromise)
    ]

    @objc func decodePdf417(_ call: CAPPluginCall) {
        guard let imageStr = call.getString("image") else {
            call.reject("Missing 'image'")
            return
        }
        guard let image = Self.loadImage(imageStr) else {
            call.reject("Could not load image from the provided string")
            return
        }
        Self.decode(in: image) { raw in
            call.resolve([
                "raw": raw as Any,
                "format": raw != nil ? "pdf417" : NSNull()
            ])
        }
    }

    // MARK: - Vision decode

    private static func decode(in image: UIImage, completion: @escaping (String?) -> Void) {
        guard let cgImage = image.cgImage else { completion(nil); return }

        let request = VNDetectBarcodesRequest { request, error in
            guard error == nil,
                  let results = request.results as? [VNBarcodeObservation] else {
                completion(nil); return
            }
            // Prefer a PDF417 result; payloadStringValue preserves the AAMVA
            // control characters (@, LF, RS) needed downstream.
            let observation = results.first(where: { $0.symbology == .pdf417 }) ?? results.first
            completion(observation?.payloadStringValue)
        }
        request.symbologies = [.pdf417]

        let orientation = cgOrientation(from: image.imageOrientation)
        let handler = VNImageRequestHandler(cgImage: cgImage, orientation: orientation, options: [:])
        do {
            try handler.perform([request])
        } catch {
            completion(nil)
        }
    }

    // MARK: - Image loading (file path, file:// URI, data: URI, or bare base64)

    private static func loadImage(_ s: String) -> UIImage? {
        if s.hasPrefix("data:") {
            guard let comma = s.firstIndex(of: ","),
                  let data = Data(base64Encoded: String(s[s.index(after: comma)...])) else { return nil }
            return UIImage(data: data)
        }
        if s.hasPrefix("file://") {
            guard let path = URL(string: s)?.path else { return nil }
            return UIImage(contentsOfFile: path)
        }
        if s.hasPrefix("/") {
            return UIImage(contentsOfFile: s)
        }
        if let data = Data(base64Encoded: s) {
            return UIImage(data: data)
        }
        return nil
    }

    private static func cgOrientation(from o: UIImage.Orientation) -> CGImagePropertyOrientation {
        switch o {
        case .up: return .up
        case .down: return .down
        case .left: return .left
        case .right: return .right
        case .upMirrored: return .upMirrored
        case .downMirrored: return .downMirrored
        case .leftMirrored: return .leftMirrored
        case .rightMirrored: return .rightMirrored
        @unknown default: return .up
        }
    }
}
