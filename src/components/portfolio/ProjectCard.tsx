"use client";

import React from "react";
import Image from "next/image";
import { useRouter } from "next/navigation";
import type { RealProject } from "@/data/realProjects";

/* Compact location-info card, visually anchored to its marker — the place
 * card Google Maps shows when you reach a pin. Re-themed to the light paper
 * map: white card, crisp dark text, blue pin accent; the whole card still
 * opens the project's existing detail page. */
export default function ProjectCard({
  project,
  x,
  y,
  emphasis,
  flip,
}: {
  project: RealProject;
  x: number;
  y: number;
  /** 0 = hidden/receded, 1 = fully active. Drives scale/opacity/translate. */
  emphasis: number;
  flip: boolean;
}) {
  const router = useRouter();
  const visible = emphasis > 0.03;
  if (!visible) return null;

  return (
    <div
      className="absolute z-20"
      style={{
        left: x,
        top: y,
        transform: `translate(${flip ? "-100%" : "0"}, 0) translateY(${(1 - emphasis) * 26}px) scale(${0.86 + emphasis * 0.14})`,
        transformOrigin: flip ? "100% 50%" : "0 50%",
        opacity: Math.min(1, emphasis * 1.35),
        pointerEvents: emphasis > 0.55 ? "auto" : "none",
        transition: "opacity 0.45s ease, transform 0.45s cubic-bezier(0.22,0.61,0.36,1)",
        willChange: "transform, opacity",
      }}
    >
      <button
        onClick={() => router.push(`/project/${project.id}`)}
        aria-label={`Open ${project.title}`}
        className="group block w-[300px] cursor-pointer overflow-hidden rounded-2xl border border-[#D8D2C4] bg-white/97 text-left shadow-[0_22px_54px_rgba(96,78,45,0.28)] backdrop-blur-sm transition-colors duration-300 hover:border-[#B9AE97] sm:w-[330px]"
      >
        <div className="relative h-[170px] w-full overflow-hidden sm:h-[185px]">
          <Image
            src={project.heroImage}
            alt={project.title}
            fill
            sizes="330px"
            loading="lazy"
            className="object-cover transition-transform duration-700 ease-out group-hover:scale-[1.05]"
          />
          <div className="absolute inset-x-0 bottom-0 h-16 bg-gradient-to-t from-white/85 to-transparent" />
          {/* category chip over the photo, like a map place label */}
          <span className="absolute left-3 top-3 rounded-full bg-white/92 px-2.5 py-1 text-[9.5px] font-semibold tracking-[0.14em] text-[#5F4B32] uppercase shadow-sm">
            {project.category}
          </span>
        </div>

        <div className="flex items-end justify-between gap-3 px-4 pb-3.5 pt-3">
          <div className="min-w-0">
            <h3 className="truncate text-[15px] font-semibold leading-snug text-[#232323]">
              {project.title}
            </h3>
            <p className="mt-0.5 flex items-center gap-1.5 truncate text-[12px] text-[#7A7468]">
              {/* tiny map-pin glyph */}
              <svg width="11" height="11" viewBox="0 0 24 24" fill="#E23B2E" aria-hidden className="shrink-0">
                <path d="M12 0C5.4 0 0 5.4 0 12c0 8.2 9.5 17.2 10.9 18.5a1.6 1.6 0 0 0 2.2 0C14.5 29.2 24 20.2 24 12c0-6.6-5.4-12-12-12Zm0 16.8a4.9 4.9 0 1 1 0-9.8 4.9 4.9 0 0 1 0 9.8Z" />
              </svg>
              {project.location || "Dhaka, Bangladesh"}
            </p>
            <p className="mt-1 text-[11px] tracking-wide text-[#8A8478]">
              <span>{project.year}</span>
            </p>
          </div>
          <span className="mb-0.5 flex h-8 w-8 shrink-0 items-center justify-center rounded-full border border-[#D8D2C4] bg-white text-[#E23B2E] transition-all duration-300 group-hover:border-[#E23B2E]/50 group-hover:bg-[#E23B2E]/10">
            <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
              <path strokeLinecap="round" strokeLinejoin="round" d="M5 12h14m0 0l-6-6m6 6l-6 6" />
            </svg>
          </span>
        </div>
      </button>
    </div>
  );
}
