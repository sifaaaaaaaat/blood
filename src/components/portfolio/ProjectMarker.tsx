"use client";

import React from "react";

/* A map pin straight out of the reference animation: glossy blue teardrop
 * (inactive/visited) that swells into the big red "you are here" pin with a
 * red target ripple when active — like dropping a pin in a real maps app. */
export default function ProjectMarker({
  x,
  y,
  active,
  visited,
  approach,
  onClick,
  label,
}: {
  x: number;
  y: number;
  active: boolean;
  visited: boolean;
  approach: number;
  onClick: () => void;
  label: string;
}) {
  const pinColor = active ? "#E23B2E" : "#3E8ED0";
  const pinDark = active ? "#B72B21" : "#2F6FA8";

  return (
    <div
      className="pointer-events-none absolute z-30"
      style={{
        left: x,
        top: y,
        transform: "translate(-50%, -92%)",
        transition: "opacity 0.5s ease",
        opacity: 0.35 + approach * 0.65,
      }}
    >
      <button
        onClick={onClick}
        aria-label={`Open project: ${label}`}
        className="pointer-events-auto relative block cursor-pointer outline-none"
        style={{ width: 44, height: 56 }}
      >
        {/* ground target rings */}
        <span
          className="marker-ring absolute left-1/2 top-full -translate-x-1/2 -translate-y-1/2 rounded-full border"
          style={{
            width: active ? 56 : 40,
            height: active ? 56 : 40,
            borderColor: active ? "rgba(226,59,46,0.7)" : "rgba(62,142,208,0.4)",
            opacity: active ? 0.9 : 0.35 + approach * 0.3,
            boxShadow: active ? "0 0 24px rgba(226,59,46,0.3)" : "none",
          }}
        />
        {/* expanding ripple while active — the red target in the video */}
        {active && (
          <span
            className="marker-pulse absolute left-1/2 top-full rounded-full border border-red-500/70"
            style={{ width: 56, height: 56 }}
          />
        )}

        {/* the pin itself */}
        <span
          className="marker-pin absolute left-1/2 top-0 -translate-x-1/2"
          style={
            {
              width: active ? 30 : 23,
              height: active ? 37 : 28,
              background: `linear-gradient(135deg, ${pinColor} 0%, ${pinDark} 100%)`,
              transition:
                "width 0.45s cubic-bezier(0.34,1.4,0.64,1), height 0.45s cubic-bezier(0.34,1.4,0.64,1), background 0.45s ease",
              opacity: visited && !active ? 0.85 : 1,
              "--pin-shine": "rgba(255,255,255,0.55)",
            } as React.CSSProperties
          }
        >
          {/* glossy highlight dot — the light reflection on 3D pins */}
          <span
            className="absolute rounded-full"
            style={{
              left: "22%",
              top: "14%",
              width: "26%",
              height: "20%",
              background:
                "radial-gradient(ellipse at center, rgba(255,255,255,0.85) 0%, rgba(255,255,255,0) 70%)",
            }}
          />
        </span>
      </button>
    </div>
  );
}
