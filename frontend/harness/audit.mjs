// In-page automated UI audit.
//
// Catches the mechanical defects that a screenshot can hide and a human
// reviewer misses: elements pushed past the viewport, controls covered by the
// fixed bottom nav, tap targets under the 44px minimum, inputs whose font-size
// triggers iOS auto-zoom, text clipped without an ellipsis.
//
// Everything runs inside the page so it measures real laid-out geometry, not
// what the Tailwind classes imply.
//
// Precision matters more than recall here: this feeds reviewers, and a checker
// that cries wolf gets ignored. So it deliberately understands four things
// about this app that would otherwise generate hundreds of false positives —
// screen-reader-only text, intentional clipping (line-clamp, the rolling-digit
// animation), the fact that screens stack as full-screen overlays leaving a
// perfectly good UI "obscured" underneath, and that a `transition-colors` is
// not a motion-policy violation (check 9).

/** @returns {Promise<{counts:Record<string,number>, issues:Array<object>}>} */
export async function audit(page) {
  return page.evaluate(() => {
    const issues = [];
    const vw = window.innerWidth;
    const vh = window.innerHeight;

    const describe = (el) => {
      const id = el.id ? `#${el.id}` : "";
      const cls =
        typeof el.className === "string" && el.className
          ? "." + el.className.trim().split(/\s+/).slice(0, 4).join(".")
          : "";
      const label = el.getAttribute("aria-label") || "";
      const text = (el.textContent || "").trim().replace(/\s+/g, " ").slice(0, 60);
      return `${el.tagName.toLowerCase()}${id}${cls}${label ? `[aria-label="${label}"]` : ""}${
        text ? ` "${text}"` : ""
      }`;
    };

    const visible = (el) => {
      const s = getComputedStyle(el);
      if (s.display === "none" || s.visibility === "hidden" || parseFloat(s.opacity) === 0) return false;
      const r = el.getBoundingClientRect();
      return r.width > 0 && r.height > 0;
    };

    // Screen-reader-only text is *supposed* to be a clipped 1px box.
    const srOnly = (el) => {
      if (el.closest(".sr-only, .visually-hidden")) return true;
      const s = getComputedStyle(el);
      if (s.clipPath && s.clipPath !== "none") return true;
      if (s.clip && s.clip !== "auto") return true;
      const r = el.getBoundingClientRect();
      return r.width <= 1 || r.height <= 1;
    };

    // Clipping the app asks for on purpose: `line-clamp-N`, and the rolling
    // digit animation, which is a tall strip of numerals translated behind a
    // one-line window.
    // Deliberately narrow. An earlier version also excused any element with a
    // transformed child, which silently swallowed real overflow findings — the
    // Home "Next bill" row clips its text and happens to contain an animated
    // amount, so it was excused despite being visibly cut off mid-word.
    const intentionalClip = (el) => {
      const s = getComputedStyle(el);
      if (s.webkitLineClamp && s.webkitLineClamp !== "none") return true;
      return !!el.closest(".rolling-number, .rolling-cell, .rolling-wheel");
    };

    // ---- which layer are we actually looking at? --------------------------
    // Screens stack: Settings and the other drill-ins render as full-screen
    // panels over the tab underneath. Everything below the top panel is
    // legitimately covered, so auditing it reports the same "obscured control"
    // for every button on every screen the user isn't looking at.
    const layerRoot = (() => {
      const dialog = [...document.querySelectorAll('[role="dialog"], dialog[open]')].filter(visible).pop();
      if (dialog) return dialog;
      const covers = [...document.querySelectorAll("body *")].filter((el) => {
        const s = getComputedStyle(el);
        if (!["fixed", "absolute"].includes(s.position)) return false;
        if (!visible(el)) return false;
        const r = el.getBoundingClientRect();
        return r.width >= vw * 0.9 && r.height >= vh * 0.85 && r.top <= 8;
      });
      return covers.length ? covers[covers.length - 1] : document.body;
    })();
    const inLayer = (el) => layerRoot === document.body || layerRoot.contains(el);

    // A covered layer should also be inert, or its controls stay in the tab
    // order and screen-reader cursor behind the overlay. One finding, not one
    // per buried button.
    if (layerRoot !== document.body) {
      const buried = [...document.querySelectorAll('button, a[href], input, [tabindex]:not([tabindex="-1"])')].filter(
        (el) => !layerRoot.contains(el) && visible(el) && !el.closest("[inert]") && el.getAttribute("aria-hidden") !== "true" && !el.closest('[aria-hidden="true"]'),
      );
      if (buried.length) {
        issues.push({
          kind: "background-layer-not-inert",
          severity: "medium",
          el: describe(layerRoot),
          detail: `${buried.length} control(s) on the screen underneath this overlay are still focusable — they need inert or aria-hidden so Tab and VoiceOver don't wander behind it (e.g. ${describe(buried[0])})`,
        });
      }
    }

    const all = [...(layerRoot === document.body ? document.body : layerRoot).querySelectorAll("*")].filter(inLayer);

    /** The nearest ancestor that scrolls or clips, and whether el is inside its visible box. */
    const clippedOutOfView = (el) => {
      const r = el.getBoundingClientRect();
      const cx = r.left + r.width / 2;
      const cy = r.top + r.height / 2;
      for (let p = el.parentElement; p && p !== document.body; p = p.parentElement) {
        const s = getComputedStyle(p);
        if (!["auto", "scroll", "hidden"].includes(s.overflowY) && !["auto", "scroll", "hidden"].includes(s.overflowX)) continue;
        const pr = p.getBoundingClientRect();
        if (cy < pr.top - 1 || cy > pr.bottom + 1 || cx < pr.left - 1 || cx > pr.right + 1) return true;
      }
      return false;
    };

    // ---- 1. page-level horizontal overflow --------------------------------
    const doc = document.scrollingElement || document.documentElement;
    if (doc.scrollWidth > vw + 1) {
      issues.push({
        kind: "page-h-overflow",
        severity: "high",
        detail: `document scrollWidth ${doc.scrollWidth}px exceeds viewport ${vw}px — the page scrolls sideways`,
      });
    }

    // ---- 2. individual elements crossing the viewport edge ----------------
    for (const el of all) {
      if (!visible(el) || srOnly(el)) continue;
      const r = el.getBoundingClientRect();
      if (r.width === 0 || r.height === 0) continue;
      let scroller = false;
      for (let p = el.parentElement; p; p = p.parentElement) {
        const ov = getComputedStyle(p).overflowX;
        if (ov === "auto" || ov === "scroll") {
          scroller = true;
          break;
        }
      }
      if (scroller) continue;
      if (r.right > vw + 1 || r.left < -1) {
        // Report only the outermost offender, so one overflow doesn't produce
        // a finding for every descendant inside it.
        const parent = el.parentElement;
        if (parent) {
          const pr = parent.getBoundingClientRect();
          if (pr.right > vw + 1 || pr.left < -1) continue;
        }
        issues.push({
          kind: "element-past-viewport",
          severity: "high",
          el: describe(el),
          detail: `spans ${Math.round(r.left)}..${Math.round(r.right)}px, viewport is 0..${vw}px`,
        });
      }
    }

    // ---- 3. text clipped with no ellipsis ---------------------------------
    for (const el of all) {
      if (!visible(el) || srOnly(el) || intentionalClip(el)) continue;
      if (el.children.length > 0) continue; // leaf text nodes only
      const s = getComputedStyle(el);
      if (s.overflowX !== "hidden" && s.overflow !== "hidden") continue;
      if (s.textOverflow === "ellipsis") continue;
      if (el.scrollWidth > el.clientWidth + 1) {
        issues.push({
          kind: "text-clipped-no-ellipsis",
          severity: "medium",
          el: describe(el),
          detail: `content ${el.scrollWidth}px in ${el.clientWidth}px box, cut off with no ellipsis`,
        });
      }
    }

    // ---- 4. interactive elements -----------------------------------------
    const INTERACTIVE =
      'button, a[href], input, select, textarea, [role="button"], [role="switch"], [role="tab"], [tabindex]:not([tabindex="-1"])';
    const controls = [...(layerRoot === document.body ? document.body : layerRoot).querySelectorAll(INTERACTIVE)]
      .filter(inLayer)
      .filter(visible);

    for (const el of controls) {
      const r = el.getBoundingClientRect();
      const s = getComputedStyle(el);
      const disabled = el.disabled || el.getAttribute("aria-disabled") === "true";
      const hiddenInput = el.tagName === "INPUT" && (parseFloat(s.opacity) === 0 || s.appearance === "none" && el.classList.contains("peer"));

      // 4a. tap target below the documented 44px minimum. A small control
      // nested in a larger tappable ancestor is fine — the ancestor is the
      // real target.
      const insideBigTarget = (() => {
        for (let p = el.parentElement; p; p = p.parentElement) {
          if (p.matches?.(INTERACTIVE) || p.tagName === "LABEL") {
            const pr = p.getBoundingClientRect();
            if (pr.height >= 44 && pr.width >= 44) return true;
          }
        }
        return false;
      })();
      // components/README.md sanctions 36px for `IconButton size="sm"` inside
      // dense stacked rows, and that component marks itself. Anything smaller
      // than 36 is still a finding, even when marked.
      const denseAllowed = el.hasAttribute("data-dense-target") && r.height >= 36 && r.width >= 36;
      if (!insideBigTarget && !denseAllowed && !srOnly(el) && (r.height < 44 || r.width < 44)) {
        issues.push({
          kind: "tap-target-too-small",
          severity: r.height < 32 || r.width < 32 ? "high" : "medium",
          el: describe(el),
          detail: `${Math.round(r.width)}x${Math.round(r.height)}px, minimum is 44x44`,
        });
      }

      // 4b. inputs under 16px font trigger iOS zoom-on-focus.
      if (/^(INPUT|TEXTAREA|SELECT)$/.test(el.tagName) && !hiddenInput) {
        const fs = parseFloat(s.fontSize);
        if (fs < 16) {
          issues.push({
            kind: "input-font-too-small",
            severity: "medium",
            el: describe(el),
            detail: `font-size ${fs}px — iOS auto-zooms the viewport on focus below 16px`,
          });
        }
      }

      // 4c. accessible name.
      const name =
        el.getAttribute("aria-label") ||
        el.getAttribute("title") ||
        (el.getAttribute("aria-labelledby") &&
          document.getElementById(el.getAttribute("aria-labelledby"))?.textContent) ||
        (el.tagName === "INPUT" && el.labels?.length ? el.labels[0].textContent : "") ||
        el.getAttribute("placeholder") ||
        el.textContent;
      if (!name || !name.trim()) {
        issues.push({
          kind: "control-without-accessible-name",
          severity: "medium",
          el: describe(el),
          detail: "no text, aria-label, title, placeholder, or associated label — a screen reader announces nothing",
        });
      }

      // 4d. covered: the user cannot physically tap it. Scrolled-out controls
      // are reachable by scrolling, so they don't count.
      if (disabled || hiddenInput) continue;
      if (clippedOutOfView(el)) continue;
      const cx = r.left + r.width / 2;
      const cy = r.top + r.height / 2;
      if (cx < 0 || cx > vw || cy < 0 || cy > vh) continue;
      const hit = document.elementFromPoint(cx, cy);
      if (hit && hit !== el && !el.contains(hit) && !hit.contains(el)) {
        issues.push({
          kind: "control-obscured",
          severity: "high",
          el: describe(el),
          detail: `its center point hits ${describe(hit)} instead — the control cannot be tapped`,
        });
      }
    }

    // ---- 5. content trapped under a pinned bottom nav ---------------------
    const nav = document.querySelector("nav");
    if (nav && ["fixed", "sticky"].includes(getComputedStyle(nav).position) && inLayer(nav)) {
      const nr = nav.getBoundingClientRect();
      for (const el of controls) {
        if (nav.contains(el) || clippedOutOfView(el)) continue;
        const r = el.getBoundingClientRect();
        if (r.top < nr.bottom && r.bottom > nr.top && r.left < nr.right && r.right > nr.left) {
          issues.push({
            kind: "control-under-bottom-nav",
            severity: "high",
            el: describe(el),
            detail: "overlaps the pinned bottom nav — the scroll container needs bottom padding",
          });
        }
      }
    }

    // ---- 6. scroll containers that cannot reach their own content --------
    for (const el of all) {
      if (!visible(el) || srOnly(el) || intentionalClip(el)) continue;
      const s = getComputedStyle(el);
      if (["auto", "scroll"].includes(s.overflowY)) continue;
      if (s.overflowY === "hidden" && el.scrollHeight > el.clientHeight + 2) {
        issues.push({
          kind: "content-clipped-unscrollable",
          severity: "high",
          el: describe(el),
          detail: `${el.scrollHeight}px of content in a ${el.clientHeight}px box with overflow-y:hidden — the remainder is unreachable`,
        });
      }
    }

    // ---- 7. obvious render failures --------------------------------------
    const bodyText = (layerRoot === document.body ? document.body : layerRoot).innerText || "";
    for (const bad of ["NaN", "undefined", "Infinity", "[object Object]"]) {
      if (new RegExp(`\\b${bad.replace(/[[\]]/g, "\\$&")}\\b`).test(bodyText)) {
        const line = bodyText.split("\n").find((l) => l.includes(bad)) || "";
        issues.push({
          kind: "bad-value-rendered",
          severity: "high",
          detail: `the string "${bad}" is visible on screen: "${line.trim().slice(0, 120)}"`,
        });
      }
    }

    // ---- 8. images without alt -------------------------------------------
    for (const img of [...document.querySelectorAll("img")].filter(visible)) {
      if (!img.hasAttribute("alt")) {
        issues.push({ kind: "img-without-alt", severity: "low", el: describe(img), detail: "no alt attribute" });
      }
    }

    // ---- 9. stray CSS transitions on moving properties -------------------
    // Motion-migration guard. Movement is Framer's job now: it is the only
    // animator here that can be interrupted mid-flight by a gesture, retarget
    // from the current velocity rather than restarting from zero, and be
    // switched off wholesale by `MotionConfig reducedMotion="user"`. A CSS
    // transition on transform or a box dimension can do none of those, so one
    // reappearing means a component grew its own motion behind the policy's
    // back — exactly the class of bug the migration existed to remove.
    //
    // Deliberately scoped to properties that MOVE or RESIZE. `transition-colors`
    // and `transition-opacity` are used on a couple of dozen elements per
    // screen and are none of Framer's business: they carry no position, no
    // gesture can grab them, and reduced motion has no opinion about a colour.
    // Flagging those would bury every real finding, and a checker that cries
    // wolf gets ignored.
    //
    // The two sanctioned CSS animations — the pixel spinner and the skeleton
    // pulse — set `animation`, never `transition`, so they fall outside this
    // check by construction rather than by exception, and it stays silent on
    // them. The one genuine exception carries `data-css-transition` and says
    // why in its own source (see `ui/Switch.tsx`), the same contract
    // `data-dense-target` uses for the 44px rule.
    const MOVING_PROP =
      /^(all|transform|translate|rotate|scale|width|height|min-width|min-height|max-width|max-height|top|right|bottom|left|inset|margin|margin-top|margin-right|margin-bottom|margin-left|padding|flex-basis|gap)$/;
    for (const el of all) {
      if (!visible(el) || el.closest("[data-css-transition]")) continue;
      const s = getComputedStyle(el);
      if (!s.transitionProperty || s.transitionProperty === "none") continue;
      // A declared property with a 0s duration animates nothing.
      const durations = (s.transitionDuration || "").split(",").map((d) => parseFloat(d) || 0);
      if (!durations.some((d) => d > 0)) continue;
      const moving = s.transitionProperty
        .split(",")
        .map((p) => p.trim())
        .filter((p) => MOVING_PROP.test(p));
      if (!moving.length) continue;
      issues.push({
        kind: "stray-css-transition",
        severity: "medium",
        el: describe(el),
        detail: `CSS transition on ${moving.join(", ")} — movement belongs to Framer (lib/motion.ts); mark it data-css-transition with a reason if it genuinely cannot move`,
      });
    }

    const seen = new Set();
    const deduped = [];
    for (const i of issues) {
      const k = `${i.kind}|${i.el || ""}|${i.detail}`;
      if (seen.has(k)) continue;
      seen.add(k);
      deduped.push(i);
    }

    const counts = {};
    for (const i of deduped) counts[i.kind] = (counts[i.kind] || 0) + 1;
    return { counts, issues: deduped, layer: describe(layerRoot).slice(0, 120) };
  });
}

/** Collapse repeated list-row findings so a 200-row table reports once, not 200 times. */
export function summarize(issues, cap = 12) {
  const byKind = {};
  for (const i of issues) (byKind[i.kind] ||= []).push(i);
  const out = [];
  for (const [kind, list] of Object.entries(byKind)) {
    out.push({
      kind,
      count: list.length,
      severity: list[0].severity,
      examples: list.slice(0, cap).map((i) => ({ el: i.el, detail: i.detail })),
    });
  }
  return out.sort((a, b) => {
    const rank = { high: 0, medium: 1, low: 2 };
    return rank[a.severity] - rank[b.severity] || b.count - a.count;
  });
}
