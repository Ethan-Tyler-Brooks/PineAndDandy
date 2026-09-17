// Cabin Ops API. Public: config, ticket submit, ticket status. Manager routes need x-ops-key.
import {
  store, json, newId, sha256Hex, randomHex,
  getProperties, listDocs, ensureMaintenanceSeeded, syncLocks,
} from "../lib/ops.mjs";

const MAX_PHOTO_BYTES = 2_500_000;
const KINDS = new Set(["supply", "repair"]);
const URGENCY = new Set(["urgent", "normal", "low"]);
const STATUSES = new Set(["open", "ordered", "scheduled", "done", "dismissed"]);

const clip = (v, n) => (typeof v === "string" ? v.trim().slice(0, n) : "");

async function checkKey(req, s) {
  const key = req.headers.get("x-ops-key") || new URL(req.url).searchParams.get("k") || "";
  if (!key) return false;
  const auth = await s.get("config/auth", { type: "json" });
  if (!auth) return false;
  return (await sha256Hex(auth.salt + key)) === auth.hash;
}

async function readBody(req) {
  try { return await req.json(); } catch { return {}; }
}

function dataUrlToBytes(dataUrl) {
  const m = /^data:(image\/(?:jpeg|png|webp));base64,(.+)$/.exec(dataUrl || "");
  if (!m) return null;
  const buf = Buffer.from(m[2], "base64");
  if (buf.length > MAX_PHOTO_BYTES) return null;
  return { contentType: m[1], bytes: buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.length) };
}

export default async (req) => {
  const url = new URL(req.url);
  const route = url.pathname.replace(/^.*\/ops\/?/, "").replace(/\/+$/, ""); // e.g. "ticket/t_abc"
  const parts = route.split("/").filter(Boolean);
  const s = store();

  // ---------- public ----------
  if (req.method === "GET" && route === "config") {
    const props = (await getProperties(s)).filter((p) => p.active);
    const auth = await s.get("config/auth", { type: "json" });
    return json({
      properties: props.map(({ id, name, short, region }) => ({ id, name, short, region })),
      setupNeeded: !auth,
    });
  }

  if (req.method === "POST" && route === "ticket") {
    const b = await readBody(req);
    if (b.website) return json({ ok: true }); // honeypot
    const props = await getProperties(s);
    const prop = props.find((p) => p.id === b.property && p.active);
    if (!prop) return json({ error: "Pick a property" }, 400);
    if (!KINDS.has(b.kind)) return json({ error: "Pick supplies or repair" }, 400);
    const item = clip(b.item, 200);
    if (!item) return json({ error: "Say what's needed" }, 400);
    const id = newId("t");
    const now = new Date().toISOString();
    let photo = false;
    if (b.photo) {
      const img = dataUrlToBytes(b.photo);
      if (img) {
        await s.set("photos/" + id, img.bytes, { metadata: { contentType: img.contentType } });
        photo = true;
      }
    }
    const ticket = {
      id, createdAt: now, property: prop.id, kind: b.kind, item,
      qty: clip(b.qty, 40),
      urgency: URGENCY.has(b.urgency) ? b.urgency : "normal",
      location: clip(b.location, 120),
      notes: clip(b.notes, 2000),
      submittedBy: clip(b.submittedBy, 60) || "Cleaner",
      photo,
      status: "open", assignee: "", managerNotes: "",
      log: [{ status: "open", at: now }],
      doneAt: null,
    };
    await s.setJSON("tickets/" + id, ticket);
    return json({ ok: true, id, createdAt: now });
  }

  if (req.method === "GET" && parts[0] === "ticket" && parts[1] && parts[2] === "status") {
    const t = await s.get("tickets/" + parts[1], { type: "json" });
    if (!t) return json({ error: "not found" }, 404);
    return json({ id: t.id, status: t.status, item: t.item, property: t.property, createdAt: t.createdAt, doneAt: t.doneAt });
  }

  if (req.method === "POST" && route === "setup") {
    const existing = await s.get("config/auth", { type: "json" });
    if (existing) return json({ error: "Already set up" }, 409);
    const b = await readBody(req);
    const pass = clip(b.passphrase, 200);
    if (pass.length < 6) return json({ error: "Passphrase needs at least 6 characters" }, 400);
    const salt = randomHex(16);
    await s.setJSON("config/auth", { salt, hash: await sha256Hex(salt + pass), createdAt: new Date().toISOString() });
    return json({ ok: true });
  }

  // ---------- manager (passphrase) ----------
  if (!(await checkKey(req, s))) return json({ error: "unauthorized" }, 401);

  if (req.method === "GET" && route === "state") {
    const properties = await getProperties(s);
    const [tickets, maintenance, deviceDays, secrets] = await Promise.all([
      listDocs("tickets/", s),
      ensureMaintenanceSeeded(properties, s),
      listDocs("devices/", s),
      s.get("config/secrets", { type: "json" }),
    ]);
    tickets.sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1));
    deviceDays.sort((a, b) => (a.date < b.date ? -1 : 1));
    return json({
      properties, tickets, maintenance, devices: deviceDays,
      hasHospitableToken: !!(secrets && secrets.hospitableToken),
      now: new Date().toISOString(),
    });
  }

  if (req.method === "GET" && parts[0] === "photo" && parts[1]) {
    const blob = await s.getWithMetadata("photos/" + parts[1], { type: "arrayBuffer" });
    if (!blob) return new Response("not found", { status: 404 });
    return new Response(blob.data, {
      headers: { "content-type": (blob.metadata && blob.metadata.contentType) || "image/jpeg", "cache-control": "private, max-age=3600" },
    });
  }

  if (req.method === "POST" && parts[0] === "ticket" && parts[1]) {
    const key = "tickets/" + parts[1];
    const t = await s.get(key, { type: "json" });
    if (!t) return json({ error: "not found" }, 404);
    const b = await readBody(req);
    const now = new Date().toISOString();
    if (b.status && STATUSES.has(b.status) && b.status !== t.status) {
      t.status = b.status;
      t.log.push({ status: b.status, at: now });
      t.doneAt = b.status === "done" ? now : t.status === "done" ? t.doneAt : null;
    }
    if (typeof b.assignee === "string") t.assignee = clip(b.assignee, 60);
    if (typeof b.managerNotes === "string") t.managerNotes = clip(b.managerNotes, 2000);
    if (typeof b.item === "string" && b.item.trim()) t.item = clip(b.item, 200);
    if (typeof b.qty === "string") t.qty = clip(b.qty, 40);
    if (b.urgency && URGENCY.has(b.urgency)) t.urgency = b.urgency;
    if (b.delete === true) {
      await s.delete(key);
      if (t.photo) await s.delete("photos/" + t.id);
      return json({ ok: true, deleted: true });
    }
    await s.setJSON(key, t);
    return json({ ok: true, ticket: t });
  }

  if (req.method === "POST" && route === "maintenance") {
    const b = await readBody(req);
    if (b.op === "delete" && b.id) {
      await s.delete("maint/" + b.id);
      return json({ ok: true });
    }
    if (b.op === "done" && b.id) {
      const m = await s.get("maint/" + b.id, { type: "json" });
      if (!m) return json({ error: "not found" }, 404);
      const at = /^\d{4}-\d{2}-\d{2}$/.test(b.date || "") ? b.date : new Date().toISOString().slice(0, 10);
      m.lastDone = at;
      m.history = [...(m.history || []), { at, note: clip(b.note, 300) }].slice(-40);
      await s.setJSON("maint/" + m.id, m);
      return json({ ok: true, item: m });
    }
    if (b.op === "upsert" && b.item) {
      const it = b.item;
      const id = clip(it.id, 40) || newId("m");
      const prev = (await s.get("maint/" + id, { type: "json" })) || { id, history: [], lastDone: null, source: "manual" };
      const m = {
        ...prev,
        id,
        property: clip(it.property, 40) || prev.property,
        name: clip(it.name, 120) || prev.name,
        intervalDays: Math.max(1, Math.min(3650, parseInt(it.intervalDays, 10) || prev.intervalDays || 90)),
        lastDone: /^\d{4}-\d{2}-\d{2}$/.test(it.lastDone || "") ? it.lastDone : (it.lastDone === null ? null : prev.lastDone),
        notes: typeof it.notes === "string" ? clip(it.notes, 500) : prev.notes || "",
      };
      if (!m.property || !m.name) return json({ error: "property and name required" }, 400);
      await s.setJSON("maint/" + id, m);
      return json({ ok: true, item: m });
    }
    return json({ error: "bad op" }, 400);
  }

  if (req.method === "POST" && route === "properties") {
    const b = await readBody(req);
    if (!Array.isArray(b.items) || !b.items.length) return json({ error: "items required" }, 400);
    const items = b.items.map((p) => ({
      id: clip(p.id, 30).toLowerCase().replace(/[^a-z0-9_-]/g, "") || newId("p"),
      name: clip(p.name, 80) || "Untitled",
      short: clip(p.short, 12) || clip(p.name, 12),
      region: p.region === "fl" ? "fl" : "wi",
      hospitableId: clip(p.hospitableId, 60),
      active: p.active !== false,
    }));
    await s.setJSON("config/properties", { items });
    return json({ ok: true, items });
  }

  if (req.method === "POST" && route === "secrets") {
    const b = await readBody(req);
    const cur = (await s.get("config/secrets", { type: "json" })) || {};
    if (typeof b.hospitableToken === "string") cur.hospitableToken = b.hospitableToken.trim();
    await s.setJSON("config/secrets", cur);
    return json({ ok: true, hasHospitableToken: !!cur.hospitableToken });
  }

  if (req.method === "POST" && route === "passphrase") {
    const b = await readBody(req);
    const pass = clip(b.passphrase, 200);
    if (pass.length < 6) return json({ error: "Passphrase needs at least 6 characters" }, 400);
    const salt = randomHex(16);
    await s.setJSON("config/auth", { salt, hash: await sha256Hex(salt + pass), changedAt: new Date().toISOString() });
    return json({ ok: true });
  }

  if (req.method === "POST" && route === "lock-sync") {
    return json(await syncLocks(s));
  }

  return json({ error: "no such route", route }, 404);
};
