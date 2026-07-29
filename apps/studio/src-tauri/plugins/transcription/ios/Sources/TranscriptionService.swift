import FluidAudio
import Foundation
import SpeakerKit
import UIKit
import WhisperKit

struct StartArgs: Decodable {
    let audioPath: String
    let model: String
    let language: String?
}

struct RemoveModelArgs: Decodable {
    let model: String
}

struct TranscribedWord: Codable {
    var id: Int
    let text: String
    let start: Double
    let end: Double
    let speaker: Int
    let deleted: Bool
}

struct NativeModelDescriptor: Codable {
    let model: String
    let label: String
    let byteLength: UInt64
    let availability: String
}

enum NativeTranscriptionError: LocalizedError {
    case invalid(String)
    case failed(String)
    case cancelled

    var errorDescription: String? {
        switch self {
        case .invalid(let message), .failed(let message): return message
        case .cancelled: return "Transcription was cancelled"
        }
    }
}

final class MobileTranscriptionJob {
    let id: String
    private let lock = NSLock()
    private var cancelled = false
    private var task: Task<Void, Never>?
    private var backgroundTask: UIBackgroundTaskIdentifier = .invalid

    init(id: String) {
        self.id = id
    }

    var isCancelled: Bool {
        lock.lock()
        defer { lock.unlock() }
        return cancelled
    }

    func attach(task: Task<Void, Never>) {
        lock.lock()
        self.task = task
        let shouldCancel = cancelled
        lock.unlock()
        if shouldCancel { task.cancel() }
    }

    func beginBackgroundExecution() {
        DispatchQueue.main.async { [weak self] in
            guard let self, self.backgroundTask == .invalid else { return }
            self.backgroundTask = UIApplication.shared.beginBackgroundTask(
                withName: "Rescript transcription"
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
        let task = self.task
        lock.unlock()
        task?.cancel()
    }
}

@available(iOS 17.0, *)
enum NativeTranscriptionService {
    private static let whisperRevision = "97a5bf9bbc74c7d9c12c755d04dea59e672e3808"
    private static let speakerRevision = "86ec9c929b52208b6656eb6a6361ed0d822a1f78"
    private static let diarizationByteLimit: UInt64 = 120 * 1024 * 1024

    static func listModels() -> [NativeModelDescriptor] {
        [
            descriptor(model: "base", label: "Whisper Base", bytes: 147_951_465),
            descriptor(model: "small", label: "Whisper Small", bytes: 487_601_967),
            parakeetDescriptor(
                model: "parakeet-v2",
                label: "Parakeet v2",
                bytes: 464_066_490,
                version: .v2
            ),
            parakeetDescriptor(
                model: "parakeet-v3",
                label: "Parakeet v3",
                bytes: 465_000_000,
                version: .v3
            ),
        ]
    }

    static func removeModel(_ model: String) throws {
        if model == "base" || model == "small" {
            let marker = modelMarker(model)
            if FileManager.default.fileExists(atPath: marker.path) {
                let path = try String(contentsOf: marker, encoding: .utf8)
                try removeIfExists(
                    URL(fileURLWithPath: path.trimmingCharacters(in: .whitespacesAndNewlines))
                )
                try removeIfExists(marker)
            }
            return
        }
        guard let version = parakeetVersion(model) else {
            throw NativeTranscriptionError.invalid("Unknown transcription model")
        }
        try removeIfExists(parakeetModelDirectory(version))
    }

    static func transcribe(
        _ args: StartArgs,
        job: MobileTranscriptionJob,
        onProgress: @escaping @Sendable (Double, String, String) -> Void
    ) async throws -> [TranscribedWord] {
        if parakeetVersion(args.model) != nil {
            return try await transcribeParakeet(args, job: job, onProgress: onProgress)
        }
        guard args.model == "base" || args.model == "small" else {
            throw NativeTranscriptionError.invalid("Unknown transcription model")
        }
        let modelFolder = try await ensureModel(args.model, job: job, onProgress: onProgress)
        try Task.checkCancellation()
        if job.isCancelled { throw NativeTranscriptionError.cancelled }

        onProgress(0.38, "model", "Loading \(args.model) model")
        let pipe = try await WhisperKit(
            modelFolder: modelFolder.path,
            verbose: false,
            load: true,
            download: false
        )
        onProgress(0.40, "audio", "Loading prepared audio")
        let audio = try AudioProcessor.loadAudioAsFloatArray(fromPath: args.audioPath)
        let options = DecodingOptions(
            language: args.language,
            skipSpecialTokens: true,
            wordTimestamps: true,
            chunkingStrategy: .vad
        )
        let results = try await pipe.transcribe(
            audioArray: audio,
            decodeOptions: options
        ) { _ in
            let fraction = pipe.progress.fractionCompleted
            onProgress(0.42 + fraction * 0.42, "transcribe", "Transcribing locally")
            return !job.isCancelled && !Task.isCancelled
        }
        try Task.checkCancellation()
        if job.isCancelled { throw NativeTranscriptionError.cancelled }

        var words = wordsWithoutSpeakers(results)
        let fileSize = ((try? FileManager.default.attributesOfItem(atPath: args.audioPath)[.size]) as? NSNumber)?.uint64Value ?? 0
        if fileSize <= diarizationByteLimit {
            do {
                onProgress(0.85, "diarize", "Detecting speakers on device")
                let speakerBase = modelsDirectory().appendingPathComponent("speakerkit", isDirectory: true)
                let speakerConfig = PyannoteConfig(
                    downloadBase: speakerBase.path,
                    download: true,
                    useBackgroundDownloadSession: true,
                    downloadRevision: speakerRevision,
                    load: false,
                    verbose: false
                )
                let speakerKit = try await SpeakerKit(speakerConfig)
                let diarization = try await speakerKit.diarize(audioArray: audio) { progress in
                    onProgress(
                        0.86 + progress.fractionCompleted * 0.12,
                        "diarize",
                        "Detecting speakers on device"
                    )
                }
                var attributed: [TranscribedWord] = []
                for segments in diarization.addSpeakerInfo(to: results) {
                    for segment in segments {
                        for speakerWord in segment.speakerWords {
                            let timing = speakerWord.wordTiming
                            let word = TranscribedWord(
                                id: 0,
                                text: timing.word.trimmingCharacters(in: .whitespacesAndNewlines),
                                start: Double(timing.start),
                                end: Double(timing.end),
                                speaker: speakerWord.speaker.speakerId ?? 0,
                                deleted: false
                            )
                            if !word.text.isEmpty && word.end > word.start {
                                attributed.append(word)
                            }
                        }
                    }
                }
                if !attributed.isEmpty { words = attributed }
            } catch is CancellationError {
                throw NativeTranscriptionError.cancelled
            } catch {
                // Speaker attribution is best-effort; accurate word timestamps remain usable.
            }
        }

        words.sort { (left: TranscribedWord, right: TranscribedWord) -> Bool in
            if left.start == right.start { return left.end < right.end }
            return left.start < right.start
        }
        for index in words.indices { words[index].id = index }
        guard !words.isEmpty else {
            throw NativeTranscriptionError.failed("Whisper returned an empty transcript")
        }
        return words
    }

    private static func wordsWithoutSpeakers(_ results: [TranscriptionResult]) -> [TranscribedWord] {
        results
            .flatMap(\.allWords)
            .map { word in
                TranscribedWord(
                    id: 0,
                    text: word.word.trimmingCharacters(in: .whitespacesAndNewlines),
                    start: Double(word.start),
                    end: Double(word.end),
                    speaker: 0,
                    deleted: false
                )
            }
            .filter { !$0.text.isEmpty && $0.end > $0.start }
    }

    private static func transcribeParakeet(
        _ args: StartArgs,
        job: MobileTranscriptionJob,
        onProgress: @escaping @Sendable (Double, String, String) -> Void
    ) async throws -> [TranscribedWord] {
        guard let version = parakeetVersion(args.model) else {
            throw NativeTranscriptionError.invalid("Unknown Parakeet model")
        }
        let modelDirectory = parakeetModelDirectory(version)
        let ready = AsrModels.modelsExist(at: modelDirectory, version: version)
        onProgress(
            ready ? 0.34 : 0.02,
            ready ? "model" : "model-download",
            ready ? "Loading Parakeet model" : "Downloading Parakeet model"
        )
        let models = try await AsrModels.downloadAndLoad(
            to: modelDirectory,
            version: version
        )
        try Task.checkCancellation()
        if job.isCancelled { throw NativeTranscriptionError.cancelled }

        onProgress(0.38, "model", "Loading Parakeet model")
        let manager = AsrManager(config: try parakeetConfig(version))
        try await manager.loadModels(models)
        onProgress(0.42, "audio", "Loading prepared audio")
        let audio = try AudioProcessor.loadAudioAsFloatArray(fromPath: args.audioPath)
        var decoderState = TdtDecoderState.make(
            decoderLayers: await manager.decoderLayerCount
        )
        let language: Language?
        if let requested = args.language?.lowercased() {
            guard let parsed = Language(rawValue: requested) else {
                throw NativeTranscriptionError.invalid(
                    "Unsupported Parakeet language: \(requested)"
                )
            }
            language = parsed
        } else {
            language = nil
        }
        let result = try await manager.transcribe(
            audio,
            decoderState: &decoderState,
            language: language
        )
        await manager.cleanup()
        try Task.checkCancellation()
        if job.isCancelled { throw NativeTranscriptionError.cancelled }
        onProgress(0.84, "transcribe", "Transcribing locally with Parakeet")

        var words = parakeetWords(result.tokenTimings ?? [])
        let fileSize = ((try? FileManager.default.attributesOfItem(atPath: args.audioPath)[.size]) as? NSNumber)?.uint64Value ?? 0
        if fileSize <= diarizationByteLimit {
            do {
                words = try await assignSpeakers(
                    to: words,
                    audio: audio,
                    onProgress: onProgress
                )
            } catch is CancellationError {
                throw NativeTranscriptionError.cancelled
            } catch {
                // Speaker attribution is best-effort; preserve Parakeet timings.
            }
        }

        words.sort { (left: TranscribedWord, right: TranscribedWord) -> Bool in
            if left.start == right.start { return left.end < right.end }
            return left.start < right.start
        }
        for index in words.indices { words[index].id = index }
        guard !words.isEmpty else {
            throw NativeTranscriptionError.failed("Parakeet returned an empty transcript")
        }
        return words
    }

    private static func parakeetWords(_ timings: [TokenTiming]) -> [TranscribedWord] {
        var words: [TranscribedWord] = []
        var text = ""
        var start = 0.0
        var end = 0.0

        func flush() {
            let trimmed = text.trimmingCharacters(in: .whitespacesAndNewlines)
            guard !trimmed.isEmpty else { return }
            words.append(TranscribedWord(
                id: words.count,
                text: trimmed,
                start: max(0, start),
                end: max(end, start + 0.01),
                speaker: 0,
                deleted: false
            ))
        }

        for timing in timings {
            let token = timing.token
            guard !token.isEmpty, token != "<blank>", token != "<pad>" else { continue }
            let startsWord = token.hasPrefix("▁") || token.first?.isWhitespace == true
            if startsWord && !text.isEmpty {
                flush()
                text = ""
            }
            let clean = token
                .trimmingCharacters(in: CharacterSet(charactersIn: "▁"))
                .trimmingCharacters(in: .whitespacesAndNewlines)
            if text.isEmpty { start = timing.startTime }
            text += clean
            end = timing.endTime
        }
        flush()
        return words
    }

    private static func assignSpeakers(
        to input: [TranscribedWord],
        audio: [Float],
        onProgress: @escaping @Sendable (Double, String, String) -> Void
    ) async throws -> [TranscribedWord] {
        guard !input.isEmpty else { return input }
        onProgress(0.85, "diarize", "Detecting speakers on device")
        let speakerBase = modelsDirectory().appendingPathComponent("speakerkit", isDirectory: true)
        let speakerConfig = PyannoteConfig(
            downloadBase: speakerBase.path,
            download: true,
            useBackgroundDownloadSession: true,
            downloadRevision: speakerRevision,
            load: false,
            verbose: false
        )
        let speakerKit = try await SpeakerKit(speakerConfig)
        let diarization = try await speakerKit.diarize(audioArray: audio) { progress in
            onProgress(
                0.86 + progress.fractionCompleted * 0.12,
                "diarize",
                "Detecting speakers on device"
            )
        }
        let segments = diarization.segments.filter { $0.speaker.speakerId != nil }
        guard !segments.isEmpty else { return input }

        return input.map { inputWord in
            var word = inputWord
            let midpoint = (word.start + word.end) / 2
            let best = segments.max { left, right in
                func score(_ segment: SpeakerSegment) -> Double {
                    let overlap = max(
                        0,
                        min(word.end, Double(segment.endTime))
                            - max(word.start, Double(segment.startTime))
                    )
                    if overlap > 0 { return 1_000 + overlap }
                    let segmentMid = (Double(segment.startTime) + Double(segment.endTime)) / 2
                    return -abs(midpoint - segmentMid)
                }
                return score(left) < score(right)
            }
            word = TranscribedWord(
                id: word.id,
                text: word.text,
                start: word.start,
                end: word.end,
                speaker: best?.speaker.speakerId ?? 0,
                deleted: false
            )
            return word
        }
    }

    private static func ensureModel(
        _ model: String,
        job: MobileTranscriptionJob,
        onProgress: @escaping @Sendable (Double, String, String) -> Void
    ) async throws -> URL {
        let marker = modelMarker(model)
        if let path = try? String(contentsOf: marker, encoding: .utf8) {
            let folder = URL(fileURLWithPath: path.trimmingCharacters(in: .whitespacesAndNewlines))
            if FileManager.default.fileExists(atPath: folder.path) { return folder }
        }

        let variant = model == "small" ? "openai_whisper-small" : "openai_whisper-base"
        let hub = HubApiWrapper(
            downloadBase: modelsDirectory(),
            useBackgroundSession: true
        )
        let root = try await hub.snapshot(
            from: .init(id: "argmaxinc/whisperkit-coreml"),
            revision: whisperRevision,
            matching: ["\(variant)/*"]
        ) { progress in
            onProgress(
                progress.fractionCompleted * 0.34,
                "model-download",
                "Downloading Whisper \(model)"
            )
        }
        try Task.checkCancellation()
        if job.isCancelled { throw NativeTranscriptionError.cancelled }
        let folder = root.appendingPathComponent(variant, isDirectory: true)
        guard FileManager.default.fileExists(atPath: folder.path) else {
            throw NativeTranscriptionError.failed("Downloaded model folder is missing")
        }
        try FileManager.default.createDirectory(
            at: marker.deletingLastPathComponent(),
            withIntermediateDirectories: true
        )
        try folder.path.write(to: marker, atomically: true, encoding: .utf8)
        return folder
    }

    private static func parakeetConfig(_ version: AsrModelVersion) throws -> ASRConfig {
        switch version {
        case .v2:
            return ASRConfig(
                tdtConfig: TdtConfig(blankId: 1024),
                encoderHiddenSize: 1024
            )
        case .v3:
            return ASRConfig(
                tdtConfig: TdtConfig(blankId: 8192),
                encoderHiddenSize: 1024,
                melChunkContext: false
            )
        case .tdtCtc110m, .tdtJa:
            throw NativeTranscriptionError.invalid("Unsupported Parakeet model")
        @unknown default:
            throw NativeTranscriptionError.invalid("Unsupported Parakeet model")
        }
    }

    private static func parakeetVersion(_ model: String) -> AsrModelVersion? {
        switch model {
        case "parakeet-v2": return .v2
        case "parakeet-v3": return .v3
        default: return nil
        }
    }

    private static func parakeetModelDirectory(_ version: AsrModelVersion) -> URL {
        let folder: String
        switch version {
        case .v2: folder = "parakeet-tdt-0.6b-v2"
        case .v3: folder = "parakeet-tdt-0.6b-v3"
        case .tdtCtc110m, .tdtJa: folder = "unsupported-parakeet-model"
        @unknown default: folder = "unsupported-parakeet-model"
        }
        let directory = modelsDirectory()
            .deletingLastPathComponent()
            .appendingPathComponent("fluidaudio", isDirectory: true)
            .appendingPathComponent(folder, isDirectory: true)
        try? FileManager.default.createDirectory(
            at: directory.deletingLastPathComponent(),
            withIntermediateDirectories: true
        )
        return directory
    }

    private static func parakeetDescriptor(
        model: String,
        label: String,
        bytes: UInt64,
        version: AsrModelVersion
    ) -> NativeModelDescriptor {
        NativeModelDescriptor(
            model: model,
            label: label,
            byteLength: bytes,
            availability: AsrModels.modelsExist(
                at: parakeetModelDirectory(version),
                version: version
            ) ? "ready" : "missing"
        )
    }

    private static func descriptor(model: String, label: String, bytes: UInt64) -> NativeModelDescriptor {
        let available: Bool
        if let path = try? String(contentsOf: modelMarker(model), encoding: .utf8) {
            available = FileManager.default.fileExists(
                atPath: path.trimmingCharacters(in: .whitespacesAndNewlines)
            )
        } else {
            available = false
        }
        return NativeModelDescriptor(
            model: model,
            label: label,
            byteLength: bytes,
            availability: available ? "ready" : "missing"
        )
    }

    static func modelsDirectory() -> URL {
        let applicationSupport = FileManager.default.urls(
            for: .applicationSupportDirectory,
            in: .userDomainMask
        ).first!
        let directory = applicationSupport
            .appendingPathComponent("models", isDirectory: true)
            .appendingPathComponent("whisperkit", isDirectory: true)
        try? FileManager.default.createDirectory(
            at: directory,
            withIntermediateDirectories: true
        )
        return directory
    }

    private static func modelMarker(_ model: String) -> URL {
        modelsDirectory()
            .appendingPathComponent("markers", isDirectory: true)
            .appendingPathComponent("\(model).path")
    }

    private static func removeIfExists(_ url: URL) throws {
        guard FileManager.default.fileExists(atPath: url.path) else { return }
        try FileManager.default.removeItem(at: url)
    }

    static func atomicWrite(_ data: Data, to destination: URL) throws {
        try FileManager.default.createDirectory(
            at: destination.deletingLastPathComponent(),
            withIntermediateDirectories: true
        )
        let temporary = destination
            .deletingLastPathComponent()
            .appendingPathComponent(".\(UUID().uuidString).tmp")
        try data.write(to: temporary, options: .atomic)
        try? FileManager.default.removeItem(at: destination)
        try FileManager.default.moveItem(at: temporary, to: destination)
    }
}
