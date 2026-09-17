// Cabin Ops — shared storage + logic for the ops function and the lock-sync scheduled function.
// Storage: Netlify Blobs store "cabin-ops". Keys:
//   config/auth        { salt, hash }                      manager passphrase (sha-256)
//   config/secrets     { hospitableToken }                 never returned to a client
//   config/properties  { items: [Property] }
//   tickets/<id>       Ticket
//   photos/<id>        image bytes (metadata.contentType)
//   maint/<id>         MaintenanceItem
//   devices/<date>     { date, readings: [Reading] }       one doc per sync day
import { getStore } from "@netlify/blobs";

export const store = () => getStore({ name: "cabin-ops", consistency: "strong" });

export const json = (data, status = 200, extra = {}) =>
  new Response(JSON.stringify(data), {
    status,
    headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store", ...extra },
  });

export const newId = (prefix) =>
  prefix + "_" + Date.now().toString(36) + Math.random().toString(36).slice(2, 7);

// ---- crypto helpers (Web Crypto; available in the Functions runtime) ----
const enc = new TextEncoder();
export async function sha256Hex(text) {
  const buf = await crypto.subtle.digest("SHA-256", enc.encode(text));
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, "0")).join("");
}
export const randomHex = (n = 16) =>
  [...crypto.getRandomValues(new Uint8Array(n))].map((b) => b.toString(16).padStart(2, "0")).join("");

// ---- defaults ----
export const DEFAULT_PROPERTIES = [
  { id: "og", name: "The O.G.", short: "OG", region: "wi", hospitableId: "dc163a80-a026-4bb1-8942-3dc597a4da9e", active: true },
  { id: "grandy", name: "The Grandy Dandy", short: "Grandy", region: "wi", hospitableId: "317d1040-86ab-4920-b27d-b11564b82412", active: true },
  { id: "dgt", name: "Dandy Good Time", short: "DGT", region: "wi", hospitableId: "", active: true },
  { id: "fl", name: "Florida Condo", short: "FL", region: "fl", hospitableId: "", active: false },
];

// Recurring maintenance seeded per property the first time the manager page loads.
// intervalDays; lastDone left null so everything reads "never logged" until Ethan marks it.
const SEED_MAINT = {
  common: [
    ["Furnace filter", 90],
    ["Smart lock batteries", 180],
    ["Smoke / CO detector batteries", 365],
    ["Water softener salt", 60],
    ["Dryer vent clean-out", 365],
    ["Fire extinguisher check", 365],
    ["Fridge coils vacuumed", 365],
    ["Gutters cleared", 180],
    ["Septic pumped", 1095],
  ],
  og: [
    ["Hot tub filter rinse", 30],
    ["Hot tub water change", 120],
  ],
  grandy: [
    ["Hot tub filter rinse", 30],
    ["Hot tub water change", 120],
    ["Sauna heater + stones check", 180],
  ],
  dgt: [],
  fl: [
    ["HVAC filter", 60],
    ["Smart lock batteries", 180],
    ["Smoke / CO detector batteries", 365],
  ],
};

export async function getProperties(s = store()) {
  const doc = await s.get("config/properties", { type: "json" });
  if (doc && Array.isArray(doc.items) && doc.items.length) return doc.items;
  await s.setJSON("config/properties", { items: DEFAULT_PROPERTIES });
  return DEFAULT_PROPERTIES;
}

export async function listDocs(prefix, s = store()) {
  const { blobs } = await s.list({ prefix });
  const docs = await Promise.all(blobs.map((b) => s.get(b.key, { type: "json" })));
  return docs.filter(Boolean);
}

export async function ensureMaintenanceSeeded(properties, s = store()) {
  const existing = await listDocs("maint/", s);
  if (existing.length) return existing;
  const items = [];
  for (const p of properties) {
    const seeds = [...(p.region === "fl" ? [] : SEED_MAINT.common), ...(SEED_MAINT[p.id] || [])];
    for (const [name, intervalDays] of seeds) {
      items.push({
        id: newId("m"),
        property: p.id,
        name,
        intervalDays,
        lastDone: null,
        notes: "",
        source: name === "Smart lock batteries" ? "lock" : "manual",
        history: [],
      });
    }
  }
  await Promise.all(items.map((m) => s.setJSON("maint/" + m.id, m)));
  return items;
}

// ---- Hospitable lock sync ----
export async function syncLocks(s = store()) {
  const secrets = (await s.get("config/secrets", { type: "json" })) || {};
  if (!secrets.hospitableToken) return { ok: false, error: "no_token" };
  const props = (await getProperties(s)).filter((p) => p.hospitableId);
  const readings = [];
  const errors = [];
  for (const p of props) {
    try {
      const r = await fetch(`https://public.api.hospitable.com/v2/properties/${p.hospitableId}/devices`, {
        headers: { Authorization: `Bearer ${secrets.hospitableToken}`, Accept: "application/json" },
      });
      if (!r.ok) {
        errors.push({ property: p.id, status: r.status });
        continue;
      }
      const body = await r.json();
      for (const d of body.data || []) {
        const st = d.state || {};
        readings.push({
          property: p.id,
          deviceId: d.id,
          name: d.name,
          type: d.device_type,
          manufacturer: d.manufacturer,
          online: !!st.online,
          locked: st.locked,
          pct: st.battery ? st.battery.percentage : null,
          status: st.battery ? st.battery.status : null,
          threshold: st.battery ? st.battery.threshold : null,
          issues: d.issues || [],
        });
      }
    } catch (e) {
      errors.push({ property: p.id, error: String(e.message || e) });
    }
  }
  const date = new Date().toISOString().slice(0, 10);
  await s.setJSON("devices/" + date, { date, at: new Date().toISOString(), readings, errors });
  // keep ~180 days
  const { blobs } = await s.list({ prefix: "devices/" });
  const keys = blobs.map((b) => b.key).sort();
  const stale = keys.slice(0, Math.max(0, keys.length - 180));
  await Promise.all(stale.map((k) => s.delete(k)));
  return { ok: true, date, readings: readings.length, errors };
}
