// Getting artwork in safely: sanitising SVG, measuring it, and turning files,
// text and shapes into canvas objects.

import { uid } from "./store.js";

export const SVG_NS = "http://www.w3.org/2000/svg";
const XLINK_NS = "http://www.w3.org/1999/xlink";

// Anything not listed is dropped with its children. No scripts, no foreignObject,
// no <style> (rules are inlined first), no animation.
const ALLOWED = new Set([
  "svg", "g", "path", "rect", "circle", "ellipse", "line", "polyline", "polygon", "text", "tspan",
  "defs", "use", "symbol", "lineargradient", "radialgradient", "stop", "clippath", "mask", "pattern", "image", "title", "desc",
]);
const UNWRAP = new Set(["a", "switch"]);
const SAFE_IMAGE = /^data:image\/(png|jpe?g|gif|webp);base64,/i;
const STYLE_PROPS = [
  "fill", "fill-opacity", "fill-rule", "stroke", "stroke-width", "stroke-opacity", "stroke-linecap", "stroke-linejoin",
  "stroke-dasharray", "opacity", "display", "visibility", "font-family", "font-size", "font-weight", "font-style", "text-anchor",
];

export function el(name, attrs = {}, parent) {
  const node = document.createElementNS(SVG_NS, name);
  for (const [key, value] of Object.entries(attrs)) if (value !== null && value !== undefined) node.setAttribute(key, value);
  if (parent) parent.appendChild(node);
  return node;
}

function cleanTree(root) {
  const walk = (node) => {
    for (const child of [...node.children]) {
      const name = child.localName.toLowerCase();
      if (child.namespaceURI !== SVG_NS || (!ALLOWED.has(name) && !UNWRAP.has(name))) {
        child.remove();
        continue;
      }
      if (UNWRAP.has(name)) {
        const group = child.ownerDocument.createElementNS(SVG_NS, "g");
        while (child.firstChild) group.appendChild(child.firstChild);
        child.replaceWith(group);
        walk(group);
        continue;
      }
      for (const attr of [...child.attributes]) {
        const key = attr.name.toLowerCase();
        const value = attr.value.trim();
        const isHref = key === "href" || key === "xlink:href";
        if (key.startsWith("on") || key === "class" || key.startsWith("xmlns:") || (attr.prefix && attr.prefix !== "xlink" && attr.prefix !== "xml")) {
          child.removeAttributeNode(attr);
        } else if (isHref) {
          // Only references inside the same drawing, or embedded bitmaps.
          const ok = value.startsWith("#") || (name === "image" && SAFE_IMAGE.test(value));
          child.removeAttributeNode(attr);
          if (ok) child.setAttribute("href", value);
        } else if (/url\s*\(\s*['"]?\s*(?!#)/i.test(value) || /javascript:/i.test(value)) {
          child.removeAttributeNode(attr);
        }
      }
      if (name === "image" && !child.hasAttribute("href")) {
        child.remove();
        continue;
      }
      walk(child);
    }
  };
  walk(root);
}

function parseSvg(text) {
  const doc = new DOMParser().parseFromString(text, "image/svg+xml");
  const root = doc.documentElement;
  if (!root || root.localName !== "svg" || doc.querySelector("parsererror")) {
    // Lenient second try: models sometimes emit HTML-ish SVG (unclosed tags, missing xmlns).
    const html = new DOMParser().parseFromString(text, "text/html");
    const found = html.querySelector("svg");
    if (!found) throw new Error("That doesn't look like an SVG drawing.");
    const again = new DOMParser().parseFromString(new XMLSerializer().serializeToString(found), "image/svg+xml");
    if (again.querySelector("parsererror")) throw new Error("That SVG couldn't be read.");
    return again.documentElement;
  }
  return root;
}

/** Copy the effect of <style> rules onto each element, so the rules can be dropped. */
async function inlineStyles(root) {
  const styles = [...root.querySelectorAll("style")];
  if (!styles.length) return;
  for (const style of styles) {
    // Keep the rules but nothing that could fetch from the network.
    style.textContent = style.textContent.replace(/@import[^;]*;?/gi, "").replace(/url\s*\(\s*['"]?\s*(?!#)[^)]*\)/gi, "none");
  }
  const frame = document.createElement("iframe");
  frame.setAttribute("sandbox", "allow-same-origin"); // no scripts can run in here
  frame.style.cssText = "position:fixed;left:-10000px;top:0;width:800px;height:800px;visibility:hidden";
  document.body.appendChild(frame);
  try {
    const doc = frame.contentDocument;
    const live = doc.importNode(root, true);
    for (const node of live.querySelectorAll("script, foreignObject, image")) node.remove();
    doc.body.appendChild(live);
    const source = [root, ...root.querySelectorAll("*")];
    const mirror = [live, ...live.querySelectorAll("*")];
    // The clone lost its images, so walk by matching structure, skipping those.
    const targets = source.filter((node) => !node.closest("script, foreignObject, image"));
    if (targets.length === mirror.length) {
      targets.forEach((node, i) => {
        // Rules can match by tag or id as well as class, so resolve every drawn element.
        if (node.localName === "style" || node.closest("defs")) return;
        const computed = frame.contentWindow.getComputedStyle(mirror[i]);
        for (const prop of STYLE_PROPS) {
          const value = computed.getPropertyValue(prop);
          if (value) node.setAttribute(prop, value);
        }
      });
    }
  } finally {
    frame.remove();
  }
}

const WHITE = /^(#fff(fff)?|white|rgba?\(\s*255\s*,\s*255\s*,\s*255\s*(,\s*1(\.0*)?\s*)?\))$/i;

/**
 * Drawing apps often export a white rectangle the size of the page. It engraves
 * as nothing, but on a line layer it would be cut as a box around the design.
 * Returns true if one was removed.
 */
function dropPageBackground(root) {
  const vb = (root.getAttribute("viewBox") || "").trim().split(/[\s,]+/).map(Number);
  const first = [...root.querySelectorAll("path, rect, circle, ellipse, line, polyline, polygon, text, image, use")].find((node) => !node.closest("defs, clipPath, mask, pattern, symbol"));
  if (!first || first.localName !== "rect" || first.closest("[transform]")) return false;
  const style = first.getAttribute("style") || "";
  const prop = (name) => (new RegExp(`(?:^|;)\\s*${name}\\s*:\\s*([^;]+)`).exec(style)?.[1] ?? first.getAttribute(name) ?? "").trim();
  const stroke = prop("stroke");
  if (!WHITE.test(prop("fill")) || (stroke && stroke !== "none")) return false;
  const size = (name, full) => {
    const value = first.getAttribute(name) || "0";
    return value.trim().endsWith("%") ? (parseFloat(value) / 100) * full : parseFloat(value);
  };
  if (vb.length !== 4 || vb.some((n) => !Number.isFinite(n))) return false;
  const covers = size("x", vb[2]) <= vb[0] + vb[2] * 0.01 && size("y", vb[3]) <= vb[1] + vb[3] * 0.01 && size("width", vb[2]) >= vb[2] * 0.98 && size("height", vb[3]) >= vb[3] * 0.98;
  if (!covers) return false;
  first.remove();
  return true;
}

/** Parse untrusted SVG text into a clean <svg> element. */
export async function sanitizeSvg(text) {
  const root = parseSvg(text);
  // Anything active goes before the drawing is rendered anywhere, even in the sandbox.
  for (const node of root.querySelectorAll("script, foreignObject, iframe, object, embed, audio, video")) node.remove();
  for (const node of [root, ...root.querySelectorAll("*")]) {
    for (const attr of [...node.attributes]) if (attr.name.toLowerCase().startsWith("on")) node.removeAttributeNode(attr);
  }
  await inlineStyles(root);
  cleanTree(root);
  if (dropPageBackground(root)) root.setAttribute("data-background-removed", "1");
  return root;
}

/** Clean inner markup that was already an object's content (project files, saved state). */
export function sanitizeMarkup(markup) {
  const doc = new DOMParser().parseFromString(`<svg xmlns="${SVG_NS}">${markup}</svg>`, "image/svg+xml");
  if (doc.querySelector("parsererror")) return "";
  cleanTree(doc.documentElement);
  return innerMarkup(doc.documentElement);
}

function innerMarkup(node) {
  const serializer = new XMLSerializer();
  return [...node.childNodes].map((child) => serializer.serializeToString(child)).join("").replaceAll(` xmlns="${SVG_NS}"`, "");
}

// --- measuring -----------------------------------------------------------------

let ruler = null;
function measure(markup, viewBox) {
  if (!ruler) {
    ruler = el("svg", { width: 10, height: 10, "aria-hidden": "true" });
    ruler.style.cssText = "position:fixed;left:-10000px;top:0;visibility:hidden;pointer-events:none";
    document.body.appendChild(ruler);
  }
  if (viewBox) ruler.setAttribute("viewBox", viewBox.join(" "));
  else ruler.removeAttribute("viewBox");
  ruler.innerHTML = `<g>${markup}</g>`;
  let box = null;
  try {
    const b = ruler.firstChild.getBBox();
    if (b.width > 0 || b.height > 0) box = [b.x, b.y, b.width, b.height];
  } catch {
    /* nothing measurable */
  }
  ruler.innerHTML = "";
  return box;
}

/** Bounding box [x, y, w, h] of some SVG markup as the browser lays it out, or null if it draws nothing. */
export const measureMarkup = (markup) => measure(markup, null);

const UNIT_MM = { mm: 1, cm: 10, in: 25.4, pt: 25.4 / 72, pc: 25.4 / 6, px: 25.4 / 96, "": 25.4 / 96 };
function lengthMm(value) {
  const match = /^\s*([\d.eE+-]+)\s*(mm|cm|in|pt|pc|px)?\s*$/.exec(value || "");
  if (!match) return null;
  const n = parseFloat(match[1]);
  return Number.isFinite(n) && n > 0 ? n * UNIT_MM[match[2] || ""] : null;
}

const ROOT_STYLE = ["fill", "fill-rule", "stroke", "stroke-width", "stroke-linecap", "stroke-linejoin", "opacity", "font-family", "font-size", "font-weight", "text-anchor", "transform"];

/** Sanitised <svg> element to object content: inner markup, tight viewBox and natural size in mm. */
export function contentFromSvg(root) {
  let vb = (root.getAttribute("viewBox") || "").trim().split(/[\s,]+/).map(Number);
  const widthMm = lengthMm(root.getAttribute("width"));
  const heightMm = lengthMm(root.getAttribute("height"));
  if (vb.length !== 4 || vb.some((n) => !Number.isFinite(n)) || vb[2] <= 0 || vb[3] <= 0) {
    const w = parseFloat(root.getAttribute("width")) || 100;
    const h = parseFloat(root.getAttribute("height")) || 100;
    vb = [0, 0, w, h];
  }
  // mm per user unit. With no physical size given, assume CSS pixels.
  const scale = widthMm ? widthMm / vb[2] : heightMm ? heightMm / vb[3] : UNIT_MM.px;
  // Presentation set on the root is inherited by everything, so carry it along.
  const inherited = ROOT_STYLE.filter((key) => key !== "transform" && root.hasAttribute(key)).map((key) => `${key}="${root.getAttribute(key).replaceAll('"', "&quot;")}"`);
  let markup = innerMarkup(root);
  if (inherited.length) markup = `<g ${inherited.join(" ")}>${markup}</g>`;
  // Crop to what's actually drawn: the laser cares about the artwork, not the page.
  const box = measure(markup, vb) || vb;
  return { svg: markup, vb: box.map((n) => +n.toFixed(4)), w: Math.max(box[2] * scale, 0.1), h: Math.max(box[3] * scale, 0.1) };
}

/** Fit a natural size inside the bed, leaving some room to move. */
export function fitSize(w, h, bed, share = 0.7) {
  const k = Math.min(1, (bed.w * share) / w, (bed.h * share) / h);
  return { w: w * k, h: h * k };
}

export async function objectFromSvgText(text, name = "Design") {
  const root = await sanitizeSvg(text);
  const content = contentFromSvg(root);
  const obj = { id: uid("o"), kind: "svg", name, rot: 0, x: 0, y: 0, ...content };
  // Not saved with the object; lets the caller tell the person what was changed.
  Object.defineProperty(obj, "backgroundRemoved", { value: root.hasAttribute("data-background-removed"), enumerable: false });
  return obj;
}

export function objectFromImage(dataUrl, name = "Image") {
  return new Promise((resolve, reject) => {
    if (!SAFE_IMAGE.test(dataUrl)) return reject(new Error("That image type isn't supported. Use PNG, JPEG, GIF or WebP."));
    const img = new Image();
    img.onload = () => {
      const w = img.naturalWidth, h = img.naturalHeight;
      resolve({
        id: uid("o"), kind: "image", name, rot: 0, x: 0, y: 0,
        svg: `<image href="${dataUrl}" width="${w}" height="${h}" preserveAspectRatio="none"/>`,
        vb: [0, 0, w, h], w: w * UNIT_MM.px, h: h * UNIT_MM.px,
      });
    };
    img.onerror = () => reject(new Error("That image couldn't be read."));
    img.src = dataUrl;
  });
}

const escapeXml = (text) => text.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;");

export const FONTS = [
  ["Sans", "Helvetica, Arial, sans-serif"],
  ["Serif", "Georgia, 'Times New Roman', serif"],
  ["Mono", "'Courier New', Courier, monospace"],
  ["Rounded", "'Arial Rounded MT Bold', 'Trebuchet MS', sans-serif"],
  ["Script", "'Brush Script MT', 'Segoe Script', cursive"],
  ["Impact", "Impact, 'Arial Black', sans-serif"],
  ["Verdana", "Verdana, Geneva, sans-serif"],
  ["Tahoma", "Tahoma, 'Segoe UI', sans-serif"],
  ["Trebuchet", "'Trebuchet MS', Tahoma, sans-serif"],
  ["Gill Sans", "'Gill Sans', 'Gill Sans MT', Calibri, sans-serif"],
  ["Futura", "Futura, 'Century Gothic', 'Trebuchet MS', sans-serif"],
  ["Palatino", "Palatino, 'Palatino Linotype', 'Book Antiqua', serif"],
  ["Garamond", "Garamond, 'EB Garamond', 'Times New Roman', serif"],
  ["Bookman", "'Bookman Old Style', Bookman, Georgia, serif"],
  ["Didot", "Didot, 'Bodoni MT', 'Playfair Display', serif"],
  ["Courier", "'Courier New', Courier, monospace"],
  ["Lucida Console", "'Lucida Console', 'Lucida Sans Typewriter', Monaco, monospace"],
  ["Comic", "'Comic Sans MS', 'Comic Neue', cursive"],
  ["Marker", "'Marker Felt', 'Chalkboard SE', 'Comic Sans MS', cursive"],
  ["Papyrus", "Papyrus, 'Herculanum', fantasy"],
  ["Copperplate", "Copperplate, 'Copperplate Gothic Light', fantasy"],
  ["Brush", "'Lucida Handwriting', 'Apple Chancery', 'Segoe Script', cursive"],
];

/** Build the SVG for a text object and measure it. Returns {svg, vb}. */
export function textContent(text) {
  const lines = (text.value || " ").split("\n");
  const spans = lines.map((line, i) => `<tspan x="0" dy="${i ? "1.2em" : "0"}">${escapeXml(line) || " "}</tspan>`).join("");
  const svg = `<text x="0" y="0" font-family="${escapeXml(text.font)}" font-size="100" font-weight="${text.bold ? 700 : 400}" font-style="${text.italic ? "italic" : "normal"}" fill="#000" xml:space="preserve">${spans}</text>`;
  const vb = measure(svg, null) || [0, -80, 100 * Math.max(1, text.value.length) * 0.5, 100];
  return { svg, vb: vb.map((n) => +n.toFixed(3)) };
}

export function objectFromText(text, heightPerLine = 12) {
  const content = textContent(text);
  const lines = text.value.split("\n").length;
  const h = heightPerLine * lines;
  return { id: uid("o"), kind: "text", name: text.value.split("\n")[0].slice(0, 24) || "Text", rot: 0, x: 0, y: 0, text: { ...text }, ...content, h, w: (h * content.vb[2]) / content.vb[3] };
}

export function objectFromShape(shape, size = 40) {
  const svg = shape === "ellipse" ? '<ellipse cx="50" cy="50" rx="50" ry="50" fill="#000"/>' : '<rect x="0" y="0" width="100" height="100" fill="#000"/>';
  return { id: uid("o"), kind: "shape", name: shape === "ellipse" ? "Ellipse" : "Rectangle", rot: 0, x: 0, y: 0, svg, vb: [0, 0, 100, 100], w: size, h: size };
}

/**
 * Give ids inside one object's artwork a unique prefix and repoint references,
 * so two designs that both define "#a" don't collide in the page.
 */
export function scopeIds(container, prefix) {
  const map = new Map();
  for (const node of container.querySelectorAll("[id]")) {
    const next = `${prefix}-${node.id}`;
    map.set(node.id, next);
    node.id = next;
  }
  if (!map.size) return;
  for (const node of container.querySelectorAll("*")) {
    for (const attr of [...node.attributes]) {
      if (attr.name === "href" && attr.value.startsWith("#")) {
        const next = map.get(attr.value.slice(1));
        if (next) node.setAttribute("href", `#${next}`);
      } else if (attr.value.includes("url(")) {
        node.setAttribute(attr.name, attr.value.replace(/url\(\s*['"]?#([^)'"]+)['"]?\s*\)/g, (all, id) => (map.has(id) ? `url(#${map.get(id)})` : all)));
      }
    }
  }
}

export { XLINK_NS };
