import type { ProjectSummary, TranscriptionModel } from "@rescript/core";
import {
  AudioLines,
  FolderOpen,
  LockKeyhole,
  MonitorSmartphone,
  Scissors,
  Trash2,
} from "lucide-react";

interface PlatformInfo {
  os: string;
  arch: string;
  mobile: boolean;
}

export default function HomeScreen({
  platform,
  projects,
  model,
  busy,
  error,
  onModelChange,
  onChooseMedia,
  onOpenProject,
  onRemoveProject,
}: {
  platform: PlatformInfo | null;
  projects: readonly ProjectSummary[];
  model: TranscriptionModel;
  busy: boolean;
  error: string | null;
  onModelChange: (model: TranscriptionModel) => void;
  onChooseMedia: () => void;
  onOpenProject: (project: ProjectSummary) => void;
  onRemoveProject: (project: ProjectSummary) => void;
}) {
  return (
    <main className="shell">
      <header className="titlebar" data-tauri-drag-region>
        <div className="brand" data-tauri-drag-region>
          <span className="brand-mark">R</span>
          <span>Rescript</span>
        </div>
        <span className="platform-pill">
          {platform
            ? `${platform.os} · ${platform.arch}${platform.mobile ? " · mobile" : ""}`
            : "Connecting…"}
        </span>
      </header>

      <section className="hero">
        <div className="hero-copy">
          <p className="eyebrow">PRIVATE, ON-DEVICE EDITING</p>
          <h1>Edit the words.<br />Rescript the video.</h1>
          <p className="lede">
            Import audio or video, transcribe it locally, and cut the recording by editing its transcript. Your source media stays on this device.
          </p>
          <div className="editor-actions">
            <button
              className="primary-action"
              type="button"
              onClick={onChooseMedia}
              disabled={busy}
            >
              <FolderOpen size={19} />
              {busy ? "Opening project…" : "Choose media"}
            </button>
            <select
              className="model-choice"
              value={model}
              onChange={(event) =>
                onModelChange(event.target.value as TranscriptionModel)
              }
              disabled={busy}
              aria-label="Default offline transcription model"
            >
              <option value="parakeet-v2">Parakeet v2 · English · Default · ~465 MB</option>
              <option value="parakeet-v3">Parakeet v3 · Multilingual · ~465 MB</option>
              <option value="base">Whisper Base · 148 MB</option>
              <option value="small">Whisper Small · 488 MB</option>
            </select>
          </div>
          {error ? <p className="error">{error}</p> : null}
        </div>

        <div className="workflow-card" aria-label="Rescript workflow">
          <div className="waveform" aria-hidden="true">
            {[13, 30, 22, 47, 34, 62, 38, 72, 49, 26, 56, 41, 68, 31, 18, 42].map((height, index) => (
              <span key={index} style={{ height }} />
            ))}
          </div>
          <div className="transcript-preview">
            <span>We should keep the opening,</span>
            <del> um, maybe trim this part, </del>
            <span>and land on the conclusion.</span>
          </div>
          <div className="clip-row">
            <span>Intro</span><span className="cut">Removed</span><span>Conclusion</span>
          </div>
        </div>
      </section>

      {projects.length > 0 ? (
        <section className="recent-projects" aria-label="Recent projects">
          <div className="section-heading">
            <p className="eyebrow">RECENT PROJECTS</p>
            <span>{projects.length} stored locally</span>
          </div>
          <div className="recent-row">
            {projects.slice(0, 8).map((project) => (
              <div key={project.id} className="project-card-wrap">
                <button type="button" className="project-card" onClick={() => onOpenProject(project)}>
                  <span>{project.mediaKind === "audio" ? "Audio" : "Video"}</span>
                  <strong>{project.name}</strong>
                  <small>
                    {project.duration > 0 ? `${Math.round(project.duration)} sec · ` : ""}
                    {new Date(project.updatedAt).toLocaleDateString()}
                  </small>
                </button>
                <button
                  type="button"
                  className="project-delete"
                  onClick={() => onRemoveProject(project)}
                  aria-label={`Delete ${project.name}`}
                >
                  <Trash2 size={14} />
                </button>
              </div>
            ))}
          </div>
        </section>
      ) : null}

      <section className="feature-grid">
        <article><Scissors size={20} /><div><h2>Transcript editing</h2><p>Cut, correct, split, trim, and assign speakers.</p></div></article>
        <article><AudioLines size={20} /><div><h2>Native media jobs</h2><p>Decoding, transcription, and export stay outside the webview.</p></div></article>
        <article><LockKeyhole size={20} /><div><h2>Offline by default</h2><p>Projects and models remain in app-controlled storage.</p></div></article>
        <article><MonitorSmartphone size={20} /><div><h2>Mac and iPhone</h2><p>One shared editor with native platform boundaries.</p></div></article>
      </section>
    </main>
  );
}
