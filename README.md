# carcisautobody.com

Static marketing site for Carcis Autobody Repair LLC, Vancouver WA.

## Deployment

Cloudflare Pages, connected to this GitHub repo. Pushing to `main` publishes to
https://www.carcisautobody.com automatically. There is **no build command
configured in Cloudflare** — Pages uploads the repo root exactly as committed,
so the generated HTML has to be committed along with its sources.

Every other branch gets its own preview deployment. `staging` is the long-lived
one. See [docs/SETUP.md](docs/SETUP.md).

## Editing the site

The HTML files at the repo root, everything in `work/`, and `sitemap.xml` are
all **generated**. Do not edit them by hand; the next build overwrites them.

| Edit this | To change |
| --- | --- |
| `src/partials/` | head, header, nav, ticker, footer, shared on every page |
| `src/pages/` | one file per static page: its title, meta, JSON-LD, content |
| `src/templates/` | the layout of job pages and the work index |
| `content/jobs/` | one JSON file per completed repair |

Then rebuild and commit both the source and the generated output:

```
node build.js
```

To check nothing was left un-rebuilt before pushing:

```
node build.js --check
```

That same check runs on every pull request. The build has no dependencies and
needs no `npm install`; it uses only the Node standard library.

## Repair jobs

One JSON file in `content/jobs/` produces a page at `/work/<slug>.html`, a card
on `/work/`, a tile on the home page, and a sitemap entry. The four newest jobs
fill the home page gallery, and the newest one with both a before and an after
photo fills the drag-to-compare slider.

Everything that shows jobs sits inside `<!--#ifjobs-->` blocks, so before the
first job is published the Our Work nav item, the home page slider and
gallery, the services and estimate strips, the work index and the sitemap
entries all disappear together. An empty index linked from the nav is worse
than no link. Draft job pages are still generated so they can be reviewed from
the pull request.

Two fields decide visibility:

- `"draft": true` renders the page with `noindex` and keeps the job off the
  home page, the work index and the sitemap. Everything imported from the form
  starts this way.
- Deleting the JSON file deletes the generated page on the next build.

The build prints a warning for any live job with under 60 words of `story`,
because thin, near-identical pages are worse than no pages under Google's
helpful content policies.

## Jobs from the Google Form

Carlos and Kayla fill in the "Carcis job upload" form on their phone: the
vehicle, the work, a few sentences about the job, and the before and after
photos. Google puts the answers in a spreadsheet and the photos in Drive. A
scheduled workflow reads rows that have not been imported, downsizes the
photos into the repo, drafts the write-up with Gemini, and opens a pull
request. Nothing publishes without a person reading the draft and merging.

The vehicle, service and date on a generated job are the shop's own answers.
The title, summary, story and alt text are model output and need review.

- Setup, one time: [docs/SETUP.md](docs/SETUP.md)
- For the shop: [docs/PHOTO-GUIDE.md](docs/PHOTO-GUIDE.md)
- The importer: `tools/sync-form.js`, dependencies in `tools/package.json`,
  installed only in CI

## Analytics

Google Tag Manager container `GTM-57K7RHSD` loads on every page. Google Ads
conversion tracking for `AW-18363583498` is *also* hardcoded in
`src/partials/head-close.html`, separately from GTM. Adding that same Ads ID
inside the GTM container would double-count conversions. Read the comment in
that partial before changing either one.

Both are gated on the hostname, so previews and staging never touch real
conversion data. The estimate page fires the conversion only on a completed
Cal.com booking, not on page load or button clicks.
