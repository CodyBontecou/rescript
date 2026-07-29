import Foundation
import Tauri

struct TranscriptionJobIdArgs: Decodable {
    let jobId: String
}

struct NativeTranscriptionProgress: Codable {
    let jobId: String
    let kind: String
    var status: String
    var phase: String
    var message: String
    var ratio: Double?
}

struct NativeTranscriptionJournal: Codable {
    var progress: NativeTranscriptionProgress
    var words: [TranscribedWord]?
}

@available(iOS 17.0, *)
final class TranscriptionPlugin: Plugin {
    private let lock = NSLock()
    private var jobs: [String: MobileTranscriptionJob] = [:]
    private var journals: [String: NativeTranscriptionJournal] = [:]

    @objc public func start(_ invoke: Invoke) throws {
        let args = try invoke.parseArgs(StartArgs.self)
        let id = "ios-transcription-\(UUID().uuidString.lowercased())"
        let job = MobileTranscriptionJob(id: id)
        install(job: job)
        invoke.resolve(["jobId": id])

        let task = Task.detached { [weak self, job] in
            guard let self else { return }
            self.update(
                jobId: id,
                status: "running",
                phase: "model",
                message: "Checking offline model",
                ratio: 0.01
            )
            do {
                let words = try await NativeTranscriptionService.transcribe(args, job: job) {
                    [weak self] ratio, phase, message in
                    self?.update(
                        jobId: id,
                        status: "running",
                        phase: phase,
                        message: message,
                        ratio: ratio
                    )
                }
                self.complete(jobId: id, words: words)
            } catch is CancellationError {
                self.update(
                    jobId: id,
                    status: "cancelled",
                    phase: "cancelled",
                    message: "Transcription cancelled",
                    ratio: nil
                )
            } catch NativeTranscriptionError.cancelled {
                self.update(
                    jobId: id,
                    status: "cancelled",
                    phase: "cancelled",
                    message: "Transcription cancelled",
                    ratio: nil
                )
            } catch {
                self.update(
                    jobId: id,
                    status: "failed",
                    phase: "failed",
                    message: error.localizedDescription,
                    ratio: nil
                )
            }
            self.removeActiveJob(id)
        }
        job.attach(task: task)
    }

    @objc public func snapshot(_ invoke: Invoke) throws {
        let args = try invoke.parseArgs(TranscriptionJobIdArgs.self)
        invoke.resolve(snapshotJournal(args.jobId)?.progress as NativeTranscriptionProgress?)
    }

    @objc public func cancel(_ invoke: Invoke) throws {
        let args = try invoke.parseArgs(TranscriptionJobIdArgs.self)
        lock.lock()
        let job = jobs[args.jobId]
        lock.unlock()
        job?.cancel()
        invoke.resolve()
    }

    @objc public func result(_ invoke: Invoke) throws {
        let args = try invoke.parseArgs(TranscriptionJobIdArgs.self)
        invoke.resolve(snapshotJournal(args.jobId)?.words as [TranscribedWord]?)
    }

    @objc public func listModels(_ invoke: Invoke) throws {
        invoke.resolve(NativeTranscriptionService.listModels())
    }

    @objc public func removeModel(_ invoke: Invoke) throws {
        let args = try invoke.parseArgs(RemoveModelArgs.self)
        try NativeTranscriptionService.removeModel(args.model)
        invoke.resolve()
    }

    private func install(job: MobileTranscriptionJob) {
        let journal = NativeTranscriptionJournal(
            progress: NativeTranscriptionProgress(
                jobId: job.id,
                kind: "transcription",
                status: "queued",
                phase: "queued",
                message: "Queued",
                ratio: 0
            ),
            words: nil
        )
        lock.lock()
        jobs[job.id] = job
        journals[job.id] = journal
        lock.unlock()
        job.beginBackgroundExecution()
        persist(journal)
        emit(journal.progress)
    }

    private func update(
        jobId: String,
        status: String,
        phase: String,
        message: String,
        ratio: Double?
    ) {
        lock.lock()
        guard var journal = journals[jobId] ?? loadJournal(jobId) else {
            lock.unlock()
            return
        }
        journal.progress.status = status
        journal.progress.phase = phase
        journal.progress.message = message
        journal.progress.ratio = ratio.map { min(1, max(0, $0)) }
        journals[jobId] = journal
        lock.unlock()
        persist(journal)
        emit(journal.progress)
    }

    private func complete(jobId: String, words: [TranscribedWord]) {
        lock.lock()
        guard var journal = journals[jobId] else {
            lock.unlock()
            return
        }
        journal.words = words
        journal.progress.status = "completed"
        journal.progress.phase = "completed"
        journal.progress.message = "Completed"
        journal.progress.ratio = 1
        journals[jobId] = journal
        lock.unlock()
        persist(journal)
        emit(journal.progress)
    }

    private func snapshotJournal(_ jobId: String) -> NativeTranscriptionJournal? {
        lock.lock()
        if let journal = journals[jobId] {
            lock.unlock()
            return journal
        }
        lock.unlock()

        guard var journal = loadJournal(jobId) else { return nil }
        if journal.progress.status == "queued" || journal.progress.status == "running" {
            journal.progress.status = "failed"
            journal.progress.phase = "interrupted"
            journal.progress.message = "Job was interrupted by application restart"
            journal.progress.ratio = nil
            persist(journal)
        }
        lock.lock()
        journals[jobId] = journal
        lock.unlock()
        return journal
    }

    private func removeActiveJob(_ jobId: String) {
        lock.lock()
        let job = jobs.removeValue(forKey: jobId)
        lock.unlock()
        job?.finishBackgroundExecution()
    }

    private func emit(_ progress: NativeTranscriptionProgress) {
        try? trigger("jobProgress", data: progress)
    }

    private func journalsDirectory() -> URL {
        let applicationSupport = FileManager.default.urls(
            for: .applicationSupportDirectory,
            in: .userDomainMask
        ).first!
        let directory = applicationSupport.appendingPathComponent(
            "transcription-jobs",
            isDirectory: true
        )
        try? FileManager.default.createDirectory(
            at: directory,
            withIntermediateDirectories: true
        )
        return directory
    }

    private func journalURL(_ jobId: String) -> URL {
        journalsDirectory().appendingPathComponent("\(jobId).json")
    }

    private func persist(_ journal: NativeTranscriptionJournal) {
        guard let data = try? JSONEncoder().encode(journal) else { return }
        try? NativeTranscriptionService.atomicWrite(
            data,
            to: journalURL(journal.progress.jobId)
        )
    }

    private func loadJournal(_ jobId: String) -> NativeTranscriptionJournal? {
        guard jobId.hasPrefix("ios-transcription-"),
              let data = try? Data(contentsOf: journalURL(jobId)) else {
            return nil
        }
        return try? JSONDecoder().decode(NativeTranscriptionJournal.self, from: data)
    }
}

@_cdecl("init_plugin_transcription")
@available(iOS 17.0, *)
func initTranscriptionPlugin() -> Plugin {
    TranscriptionPlugin()
}
