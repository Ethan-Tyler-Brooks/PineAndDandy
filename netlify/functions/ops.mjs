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
    await alertTicket(ticket, prop);
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

// ---------- ticket alert texts (Molly: supplies; Ethan: repairs + hot tub supplies) ----------
// Posts to a Make webhook (URL in Netlify env OPS_ALERT_WEBHOOK, never in this public repo).
// The Make scenario sends via Quo from the cabin line; recipient numbers are fixed there.
const HYPE = [
  "Mahjong queen, certified bookworm, future therapist, mom of 3, AND she orders the toilet paper. Is there anything you can't do? 🀄📚",
  "Pung! Kong! Mahjong! ...and also paper towels. You win every round. 🀄",
  "Plot twist: the main character of this book is YOU. Chapter 47: She Restocks the Cabin and Saves the Day. 📖",
  "Future licensed counselor tip: ordering supplies is a healthy coping skill. You're basically already certified. 🧠💛",
  "How does that make you feel? (Correct answer: AMAZING, because you're crushing it.) 🛋️",
  "Three kids, grad school, two cabins, and still the coolest person in every room. Someone give this woman a parade. 🎉",
  "Your kids think you're a superhero. The cabins think you're a superhero. Ethan definitely thinks you're a superhero. 🦸‍♀️",
  "Passport stamps: many. Mahjong tiles: mastered. Cabin supplies: handled. Next destination: GREATNESS. ✈️",
  "Wanderlust level: expert. Restock level: expert. Being awesome: off the charts. 🌍",
  "Somewhere a paper towel roll just whispered your name. Legend.",
  "Breaking news: local woman too amazing, cabins report record happiness. 📰",
  "This text was sent with 0 cringe. (Lie. Maximum cringe. Love you.) 😘",
  "Dust bunnies flee. Toilet paper bows. You're that girl.",
  "Five-star reviews don't write themselves. Oh wait, yours basically do. ⭐⭐⭐⭐⭐",
  "Pine & Dandy runs on coffee, firewood, and you. Mostly you. ☕🪵",
  "Roses are red, the cabin's a gem, you order the stuff, and we all say amen. 🌹",
  "Fun fact: you could study for an exam, referee 3 kids, AND win a mahjong game all before lunch. Science. 🔬",
  "If this restock were a novel, it'd be a bestseller. Because you're the author. 📚✨",
  "Mental health counselor in training, cabin boss in reality. Ethan is a lucky dude.",
  "Rate your day: 10/10, would host again, would travel again, would mahjong again. 💪",
];
const smsSafe = (v) => String(v || "").replace(/[\\"]/g, "'").replace(/[\r\n\t]+/g, " ").replace(/[\u0000-\u001f]/g, "").trim();

// Ethan's texts (repairs, hot tub supplies) close with a random passage from these 200 popular
// references. ESV wording is copyrighted (Crossway), so it is fetched live from the ESV API
// (https://api.esv.org, key in Netlify env ESV_API_KEY) instead of being stored in this repo.
// Without a key, or if the API fails, a public-domain KJV line is used instead.
const VERSE_REFS = [
  "John 3:16", "Jeremiah 29:11", "Philippians 4:13", "Romans 8:28", "Proverbs 3:5-6", "Isaiah 41:10",
  "Philippians 4:6-7", "Matthew 28:19-20", "Joshua 1:9", "Romans 12:2", "Psalm 23:1-3", "Galatians 5:22-23",
  "2 Timothy 3:16-17", "Ephesians 2:8-9", "Matthew 11:28-30", "Hebrews 11:1", "1 Corinthians 10:13",
  "2 Corinthians 5:17", "John 14:6", "Isaiah 40:31", "Matthew 6:33", "Romans 5:8", "1 John 1:9",
  "Psalm 46:10", "Proverbs 18:10", "Hebrews 12:1-2", "Psalm 119:105", "Romans 10:9", "John 1:1",
  "John 16:33", "Lamentations 3:22-23", "Psalm 37:4", "Colossians 3:23", "Micah 6:8", "Matthew 5:16",
  "Psalm 34:8", "1 Peter 5:7", "Romans 15:13", "James 1:2-3", "James 1:5", "Psalm 121:1-2", "Psalm 27:1",
  "Deuteronomy 31:6", "Psalm 91:1-2", "Isaiah 26:3", "Philippians 4:8", "Psalm 51:10", "Matthew 22:37-39",
  "1 Corinthians 13:4-7", "Ecclesiastes 3:1", "Psalm 118:24", "Proverbs 16:3", "Proverbs 16:9",
  "Galatians 6:9", "Hebrews 13:8", "Hebrews 13:2", "1 Peter 4:9-10", "Romans 12:12", "Romans 12:10",
  "Romans 12:13", "Colossians 3:12", "Colossians 3:17", "Ephesians 4:32", "Ephesians 4:2-3",
  "Ephesians 3:20", "Ephesians 6:10", "Psalm 127:1", "Proverbs 24:3-4", "Matthew 6:34", "Matthew 7:7",
  "Matthew 5:14", "Matthew 5:9", "John 15:5", "John 15:13", "John 13:34-35", "John 10:10", "John 11:25",
  "John 8:12", "John 14:27", "John 14:1-2", "1 John 4:18", "1 John 4:19", "1 John 4:7", "1 John 3:18",
  "2 Corinthians 12:9", "2 Corinthians 4:16-18", "2 Corinthians 9:7", "2 Corinthians 9:8",
  "1 Thessalonians 5:16-18", "1 Thessalonians 5:11", "2 Thessalonians 3:13", "1 Timothy 4:12",
  "2 Timothy 1:7", "Titus 2:7", "Psalm 1:1-3", "Psalm 16:11", "Psalm 19:1", "Psalm 19:14", "Psalm 28:7",
  "Psalm 30:5", "Psalm 31:24", "Psalm 32:8", "Psalm 33:20-21", "Psalm 37:5", "Psalm 37:23-24",
  "Psalm 40:1-2", "Psalm 42:11", "Psalm 46:1", "Psalm 55:22", "Psalm 56:3", "Psalm 62:1-2", "Psalm 73:26",
  "Psalm 84:11", "Psalm 90:12", "Psalm 90:17", "Psalm 94:19", "Psalm 100:4-5", "Psalm 103:1-2",
  "Psalm 103:12", "Psalm 107:1", "Psalm 112:7", "Psalm 115:1", "Psalm 119:11", "Psalm 128:1-2",
  "Psalm 133:1", "Psalm 136:1", "Psalm 139:14", "Psalm 143:8", "Psalm 145:18", "Psalm 147:3", "Psalm 150:6",
  "Proverbs 1:7", "Proverbs 4:23", "Proverbs 10:4", "Proverbs 11:25", "Proverbs 12:25", "Proverbs 13:4",
  "Proverbs 14:23", "Proverbs 15:1", "Proverbs 16:24", "Proverbs 17:17", "Proverbs 17:22", "Proverbs 19:21",
  "Proverbs 21:5", "Proverbs 22:6", "Proverbs 27:17", "Proverbs 31:25", "Ecclesiastes 4:9-10",
  "Ecclesiastes 9:10", "Isaiah 9:6", "Isaiah 12:2", "Isaiah 30:15", "Isaiah 40:8", "Isaiah 40:29",
  "Isaiah 43:2", "Isaiah 43:19", "Isaiah 54:10", "Isaiah 55:8-9", "Isaiah 58:11", "Jeremiah 17:7-8",
  "Jeremiah 33:3", "Zephaniah 3:17", "Nahum 1:7", "Habakkuk 3:17-18", "Joshua 24:15", "Numbers 6:24-26",
  "Exodus 14:14", "Deuteronomy 7:9", "Deuteronomy 6:5", "1 Samuel 16:7", "1 Chronicles 16:11",
  "1 Chronicles 16:34", "2 Chronicles 7:14", "Nehemiah 8:10", "Job 19:25", "Ruth 1:16", "Genesis 1:1",
  "Genesis 50:20", "Matthew 6:26", "Matthew 19:26", "Matthew 25:21", "Mark 9:23", "Mark 10:45", "Mark 11:24",
  "Luke 1:37", "Luke 6:31", "Luke 6:38", "Luke 12:34", "Acts 1:8", "Acts 20:35", "Romans 1:16",
  "Romans 5:3-4", "Romans 8:1", "Romans 8:31", "Romans 8:38-39", "Romans 12:18", "Romans 13:8",
  "1 Corinthians 15:58", "1 Corinthians 16:13-14", "Galatians 2:20",
];
const KJV_FALLBACK = [
  "And whatsoever ye do, do it heartily, as to the Lord, and not unto men. (Colossians 3:23 KJV)",
  "Be strong and of a good courage; be not afraid, neither be thou dismayed: for the LORD thy God is with thee whithersoever thou goest. (Joshua 1:9 KJV)",
  "This is the day which the LORD hath made; we will rejoice and be glad in it. (Psalm 118:24 KJV)",
  "Be not forgetful to entertain strangers: for thereby some have entertained angels unawares. (Hebrews 13:2 KJV)",
  "Except the LORD build the house, they labour in vain that build it. (Psalm 127:1 KJV)",
];
const pick = (a) => a[Math.floor(Math.random() * a.length)];

async function verse() {
  const key = process.env.ESV_API_KEY;
  if (key) {
    const ref = pick(VERSE_REFS);
    try {
      const q = new URLSearchParams({
        q: ref, "include-passage-references": "false", "include-verse-numbers": "false",
        "include-first-verse-numbers": "false", "include-footnotes": "false", "include-headings": "false",
        "include-short-copyright": "false", "include-passage-horizontal-lines": "false", "include-heading-horizontal-lines": "false",
      });
      const r = await fetch("https://api.esv.org/v3/passage/text/?" + q, {
        headers: { Authorization: "Token " + key }, signal: AbortSignal.timeout(3000),
      });
      if (r.ok) {
        const d = await r.json();
        const text = String((d.passages || [])[0] || "").replace(/\s+/g, " ").trim();
        if (text) return `${text.slice(0, 600)} (${ref} ESV)`;
      }
    } catch (e) {
      console.error("ESV fetch failed", e && e.message);
    }
  }
  return pick(KJV_FALLBACK);
}

// Hot tub supplies go to Ethan, not Molly (she doesn't order them).
const HOT_TUB_RE = /hot\s*-?\s*tub|hottub|\bspa\b|chlorine|bromine|\bshock\b|test strips?|\bph\b|alkalinity|defoamer|tub (filter|cover)/i;

// Routing: repairs -> Ethan; hot tub supplies -> Ethan (with a verse); all other supplies -> Molly (with hype).
// "who" picks the route in the Make scenario; the actual phone numbers live only there.
async function alertTicket(t, prop) {
  const hook = process.env.OPS_ALERT_WEBHOOK;
  if (!hook) return;
  const text = [t.item, t.notes, t.location].join(" ");
  const hotTub = t.kind === "supply" && HOT_TUB_RE.test(text);
  const toEthan = t.kind === "repair" || hotTub;
  const urgent = t.urgency === "urgent" ? "URGENT " : "";
  const label = t.kind === "repair" ? "Repair ticket 🔧" : hotTub ? "Hot tub supply request 🛁" : "Supply alert 🛒";
  const verb = t.kind === "repair" ? "reports at" : "says";
  const what = t.kind === "repair" ? `${smsSafe(prop.name)}: ${smsSafe(t.item)}` : `${smsSafe(prop.name)} needs: ${smsSafe(t.item)}${t.qty ? " (" + smsSafe(t.qty) + ")" : ""}`;
  const parts = [`${urgent}${label} ${smsSafe(t.submittedBy)} ${verb} ${what}.`];
  if (t.location) parts.push(`Where: ${smsSafe(t.location)}.`);
  if (t.notes) parts.push(`Note: ${smsSafe(t.notes).slice(0, 300)}`);
  if (t.photo) parts.push("Photo attached in Ops.");
  parts.push(t.kind === "repair" ? "Details: thepineanddandy.com/ops/" : "Mark it ordered at thepineanddandy.com/ops/");
  let message = parts.join(" ");
  // Literal \n sequences become line breaks once Make embeds this in the JSON body.
  const closer = toEthan ? await verse() : pick(HYPE);
  message += "\\n\\n" + smsSafe(closer);
  try {
    await fetch(hook, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ message, who: toEthan ? "ethan" : "molly", ticket: t.id }),
      signal: AbortSignal.timeout(5000),
    });
  } catch (e) {
    console.error("ticket alert failed", e && e.message);
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
