// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: The thunderbird-mcp and Commonpost contributors (see LICENSE)
"use strict";
// Hidden text, judged by Thunderbird's own layout engine (docs/architecture.md, "Hidden text in HTML bodies").
//
// api.js sends, through the commonpostMcp.onRender event, the document Thunderbird's message pane shows for a message
// (libmime's output), the size of the pane and the images of the message's own parts. This page renders it in a
// sandboxed frame and answers, for each unit of the document (a run of text nodes, an <img>, an <a>; the definition
// is shared with engineUnits in api.js), whether a reader can see it.
//
// Nothing in the frame may run or reach the network:
// - the frame is sandboxed without allow-scripts: no script, no form, no navigation, no meta refresh;
// - it inherits this page's policy (manifest.json content_security_policy), which is in force before the first byte
//   is parsed and also covers the speculative loads of srcset and <picture>; checkPolicy() checks at startup that it
//   is the add-on's policy and not Gecko's default, and the engine stays off otherwise;
// - a <meta> policy and x-dns-prefetch-control off are put first in <head>, and removed once the document is
//   parsed (the policy and the setting stay in force), so that no selector of the message can see them.
// The message's DOM is not changed otherwise: a selector of the message must match here exactly as in the pane.

globalThis.commonpostEngineVisibility = (() => {
  // DOM properties read from the prototypes of the frame's own global: a document's named items (<img
  // name="createTreeWalker">) and a form's named controls (<input name="parentElement">) shadow the properties of the
  // objects themselves. The frame's objects are handled with the frame's own functions.
  function domAccess(g) {
    const getter = (proto, key) => Object.getOwnPropertyDescriptor(proto, key).get;
    return {
      DOC: {
        defaultView: getter(g.Document.prototype, "defaultView"),
        documentElement: getter(g.Document.prototype, "documentElement"),
        body: getter(g.Document.prototype, "body"),
        images: getter(g.Document.prototype, "images"),
        adoptedStyleSheets: getter(g.Document.prototype, "adoptedStyleSheets"),
        createElement: g.Document.prototype.createElement,
        importNode: g.Document.prototype.importNode,
        createRange: g.Document.prototype.createRange,
        querySelectorAll: g.Document.prototype.querySelectorAll,
        elementsFromPoint: g.Document.prototype.elementsFromPoint,
      },
      NODE: {
        parentElement: getter(g.Node.prototype, "parentElement"),
        nodeType: getter(g.Node.prototype, "nodeType"),
        childNodes: getter(g.Node.prototype, "childNodes"),
        contains: g.Node.prototype.contains,
        replaceChild: g.Node.prototype.replaceChild,
        textContent: getter(g.Node.prototype, "textContent"),
      },
      EL: {
        localName: getter(g.Element.prototype, "localName"),
        namespaceURI: getter(g.Element.prototype, "namespaceURI"),
        children: getter(g.Element.prototype, "children"),
        getAttribute: g.Element.prototype.getAttribute,
        attributes: getter(g.Element.prototype, "attributes"),
        hasAttribute: g.Element.prototype.hasAttribute,
        toggleAttribute: g.Element.prototype.toggleAttribute,
        remove: g.Element.prototype.remove,
        closest: g.Element.prototype.closest,
        clientLeft: getter(g.Element.prototype, "clientLeft"),
        clientTop: getter(g.Element.prototype, "clientTop"),
        clientWidth: getter(g.Element.prototype, "clientWidth"),
        clientHeight: getter(g.Element.prototype, "clientHeight"),
        checkVisibility: g.Element.prototype.checkVisibility,
        getBoundingClientRect: g.Element.prototype.getBoundingClientRect,
        getClientRects: g.Element.prototype.getClientRects,
      },
      TEXT_DATA: getter(g.CharacterData.prototype, "data"),
      ATTR: {
        name: getter(g.Attr.prototype, "name"),
        value: getter(g.Attr.prototype, "value"),
        setValue: Object.getOwnPropertyDescriptor(g.Attr.prototype, "value").set,
      },
      IMG: {
        naturalWidth: getter(g.HTMLImageElement.prototype, "naturalWidth"),
        decode: g.HTMLImageElement.prototype.decode,
      },
    };
  }

  // Same thresholds as the inline-style reading of api.js (MIN_VISIBLE_FONT_PX, MIN_VISIBLE_OPACITY); 1.2 is a WCAG 2
  // contrast ratio, 1 being one colour on itself.
  const MIN_PX = 3;
  const MIN_OPACITY = 0.1;
  const MIN_CONTRAST = 1.2;
  const SVG_NS = "http://www.w3.org/2000/svg";
  const FULL = { left: -Infinity, top: -Infinity, right: Infinity, bottom: Infinity };

  function parseRgb(value) {
    const m = /^rgba?\(\s*([\d.]+)[,\s]+([\d.]+)[,\s]+([\d.]+)(?:\s*[,/]\s*([\d.]+%?))?\s*\)$/.exec(value || "");
    if (!m) return null;
    const alpha = m[4] === undefined ? 1 : m[4].endsWith("%") ? parseFloat(m[4]) / 100 : parseFloat(m[4]);
    return [+m[1], +m[2], +m[3], alpha];
  }
  // Any CSS colour as [r, g, b, alpha]: Gecko serialises computed colours as rgb(), but also as oklch(), lab() or
  // color() (and not always the same way for one value); a canvas reads every form. null when unknown.
  let colorContext = null;
  const colorCache = new Map();
  function parseColor(value) {
    if (!value) return null;
    if (colorCache.has(value)) return colorCache.get(value);
    let rgba = parseRgb(value);
    if (!rgba && typeof document !== "undefined") {
      try {
        colorContext ||= document.createElement("canvas").getContext("2d");
        colorContext.fillStyle = "#010203";
        colorContext.fillStyle = value;
        const read = String(colorContext.fillStyle);
        const hex = /^#([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i.exec(read);
        if (read !== "#010203") rgba = hex ? [parseInt(hex[1], 16), parseInt(hex[2], 16), parseInt(hex[3], 16), 1] : parseRgb(read);
      } catch {
        rgba = null;
      }
    }
    if (colorCache.size < 4096) colorCache.set(value, rgba);
    return rgba;
  }
  // The colours of a computed text-shadow ("none" or shadows separated by top-level commas)
  function shadowColors(value) {
    if (!value || value === "none") return [];
    const parts = [];
    let depth = 0, start = 0;
    for (let i = 0; i < value.length; i++) {
      const c = value[i];
      if (c === "(") depth++;
      else if (c === ")") depth--;
      else if (c === "," && depth === 0) {
        parts.push(value.slice(start, i));
        start = i + 1;
      }
    }
    parts.push(value.slice(start));
    return parts.map(part => {
      const fn = /[a-z-]+\([^)]*\)/i.exec(part);
      if (fn) return parseColor(fn[0]);
      const word = part.trim().split(/\s+/).find(w => !/^-?[\d.]/.test(w));
      return word ? parseColor(word) : null;
    }).filter(Boolean);
  }
  function luminance([r, g, b]) {
    const c = [r, g, b].map(v => {
      v /= 255;
      return v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4);
    });
    return 0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2];
  }
  // A colour with alpha painted over an opaque one
  function over(top, bottom) {
    const a = top[3];
    return [top[0] * a + bottom[0] * (1 - a), top[1] * a + bottom[1] * (1 - a), top[2] * a + bottom[2] * (1 - a), 1];
  }
  function contrast(a, b) {
    const l1 = luminance(a), l2 = luminance(b);
    return (Math.max(l1, l2) + 0.05) / (Math.min(l1, l2) + 0.05);
  }
  function intersect(r, c) {
    const left = Math.max(r.left, c.left), top = Math.max(r.top, c.top);
    const right = Math.min(r.right, c.right), bottom = Math.min(r.bottom, c.bottom);
    return { left, top, right, bottom, width: Math.max(0, right - left), height: Math.max(0, bottom - top) };
  }

  // What a reader of the rendered document cannot see: Map(text node or element -> reason), for the text nodes with
  // more than white space and the <img> and <a> elements of its units.
  function judge(doc, dom, found = units(doc, dom)) {
    const { DOC, NODE, EL, TEXT_DATA } = dom;
    const parentOf = node => NODE.parentElement.call(node);
    const tagOf = el => EL.localName.call(el);
    const win = DOC.defaultView.call(doc);
    const root = DOC.documentElement.call(doc), body = DOC.body.call(doc);
    const styles = new Map();
    const cs = el => {
      let s = styles.get(el);
      if (!s) {
        s = win.getComputedStyle(el);
        styles.set(el, s);
      }
      return s;
    };
    // Product of the opacities down to an element, filter: opacity() included
    const opacities = new Map();
    function opacity(el) {
      if (!el) return 1;
      if (opacities.has(el)) return opacities.get(el);
      const s = cs(el);
      let v = parseFloat(s.opacity);
      const f = /opacity\(([\d.]+)(%?)\)/.exec(s.filter || "");
      if (f) v *= f[2] ? parseFloat(f[1]) / 100 : parseFloat(f[1]);
      v *= opacity(parentOf(el));
      opacities.set(el, v);
      return v;
    }
    // The colour behind an element: its background and its ancestors' composited onto a white canvas; null when an
    // image or a gradient is painted on the way (unknown).
    function background(el) {
      const layers = [];
      for (let e = el; e; e = parentOf(e)) {
        const s = cs(e);
        if (s.backgroundImage && s.backgroundImage !== "none") return null;
        const c = parseColor(s.backgroundColor);
        if (!c) return null;
        if (c[3] > 0) layers.push(c);
        if (c[3] >= 1) break;
      }
      let bg = [255, 255, 255, 1];
      for (let i = layers.length - 1; i >= 0; i--) bg = over(layers[i], bg);
      return bg;
    }
    // The area an element's content can show in: the clips of its ancestors (overflow other than visible, clip,
    // clip-path inset() or a zero circle), following the containing blocks of positioned boxes.
    const positioned = s => s.position !== "static" || s.transform !== "none" || s.filter !== "none"
      || /paint|layout|strict|content/.test(s.contain || "");
    // overflow clips the content of block, flex and grid containers, table cells and replaced elements, not of an
    // inline box or a part of a table; nor the element's own box (an image clips its own content: ownBox)
    const NO_OVERFLOW = /^(inline|contents|none|table-row|table-row-group|table-header-group|table-footer-group|table-column|table-column-group)$/;
    function clipArea(el, ownBox = false) {
      let area = FULL;
      let skipStatic = false;
      for (let e = el; e && NODE.nodeType.call(e) === 1; e = parentOf(e)) {
        const s = cs(e);
        const clipsHere = !(skipStatic && !positioned(s)) || e === el;
        if (clipsHere && e !== root && e !== body) {
          const r = EL.getBoundingClientRect.call(e);
          const overflowApplies = !(ownBox && e === el) && !NO_OVERFLOW.test(s.display);
          if (overflowApplies && (s.overflowX !== "visible" || s.overflowY !== "visible")) {
            const scrolls = /auto|scroll/.test(s.overflowX + s.overflowY);
            const cl = EL.clientLeft.call(e), ct = EL.clientTop.call(e), cw = EL.clientWidth.call(e), ch = EL.clientHeight.call(e);
            // A scroll container lets the reader scroll to its content, unless it has no room at all
            if (!scrolls || cw < 1 || ch < 1) {
              area = intersect(area, { left: r.left + cl, top: r.top + ct, right: r.left + cl + cw, bottom: r.top + ct + ch });
            }
          }
          const clip = /^rect\(\s*(-?[\d.]+)px,?\s*(-?[\d.]+)px,?\s*(-?[\d.]+)px,?\s*(-?[\d.]+)px\s*\)$/.exec(s.clip || "");
          if (clip && (s.position === "absolute" || s.position === "fixed")) {
            area = intersect(area, { left: r.left + +clip[4], top: r.top + +clip[1], right: r.left + +clip[2], bottom: r.top + +clip[3] });
          }
          const inset = /^inset\(([^)]*)\)/.exec(s.clipPath || "");
          if (inset) {
            const v = inset[1].split(/\s+round\s+/)[0].trim().split(/\s+/)
              .map(x => (x.endsWith("%") ? { p: parseFloat(x) } : { px: parseFloat(x) }));
            const [t, rr, b, l] = [v[0], v[1] || v[0], v[2] || v[0], v[3] || v[1] || v[0]];
            const len = (x, size) => (x.p !== undefined ? x.p * size / 100 : x.px);
            area = intersect(area, {
              left: r.left + len(l, r.width), top: r.top + len(t, r.height),
              right: r.right - len(rr, r.width), bottom: r.bottom - len(b, r.height),
            });
          } else if (/^(circle|ellipse)\(0(px)?[\s)]/.test(s.clipPath || "")) {
            area = intersect(area, { left: 0, top: 0, right: 0, bottom: 0 });
          }
        }
        if (s.position === "fixed") break;
        if (s.position === "absolute") skipStatic = true;
        else if (positioned(s)) skipStatic = false;
      }
      return area;
    }
    // A viewport the reader cannot scroll (overflow hidden or clip on the root, or on the body when the root's is
    // visible) shows only its own area; any viewport shows nothing left of or above the page.
    const rootStyle = cs(root), bodyStyle = body ? cs(body) : null;
    let vx = rootStyle.overflowX, vy = rootStyle.overflowY;
    if (vx === "visible" && vy === "visible" && bodyStyle) {
      vx = bodyStyle.overflowX;
      vy = bodyStyle.overflowY;
    }
    const fixedX = vx === "hidden" || vx === "clip", fixedY = vy === "hidden" || vy === "clip";
    const page = {
      left: -win.scrollX, top: -win.scrollY,
      right: fixedX ? win.innerWidth : Infinity, bottom: fixedY ? win.innerHeight : Infinity,
    };
    const shownRects = (rects, el, ownBox = false) => {
      const area = clipArea(el, ownBox);
      return rects.map(r => intersect(intersect(r, area), page)).filter(r => r.width >= 1 && r.height >= 1);
    };
    // Hidden with all it contains, whatever its text looks like
    function boxHidden(el) {
      // display:contents has no box of its own (checkVisibility is false) while its content shows: ask the nearest box
      let boxEl = el;
      while (boxEl && cs(boxEl).display === "contents") boxEl = parentOf(boxEl);
      if (boxEl && EL.checkVisibility
        && !EL.checkVisibility.call(boxEl, { visibilityProperty: true, checkVisibilityCSS: true, contentVisibilityAuto: true })) {
        return "checkVisibility";
      }
      if (cs(el).visibility !== "visible") return "visibility";
      for (let e = el; e; e = parentOf(e)) if (cs(e).contentVisibility === "hidden") return "content-visibility";
      if (opacity(el) < MIN_OPACITY) return "opacity";
      // A closed <details> renders its <summary> only
      const details = EL.closest.call(el, "details:not([open])");
      if (details) {
        const summary = Array.from(EL.children.call(details)).find(c => tagOf(c) === "summary");
        if (!summary || !NODE.contains.call(summary, el)) return "closed-details";
      }
      return null;
    }

    const hidden = new Map();
    const range = DOC.createRange.call(doc);
    for (const unit of found) {
      const node = unit.nodes[0];
      if (NODE.nodeType.call(node) === 1) {
        // <img> and <a>: hidden when their box shows nowhere
        const reason = boxHidden(node) || (shownRects(Array.from(EL.getClientRects.call(node)), node, true).length ? null : "no-box");
        if (reason) hidden.set(node, reason);
        continue;
      }
      for (const n of unit.nodes) {
        if (!/\S/.test(TEXT_DATA.call(n))) continue;
        const el = parentOf(n);
        if (!el) continue;
        const reason = textHidden(n, el);
        if (reason) hidden.set(n, reason);
      }
    }
    // A background painted into the text (background-clip: text, as gradient headings do), on the element or an
    // ancestor: the text shows whatever its own colour
    function paintedThroughText(el) {
      for (let e = el; e; e = parentOf(e)) {
        const s = cs(e);
        if (!/\btext\b/.test(s.backgroundClip || "")) continue;
        const color = parseColor(s.backgroundColor);
        if ((s.backgroundImage && s.backgroundImage !== "none") || (color && color[3] > 0)) return true;
      }
      return false;
    }
    function textHidden(n, el) {
      const boxReason = boxHidden(el);
      if (boxReason) return boxReason;
      const s = cs(el);
      if (parseFloat(s.fontSize) < MIN_PX) return "font-size";
      // SVG text painted with neither fill nor stroke
      if (EL.namespaceURI.call(el) === SVG_NS) {
        const fillOn = s.fill !== "none" && parseFloat(s.fillOpacity) * opacity(el) >= MIN_OPACITY;
        const strokeOn = s.stroke !== "none" && parseFloat(s.strokeWidth) > 0 && parseFloat(s.strokeOpacity) * opacity(el) >= MIN_OPACITY;
        if (!fillOn && !strokeOn) return "svg-no-paint";
      }
      // The text of a form control is drawn by the control: measure the control
      const tag = tagOf(el);
      let rects;
      if (tag === "textarea" || tag === "option") rects = Array.from(EL.getClientRects.call(el));
      else {
        range.selectNodeContents(n);
        rects = Array.from(range.getClientRects());
      }
      const shown = shownRects(rects, el).filter(r => r.height >= MIN_PX);
      if (!shown.length) return rects.length ? "clipped-or-offscreen" : "no-box";
      // Effects whose result the computed values do not tell: a blend mode, a mask, a colour filter or a strong blur on
      // the text or above it. Rare in mail; the text counts as hidden.
      const effect = paintEffect(el);
      if (effect) return effect;
      // Covered by an opaque box painted over it, at the points tested (elementsFromPoint)
      const stack = stackUnder(n, el, shown);
      if (stack === "covered") return "covered";
      // The text against what is behind it: the fill, a stroke or a shadow that shows makes it readable
      const fill = parseColor(s.webkitTextFillColor) || parseColor(s.color);
      if (fill && !paintedThroughText(el)) {
        const op = opacity(el);
        const bg = Array.isArray(stack) ? stackBackground(stack) : background(el);
        const shows = c => !!c && c[3] * op >= MIN_OPACITY && (!bg || contrast(over(c, bg), bg) >= MIN_CONTRAST);
        const stroke = parseFloat(s.webkitTextStrokeWidth || "0") > 0 ? parseColor(s.webkitTextStrokeColor) : null;
        if (!shows(fill) && !shows(stroke) && !shadowColors(s.textShadow).some(shows)) {
          return fill[3] * op < MIN_OPACITY ? "transparent-colour" : "colour-on-background";
        }
      }
      return null;
    }
    function paintEffect(el) {
      for (let e = el; e; e = parentOf(e)) {
        const s = cs(e);
        if (s.mixBlendMode && s.mixBlendMode !== "normal") return "blend";
        if ((s.maskImage && s.maskImage !== "none") || (s.mask && s.mask !== "none" && /url|gradient|image/i.test(s.mask))) return "mask";
        const filter = s.filter || "none";
        if (filter !== "none") {
          if (/\b(?:brightness|contrast|invert|saturate|sepia|hue-rotate|grayscale|url)\(/i.test(filter)) return "filter";
          const blur = /blur\(\s*([\d.]+)px/i.exec(filter);
          if (blur && parseFloat(blur[1]) >= 3) return "blur";
        }
      }
      return null;
    }
    // The elements stacked at up to three points of a text (topmost first), from the text's element down: "covered"
    // when an opaque box is painted over it at every point tested, null when hit testing cannot tell (the text's
    // element is not hit: pointer-events, a point that cannot be scrolled to). A cover that ignores pointer events is
    // not seen.
    function stackUnder(n, el, shown) {
      if (!DOC.elementsFromPoint) return null;
      try {
        return stackAt(el, shown);
      } catch {
        return null;
      }
    }
    function stackAt(el, shown) {
      const points = [shown[0], shown[Math.floor(shown.length / 2)], shown[shown.length - 1]]
        .map(r => [(r.left + r.right) / 2, (r.top + r.bottom) / 2]);
      let covered = 0, under = null;
      for (const [x, y] of points) {
        let top = 0;
        if (y < 0 || y >= win.innerHeight) {
          if (typeof win.scrollTo !== "function") return null;
          top = Math.max(0, y - win.innerHeight / 2);
          win.scrollTo(win.scrollX, top);
          top = win.scrollY;
        }
        const stack = Array.from(DOC.elementsFromPoint.call(doc, x, y - top));
        if (top) win.scrollTo(win.scrollX, 0);
        const at = stack.indexOf(el);
        if (at < 0) return null;
        if (stack.slice(0, at).some(e => opaqueAt(e, x, y - top))) covered++;
        else under ||= stack.slice(at);
      }
      return covered === points.length ? "covered" : under;
    }
    // An element hit at a point covers it with its own background only when the point is in its own box: a hit can
    // also come from its pseudo-elements or overflowing content, whose paint is not read here
    function opaqueAt(e, x, y) {
      const r = EL.getBoundingClientRect.call(e);
      return x >= r.left && x < r.right && y >= r.top && y < r.bottom && opaque(e);
    }
    function opaque(e) {
      const s = cs(e);
      if (s.visibility !== "visible" || opacity(e) < 0.9) return false;
      if (s.backgroundImage && s.backgroundImage !== "none" && !/^\s*$/.test(s.backgroundImage)) return true;
      const c = parseColor(s.backgroundColor);
      return !!c && c[3] >= 0.9;
    }
    // What is behind the text where it shows: the backgrounds of its element and of what the hit test found under it,
    // composited onto a white canvas; null when an image or a gradient is painted on the way
    function stackBackground(stack) {
      const layers = [];
      for (const e of stack) {
        const s = cs(e);
        if (s.backgroundImage && s.backgroundImage !== "none") return null;
        const c = parseColor(s.backgroundColor);
        if (!c) return null;
        if (c[3] > 0) layers.push([c[0], c[1], c[2], c[3] * (opacity(e) / (opacity(parentOf(e)) || 1))]);
        if (c[3] >= 1 && opacity(e) >= 1) break;
      }
      let bg = [255, 255, 255, 1];
      for (let i = layers.length - 1; i >= 0; i--) bg = over(layers[i], bg);
      return bg;
    }
    return hidden;
  }

  // The units of a document, in document order. Keep in step with engineUnits in api.js: same tags left out, same
  // runs, same keys.
  const SKIPPED_TAGS = new Set(["script", "style", "title", "template", "noembed", "noframes", "iframe"]);
  const MAX_UNITS = 200000;
  function units(doc, dom) {
    const { DOC, NODE, EL, TEXT_DATA } = dom;
    const found = [];
    const pending = [[DOC.documentElement.call(doc), 0]];
    // Iterative depth-first walk (a deep document must not overflow the stack): [parent, index of the next child]
    let run = null;
    const flush = () => {
      if (run && /\S/.test(run.key)) found.push(run);
      run = null;
    };
    while (pending.length) {
      const top = pending[pending.length - 1];
      const children = NODE.childNodes.call(top[0]);
      if (top[1] >= children.length) {
        flush();
        pending.pop();
        continue;
      }
      const child = children[top[1]++];
      const type = NODE.nodeType.call(child);
      if (type === 3) {
        const data = TEXT_DATA.call(child);
        if (run) {
          run.nodes.push(child);
          run.key += data;
        } else {
          run = { nodes: [child], key: data };
        }
        continue;
      }
      flush();
      if (type !== 1) continue;
      const tag = EL.localName.call(child);
      if (SKIPPED_TAGS.has(tag)) continue;
      if (tag === "img") found.push({ nodes: [child], key: "\u0000img\u0000" + (EL.getAttribute.call(child, "alt") || "") });
      else if (tag === "a") found.push({ nodes: [child], key: "\u0000a" });
      if (found.length > MAX_UNITS) throw new Error("too many units");
      pending.push([child, 0]);
    }
    return found;
  }

  // The add-on's own policy is in force on this page: Gecko silently falls back to its default policy, which has no
  // img-src, when the manifest's does not validate. The add-on's allows no blob: image, so an image of a blob: URL of
  // this page must be refused, with a policy violation; were the policy missing, it would load, from memory.
  let policy = null;
  function checkPolicy() {
    if (!policy) {
      policy = new Promise(resolve => {
        const pixel = Uint8Array.from(atob("R0lGODlhAQABAAAAACw="), c => c.charCodeAt(0));
        const url = URL.createObjectURL(new Blob([pixel], { type: "image/gif" }));
        const done = ok => {
          document.removeEventListener("securitypolicyviolation", onViolation);
          clearTimeout(timer);
          URL.revokeObjectURL(url);
          resolve(ok);
        };
        const onViolation = event => {
          if (/^img-src/.test(event.violatedDirective || "") && /^blob(:|$)/.test(String(event.blockedURI || ""))) done(true);
        };
        document.addEventListener("securitypolicyviolation", onViolation);
        const timer = setTimeout(() => done(false), 3000);
        const probe = new Image();
        probe.src = url;
      });
    }
    return policy;
  }

  const LOAD_TIMEOUT_MS = 4000;
  const SHEET_TIMEOUT_MS = 2000;
  // Waits for promises, at most `ms`
  function settled(promises, ms) {
    return Promise.race([Promise.allSettled(promises), new Promise(resolve => {
      setTimeout(resolve, ms);
    })]);
  }
  const MAX_RENDERS = 2;
  let running = 0;
  const waiting = [];
  async function inSlot(task) {
    if (running >= MAX_RENDERS) {
      await new Promise(resolve => {
        waiting.push(resolve);
      });
    }
    running++;
    try {
      return await task();
    } finally {
      running--;
      const next = waiting.shift();
      if (next) next();
    }
  }

  function checkJob(job) {
    if (!job || typeof job !== "object") return "no job";
    if (typeof job.html !== "string" || !job.html) return "no html";
    for (const side of ["width", "height"]) {
      if (!Number.isInteger(job[side]) || job[side] < 100 || job[side] > 10000) return "bad " + side;
    }
    if (!Array.isArray(job.parts)) return "bad parts";
    for (const part of job.parts) {
      if (!Array.isArray(part) || typeof part[0] !== "string" || typeof part[1] !== "string" || !part[1].startsWith("data:image/")) {
        return "bad part";
      }
    }
    return null;
  }

  // The frame starts as an empty document holding only the policy: the message's HTML is parsed apart (DOMParser:
  // no load, no script) and its tree put in place of this one, so that no load starts before the policy is in force
  // (a parser's speculative loads would). The elements of the policy go away with this tree; the policy and the
  // prefetch setting stay in force.
  function frameHtml() {
    return "<!DOCTYPE html><html><head>"
      + "<meta http-equiv=\"Content-Security-Policy\" content=\"default-src 'none'; img-src data:; "
      + "style-src 'unsafe-inline' chrome://messagebody/skin/ chrome://messenger/skin/\">"
      + "<meta http-equiv=\"x-dns-prefetch-control\" content=\"off\"></head><body></body></html>";
  }


  // The URLs of Thunderbird's own message protocols (mailbox:, imap:, news:, cid:...) must not be loaded outside its
  // main process, and for images the channel is opened before the content policy is checked; libmime itself turns
  // the cid: images of a message into mailbox: or imap: URLs. So, before the message's tree reaches the frame, every
  // URL that a load could start from must be http, https or data
  // (the add-on's policy then refuses all but data:); others get an inert scheme of the same length ("mailbox:" ->
  // "x------:"), which no handler takes. A selector of the message that reads one of the changed attributes, a style
  // sheet that loads such a URL (CSS can escape it) or a srcdoc frame: the message is not rendered.
  const SAFE_SCHEMES = new Set(["http", "https", "data"]);
  const SAFE_STYLESHEET_SCHEMES = new Set(["http", "https", "data", "chrome"]);
  const LOADING_ATTRIBUTES = new Set(["src", "srcset", "imagesrcset", "href", "xlink:href", "background", "poster",
    "data", "codebase", "lowsrc", "dynsrc", "action", "formaction", "cite", "longdesc", "manifest", "icon", "ping",
    "profile", "usemap", "archive", "classid"]);
  const URL_LISTS = new Set(["srcset", "imagesrcset"]);
  const ANIMATION_TAGS = new Set(["set", "animate", "animatetransform", "animatemotion", "animatecolor", "discard"]);

  // The URL with an inert scheme ("mailbox:" -> "x------:", which no handler takes), or null when it may stay. Read as
  // the URL parser reads it: leading and trailing C0 controls and spaces dropped, tabs and newlines removed.
  const INERT_SCHEME = /^x-*$/;
  function inertUrl(url, allowed) {
    const joined = url.replace(/[\t\n\r]/g, "");
    // A loop, not a regular expression: a long run of spaces inside a value would make one backtrack
    let from = 0, to = joined.length;
    while (from < to && joined.charCodeAt(from) <= 0x20) from++;
    while (to > from && joined.charCodeAt(to - 1) <= 0x20) to--;
    const cleaned = joined.slice(from, to);
    const m = /^([a-z][a-z0-9+.-]*):/i.exec(cleaned);
    if (!m || allowed.has(m[1].toLowerCase()) || INERT_SCHEME.test(m[1])) return null;
    return "x" + "-".repeat(m[1].length - 1) + cleaned.slice(m[1].length);
  }

  // The candidates of a srcset: each URL runs to the next white space; a URL may hold commas (data: URLs)
  function inertSrcset(value) {
    let changed = false, out = "", i = 0;
    while (i < value.length) {
      const start = i;
      while (i < value.length && /[\s,]/.test(value[i])) i++;
      out += value.slice(start, i);
      const urlStart = i;
      while (i < value.length && !/\s/.test(value[i])) i++;
      let url = value.slice(urlStart, i);
      let tail = "";
      while (url.endsWith(",")) {
        url = url.slice(0, -1);
        tail += ",";
      }
      const inert = url && inertUrl(url, SAFE_SCHEMES);
      if (inert) changed = true;
      out += (inert || url) + tail;
      if (!tail) {
        const descriptorsStart = i;
        while (i < value.length && value[i] !== ",") i++;
        out += value.slice(descriptorsStart, i);
      }
    }
    return changed ? out : null;
  }

  function cssUnescape(text) {
    return text.replace(/\\(?:([0-9a-fA-F]{1,6})[ \t\n\r\f]?|([^\n\r\f]))/g, (match, hex, char) => {
      if (char !== undefined) return char;
      const cp = parseInt(hex, 16);
      return cp > 0 && cp <= 0x10FFFF && (cp < 0xD800 || cp > 0xDFFF) ? String.fromCodePoint(cp) : "�";
    });
  }

  // CSS without its comments (an unclosed one runs to the end), in one pass
  function stripCssComments(css) {
    let out = "", i = 0;
    for (;;) {
      const open = css.indexOf("/*", i);
      if (open < 0) return out + css.slice(i);
      out += css.slice(i, open) + " ";
      const close = css.indexOf("*/", open + 2);
      if (close < 0) return out;
      i = close + 2;
    }
  }

  // Whether CSS text could load a URL that is not http, https or data: in url(), in @import, or in image-set().
  // Linear: an image-set() is read up to the next ")" (the text split at each one), whatever comes before.
  function cssLoadsUnsafeUrl(css) {
    const text = cssUnescape(stripCssComments(css));
    for (const m of text.matchAll(/url\(\s*["']?([^"')]*)/gi)) if (inertUrl(m[1], SAFE_SCHEMES)) return true;
    for (const m of text.matchAll(/@import\s*["']([^"']*)/gi)) if (inertUrl(m[1], SAFE_SCHEMES)) return true;
    for (const segment of text.split(")")) {
      const set = segment.toLowerCase().indexOf("image-set(");
      if (set < 0) continue;
      for (const m of segment.slice(set + 10).matchAll(/["']([^"']*)/g)) if (inertUrl(m[1], SAFE_SCHEMES)) return true;
    }
    return false;
  }

  const ENTITIES = { amp: "&", quot: "\"", apos: "'", lt: "<", gt: ">", nbsp: "\u00A0", colon: ":", tab: "\t",
    newline: "\n", period: ".", plus: "+", sol: "/" };
  function decodeAttribute(raw) {
    return raw.replace(/&(#x[0-9a-f]+|#[0-9]+|[a-z]+);?/gi, (match, entity) => {
      if (entity[0] === "#") {
        const cp = entity[1] === "x" || entity[1] === "X" ? parseInt(entity.slice(2), 16) : parseInt(entity.slice(1), 10);
        return cp > 0 && cp <= 0x10FFFF ? String.fromCodePoint(cp) : "�";
      }
      return ENTITIES[entity.toLowerCase()] ?? match;
    });
  }
  const encodeAttribute = value => value.replace(/&/g, "&amp;").replace(/"/g, "&quot;");

  // The attribute name a value may hold a URL a load starts from (not the href of a link a reader follows)
  function loadingAttribute(tag, name) {
    if (!LOADING_ATTRIBUTES.has(name)) return null;
    if (name === "href" && (tag === "a" || tag === "area")) return null;
    return name;
  }
  const isHtmlSpace = c => c === " " || c === "\t" || c === "\n" || c === "\r" || c === "\f";

  // The start tags of HTML text, read in one pass as the HTML tokenizer reads them (a name, then attributes with a
  // quoted, unquoted or no value): [{ name, end, attributes: [{ name, valueStart, valueEnd, quote }] }]. A tag left
  // open at the end of the text is not given (the parsed tree is checked anyway).
  function startTags(html) {
    const tags = [];
    const n = html.length;
    let i = 0;
    while (i < n) {
      const lt = html.indexOf("<", i);
      if (lt < 0 || lt + 1 >= n) break;
      if (!/[a-zA-Z]/.test(html[lt + 1])) {
        i = lt + 1;
        continue;
      }
      let j = lt + 1;
      while (j < n && !isHtmlSpace(html[j]) && html[j] !== "/" && html[j] !== ">") j++;
      const tag = { name: html.slice(lt + 1, j).toLowerCase(), attributes: [] };
      let closed = false;
      while (j < n) {
        while (j < n && (isHtmlSpace(html[j]) || html[j] === "/")) j++;
        if (j >= n) break;
        if (html[j] === ">") {
          closed = true;
          j++;
          break;
        }
        const nameStart = j;
        j++;
        while (j < n && !isHtmlSpace(html[j]) && html[j] !== "/" && html[j] !== ">" && html[j] !== "=") j++;
        const attribute = { name: html.slice(nameStart, j).toLowerCase() };
        let k = j;
        while (k < n && isHtmlSpace(html[k])) k++;
        if (html[k] === "=") {
          k++;
          while (k < n && isHtmlSpace(html[k])) k++;
          if (html[k] === "\"" || html[k] === "'") {
            const close = html.indexOf(html[k], k + 1);
            if (close < 0) {
              j = n;
              break;
            }
            Object.assign(attribute, { valueStart: k + 1, valueEnd: close, quote: html[k] });
            j = close + 1;
          } else {
            let end = k;
            while (end < n && !isHtmlSpace(html[end]) && html[end] !== ">") end++;
            Object.assign(attribute, { valueStart: k, valueEnd: end, quote: "" });
            j = end;
          }
        }
        tag.attributes.push(attribute);
      }
      if (!closed) break;
      tag.end = j;
      tags.push(tag);
      i = j;
    }
    return tags;
  }

  // The message's HTML with the loads made safe (above), changed as text before it is ever parsed: a parsed element
  // must never hold such a URL, even before an attribute is changed. { html, changed: Set of attribute names }
  function inertHtml(html) {
    const changed = new Set();
    const edits = [];
    for (const tag of startTags(html)) {
      const value = attribute => (attribute.valueStart === undefined ? "" : decodeAttribute(html.slice(attribute.valueStart, attribute.valueEnd)));
      const rel = tag.attributes.find(attribute => attribute.name === "rel");
      const allowed = tag.name === "link" && rel && /\bstylesheet\b/i.test(value(rel)) ? SAFE_STYLESHEET_SCHEMES : SAFE_SCHEMES;
      for (const attribute of tag.attributes) {
        const name = loadingAttribute(tag.name, attribute.name);
        if (!name || attribute.valueStart === undefined) continue;
        const inert = URL_LISTS.has(name) ? inertSrcset(value(attribute)) : inertUrl(value(attribute), allowed);
        if (inert === null) continue;
        changed.add(name);
        const q = attribute.quote ? 1 : 0;
        edits.push([attribute.valueStart - q, attribute.valueEnd + q, `"${encodeAttribute(inert)}"`]);
      }
    }
    let out = "", at = 0;
    for (const [start, end, text] of edits) {
      out += html.slice(at, start) + text;
      at = end;
    }
    return { html: out + html.slice(at), changed };
  }

  // Checks a parsed message document, without changing it: { ok: true } or { error }
  function checkLoads(parsed, own, changed) {
    const { DOC, EL } = own;
    const styleTexts = [];
    for (const el of Array.from(DOC.querySelectorAll.call(parsed, "*"))) {
      const tag = EL.localName.call(el);
      if (tag === "style") styleTexts.push(own.NODE.textContent.call(el));
      // A Link header given in a <meta> could start a preload; a refresh would navigate to its URL (the sandbox should
      // stop it: not trusted with a message URL)
      if (tag === "meta") {
        const equiv = (EL.getAttribute.call(el, "http-equiv") || "").trim().toLowerCase();
        if (equiv === "link") return { error: "meta Link" };
        const target = /url\s*=\s*["']?([^"';]*)/i.exec(EL.getAttribute.call(el, "content") || "");
        if (equiv === "refresh" && target && inertUrl(target[1], SAFE_SCHEMES)) return { error: "meta refresh" };
      }
      // SVG animation (SMIL) sets attributes while the document runs, URLs included, after every check here
      if (ANIMATION_TAGS.has(tag)) return { error: "SVG animation" };
      const stylesheet = tag === "link" && /\bstylesheet\b/i.test(EL.getAttribute.call(el, "rel") || "");
      for (const attr of Array.from(EL.attributes.call(el))) {
        const name = own.ATTR.name.call(attr).toLowerCase();
        const value = own.ATTR.value.call(attr);
        if (name === "srcdoc") return { error: "srcdoc frame" };
        if ((name === "style" || /url\(/i.test(value)) && cssLoadsUnsafeUrl(value)) return { error: "message URL in a style" };
        if (!loadingAttribute(tag, name)) continue;
        const unsafe = URL_LISTS.has(name) ? inertSrcset(value) : inertUrl(value, stylesheet ? SAFE_STYLESHEET_SCHEMES : SAFE_SCHEMES);
        if (unsafe !== null) return { error: "message URL left in " + name };
      }
    }
    for (const css of styleTexts) if (cssLoadsUnsafeUrl(css)) return { error: "message URL in a style sheet" };
    if (changed.size) {
      const css = cssUnescape(stripCssComments(styleTexts.join("\n"))).toLowerCase();
      if (/\battr\(/.test(css)) return { error: "attr() in a style sheet" };
      for (const name of changed) {
        const local = name.replace(/^xlink:/, "").replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
        if (new RegExp(`\\[\\s*(?:[\\w*-]*\\|)?${local}\\s*[\\]~|^$*=]`).test(css)) return { error: `selector on ${name}` };
      }
    }
    return { ok: true };
  }

  function loadFrame(job) {
    return new Promise((resolve, reject) => {
      const frame = document.createElement("iframe");
      // Set before the frame is in the document and before it gets its URL
      frame.setAttribute("sandbox", "allow-same-origin");
      frame.setAttribute("width", String(job.width));
      frame.setAttribute("height", String(job.height));
      // Laid out (never display:none, which leaves no computed style), out of sight
      frame.style.cssText = "position:absolute;left:0;top:0;border:0;visibility:hidden";
      const url = URL.createObjectURL(new Blob([frameHtml()], { type: "text/html" }));
      const timer = setTimeout(() => {
        URL.revokeObjectURL(url);
        frame.remove();
        reject(new Error("load timeout"));
      }, LOAD_TIMEOUT_MS);
      frame.addEventListener("load", () => {
        clearTimeout(timer);
        URL.revokeObjectURL(url);
        resolve(frame);
      }, { once: true });
      frame.src = url;
      document.body.appendChild(frame);
    });
  }

  async function render(job) {
    // The message's document with its loads made safe, parsed apart (no load, no script), checked
    const safe = inertHtml(job.html);
    const parsed = new DOMParser().parseFromString(safe.html, "text/html");
    if (!parsed.documentElement) return { ok: false, error: "no message document" };
    const checked = checkLoads(parsed, domAccess(globalThis), safe.changed);
    if (checked.error) return { ok: false, error: checked.error };
    const frame = await loadFrame(job);
    try {
      const win = frame.contentWindow;
      const doc = frame.contentDocument;
      if (!win || !doc) throw new Error("no document");
      const dom = domAccess(win);
      const { DOC, EL, IMG } = dom;
      const root = DOC.importNode.call(doc, parsed.documentElement, true);
      dom.NODE.replaceChild.call(doc, root, DOC.documentElement.call(doc));
      // Thunderbird's own style sheets (messageBody.css and what it imports) load now
      await settled(Array.from(DOC.querySelectorAll.call(doc, "link")).map(link => new Promise(resolve => {
        if (link.sheet) resolve();
        link.addEventListener("load", resolve, { once: true });
        link.addEventListener("error", resolve, { once: true });
      })), SHEET_TIMEOUT_MS);
      // As the message pane does once a message is loaded (msgHdrView.js): images outside links can shrink to fit
      const images = Array.from(DOC.images.call(doc));
      for (const img of images) if (!EL.closest.call(img, "[href]")) EL.toggleAttribute.call(img, "shrinktofit", true);
      // Images of the message's own parts, which this page cannot load: their content comes through a style sheet
      // that no selector of the message can see, in a layer, below every rule of the message.
      const naturalWidths = new Map();
      if (job.parts.length) {
        const rules = [];
        for (const [original, data] of job.parts) {
          const src = inertUrl(original, SAFE_SCHEMES) || original;
          const probe = DOC.createElement.call(doc, "img");
          probe.src = data;
          try {
            await IMG.decode.call(probe);
          } catch {
            continue;
          }
          naturalWidths.set(src, IMG.naturalWidth.call(probe));
          rules.push(`img[src="${CSS.escape(src)}"]{content:url("${data}")}`);
        }
        if (rules.length) {
          const sheet = new win.CSSStyleSheet();
          sheet.replaceSync(`@layer commonpost-message-parts{${rules.join("")}}`);
          DOC.adoptedStyleSheets.call(doc).push(sheet);
        }
      }
      // Images that can load here (data:) load before their size is read
      await settled(images.map(img => IMG.decode.call(img).catch(() => {})), SHEET_TIMEOUT_MS);
      for (const img of images) {
        if (!EL.hasAttribute.call(img, "shrinktofit")) continue;
        const src = EL.getAttribute.call(img, "src") || "";
        const natural = naturalWidths.has(src) ? naturalWidths.get(src) : IMG.naturalWidth.call(img);
        EL.toggleAttribute.call(img, "overflowing", natural > EL.clientWidth.call(img));
      }
      // A frame laid out at another size than asked would judge another page
      if (win.innerWidth !== job.width || win.innerHeight !== job.height) throw new Error("viewport");
      const found = units(doc, dom);
      const hidden = judge(doc, dom, found);
      const keys = [], hiddenUnits = [];
      found.forEach((unit, i) => {
        keys.push(unit.key);
        if (unit.nodes.some(n => hidden.has(n))) hiddenUnits.push(i);
      });
      return { ok: true, keys, hidden: hiddenUnits };
    } finally {
      frame.remove();
    }
  }

  // The onRender listener: always a plain object, never a throw (a parent awaiting fire.async gets it as is)
  async function renderJob(job) {
    try {
      const problem = checkJob(job);
      if (problem) return { ok: false, error: problem };
      if (!(await checkPolicy())) return { ok: false, error: "policy" };
      return await inSlot(() => render(job));
    } catch (e) {
      return { ok: false, error: String((e && e.message) || e).slice(0, 200) };
    }
  }

  if (typeof browser !== "undefined" && browser.commonpostMcp && browser.commonpostMcp.onRender) {
    browser.commonpostMcp.onRender.addListener(renderJob);
    checkPolicy();
  }
  return { domAccess, judge, units, renderJob, checkJob, frameHtml, inertUrl, inertSrcset, cssLoadsUnsafeUrl, inertHtml, checkLoads,
    parseRgb, contrast, intersect };
})();
