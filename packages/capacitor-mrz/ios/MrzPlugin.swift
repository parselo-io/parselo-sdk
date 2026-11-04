import Foundation
import Capacitor
import Vision
import UIKit

@objc(MrzPlugin)
public class MrzPlugin: CAPPlugin {

    @objc func recognizeText(_ call: CAPPluginCall) {
        guard let imageStr = call.getString("image") else {
            print("[MrzPlugin] ERROR: Missing 'image' parameter")
            call.reject("Missing 'image'")
            return
        }
        print("[MrzPlugin] recognizeText called, image string length: \(imageStr.count)")
        guard let image = Self.loadImage(imageStr) else {
            print("[MrzPlugin] ERROR: Could not load image from the provided string")
            call.reject("Could not load image from the provided string")
            return
        }
        print("[MrzPlugin] Image loaded: \(Int(image.size.width))×\(Int(image.size.height)), orientation: \(image.imageOrientation.rawValue)")
        Self.recognize(in: image) { lines in
            print("[MrzPlugin] Vision returned \(lines.count) line(s):")
            lines.enumerated().forEach { i, l in print("[MrzPlugin]   [\(i)] (\(l.count) chars): \(l)") }
            call.resolve([
                "lines": lines,
                "raw":   lines.joined(separator: "\n"),
            ])
        }
    }

    // MARK: - Vision text recognition

    private static func recognize(in image: UIImage, completion: @escaping ([String]) -> Void) {
        guard let cgImage = image.cgImage else { completion([]); return }

        let request = VNRecognizeTextRequest { req, err in
            if let err = err {
                print("[MrzPlugin] Vision error: \(err.localizedDescription)")
                completion([]); return
            }
            guard let results = req.results as? [VNRecognizedTextObservation] else {
                print("[MrzPlugin] Vision: no results")
                completion([]); return
            }
            print("[MrzPlugin] Vision: \(results.count) text observation(s)")
            let lines = results.compactMap { $0.topCandidates(1).first?.string }
            completion(lines)
        }
        // Accurate mode is required for MRZ — fast mode misses characters.
        request.recognitionLevel = .accurate
        // Language correction must be off: it replaces valid MRZ tokens (e.g. "<<")
        // with natural-language words and corrupts check digits.
        request.usesLanguageCorrection = false
        request.recognitionLanguages   = ["en-US"]

        let orientation = cgOrientation(from: image.imageOrientation)
        let handler = VNImageRequestHandler(cgImage: cgImage, orientation: orientation, options: [:])
        do {
            try handler.perform([request])
        } catch {
            completion([])
        }
    }

    // MARK: - Image loading (file path, file:// URI, data: URI, or bare base64)

    private static func loadImage(_ s: String) -> UIImage? {
        if s.hasPrefix("data:") {
            guard let comma = s.firstIndex(of: ","),
                  let data  = Data(base64Encoded: String(s[s.index(after: comma)...])) else { return nil }
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
        case .up:            return .up
        case .down:          return .down
        case .left:          return .left
        case .right:         return .right
        case .upMirrored:    return .upMirrored
        case .downMirrored:  return .downMirrored
        case .leftMirrored:  return .leftMirrored
        case .rightMirrored: return .rightMirrored
        @unknown default:    return .up
        }
    }
}
