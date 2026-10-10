"use client";

import React from "react";
import type { MapLayout } from "@/lib/mapLayout";

/* The journey route: a single SVG in WORLD coordinates. Re-themed to read as
 * a turn-by-turn route printed on the paper city map — white casing under a
 * warm amber line with a flowing dash, plus per-stop target rings (soft blue
 * for upcoming stops, red for the active one, mirroring the pins). */
export default function MapRoute({
  layout,
  activeIndex,
}: {
  layout: MapLayout;
  activeIndex: number;
}) {
  const { stops, pathD, world } = layout;

  return (
    <svg
      className="pointer-events-none absolute inset-0"
      width={world.w}
      height={world.h}
      viewBox={`0 0 ${world.w} ${world.h}`}
      fill="none"
      aria-hidden
    >
      <defs>
        <linearGradient id="routeAmber" x1="0" y1="0" x2={world.w} y2={world.h} gradientUnits="userSpaceOnUse">
          <stop offset="0" stopColor="#D97B2A" />
          <stop offset="0.35" stopColor="#E8944A" />
          <stop offset="0.7" stopColor="#E8944A" />
          <stop offset="1" stopColor="#C96F24" />
        </linearGradient>
      </defs>

      {/* white casing lifts the route off the printed roads */}
      <path d={pathD} stroke="#FFFFFF" strokeWidth="11" strokeLinecap="round" opacity="0.95" />
      {/* amber route line */}
      <path d={pathD} stroke="url(#routeAmber)" strokeWidth="6.5" strokeLinecap="round" opacity="0.95" />
      {/* flowing dash hinting direction of travel */}
      <path
        d={pathD}
        stroke="#FFFFFF"
        strokeWidth="2.2"
        strokeLinecap="round"
        strokeDasharray="2 26"
        className="route-dash"
        opacity="0.85"
      />

      {/* target rings under each pin — like the red target in the reference */}
      {stops.map((s, i) => {
        const active = i === activeIndex;
        return (
          <ellipse
            key={s.project.id}
            cx={s.pos.x}
            cy={s.pos.y}
            rx={active ? 30 : 22}
            ry={active ? 12 : 8.5}
            stroke={active ? "#E23B2E" : "#5B9BD5"}
            strokeWidth={active ? 2.4 : 1.4}
            opacity={active ? 0.95 : 0.5}
            style={{ transition: "all 0.5s ease" }}
          />
        );
      })}
    </svg>
  );
}
