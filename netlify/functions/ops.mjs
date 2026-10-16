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
    if (ticket.kind === "supply") await alertMolly(ticket, prop);
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

  // Cleaner-side maintenance: read the schedule, log completions, add/edit items (no delete).
  if (req.method === "GET" && route === "maintenance") {
    const props = (await getProperties(s)).filter((p) => p.active);
    const active = new Set(props.map((p) => p.id));
    const items = (await ensureMaintenanceSeeded(props, s)).filter((m) => active.has(m.property));
    return json({ properties: props.map(({ id, name, short, region }) => ({ id, name, short, region })), items });
  }

  if (req.method === "POST" && route === "maintenance/cleaner") {
    const b = await readBody(req);
    if (b.website) return json({ ok: true }); // honeypot
    return handleMaint(b, s, { allowDelete: false });
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
    return handleMaint(await readBody(req), s, { allowDelete: true });
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

// ---------- supply alert text to Molly ----------
// Posts to a Make webhook (URL in Netlify env OPS_ALERT_WEBHOOK, never in this public repo).
// The Make scenario sends via Quo from the cabin line to Molly's number, which is fixed there.
const HYPE = [
  "You are the CEO of clean sheets and the Queen of Up North. 👑",
  "Somewhere a paper towel roll just whispered your name. Legend.",
  "Hospitality icon. Supply-chain goddess. Probably also a great parallel parker. 🚗",
  "Five-star reviews don't write themselves. Oh wait, yours basically do. ⭐⭐⭐⭐⭐",
  "Fun fact: 100% of cabins are happier when you're in charge. Science. 🔬",
  "You + a shopping cart = unstoppable. Go get 'em, tiger. 🐯",
  "The loons on the lake are cheering for you right now. Probably. 🦆",
  "Hot tub chemicals fear you. Dust bunnies flee. You're that girl.",
  "If being awesome were a supply, we'd never run out. Because of you. 💅",
  "Molly Brooks: wife, mom, mogul, restock royalty. Ethan is a lucky dude.",
  "Breaking news: local woman too amazing, cabins report record happiness. 📰",
  "This text was sent with 0 cringe. (Lie. Maximum cringe. Love you.) 😘",
  "You're the reason the toilet paper never runs out and the vibes never stop. 🧻✨",
  "Pine & Dandy runs on coffee, firewood, and you. Mostly you. ☕🪵",
  "Rate your day: 10/10, would host again. Keep crushing it! 💪",
  "Roses are red, the cabin's a gem, you order the stuff, and we all say amen. 🌹",
];
const smsSafe = (v) => String(v || "").replace(/[\\"]/g, "'").replace(/[\r\n\t]+/g, " ").replace(/[\u0000-\u001f]/g, "").trim();

async function alertMolly(t, prop) {
  const hook = process.env.OPS_ALERT_WEBHOOK;
  if (!hook) return;
  const urgent = t.urgency === "urgent" ? "URGENT " : "";
  const parts = [
    `${urgent}Supply alert 🛒 ${smsSafe(t.submittedBy)} says ${smsSafe(prop.name)} needs: ${smsSafe(t.item)}${t.qty ? " (" + smsSafe(t.qty) + ")" : ""}.`,
  ];
  if (t.location) parts.push(`Where: ${smsSafe(t.location)}.`);
  if (t.notes) parts.push(`Note: ${smsSafe(t.notes).slice(0, 300)}`);
  parts.push("Mark it ordered at thepineanddandy.com/ops/");
  const hype = HYPE[Math.floor(Math.random() * HYPE.length)];
  // Literal \n sequences become line breaks once Make embeds this in the JSON body.
  const message = parts.join(" ") + "\\n\\n" + smsSafe(hype);
  try {
    await fetch(hook, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ message, ticket: t.id }),
      signal: AbortSignal.timeout(5000),
    });
  } catch (e) {
    console.error("supply alert failed", e && e.message);
  }
}

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
async function handleMaint(b, s, { allowDelete }) {
  const by = clip(b.by, 60);
  if (b.op === "delete" && b.id) {
    if (!allowDelete) return json({ error: "not allowed" }, 403);
    await s.delete("maint/" + b.id);
    return json({ ok: true });
  }
  if (b.op === "done" && b.id) {
    const m = await s.get("maint/" + b.id, { type: "json" });
    if (!m) return json({ error: "not found" }, 404);
    const at = DATE_RE.test(b.date || "") ? b.date : new Date().toISOString().slice(0, 10);
    if (!m.lastDone || at >= m.lastDone) m.lastDone = at;
    m.history = [...(m.history || []), { at, note: clip(b.note, 300), by }].slice(-40);
    await s.setJSON("maint/" + m.id, m);
    return json({ ok: true, item: m });
  }
  if (b.op === "upsert" && b.item) {
    const it = b.item;
    const id = clip(it.id, 40) || newId("m");
    const prev = (await s.get("maint/" + id, { type: "json" })) || { id, history: [], lastDone: null, source: "manual", createdBy: by };
    const m = {
      ...prev,
      id,
      property: clip(it.property, 40) || prev.property,
      name: clip(it.name, 120) || prev.name,
      intervalDays: Math.max(1, Math.min(3650, parseInt(it.intervalDays, 10) || prev.intervalDays || 90)),
      lastDone: DATE_RE.test(it.lastDone || "") ? it.lastDone : (it.lastDone === null ? null : prev.lastDone),
      notes: typeof it.notes === "string" ? clip(it.notes, 500) : prev.notes || "",
      updatedBy: by,
    };
    if (!m.property || !m.name) return json({ error: "property and name required" }, 400);
    const props = await getProperties(s);
    if (!props.some((p) => p.id === m.property)) return json({ error: "unknown property" }, 400);
    await s.setJSON("maint/" + id, m);
    return json({ ok: true, item: m });
  }
  return json({ error: "bad op" }, 400);
}
