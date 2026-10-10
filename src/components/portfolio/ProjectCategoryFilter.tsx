"use client";

import React from "react";
import { CATEGORIES, type CategoryFilter } from "@/lib/mapLayout";

/* Vertical project-category navigation (top right), paper style: a thin ink
 * line through the dots; the active entry shows a filled blue dot (matching
 * the blue pins) with a red dot reserved by convention for ALL. */
export default function ProjectCategoryFilter({
  active,
  counts,
  onChange,
}: {
  active: CategoryFilter;
  counts: Record<CategoryFilter, number>;
  onChange: (c: CategoryFilter) => void;
}) {
  return (
    <nav
      aria-label="Project categories"
      className="relative flex flex-col gap-[18px] rounded-2xl border border-[#DDD6C6] bg-white/85 px-4 py-4 shadow-[0_14px_36px_rgba(96,78,45,0.14)] backdrop-blur-sm"
    >
      {/* vertical ink line through the dots */}
      <span className="absolute left-[21px] top-5 bottom-5 w-px bg-gradient-to-b from-[#5B9BD5]/60 via-[#5B9BD5]/30 to-[#5B9BD5]/10" />

      {CATEGORIES.map((cat) => {
        const isActive = cat === active;
        const count = counts[cat] ?? 0;
        return (
          <button
            key={cat}
            onClick={() => onChange(cat)}
            className="group relative flex cursor-pointer items-center gap-3 pl-0 text-left"
            aria-pressed={isActive}
          >
            <span
              className="relative z-10 h-[11px] w-[11px] shrink-0 rounded-full border transition-all duration-300"
              style={{
                borderColor: isActive ? "#3E8ED0" : "rgba(95,75,50,0.4)",
                background: isActive ? "#3E8ED0" : "transparent",
                boxShadow: isActive ? "0 0 10px rgba(62,142,208,0.55)" : "none",
              }}
            />
            <span
              className={`text-[10.5px] font-semibold tracking-[0.14em] transition-colors duration-300 ${
                isActive ? "text-[#1F5E96]" : "text-[#7A7468] group-hover:text-[#232323]"
              }`}
            >
              {cat}
              {cat !== "ALL PROJECTS" && count === 0 && (
                <span className="ml-1.5 text-[9px] text-[#B4AC9C]">— 0</span>
              )}
            </span>
          </button>
        );
      })}
    </nav>
  );
}
