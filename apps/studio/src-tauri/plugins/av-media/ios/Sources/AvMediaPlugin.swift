import Foundation
import Tauri

struct JobIdArgs: Decodable {
    let jobId: String
}

struct MobileJobProgress: Codable {
    let jobId: String
    let kind: String
    var status: String
    var phase: String
    var message: String
    var ratio: Double?
}

struct MobileJobJournal: Codable {
    var progress: MobileJobProgress
    var preparedMedia: PreparedMediaResult?
    var mediaExport: MediaExportResult?
}

@available(iOS 16.0, *)
final class AvMediaPlugin: Plugin {
    private let lock = NSLock()
    private var jobs: [String: MobileMediaJob] = [:]
    private var journals: [String: MobileJobJournal] = [:]

    @objc public func startPrepare(_ invoke: Invoke) throws {
        let args = try invoke.parseArgs(PrepareArgs.self)
        let id = "ios-\(UUID().uuidString.lowercased())"
        let job = MobileMediaJob(id: id, kind: "media")
        install(job: job)
        invoke.resolve(["jobId": id])

        Task.detached { [weak self, job] in
            guard let self else { return }
            self.update(
                jobId: id,
                status: "running",
                phase: "decode",
                message: "Preparing native audio",
                ratio: 0.01
            )
            do {
                let result = try await AvMediaService.prepare(args, job: job) {
                    [weak self] ratio, phase, message in
                    self?.update(
                        jobId: id,
                        status: "running",
                        phase: phase,
                        message: message,
                        ratio: ratio
                    )
                }
                self.completePrepare(jobId: id, result: result)
            } catch AvMediaError.cancelled {
                self.update(
                    jobId: id,
                    status: "cancelled",
                    phase: "cancelled",
                    message: "Media preparation cancelled",
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
    }

    @objc public func startExport(_ invoke: Invoke) throws {
        let args = try invoke.parseArgs(ExportArgs.self)
        let id = "ios-\(UUID().uuidString.lowercased())"
        let job = MobileMediaJob(id: id, kind: "export")
        install(job: job)
        invoke.resolve(["jobId": id])

        Task.detached { [weak self, job] in
            guard let self else { return }
            self.update(
                jobId: id,
                status: "running",
                phase: "export",
                message: "Rendering edited media",
                ratio: 0.01
            )
            do {
                let result = try await AvMediaService.export(args, job: job) {
                    [weak self] ratio, phase, message in
                    self?.update(
                        jobId: id,
                        status: "running",
                        phase: phase,
                        message: message,
                        ratio: ratio
                    )
                }
                self.completeExport(jobId: id, result: result)
            } catch AvMediaError.cancelled {
                self.update(
                    jobId: id,
                    status: "cancelled",
                    phase: "cancelled",
                    message: "Export cancelled",
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
    }

    @objc public func snapshot(_ invoke: Invoke) throws {
        let args = try invoke.parseArgs(JobIdArgs.self)
        invoke.resolve(snapshotJournal(args.jobId)?.progress as MobileJobProgress?)
    }

    @objc public func cancel(_ invoke: Invoke) throws {
        let args = try invoke.parseArgs(JobIdArgs.self)
        lock.lock()
        let job = jobs[args.jobId]
        lock.unlock()
        job?.cancel()
        invoke.resolve()
    }

    @objc public func prepareResult(_ invoke: Invoke) throws {
        let args = try invoke.parseArgs(JobIdArgs.self)
        invoke.resolve(snapshotJournal(args.jobId)?.preparedMedia as PreparedMediaResult?)
    }

    @objc public func exportResult(_ invoke: Invoke) throws {
        let args = try invoke.parseArgs(JobIdArgs.self)
        invoke.resolve(snapshotJournal(args.jobId)?.mediaExport as MediaExportResult?)
    }

    private func install(job: MobileMediaJob) {
        let journal = MobileJobJournal(
            progress: MobileJobProgress(
                jobId: job.id,
                kind: job.kind,
                status: "queued",
                phase: "queued",
                message: "Queued",
                ratio: 0
            ),
            preparedMedia: nil,
            mediaExport: nil
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

    private func completePrepare(jobId: String, result: PreparedMediaResult) {
        lock.lock()
        guard var journal = journals[jobId] else {
            lock.unlock()
            return
        }
        journal.preparedMedia = result
        journal.progress.status = "completed"
        journal.progress.phase = "completed"
        journal.progress.message = "Completed"
        journal.progress.ratio = 1
        journals[jobId] = journal
        lock.unlock()
        persist(journal)
        emit(journal.progress)
    }

    private func completeExport(jobId: String, result: MediaExportResult) {
        lock.lock()
        guard var journal = journals[jobId] else {
            lock.unlock()
            return
        }
        journal.mediaExport = result
        journal.progress.status = "completed"
        journal.progress.phase = "completed"
        journal.progress.message = "Completed"
        journal.progress.ratio = 1
        journals[jobId] = journal
        lock.unlock()
        persist(journal)
        emit(journal.progress)
    }

    private func snapshotJournal(_ jobId: String) -> MobileJobJournal? {
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

    private func emit(_ progress: MobileJobProgress) {
        try? trigger("jobProgress", data: progress)
    }

    private func jobsDirectory() -> URL {
        let applicationSupport = FileManager.default.urls(
            for: .applicationSupportDirectory,
            in: .userDomainMask
        ).first!
        let directory = applicationSupport.appendingPathComponent("jobs", isDirectory: true)
        try? FileManager.default.createDirectory(
            at: directory,
            withIntermediateDirectories: true
        )
        return directory
    }

    private func journalURL(_ jobId: String) -> URL {
        jobsDirectory().appendingPathComponent("\(jobId).json")
    }

    private func persist(_ journal: MobileJobJournal) {
        guard let data = try? JSONEncoder().encode(journal) else { return }
        try? AvMediaService.atomicWrite(data, to: journalURL(journal.progress.jobId))
    }

    private func loadJournal(_ jobId: String) -> MobileJobJournal? {
        guard jobId.hasPrefix("ios-"),
              let data = try? Data(contentsOf: journalURL(jobId)) else {
            return nil
        }
        return try? JSONDecoder().decode(MobileJobJournal.self, from: data)
    }
}

@_cdecl("init_plugin_av_media")
@available(iOS 16.0, *)
func initPlugin() -> Plugin {
    AvMediaPlugin()
}
