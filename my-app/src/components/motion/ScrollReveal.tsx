"use client";

import { useEffect, useRef, type ElementType, type ReactNode } from "react";
import gsap from "gsap";
import { ScrollTrigger } from "gsap/ScrollTrigger";

/**
 * Scroll-triggered reveal (GSAP ScrollTrigger, per
 * https://gsap.com/docs/v3/Installation/).
 *
 * Every page section wraps its content once with <ScrollReveal>; sections are
 * hidden until they enter the viewport, then fade/slide in. One animation per
 * wrapper keeps the DOM small; reduced-motion users get the visible page with
 * no animation.
 */
let registered = false;
function registerOnce() {
  if (!registered) {
    gsap.registerPlugin(ScrollTrigger);
    registered = true;
  }
}

export function ScrollReveal({
  children,
  as: Tag = "div",
  /** Extra slide distance in px (positive = from below). */
  y = 32,
  /** Per-element duration in seconds. */
  duration = 0.7,
  className,
  id,
  animateChildren = false,
}: {
  children: ReactNode;
  as?: ElementType;
  y?: number;
  duration?: number;
  className?: string;
  id?: string;
  /** Animate direct children with a stagger instead of the wrapper itself. */
  animateChildren?: boolean;
}) {
  const ref = useRef<HTMLElement | null>(null);

  useEffect(() => {
    registerOnce();
    const el = ref.current;
    if (!el) return;

    // Respect reduced motion: skip hints entirely.
    if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) return;

    const ctx = gsap.context(() => {
      const targets = animateChildren ? Array.from(el.children) : [el];
      gsap.set(targets, { autoAlpha: 0, y });
      gsap.to(targets, {
        autoAlpha: 1,
        y: 0,
        ease: "power2.out",
        duration,
        stagger: animateChildren ? 0.12 : 0,
        scrollTrigger: {
          trigger: el,
          start: "top 85%",
          once: true,
        },
      });
    }, el);
    return () => ctx.revert();
  }, [animateChildren, y, duration]);

  return (
    <Tag ref={ref} id={id} className={className}>
      {children}
    </Tag>
  );
}
