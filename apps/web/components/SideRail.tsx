"use client";

import { Captions, FolderOpen, Image, Layers, Shapes, Sparkles } from "lucide-react";

const items = [
  { icon: FolderOpen, label: "Project" },
  { icon: Sparkles, label: "AI Tools" },
  { icon: Layers, label: "Layers" },
  { icon: Shapes, label: "Elements" },
  { icon: Captions, label: "Captions" },
  { icon: Image, label: "Stock" },
];

/** Decorative right-hand tool rail (matches the reference layout; tools are future work). */
export default function SideRail() {
  return (
    <nav className="flex w-16 shrink-0 flex-col items-center gap-1 border-l border-zinc-200 bg-white py-3">
      {items.map(({ icon: Icon, label }) => (
        <button
          key={label}
          title={`${label} — coming soon`}
          className="flex w-14 cursor-default flex-col items-center gap-1 rounded-lg px-1 py-2 text-zinc-400 transition hover:bg-zinc-50 hover:text-zinc-600"
        >
          <Icon size={17} strokeWidth={1.75} />
          <span className="text-[10px] leading-none">{label}</span>
        </button>
      ))}
    </nav>
  );
}
