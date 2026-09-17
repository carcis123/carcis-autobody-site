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

Personal information is removed automatically. The importer has Gemini box
every license plate, face, name, document or screen in the photos and
pixelates them, then sends the redacted photos back to be checked, redacting
again if anything is still readable. The shop's notes are stored with personal
details replaced by [removed], and the page copy is kept free of them. Anything
the model could not fix, or a check that did not finish, goes into
`_generated.privacyIssues`, and the build refuses to publish that job until
someone has looked and set `_generated.privacyReviewed` to true.

The importer also fixes typos in the form's vehicle fields, recording each
change in `_generated.corrections`, and keeps all copy in American English.

## Photos and the gallery

Every photo on a job page opens in a lightbox: a full-screen viewer with arrow
buttons, arrow keys, swipe, and Escape to close, built on the native `<dialog>`
element in `js/site.js`. Without JavaScript the photo links still open the
image itself.

`/gallery/` shows every photo from every published job, newest job first and
before shots ahead of after shots, in the same viewer, with captions linking
back to each job. Like the work index, it only exists while at least one job
is live, and drafts never appear in it.

Instagram (@carcisautobody) is linked from the footer and the gallery, and is
listed as the business's `sameAs` profile in structured data. The site does not
embed an Instagram feed on purpose: those photos would bypass the redaction the
importer applies, and a live feed needs an Instagram Business account tied to a
Facebook Page plus access tokens that expire every 60 days.

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
- For the shop: https://www.carcisautobody.com/photo-guide, an unlisted,
  noindex page built from `src/pages/photo-guide.html`. Keep it in step with
  [docs/PHOTO-GUIDE.md](docs/PHOTO-GUIDE.md).
- The importer: `tools/sync-form.js`, dependencies in `tools/package.json`,
  installed only in CI

## Analytics

Google Tag Manager container `GTM-57K7RHSD` loads on every page. Google Ads
(`AW-18363583498`), Google Analytics 4 and Microsoft Clarity are *also*
loaded directly from `src/partials/head-close.html`, separately from GTM.
Adding the same IDs inside the GTM container would double-count. Read the
comment in that partial before changing either one.

Every ID is in the `CARCIS_TRACKING` object in that partial, and an empty
string switches that service off. To turn one on, paste the ID in, run
`node build.js`, and commit.

| Key | What it is | Where to find it |
| --- | --- | --- |
| `adsBooking` | Book appointment conversion | Google Ads > Goals > Conversions > the action > Tag setup, the `send_to` value |
| `adsCall` | Website phone number clicks conversion | Same place, for that action |
| `ga4` | GA4 measurement ID, `G-...`. **Leave empty**: see below | Analytics > Admin > Data streams > the web stream |
| `clarity` | Clarity project ID | Clarity > the project > Settings > Overview |

GA4 property `G-WC1N8XG1KK` ("Carcis autobody repair") is linked to the Ads
Google tag in Google's own tag settings, so loading `AW-18363583498` already
sends page views and every `gtag('event')` to it. Setting `ga4` as well would
count everything twice.

What is measured:

- **Online bookings.** The estimate page fires the Ads booking conversion and
  a GA4 `generate_lead` event only on a completed Cal.com booking, not on
  page load or button clicks.
- **Phone taps.** `js/site.js` fires the Ads call conversion and a GA4
  `phone_click` event on any `tel:` link, with `link_location` set to
  header, mobile_menu, footer or page. Email links send `email_click`.

Everything is gated on the hostname, so previews and staging never touch real
data. The privacy page describes all of these services; update it if one is
added or removed.
