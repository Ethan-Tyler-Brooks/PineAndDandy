# Autonomous Publishing Playbook — The Northwoods Journal (Pine & Dandy)

Runbook for the scheduled Cowork task (Mon/Wed/Fri). One local-guide post per run,
published live (GitHub Ethan-Tyler-Brooks/PineAndDandy → Netlify,
https://www.thepineanddandy.com/journal/). Work in the sandbox shell; the Cowork mount
cannot run git.

## 0. Auth & checkout
- TOKEN from the Cowork mount: `.rcs-publish/gh_token_pinedandy_rmg`.
- Clone to the sandbox FS (e.g. /tmp/pnd), NOT the mount:
  `git clone https://x-access-token:<TOKEN>@github.com/Ethan-Tyler-Brooks/PineAndDandy.git`
- `git config user.name "Pine & Dandy Bot"` / `user.email "hello@thepineanddandy.com"`.
- Never print the token; mask with sed. Use the tokened URL only on push.

## 1. Topic
- Read CONTENT-CALENDAR.md; take the first `⬜` row. If none, generate a fresh
  Eagle-River / Northwoods travel topic not already covered.

## 2. Write the post — copy an existing guide page as the template
Use `journal/northwoods-fall-color-guide.html` (or `area-guide.html`) as the structural
template. These pages carry the full inline CSS/design — KEEP the entire head fonts +
`<style>` block, the `<header>` nav, the mobile menu, and the footer untouched. Swap only:
- The head SEO region (title, meta description, canonical, Open Graph, twitter) for the
  new URL `https://www.thepineanddandy.com/journal/<slug>.html`.
- TWO JSON-LD blocks in the head: an `Article` (headline, description, datePublished +
  dateModified = today, author + publisher Organization "Pine & Dandy",
  mainEntityOfPage = post URL, an `about` array, a `keywords` array) AND a `FAQPage`
  built from the post's 3 FAQ `<details>` questions.
- The `.ghero` section (image from /images/, back link to /journal/, eyebrow, h1, lede).
- The `.subnav` (keep the Journal/Area Guide/Where to Eat/Fishing/The Cabins row).
- The `<main class="wrap gwrap">` content: `.gsec` sections with `.eyebrow` + `<h2>`
  (phrased as real questions), a `.lede-lg` intro, `.season-grid`/`.card` blocks where
  useful, a `.callout` "where to stay" CTA, and a final `.gsec.faqg` FAQ section using
  `<details><summary>…</summary><div class="ans">…</div></details>` that matches the
  FAQPage schema. 600–900 words. Warm host voice. Clean keyword-rich slug.

## 3. Update surfaces
- New `journal/<slug>.html`.
- `journal/index.html` — add an `<a class="card" href="/journal/<slug>.html">…</a>` at the
  TOP of the `.season-grid`, and add a `BlogPosting` entry at the TOP of the head Blog
  JSON-LD `blogPost` array.
- `sitemap.xml` — add `<url><loc>https://www.thepineanddandy.com/journal/<slug>.html</loc><changefreq>monthly</changefreq><priority>0.7</priority></url>` before `</urlset>`.
- Nav already links to /journal/ on every page; no nav edits needed.

## 4. Calendar
- Flip the chosen row's status from `⬜` to `✅ Published`.

## 5. Validate → commit → push → verify
- Every JSON-LD block must json.loads cleanly; sitemap.xml must parse as XML. Fix before push.
- Commit, then `git push https://x-access-token:<TOKEN>@github.com/Ethan-Tyler-Brooks/PineAndDandy.git HEAD:main` (mask token).
- Wait ~40s, fetch the live post URL to confirm Netlify deployed.
- Report headline, live URL, word count, remaining ⬜ count.

## Notes
- Static site, no build step; Netlify auto-deploys pushes to main.
- Keep facts evergreen; never invent specific dates/prices/hours.
- If the account rejects the token, stop and surface the error; do not retry blindly.
