// The person's own materials: settings saved from a layer or picked from a test grid.
// Stored by the server in a file next to the app's settings.

import { state, emit, setMaterials, saveUi } from "./store.js";
import { api } from "./api.js";

export const OPS = [
  ["engrave", "Engrave", "fill"],
  ["score", "Score", "line"],
  ["cut", "Cut", "line"],
];

export const selectedMaterial = () => state.materials.find((m) => m.id === state.ui.materialId) || null;

export function today() {
  const d = new Date();
  const pad = (n) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

const slug = (name) => name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 40) || "material";
const newId = (name) => `my-${slug(name)}-${Math.random().toString(36).slice(2, 6)}`;

function cleanSetting(s) {
  if (!s) return null;
  const out = { mode: s.mode, speed: s.speed, power: s.power, passes: s.passes || 1, source: s.source || "starting", date: s.date || "" };
  if (s.mode === "fill" && s.interval) out.interval = s.interval;
  return out;
}

const clean = (m) => ({ id: m.id, name: m.name.trim(), notes: (m.notes || "").trim(), engrave: cleanSetting(m.engrave), score: cleanSetting(m.score), cut: cleanSetting(m.cut) });

export async function putMaterial(material) {
  const { library } = await api(`/api/library/${material.id}`, { method: "PUT", body: clean(material) });
  setMaterials({ library });
  emit("config");
  return state.materials.find((m) => m.id === material.id);
}

export async function deleteMaterial(id) {
  const { library } = await api(`/api/library/${id}`, { method: "DELETE" });
  setMaterials({ library });
  if (state.ui.materialId === id) {
    state.ui.materialId = "";
    saveUi();
  }
  emit("config");
}

export async function createMaterial(name, notes = "") {
  const material = await putMaterial({ id: newId(name), name, notes });
  state.ui.materialId = material.id;
  saveUi();
  return material;
}

/**
 * The person's own entry for the material in use. A built-in starting point is
 * copied into their library first, so the built-in table itself never changes.
 */
export async function ownMaterial(nameIfNone = "") {
  const current = selectedMaterial();
  if (current?.mine) return current;
  const name = (current?.name || nameIfNone).trim();
  if (!name) throw new Error("Give the material a name first.");
  let material = state.materials.find((m) => m.mine && m.name.trim().toLowerCase() === name.toLowerCase());
  if (!material) {
    const copy = { id: newId(name), name, notes: current?.notes || "" };
    for (const [op] of OPS) if (current?.[op]) copy[op] = { ...current[op], source: "starting", date: "" };
    material = await putMaterial(copy);
  }
  state.ui.materialId = material.id;
  saveUi();
  return material;
}

/** Save one operation's settings to the material in use. Returns the updated material. */
export async function saveSetting(op, setting, nameIfNone = "") {
  const material = await ownMaterial(nameIfNone);
  return putMaterial({ ...material, [op]: { ...setting, date: today() } });
}

const shortDate = (iso) => {
  const d = new Date(`${iso}T12:00:00`);
  return Number.isNaN(d.getTime()) ? "" : d.toLocaleDateString(undefined, { day: "numeric", month: "short" });
};

export function describeSetting(s) {
  const parts = [`${s.speed} mm/min`, `${s.power}%`, s.passes === 1 ? "1 pass" : `${s.passes} passes`];
  if (s.mode === "fill" && s.interval) parts.push(`${s.interval} mm gap`);
  return parts.join(", ");
}

export function describeSource(s) {
  if (s.source === "test") return `picked from a test${s.date ? `, ${shortDate(s.date)}` : ""}`;
  if (s.source === "saved") return `saved${s.date ? ` ${shortDate(s.date)}` : ""}`;
  return "starting point, not tested";
}
