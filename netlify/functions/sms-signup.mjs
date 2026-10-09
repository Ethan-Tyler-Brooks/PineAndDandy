// Returning-guest SMS opt-in. Public: POST /api/sms/signup. Manager: GET /api/sms/list (x-ops-key).
// Each signup is stored with the exact consent language shown, timestamp, IP and user agent as proof of consent.
import { store, json, sha256Hex } from "../lib/ops.mjs";

async function checkKey(req, s) {
  const key = req.headers.get("x-ops-key") || new URL(req.url).searchParams.get("k") || "";
  if (!key) return false;
  const auth = await s.get("config/auth", { type: "json" });
  if (!auth) return false;
  return (await sha256Hex(auth.salt + key)) === auth.hash;
}

const clean = (v, n = 120) => String(v ?? "").replace(/[\u0000-\u001f]/g, " ").trim().slice(0, n);

export default async (req) => {
  const s = store();
  const path = new URL(req.url).pathname.replace(/^.*\/(api\/sms|sms-signup)\/?/, "");

  if (req.method === "POST" && (path === "signup" || path === "")) {
    let b;
    try { b = await req.json(); } catch { return json({ error: "bad json" }, 400); }
    if (b.website) return json({ ok: true }); // honeypot
    let d = String(b.phone || "").replace(/\D/g, "");
    if (d.length === 11 && d[0] === "1") d = d.slice(1);
    if (d.length !== 10 || /^[01]/.test(d)) return json({ error: "invalid phone" }, 400);
    if (b.consent !== true) return json({ error: "consent required" }, 400);
    const first = clean(b.first, 60);
    if (!first) return json({ error: "first name required" }, 400);
    const phone = "+1" + d;
    const key = `sms/${phone}`;
    const prev = await s.get(key, { type: "json" });
    const now = new Date().toISOString();
    const rec = {
      phone, first, last: clean(b.last, 60), cabin: clean(b.cabin, 40),
      status: "opted_in", source: "web",
      consentText: clean(b.consentText, 1200), page: clean(b.page, 300),
      ip: req.headers.get("x-nf-client-connection-ip") || req.headers.get("x-forwarded-for") || "",
      userAgent: clean(req.headers.get("user-agent"), 300),
      createdAt: prev?.createdAt || now, updatedAt: now,
      history: [...(prev?.history || []), { at: now, event: "web_opt_in" }].slice(-20),
    };
    await s.setJSON(key, rec);
    return json({ ok: true });
  }

  if (req.method === "GET" && path === "list") {
    if (!(await checkKey(req, s))) return json({ error: "unauthorized" }, 401);
    const { blobs } = await s.list({ prefix: "sms/" });
    const rows = [];
    for (const b of blobs) { const r = await s.get(b.key, { type: "json" }); if (r) rows.push(r); }
    rows.sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1));
    return json({ count: rows.length, signups: rows });
  }

  return json({ error: "not found" }, 404);
};
