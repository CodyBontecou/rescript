import type { ProjectSummary, TranscriptionModel } from "@rescript/core";
import { FolderOpen, Trash2 } from "lucide-react";

interface PlatformInfo {
  os: string;
  arch: string;
  mobile: boolean;
}

const waveformHeights = [
  18, 34, 22, 46, 31, 58, 40, 70, 49, 28, 55, 38, 64, 33, 21, 45, 61,
  37, 52, 73, 44, 29, 57, 36, 67, 48, 25, 41, 59, 32, 50, 27,
];

function platformLabel(platform: PlatformInfo | null): string {
  if (!platform) return "Connecting…";

  const os =
    platform.os.toLowerCase() === "macos"
      ? "macOS"
      : platform.os.toLowerCase() === "ios"
        ? "iOS"
        : platform.os;

  return `${os} · ${platform.arch}${platform.mobile ? " · mobile" : ""}`;
}

export default function HomeScreen({
  platform,
  projects,
  model,
  speakerDiarizationEnabled,
  busy,
  error,
  onModelChange,
  onSpeakerDiarizationChange,
  onChooseMedia,
  onOpenProject,
  onRemoveProject,
}: {
  platform: PlatformInfo | null;
  projects: readonly ProjectSummary[];
  model: TranscriptionModel;
  speakerDiarizationEnabled: boolean;
  busy: boolean;
  error: string | null;
  onModelChange: (model: TranscriptionModel) => void;
  onSpeakerDiarizationChange: (enabled: boolean) => void;
  onChooseMedia: () => void;
  onOpenProject: (project: ProjectSummary) => void;
  onRemoveProject: (project: ProjectSummary) => void;
}) {
  return (
    <main className="home-shell">
      <header className="home-titlebar" data-tauri-drag-region>
        <div className="home-brand" data-tauri-drag-region>
          <img src="/rescript-logo.png" alt="" />
          <span>Rescript</span>
        </div>
        <span className="home-platform" aria-live="polite">
          {platformLabel(platform)}
        </span>
      </header>

      <section className="home-opening" aria-labelledby="home-title">
        <div className="home-opening-copy">
          <h1 id="home-title">Edit the recording by editing the words.</h1>
          <p>
            Import audio or video, transcribe it on this device, and cut the
            media by changing its transcript. Nothing is uploaded.
          </p>
        </div>

        <div className="home-start">
          <div>
            <h2>Start a project</h2>
            <p>Choose a file and Rescript will prepare a private local copy.</p>
          </div>

          <button
            className="home-primary-action"
            type="button"
            onClick={onChooseMedia}
            disabled={busy}
          >
            <FolderOpen size={17} aria-hidden="true" />
            {busy ? "Opening project…" : "Choose audio or video"}
          </button>

          <label className="home-model-field">
            <span>Transcription model</span>
            <select
              value={model}
              onChange={(event) =>
                onModelChange(event.target.value as TranscriptionModel)
              }
              disabled={busy}
            >
              <option value="parakeet-v2">Parakeet v2 · English · Default · 465 MB</option>
              <option value="parakeet-v3">Parakeet v3 · Multilingual · 465 MB</option>
              <option value="base">Whisper Base · 148 MB</option>
              <option value="small">Whisper Small · 488 MB</option>
            </select>
          </label>

          <label className="home-speaker-field">
            <input
              type="checkbox"
              checked={speakerDiarizationEnabled}
              onChange={(event) =>
                onSpeakerDiarizationChange(event.target.checked)
              }
              disabled={busy}
            />
            <span>
              <strong>Identify speakers</strong>
              <small>Detect and label multiple voices during transcription.</small>
            </span>
          </label>

          <p className="home-start-note">
            Models download once, then remain available offline.
          </p>
          {error ? (
            <p className="home-error" role="alert">
              {error}
            </p>
          ) : null}
        </div>
      </section>

      <figure
        className="home-workflow"
        aria-labelledby="workflow-title"
        aria-describedby="workflow-caption"
      >
        <div className="home-workflow-heading">
          <h2 id="workflow-title">The timeline follows the transcript.</h2>
          <p id="workflow-caption">
            Delete a phrase and the matching media range disappears from the
            final cut.
          </p>
        </div>

        <div className="home-workflow-demo">
          <div className="home-transcript-sample">
            <span className="home-workflow-label">Transcript</span>
            <p>
              We should keep the opening,
              <del> um, maybe trim this part, </del>
              and land on the conclusion.
            </p>
          </div>

          <div className="home-timeline-sample">
            <span className="home-workflow-label">Timeline</span>
            <div className="home-waveform" aria-hidden="true">
              {waveformHeights.map((height, index) => (
                <span
                  key={index}
                  className={index >= 12 && index <= 17 ? "is-cut" : undefined}
                  style={{ height: `${height}%` }}
                />
              ))}
            </div>
            <div className="home-clip-row">
              <span>Opening</span>
              <span className="is-cut">Removed</span>
              <span>Conclusion</span>
            </div>
          </div>
        </div>
      </figure>

      {projects.length > 0 ? (
        <section className="home-recents" aria-labelledby="recent-projects-title">
          <div className="home-section-heading">
            <h2 id="recent-projects-title">Recent projects</h2>
            <p>{projects.length} stored locally</p>
          </div>
          <div className="home-project-list">
            {projects.slice(0, 8).map((project) => (
              <div key={project.id} className="home-project-row">
                <button
                  type="button"
                  className="home-project-open"
                  onClick={() => onOpenProject(project)}
                  disabled={busy}
                >
                  <span className="home-project-kind">
                    {project.mediaKind === "audio" ? "Audio" : "Video"}
                  </span>
                  <strong>{project.name}</strong>
                  <span className="home-project-meta">
                    {project.duration > 0 ? `${Math.round(project.duration)} sec · ` : ""}
                    {new Date(project.updatedAt).toLocaleDateString()}
                  </span>
                </button>
                <button
                  type="button"
                  className="home-project-delete"
                  onClick={() => onRemoveProject(project)}
                  disabled={busy}
                  aria-label={`Delete ${project.name}`}
                >
                  <Trash2 size={15} aria-hidden="true" />
                </button>
              </div>
            ))}
          </div>
        </section>
      ) : null}

      <section className="home-principles" aria-label="Rescript principles">
        <article>
          <h2>Private by design</h2>
          <p>Source media, transcripts, and edits stay on this device.</p>
        </article>
        <article>
          <h2>Native media processing</h2>
          <p>Preparation, transcription, playback, and export run locally.</p>
        </article>
        <article>
          <h2>Built for real edits</h2>
          <p>Cut words, adjust timing, assign speakers, and export the result.</p>
        </article>
      </section>
    </main>
  );
}
