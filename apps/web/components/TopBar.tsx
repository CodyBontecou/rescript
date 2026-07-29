"use client";

import { Download, Redo2, Undo2 } from "lucide-react";
import { useEditorStore } from "@/lib/store";
import Image from "next/image";
import logo from "@/assets/logo.png";
import GitHubLink from "./GitHubLink";

export default function TopBar() {
  const videoFile = useEditorStore((s) => s.videoFile);
  const status = useEditorStore((s) => s.status);
  const canUndo = useEditorStore((s) => s.past.length > 0);
  const canRedo = useEditorStore((s) => s.future.length > 0);
  const undo = useEditorStore((s) => s.undo);
  const redo = useEditorStore((s) => s.redo);
  const reset = useEditorStore((s) => s.reset);
  const setExportOpen = useEditorStore((s) => s.setExportOpen);

  return (
    <header className="flex h-12 shrink-0 items-center gap-2 border-b border-zinc-100 bg-white px-3">
      <button
        onClick={reset}
        title="Start over"
        className="flex h-7 w-7 cursor-pointer items-center justify-center rounded-lg text-zinc-500 transition hover:bg-zinc-100 hover:text-zinc-800"
      >
        <Image
          src={logo}
          alt="Rescript"
          width={18}
          height={18}
          priority
          className="rounded-sm"
        />
      </button>
      <span className="text-sm font-semibold tracking-tight text-zinc-800">
        Rescript
      </span>

      {videoFile && (
        <div className="pointer-events-none absolute left-1/2 hidden -translate-x-1/2 items-center text-[13px] text-zinc-500 sm:flex">
          {videoFile.name}
        </div>
      )}

      <div className="ml-auto flex items-center gap-1">
        <GitHubLink />
        <button
          onClick={undo}
          disabled={!canUndo}
          title="Undo (⌘Z)"
          className="flex h-8 w-8 items-center justify-center rounded-lg text-zinc-500 transition hover:bg-zinc-100 hover:text-zinc-800 disabled:opacity-30 disabled:hover:bg-transparent"
        >
          <Undo2 size={16} />
        </button>
        <button
          onClick={redo}
          disabled={!canRedo}
          title="Redo (⇧⌘Z)"
          className="flex h-8 w-8 items-center justify-center rounded-lg text-zinc-500 transition hover:bg-zinc-100 hover:text-zinc-800 disabled:opacity-30 disabled:hover:bg-transparent"
        >
          <Redo2 size={16} />
        </button>
        <div className="mx-1 h-5 w-px bg-zinc-200" />
        <button
          onClick={() => setExportOpen(true)}
          disabled={status !== "ready" && status !== "exporting"}
          className="flex h-8 items-center gap-1.5 rounded-full bg-zinc-900 px-4 text-[13px] font-medium text-white transition hover:bg-zinc-700 disabled:cursor-not-allowed disabled:opacity-40"
        >
          <Download size={14} />
          Export
        </button>
      </div>
    </header>
  );
}
