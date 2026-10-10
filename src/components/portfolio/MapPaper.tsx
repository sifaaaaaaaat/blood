"use client";

import React, { useMemo } from "react";
import type { MapLayout } from "@/lib/mapLayout";

/* ============================================================================
 * MAP PAPER — the folded paper-city sheet the journey travels across.
 *
 * Recreates the reference animation's map: a white paper sheet with rounded
 * corners and a soft shadow, printed with pastel cartography — soft-yellow
 * arterials with white casings, a pale blue river with ponds, green parks and
 * warm-grey city blocks. Everything is generated deterministically from a
 * fixed seed inside the WORLD's coordinate space, so it pans under the camera
 * with the route and never shifts between renders.
 *
 * Layers (paint order): blocks → parks → water → road casings → roads →
 * arterials → route is drawn separately by MapRoute on top.
 * ========================================================================== */

/** Deterministic PRNG (same family as mapLayout's). */
function mulberry32(seed: number) {
  let a = seed >>> 0;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

type Rect = { x: number; y: number; w: number; h: number; r: number };

type CityPlan = {
  blocks: Rect[];
  parks: Rect[];
  ponds: { cx: number; cy: number; rx: number; ry: number }[];
  minor: string[]; // white streets (casing under)
  major: string[]; // soft-yellow arterials (casing under)
  river: string; // one wide meandering river path
};

/** Build the whole city plan once per world size. The river runs roughly
 *  top-to-bottom meandering like the reference; arterials cross it; parks and
 *  blocks fill the space between roads. */
function buildCityPlan(w: number, h: number): CityPlan {
  const rnd = mulberry32(20260927);
  const blocks: Rect[] = [];
  const parks: Rect[] = [];
  const ponds: CityPlan["ponds"] = [];
  const minor: string[] = [];
  const major: string[] = [];

  /* --- the river: a gentle S-meander top → bottom --- */
  const riverPts: { x: number; y: number }[] = [];
  const bendCount = Math.max(3, Math.round(h / 700));
  for (let i = 0; i <= bendCount; i++) {
    riverPts.push({
      x: w * (0.52 + Math.sin(i * 1.9) * 0.13 + (rnd() - 0.5) * 0.04),
      y: (h / bendCount) * i,
    });
  }
  // Catmull-Rom-lite: quadratic smoothing through midpoints.
  let river = `M ${riverPts[0].x.toFixed(1)} ${riverPts[0].y.toFixed(1)}`;
  for (let i = 1; i < riverPts.length - 1; i++) {
    const a = riverPts[i];
    const b = riverPts[i + 1];
    const mx = (a.x + b.x) / 2;
    const my = (a.y + b.y) / 2;
    river += ` Q ${a.x.toFixed(1)} ${a.y.toFixed(1)}, ${mx.toFixed(1)} ${my.toFixed(1)}`;
  }
  river += ` T ${riverPts[riverPts.length - 1].x.toFixed(1)} ${riverPts[riverPts.length - 1].y.toFixed(1)}`;

  /* --- arterial roads: wide arcs crossing the world --- */
  const arterials = Math.max(3, Math.round(h / 620));
  for (let i = 0; i < arterials; i++) {
    const y0 = (h / (arterials + 1)) * (i + 1) + (rnd() - 0.5) * 120;
    const dip = (rnd() - 0.5) * 260;
    major.push(
      `M ${-80} ${y0.toFixed(1)} C ${(w * 0.3).toFixed(1)} ${(y0 + dip).toFixed(1)}, ${(w * 0.7).toFixed(1)} ${(y0 - dip).toFixed(1)}, ${(w + 80).toFixed(1)} ${(y0 + (rnd() - 0.5) * 100).toFixed(1)}`
    );
  }
  // A couple of vertical connectors.
  for (let i = 0; i < 2; i++) {
    const x0 = w * (0.24 + i * 0.5) + (rnd() - 0.5) * 60;
    major.push(`M ${x0.toFixed(1)} ${-60} C ${(x0 - 130).toFixed(1)} ${(h * 0.35).toFixed(1)}, ${(x0 + 130).toFixed(1)} ${(h * 0.65).toFixed(1)}, ${x0.toFixed(1)} ${h + 60}`);
  }

  /* --- minor street grid: fine white lattice, denser near center --- */
  const cols = Math.round(w / 105);
  const rows = Math.round(h / 150);
  for (let i = 0; i <= cols; i++) {
    const x = (w / cols) * i + (rnd() - 0.5) * 26;
    const sway = (rnd() - 0.5) * 90;
    minor.push(`M ${x.toFixed(1)} ${-40} C ${(x + sway).toFixed(1)} ${(h * 0.33).toFixed(1)}, ${(x - sway).toFixed(1)} ${(h * 0.66).toFixed(1)}, ${x.toFixed(1)} ${h + 40}`);
  }
  for (let i = 0; i <= rows; i++) {
    const y = (h / rows) * i + (rnd() - 0.5) * 30;
    const sway = (rnd() - 0.5) * 70;
    minor.push(`M ${-40} ${y.toFixed(1)} C ${(w * 0.33).toFixed(1)} ${(y + sway).toFixed(1)}, ${(w * 0.66).toFixed(1)} ${(y - sway).toFixed(1)}, ${(w + 40).toFixed(1)} ${y.toFixed(1)}`);
  }

  /* --- parks + ponds: sprinkled on the sheet --- */
  const parkCount = Math.max(6, Math.round((w * h) / 620000));
  for (let i = 0; i < parkCount; i++) {
    const pw = 90 + rnd() * 190;
    const ph = 70 + rnd() * 150;
    parks.push({
      x: 60 + rnd() * (w - 120 - pw),
      y: 60 + rnd() * (h - 120 - ph),
      w: pw,
      h: ph,
      r: 26 + rnd() * 34,
    });
  }
  const pondCount = Math.max(5, Math.round((w * h) / 520000));
  for (let i = 0; i < pondCount; i++) {
    ponds.push({
      cx: 80 + rnd() * (w - 160),
      cy: 80 + rnd() * (h - 160),
      rx: 26 + rnd() * 60,
      ry: 18 + rnd() * 40,
    });
  }

  /* --- city blocks: fill the grid with warm-grey rounded rectangles --- */
  const cellW = w / cols;
  const cellH = h / rows;
  for (let c = 0; c < cols; c++) {
    for (let r = 0; r < rows; r++) {
      if (rnd() < 0.22) continue; // leave gaps (plazas)
      const inset = 14 + rnd() * 16;
      blocks.push({
        x: cellW * c + inset,
        y: cellH * r + inset,
        w: Math.max(10, cellW - inset * 2),
        h: Math.max(10, cellH - inset * 2),
        r: 7 + rnd() * 9,
      });
    }
  }

  return { blocks, parks, ponds, minor, major, river };
}

export default function MapPaper({ layout }: { layout: MapLayout }) {
  const plan = useMemo(
    () => buildCityPlan(layout.world.w, layout.world.h),
    [layout.world.w, layout.world.h]
  );

  return (
    <div
      className="pointer-events-none absolute"
      aria-hidden
      style={{
        left: 0,
        top: 0,
        width: layout.world.w,
        height: layout.world.h,
      }}
    >
      {/* THE SHEET — white folded paper with soft shadow, floating on the
          warm-white page (the white margin "around the map"). */}
      <div
        className="absolute rounded-[34px]"
        style={{
          inset: 90,
          background:
            "linear-gradient(155deg, #FFFFFF 0%, #FDFBF6 55%, #F7F3EA 100%)",
          boxShadow:
            "0 40px 90px rgba(96,78,45,0.16), 0 12px 34px rgba(96,78,45,0.10), inset 0 0 0 1px rgba(120,98,70,0.06)",
        }}
      >
        {/* subtle fold creases, like the reference's crumpled sheet */}
        <div
          className="absolute inset-0 rounded-[34px] opacity-[0.5]"
          style={{
            background:
              "repeating-linear-gradient(94deg, rgba(120,98,70,0) 0 340px, rgba(120,98,70,0.045) 340px 344px, rgba(120,98,70,0) 344px 700px)",
          }}
        />
      </div>

      {/* CARTOGRAPHY — one SVG clipped to the sheet */}
      <svg
        className="absolute inset-0"
        width={layout.world.w}
        height={layout.world.h}
        viewBox={`0 0 ${layout.world.w} ${layout.world.h}`}
        fill="none"
        aria-hidden
      >
        <defs>
          <clipPath id="paperClip">
            <rect x={90} y={90} width={layout.world.w - 180} height={layout.world.h - 180} rx={34} />
          </clipPath>
        </defs>

        <g clipPath="url(#paperClip)">
          {/* city blocks */}
          {plan.blocks.map((b, i) => (
            <rect
              key={`b${i}`}
              x={b.x}
              y={b.y}
              width={b.w}
              height={b.h}
              rx={b.r}
              fill="#EDE9E0"
            />
          ))}

          {/* parks */}
          {plan.parks.map((p, i) => (
            <rect
              key={`p${i}`}
              x={p.x}
              y={p.y}
              width={p.w}
              height={p.h}
              rx={p.r}
              fill="#DDEBD3"
            />
          ))}

          {/* ponds + river (white casing first, then water) */}
          {plan.ponds.map((o, i) => (
            <ellipse
              key={`o${i}`}
              cx={o.cx}
              cy={o.cy}
              rx={o.rx + 5}
              ry={o.ry + 5}
              fill="#FFFFFF"
              opacity={0.9}
            />
          ))}
          {plan.ponds.map((o, i) => (
            <ellipse
              key={`ow${i}`}
              cx={o.cx}
              cy={o.cy}
              rx={o.rx}
              ry={o.ry}
              fill="#C4E1F5"
            />
          ))}
          <path d={plan.river} stroke="#FFFFFF" strokeWidth={64} strokeLinecap="round" opacity={0.9} />
          <path d={plan.river} stroke="#C4E1F5" strokeWidth={52} strokeLinecap="round" />

          {/* minor streets: white on the printed background */}
          {plan.minor.map((d, i) => (
            <path key={`m${i}`} d={d} stroke="#FFFFFF" strokeWidth={9} strokeLinecap="round" opacity={0.95} />
          ))}

          {/* arterials: white casing + soft yellow fill, like the reference */}
          {plan.major.map((d, i) => (
            <path key={`M${i}`} d={d} stroke="#FFFFFF" strokeWidth={26} strokeLinecap="round" opacity={0.95} />
          ))}
          {plan.major.map((d, i) => (
            <path key={`Ma${i}`} d={d} stroke="#F9E3AE" strokeWidth={17} strokeLinecap="round" />
          ))}

          {/* few road labels-free accents: tiny district dots */}
          {plan.parks.slice(0, 5).map((p, i) => (
            <circle
              key={`d${i}`}
              cx={p.x + p.w / 2}
              cy={p.y + p.h / 2}
              r={4}
              fill="#A9CD97"
              opacity={0.8}
            />
          ))}
        </g>
      </svg>
    </div>
  );
}
