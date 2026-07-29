import AVFoundation
import Foundation
import UIKit

struct PrepareArgs: Decodable {
    let inputPath: String
    let outputDirectory: String
    let audioReference: String
}

struct MediaTimeRange: Codable {
    let start: Double
    let end: Double
}

struct ExportArgs: Decodable {
    let inputPath: String
    let destination: String
    let mediaKind: String
    let keepRanges: [MediaTimeRange]
}

struct PreparedMediaResult: Codable {
    let duration: Double
    let sampleRate: Int
    let waveformSamplesPerSecond: Double
    let waveform: [Double]
    let audioReference: String
}

struct MediaExportResult: Codable {
    let destination: String
    let byteLength: UInt64
}

enum AvMediaError: LocalizedError {
    case invalid(String)
    case failed(String)
    case cancelled

    var errorDescription: String? {
        switch self {
        case .invalid(let message), .failed(let message): return message
        case .cancelled: return "Media job was cancelled"
        }
    }
}

final class MobileMediaJob {
    let id: String
    let kind: String
    private let lock = NSLock()
    private var cancelled = false
    private var reader: AVAssetReader?
    private var exporter: AVAssetExportSession?
    private var backgroundTask: UIBackgroundTaskIdentifier = .invalid

    init(id: String, kind: String) {
        self.id = id
        self.kind = kind
    }

    var isCancelled: Bool {
        lock.lock()
        defer { lock.unlock() }
        return cancelled
    }

    func attach(reader: AVAssetReader) {
        lock.lock()
        self.reader = reader
        let shouldCancel = cancelled
        lock.unlock()
        if shouldCancel { reader.cancelReading() }
    }

    func attach(exporter: AVAssetExportSession) {
        lock.lock()
        self.exporter = exporter
        let shouldCancel = cancelled
        lock.unlock()
        if shouldCancel { exporter.cancelExport() }
    }

    func beginBackgroundExecution() {
        DispatchQueue.main.async { [weak self] in
            guard let self, self.backgroundTask == .invalid else { return }
            self.backgroundTask = UIApplication.shared.beginBackgroundTask(
                withName: "Rescript \(self.kind)"
            ) { [weak self] in
                self?.cancel()
            }
        }
    }

    func finishBackgroundExecution() {
        DispatchQueue.main.async { [weak self] in
            guard let self, self.backgroundTask != .invalid else { return }
            UIApplication.shared.endBackgroundTask(self.backgroundTask)
            self.backgroundTask = .invalid
        }
    }

    func cancel() {
        lock.lock()
        cancelled = true
        let reader = self.reader
        let exporter = self.exporter
        lock.unlock()
        reader?.cancelReading()
        exporter?.cancelExport()
    }
}

@available(iOS 16.0, *)
enum AvMediaService {
    static func prepare(
        _ args: PrepareArgs,
        job: MobileMediaJob,
        onProgress: @escaping (Double, String, String) -> Void
    ) async throws -> PreparedMediaResult {
        let input = URL(fileURLWithPath: args.inputPath)
        let outputDirectory = URL(fileURLWithPath: args.outputDirectory, isDirectory: true)
        try FileManager.default.createDirectory(
            at: outputDirectory,
            withIntermediateDirectories: true
        )
        let audioURL = outputDirectory.appendingPathComponent("audio-16k.wav")
        let waveformURL = outputDirectory.appendingPathComponent("waveform.json")

        if FileManager.default.fileExists(atPath: audioURL.path),
           let data = try? Data(contentsOf: waveformURL),
           let cached = try? JSONDecoder().decode(PreparedMediaResult.self, from: data) {
            return PreparedMediaResult(
                duration: cached.duration,
                sampleRate: cached.sampleRate,
                waveformSamplesPerSecond: cached.waveformSamplesPerSecond,
                waveform: cached.waveform,
                audioReference: args.audioReference
            )
        }

        let asset = AVURLAsset(url: input)
        let durationTime = try await asset.load(.duration)
        let duration = durationTime.seconds
        guard duration.isFinite, duration > 0 else {
            throw AvMediaError.invalid("Media duration is unavailable")
        }
        guard let track = try await asset.loadTracks(withMediaType: .audio).first else {
            throw AvMediaError.invalid("Selected media has no audio track")
        }

        let temporary = outputDirectory.appendingPathComponent(".audio-16k.tmp.wav")
        try? FileManager.default.removeItem(at: temporary)
        FileManager.default.createFile(atPath: temporary.path, contents: nil)
        let outputHandle = try FileHandle(forWritingTo: temporary)
        defer { try? outputHandle.close() }
        try outputHandle.write(contentsOf: Data(repeating: 0, count: 44))

        let reader = try AVAssetReader(asset: asset)
        let output = AVAssetReaderTrackOutput(
            track: track,
            outputSettings: [
                AVFormatIDKey: kAudioFormatLinearPCM,
                AVSampleRateKey: 16_000,
                AVNumberOfChannelsKey: 1,
                AVLinearPCMBitDepthKey: 16,
                AVLinearPCMIsFloatKey: false,
                AVLinearPCMIsBigEndianKey: false,
                AVLinearPCMIsNonInterleaved: false,
            ]
        )
        output.alwaysCopiesSampleData = false
        guard reader.canAdd(output) else {
            throw AvMediaError.failed("AVFoundation cannot decode this audio track")
        }
        reader.add(output)
        job.attach(reader: reader)
        guard reader.startReading() else {
            throw AvMediaError.failed(reader.error?.localizedDescription ?? "Audio decoding failed")
        }

        var dataBytes: UInt32 = 0
        var waveform: [Double] = []
        var bucketPeak = 0.0
        var bucketSamples = 0
        let bucketSize = 160
        var lastProgress = 0.0

        while reader.status == .reading {
            if job.isCancelled {
                reader.cancelReading()
                throw AvMediaError.cancelled
            }
            guard let sampleBuffer = output.copyNextSampleBuffer() else { break }
            guard let blockBuffer = CMSampleBufferGetDataBuffer(sampleBuffer) else { continue }
            let byteCount = CMBlockBufferGetDataLength(blockBuffer)
            if byteCount == 0 { continue }
            var bytes = Data(count: byteCount)
            let status = bytes.withUnsafeMutableBytes { pointer in
                CMBlockBufferCopyDataBytes(
                    blockBuffer,
                    atOffset: 0,
                    dataLength: byteCount,
                    destination: pointer.baseAddress!
                )
            }
            guard status == kCMBlockBufferNoErr else {
                throw AvMediaError.failed("Unable to read decoded audio samples")
            }
            try outputHandle.write(contentsOf: bytes)
            dataBytes = dataBytes &+ UInt32(byteCount)

            bytes.withUnsafeBytes { pointer in
                let samples = pointer.bindMemory(to: Int16.self)
                for sample in samples {
                    let normalized = min(1, abs(Double(Int16(littleEndian: sample))) / Double(Int16.max))
                    bucketPeak = max(bucketPeak, normalized)
                    bucketSamples += 1
                    if bucketSamples == bucketSize {
                        waveform.append(bucketPeak)
                        bucketPeak = 0
                        bucketSamples = 0
                    }
                }
            }

            let seconds = CMSampleBufferGetPresentationTimeStamp(sampleBuffer).seconds
            let progress = min(0.92, max(0.01, seconds / duration * 0.92))
            if progress - lastProgress >= 0.005 {
                lastProgress = progress
                onProgress(progress, "decode", "Decoding audio")
            }
        }

        if reader.status == .failed {
            throw AvMediaError.failed(reader.error?.localizedDescription ?? "Audio decoding failed")
        }
        if reader.status == .cancelled || job.isCancelled {
            throw AvMediaError.cancelled
        }
        if bucketSamples > 0 { waveform.append(bucketPeak) }

        try outputHandle.seek(toOffset: 0)
        try outputHandle.write(contentsOf: wavHeader(dataBytes: dataBytes, sampleRate: 16_000))
        try outputHandle.synchronize()
        try outputHandle.close()
        try? FileManager.default.removeItem(at: audioURL)
        try FileManager.default.moveItem(at: temporary, to: audioURL)

        onProgress(0.97, "waveform", "Saving waveform")
        let result = PreparedMediaResult(
            duration: duration,
            sampleRate: 16_000,
            waveformSamplesPerSecond: 100,
            waveform: waveform,
            audioReference: args.audioReference
        )
        try atomicWrite(JSONEncoder().encode(result), to: waveformURL)
        return result
    }

    static func export(
        _ args: ExportArgs,
        job: MobileMediaJob,
        onProgress: @escaping (Double, String, String) -> Void
    ) async throws -> MediaExportResult {
        guard !args.keepRanges.isEmpty else {
            throw AvMediaError.invalid("Export needs at least one keep range")
        }
        var previousEnd = 0.0
        for range in args.keepRanges {
            guard range.start.isFinite,
                  range.end.isFinite,
                  range.start >= previousEnd,
                  range.end > range.start else {
                throw AvMediaError.invalid("Export ranges must be ordered and non-overlapping")
            }
            previousEnd = range.end
        }

        let asset = AVURLAsset(url: URL(fileURLWithPath: args.inputPath))
        let composition = AVMutableComposition()
        let sourceVideo = try await asset.loadTracks(withMediaType: .video).first
        let sourceAudio = try await asset.loadTracks(withMediaType: .audio).first
        let compositionVideo = sourceVideo.flatMap { _ in
            composition.addMutableTrack(withMediaType: .video, preferredTrackID: kCMPersistentTrackID_Invalid)
        }
        let compositionAudio = sourceAudio.flatMap { _ in
            composition.addMutableTrack(withMediaType: .audio, preferredTrackID: kCMPersistentTrackID_Invalid)
        }
        if let sourceVideo, let compositionVideo {
            compositionVideo.preferredTransform = try await sourceVideo.load(.preferredTransform)
        }
        if args.mediaKind == "video" && sourceVideo == nil {
            throw AvMediaError.invalid("Video track is missing")
        }
        if sourceAudio == nil && sourceVideo == nil {
            throw AvMediaError.invalid("Media has no exportable tracks")
        }

        var cursor = CMTime.zero
        for range in args.keepRanges {
            let start = CMTime(seconds: range.start, preferredTimescale: 600)
            let duration = CMTime(seconds: range.end - range.start, preferredTimescale: 600)
            let timeRange = CMTimeRange(start: start, duration: duration)
            if let sourceVideo, let compositionVideo {
                try compositionVideo.insertTimeRange(timeRange, of: sourceVideo, at: cursor)
            }
            if let sourceAudio, let compositionAudio {
                try compositionAudio.insertTimeRange(timeRange, of: sourceAudio, at: cursor)
            }
            cursor = cursor + duration
        }

        guard let exporter = AVAssetExportSession(
            asset: composition,
            presetName: AVAssetExportPresetHighestQuality
        ) else {
            throw AvMediaError.failed("AVFoundation cannot create an export session")
        }
        job.attach(exporter: exporter)
        let destination = URL(fileURLWithPath: args.destination)
        let expectedExtension = args.mediaKind == "audio" ? "m4a" : "mp4"
        guard destination.pathExtension.lowercased() == expectedExtension else {
            throw AvMediaError.invalid("Export destination must use .\(expectedExtension)")
        }
        let hasSecurityScope = destination.startAccessingSecurityScopedResource()
        defer {
            if hasSecurityScope { destination.stopAccessingSecurityScopedResource() }
        }
        let temporary = destination
            .deletingLastPathComponent()
            .appendingPathComponent(".\(UUID().uuidString).tmp.\(destination.pathExtension)")
        try? FileManager.default.removeItem(at: temporary)
        exporter.outputURL = temporary
        exporter.outputFileType = args.mediaKind == "audio" ? .m4a : .mp4
        exporter.shouldOptimizeForNetworkUse = args.mediaKind == "video"

        let progressTask = Task {
            while !Task.isCancelled {
                onProgress(Double(exporter.progress) * 0.97, "export", "Rendering edited media")
                try? await Task.sleep(nanoseconds: 150_000_000)
            }
        }
        await withCheckedContinuation { (continuation: CheckedContinuation<Void, Never>) in
            exporter.exportAsynchronously { continuation.resume() }
        }
        progressTask.cancel()

        if job.isCancelled || exporter.status == .cancelled {
            try? FileManager.default.removeItem(at: temporary)
            throw AvMediaError.cancelled
        }
        guard exporter.status == .completed else {
            try? FileManager.default.removeItem(at: temporary)
            throw AvMediaError.failed(exporter.error?.localizedDescription ?? "Media export failed")
        }
        try replaceFile(temporary, at: destination)
        let attributes = try FileManager.default.attributesOfItem(atPath: destination.path)
        let size = (attributes[.size] as? NSNumber)?.uint64Value ?? 0
        return MediaExportResult(destination: destination.path, byteLength: size)
    }

    private static func replaceFile(_ source: URL, at destination: URL) throws {
        let backup = destination
            .deletingLastPathComponent()
            .appendingPathComponent(".\(destination.lastPathComponent).backup")
        try? FileManager.default.removeItem(at: backup)
        let hadDestination = FileManager.default.fileExists(atPath: destination.path)
        if hadDestination {
            try FileManager.default.moveItem(at: destination, to: backup)
        }
        do {
            try FileManager.default.moveItem(at: source, to: destination)
            try? FileManager.default.removeItem(at: backup)
        } catch {
            if hadDestination && FileManager.default.fileExists(atPath: backup.path) {
                try? FileManager.default.moveItem(at: backup, to: destination)
            }
            throw error
        }
    }

    private static func wavHeader(dataBytes: UInt32, sampleRate: UInt32) -> Data {
        var data = Data()
        func append<T>(_ value: T) {
            var littleEndian = value
            withUnsafeBytes(of: &littleEndian) { data.append(contentsOf: $0) }
        }
        data.append("RIFF".data(using: .ascii)!)
        append((36 &+ dataBytes).littleEndian)
        data.append("WAVEfmt ".data(using: .ascii)!)
        append(UInt32(16).littleEndian)
        append(UInt16(1).littleEndian)
        append(UInt16(1).littleEndian)
        append(sampleRate.littleEndian)
        append((sampleRate * 2).littleEndian)
        append(UInt16(2).littleEndian)
        append(UInt16(16).littleEndian)
        data.append("data".data(using: .ascii)!)
        append(dataBytes.littleEndian)
        return data
    }

    static func atomicWrite(_ data: Data, to destination: URL) throws {
        let temporary = destination
            .deletingLastPathComponent()
            .appendingPathComponent(".\(UUID().uuidString).tmp")
        try data.write(to: temporary, options: .atomic)
        try? FileManager.default.removeItem(at: destination)
        try FileManager.default.moveItem(at: temporary, to: destination)
    }
}
