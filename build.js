#!/usr/bin/env node
/*
 * build.js — regenerates every deployed HTML page from src/ and content/.
 *
 * The site is plain static HTML on Cloudflare Pages with no build command:
 * what is committed at the repo root is exactly what gets served. This script
 * exists so the shared chrome lives in one file instead of six, and so a
 * completed repair job becomes a page, a gallery tile and a sitemap entry
 * from one JSON file.
 *
 *   node build.js          rewrite the generated pages
 *   node build.js --check  exit 1 if anything is out of date, write nothing
 *
 * Inputs
 *   src/partials/    shared fragments (head, header, nav, ticker, footer)
 *   src/pages/       one source per static page at the site root
 *   src/templates/   job.html and work-index.html, rendered from job data
 *   content/jobs/    one JSON file per completed repair
 *
 * Outputs (all committed, all overwritten on every build)
 *   *.html           the six static pages
 *   work/index.html  the "Our Work" index
 *   work/<slug>.html one page per job
 *   sitemap.xml
 *
 * Directives, expanded recursively:
 *   <!--#include name-->              inline src/partials/name.html
 *   <!--#include name key="value"-->  ...and set {{key}} within it
 *   <!--#jobs KIND attr="value"-->    render job data; see JOB_BLOCKS below
 *   {{key}} / {{a.b}}                 a value from the current scope
 *   {{cur:foo}}                       ' aria-current="page"' when nav == foo
 *
 * Substitution is raw insertion, NOT escaped. Anything derived from job JSON
 * is escaped here in build.js when the scope is assembled; fields whose name
 * ends in Html are pre-rendered markup and are inserted as-is.
 */

'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const ROOT = __dirname;
const PARTIALS = path.join(ROOT, 'src', 'partials');
const PAGES = path.join(ROOT, 'src', 'pages');
const TEMPLATES = path.join(ROOT, 'src', 'templates');
const JOBS_DIR = path.join(ROOT, 'content', 'jobs');
const WORK_DIR = path.join(ROOT, 'work');

const SITE = 'https://www.carcisautobody.com';

/* styles/site.css and js/site.js are not content-hashed filenames, so a
   returning visitor could hold a cached copy from before a deploy and render
   new HTML against old CSS. On images that is cosmetic; on the stylesheet it
   breaks the layout, for as long as the cache lasts. Stamping a hash of the
   file's own bytes into the URL means the URL changes exactly when the file
   does, so the cache can be long and can never serve a mismatched pair. */
function assetVersion(relPath) {
  const full = path.join(ROOT, relPath);
  if (!fs.existsSync(full)) return '0';
  return crypto.createHash('sha1').update(fs.readFileSync(full)).digest('hex').slice(0, 8);
}
const CHECK = process.argv.includes('--check');

/* Service ids used in job JSON, mapped to their label and services.html anchor.
   Keep in sync with the feature rows in src/pages/services.html. */
const SERVICES = {
  dent: 'Dent Repair',
  panel: 'Panel Repair',
  rust: 'Rust Repair',
  collision: 'Collision Repair',
  paint: 'Paint',
  'custom-paint': 'Custom Paint & Design',
  'custom-body': 'Custom Body Work',
};

const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July',
  'August', 'September', 'October', 'November', 'December'];

/* ------------------------------------------------------------------ utils */

function esc(s) {
  return String(s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

function fail(msg) { throw new Error(msg); }

function writeIfChanged(dest, content, report) {
  const current = fs.existsSync(dest) ? fs.readFileSync(dest, 'utf8') : null;
  const rel = path.relative(ROOT, dest).replace(/\\/g, '/');
  if (current === content) {
    report.upToDate.push(rel);
    return;
  }
  report.changed.push(rel);
  if (!CHECK) {
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    fs.writeFileSync(dest, content);
  }
}

/* ------------------------------------------------------------------- jobs */

function loadJobs() {
  if (!fs.existsSync(JOBS_DIR)) return [];
  const files = fs.readdirSync(JOBS_DIR).filter(f => f.endsWith('.json')).sort();

  const jobs = files.map(file => {
    const full = path.join(JOBS_DIR, file);
    let job;
    try {
      job = JSON.parse(fs.readFileSync(full, 'utf8'));
    } catch (e) {
      fail('content/jobs/' + file + ': invalid JSON — ' + e.message);
    }

    const where = 'content/jobs/' + file;
    for (const key of ['slug', 'date', 'title', 'summary', 'service', 'photos']) {
      if (!job[key]) fail(where + ': missing required field "' + key + '"');
    }
    if (!/^[a-z0-9][a-z0-9-]*$/.test(job.slug)) {
      fail(where + ': slug must be lowercase letters, digits and hyphens');
    }
    if (!/^\d{4}-\d{2}-\d{2}$/.test(job.date)) {
      fail(where + ': date must be YYYY-MM-DD');
    }
    if (!SERVICES[job.service]) {
      fail(where + ': unknown service "' + job.service + '". Valid: '
        + Object.keys(SERVICES).join(', '));
    }
    if (!Array.isArray(job.photos) || !job.photos.length) {
      fail(where + ': needs at least one photo');
    }

    job.photos.forEach((p, i) => {
      const at = where + ' photo[' + i + ']';
      if (!p.file) fail(at + ': missing "file"');
      if (!p.alt) fail(at + ': missing "alt" (needed for accessibility and SEO)');
      if (!p.width || !p.height) fail(at + ': missing width/height');
      const onDisk = path.join(ROOT, p.file.replace(/^\//, ''));
      if (!fs.existsSync(onDisk)) fail(at + ': file not found — ' + p.file);
      if (p.role && p.role !== 'before' && p.role !== 'after') {
        fail(at + ': role must be "before" or "after" if present');
      }
    });

    // A readable license plate went public on two job pages before anyone
    // noticed. The importer now asks the model to list anything identifying
    // in the photos. A flagged job can sit as a draft, but it cannot be
    // published until a person has redacted the photos and said so.
    const gen = job._generated || {};
    const privacy = Array.isArray(gen.privacyIssues) ? gen.privacyIssues : [];
    if (job.draft !== true && privacy.length && gen.privacyReviewed !== true) {
      fail(where + ': cannot publish. The import flagged private details in the '
        + 'photos: ' + privacy.join('; ') + '. Redact them, then set '
        + '"_generated.privacyReviewed": true.');
    }

    return decorate(job, where);
  });

  const seen = new Set();
  for (const j of jobs) {
    if (seen.has(j.slug)) fail('duplicate job slug: ' + j.slug);
    seen.add(j.slug);
  }

  // Newest first everywhere on the site.
  jobs.sort((a, b) => (a.date < b.date ? 1 : a.date > b.date ? -1 : 0));

  // Second pass: cross-links need the full, sorted set.
  for (const job of jobs) {
    const related = relatedTo(job, jobs);
    job.hasRelated = related.length > 0;
    job.relatedHtml = related.length ? [
      '',
      '<section class="work-more">',
      '  <div class="wrap">',
      '    <h2 class="section-title">More <span class="accent">work</span>.</h2>',
      '    <div class="work-grid">',
      renderCards(related, '      '),
      '    </div>',
      '  </div>',
      '</section>',
    ].join('\n') : '';
  }

  return jobs;
}

function decorate(job, where) {
  const before = job.photos.find(p => p.role === 'before');
  const after = job.photos.find(p => p.role === 'after');

  job.url = '/work/' + job.slug;
  job.absUrl = SITE + job.url;
  job.serviceLabel = SERVICES[job.service];
  job.serviceUrl = '/services#svc-' + job.service;
  job.draft = job.draft === true;

  const [y, m, d] = job.date.split('-').map(Number);
  job.dateLabel = MONTHS[m - 1] + ' ' + y;
  job.dateIso = job.date;
  job.dateTitle = MONTHS[m - 1] + ' ' + d + ', ' + y;

  const v = job.vehicle || {};
  job.vehicleLabel = [v.year, v.make, v.model].filter(Boolean).join(' ');

  job.before = before;
  job.after = after;
  job.hasComparison = Boolean(before && after);
  job.cardPhoto = after || job.photos[0];
  job.heroPhoto = after || before || job.photos[0];
  job.heroImageAbs = SITE + '/' + job.heroPhoto.file.replace(/^\//, '');

  // Escaped scalars for direct substitution into markup.
  job.titleEsc = esc(job.title);
  job.summaryEsc = esc(job.summary);
  job.vehicleLabelEsc = esc(job.vehicleLabel);
  job.serviceLabelEsc = esc(job.serviceLabel);

  const story = job.story || [];
  if (!Array.isArray(story)) fail(where + ': "story" must be an array of paragraphs');
  job.storyHtml = story.map(p => '      <p class="job-para">' + esc(p) + '</p>').join('\n');
  job.wordCount = story.join(' ').split(/\s+/).filter(Boolean).length;

  job.robots = job.draft
    ? '\n<meta name="robots" content="noindex, nofollow">'
    : '';

  job.vehicleFactHtml = job.vehicleLabel
    ? '\n        <div class="job-fact"><span>Vehicle</span><span>'
      + job.vehicleLabelEsc + '</span></div>'
    : '';
  job.insuranceFactHtml = job.insurance
    ? '\n        <div class="job-fact"><span>Paid by</span><span>Insurance claim</span></div>'
    : '';

  // The whole section, not just the slider, so a job without a before/after
  // pair simply omits it rather than leaving an empty heading behind.
  job.comparisonHtml = job.hasComparison ? [
    '',
    '<section class="signature">',
    '  <div class="wrap">',
    '    <div class="signature-head reveal">',
    '      <h2 class="section-title">Damage to <span class="accent">done</span>.</h2>',
    '      <p class="signature-lede">Drag the line to compare this repair.</p>',
    '    </div>',
    renderSlider(job, '    '),
    '  </div>',
    '</section>',
  ].join('\n') : '';

  job.photosHtml = renderPhotoStrip(job, '        ');
  job.jsonLd = renderJobJsonLd(job);
  job.breadcrumbLd = renderBreadcrumbLd(job);
  return job;
}

/* Up to three other jobs to show at the foot of a job page. Same service
   first, since that is the most useful next click, then most recent. */
function relatedTo(job, all) {
  const others = all.filter(j => !j.draft && j.slug !== job.slug);
  const sameService = others.filter(j => j.service === job.service);
  const rest = others.filter(j => j.service !== job.service);
  return sameService.concat(rest).slice(0, 3);
}

/* -------------------------------------------------------------- renderers */

function indentBlock(text, indent) {
  if (!indent) return text;
  return text.split('\n').map(l => (l ? indent + l : l)).join('\n');
}

function img(p, extra) {
  return '<img src="' + esc(p.file) + '" alt="' + esc(p.alt) + '"'
    + ' width="' + p.width + '" height="' + p.height + '"' + (extra || '') + '>';
}

/* The drag-to-compare slider. js/site.js binds to #sliderFrame / #sliderInput,
   so there can only ever be one of these per page. */
function renderSlider(job, indent) {
  const body = [
    '<div class="slider-frame reveal" id="sliderFrame">',
    '  <div class="slider-panel panel-before">',
    '    ' + img(job.before, ' loading="lazy" decoding="async"'),
    '  </div>',
    '  <div class="slider-panel panel-after" id="afterPanel">',
    '    ' + img(job.after, ' loading="lazy" decoding="async"'),
    '  </div>',
    '  <span class="panel-label before">Before</span>',
    '  <span class="panel-label after">After</span>',
    '  <div class="slider-handle">',
    '    <div class="slider-grip">',
    '      <svg viewBox="0 0 24 24" fill="none" stroke="oklch(0.98 0.005 35)" stroke-width="2.4" stroke-linecap="round">',
    '        <path d="M8 7 4 12l4 5M16 7l4 5-4 5"/>',
    '      </svg>',
    '    </div>',
    '  </div>',
    '  <input type="range" class="slider-input" id="sliderInput" min="0" max="100" value="50"',
    '         aria-label="Drag to compare before and after repair">',
    '</div>',
  ].join('\n');
  return indentBlock(body, indent);
}

/* The four-tile home page grid. Its CSS uses fixed a/b/c/d layout classes. */
const GRID_SLOTS = ['a', 'b', 'c', 'd'];

function renderGrid(jobs, indent) {
  const body = jobs.slice(0, GRID_SLOTS.length).map((job, i) => [
    '<a class="gallery-item ' + GRID_SLOTS[i] + '" href="' + job.url + '">',
    '  ' + img(job.cardPhoto, ' loading="lazy" decoding="async"'),
    '  <span class="gallery-caption">' + job.titleEsc + '</span>',
    '</a>',
  ].join('\n')).join('\n');
  return indentBlock(body, indent);
}

function renderCards(jobs, indent) {
  const body = jobs.map(job => [
    '<a class="work-card reveal" href="' + job.url + '">',
    '  <div class="work-card-media">',
    '    ' + img(job.cardPhoto, ' loading="lazy" decoding="async"'),
    (job.hasComparison ? '    <span class="work-card-badge">Before &amp; after</span>' : ''),
    '  </div>',
    '  <div class="work-card-body">',
    '    <span class="work-card-service">' + job.serviceLabelEsc + '</span>',
    '    <h3 class="work-card-title">' + job.titleEsc + '</h3>',
    '    <p class="work-card-summary">' + job.summaryEsc + '</p>',
    '    <span class="work-card-date">' + esc(job.dateLabel) + '</span>',
    '  </div>',
    '</a>',
  ].filter(Boolean).join('\n')).join('\n');
  return indentBlock(body, indent);
}

/* Every photo on the job page, with the before/after pair called out. */
function renderPhotoStrip(job, indent) {
  const body = job.photos.map(p => {
    const label = p.role === 'before' ? 'Before'
      : p.role === 'after' ? 'After' : '';
    return [
      '<figure class="job-shot">',
      '  ' + img(p, ' loading="lazy" decoding="async"'),
      (label ? '  <figcaption class="job-shot-label">' + label + '</figcaption>' : ''),
      '</figure>',
    ].filter(Boolean).join('\n');
  }).join('\n');
  return indentBlock(body, indent);
}

function renderJobJsonLd(job) {
  const about = [{ '@type': 'Service', name: job.serviceLabel }];
  if (job.vehicleLabel) about.push({ '@type': 'Vehicle', name: job.vehicleLabel });

  const data = {
    '@context': 'https://schema.org',
    '@type': 'Article',
    headline: job.title,
    description: job.summary,
    datePublished: job.date,
    dateModified: job.date,
    mainEntityOfPage: { '@type': 'WebPage', '@id': job.absUrl },
    image: job.photos.map(p => SITE + '/' + p.file.replace(/^\//, '')),
    author: { '@type': 'Organization', name: 'Carcis Autobody Repair' },
    publisher: {
      '@type': 'AutoBodyShop',
      name: 'Carcis Autobody Repair',
      telephone: '+1-360-381-5219',
      address: {
        '@type': 'PostalAddress',
        streetAddress: '1520 Washington St',
        addressLocality: 'Vancouver',
        addressRegion: 'WA',
        postalCode: '98660',
        addressCountry: 'US',
      },
    },
    about: about,
  };
  return JSON.stringify(data, null, 2);
}

function renderBreadcrumbLd(job) {
  return JSON.stringify({
    '@context': 'https://schema.org',
    '@type': 'BreadcrumbList',
    itemListElement: [
      { '@type': 'ListItem', position: 1, name: 'Home', item: SITE + '/' },
      { '@type': 'ListItem', position: 2, name: 'Our Work', item: SITE + '/work/' },
      { '@type': 'ListItem', position: 3, name: job.title, item: job.absUrl },
    ],
  }, null, 2);
}

/* ------------------------------------------------------- job block routing */

const JOB_BLOCKS = {
  /* Newest job that has both a before and an after photo. If nothing
     qualifies yet, fall back to a single photo rather than failing the build:
     a shop that has only posted finished shots should still get a page. */
  slider(jobs, attrs, indent) {
    const live = select(jobs, attrs);
    const pair = live.find(j => j.hasComparison);
    if (pair) return renderSlider(pair, indent);
    if (!live.length) return '';
    const job = live[0];
    return indentBlock([
      '<figure class="slider-frame slider-single reveal">',
      '  ' + img(job.heroPhoto, ' loading="lazy" decoding="async"'),
      '</figure>',
    ].join('\n'), indent);
  },
  grid(jobs, attrs, indent) {
    return renderGrid(select(jobs, attrs), indent);
  },
  cards(jobs, attrs, indent) {
    return renderCards(select(jobs, attrs), indent);
  },
};

function select(jobs, attrs) {
  let out = jobs.filter(j => !j.draft);
  if (attrs.service) out = out.filter(j => j.service === attrs.service);
  if (attrs.exclude) out = out.filter(j => j.slug !== attrs.exclude);
  const limit = attrs.limit ? parseInt(attrs.limit, 10) : out.length;
  return out.slice(0, limit);
}

/* -------------------------------------------------------------- expansion */

/* <!--#ifjobs--> ... <!--#endifjobs--> keeps its contents only while at least
   one job is live. Before the first real job is published, and any time every
   job is a draft, the whole Our Work surface has to disappear: an empty index
   linked from the nav is worse than no link at all. Stripped before anything
   inside it is expanded, so the directives within never run. */
const IF_JOBS = /^[ \t]*<!--#ifjobs-->[ \t]*\r?\n([\s\S]*?)^[ \t]*<!--#endifjobs-->[ \t]*\r?\n/gm;

const INCLUDE = /^([ \t]*)<!--#include\s+([a-z0-9-]+)((?:\s+[a-z]+="[^"]*")*)\s*-->[ \t]*$/gm;
const JOBS = /^([ \t]*)<!--#jobs\s+([a-z]+)((?:\s+[a-z]+="[^"]*")*)\s*-->[ \t]*$/gm;
const ATTR = /([a-z]+)="([^"]*)"/g;

function parseAttrs(raw) {
  const out = {};
  let m;
  while ((m = ATTR.exec(raw)) !== null) out[m[1]] = m[2];
  ATTR.lastIndex = 0;
  return out;
}

function readPartial(name) {
  const file = path.join(PARTIALS, name + '.html');
  if (!fs.existsSync(file)) fail('no such partial: src/partials/' + name + '.html');
  return fs.readFileSync(file, 'utf8').replace(/\n$/, '');
}

function lookup(scope, key) {
  let cur = scope;
  for (const part of key.split('.')) {
    if (cur === null || cur === undefined) return undefined;
    cur = cur[part];
  }
  return cur;
}

function expand(text, scope, jobs, depth) {
  if (depth > 10) fail('include nesting too deep, probably a cycle');

  const anyLive = jobs.some(j => !j.draft);
  let out = text.replace(IF_JOBS, (_m, body) => (anyLive ? body : ''));

  out = out.replace(INCLUDE, (_m, indent, name, attrs) => {
    const inner = Object.assign({}, scope, parseAttrs(attrs));
    return indentBlock(expand(readPartial(name), inner, jobs, depth + 1), indent);
  });

  out = out.replace(JOBS, (_m, indent, kind, attrs) => {
    const fn = JOB_BLOCKS[kind];
    if (!fn) fail('unknown job block "' + kind + '". Valid: ' + Object.keys(JOB_BLOCKS).join(', '));
    return fn(jobs, parseAttrs(attrs), indent);
  });

  out = out.replace(/\{\{cur:([a-z]+)\}\}/g, (_m, name) =>
    scope.nav === name ? ' aria-current="page"' : '');

  out = out.replace(/\{\{([a-z][a-z0-9_.]*)\}\}/gi, (m, key) => {
    const val = lookup(scope, key);
    if (val === undefined || val === null) {
      // An unset include attribute is legitimately empty; a mistyped job field
      // is not, so only the dotted job.* form is treated as an error.
      if (key.indexOf('.') !== -1) fail('unknown template value {{' + key + '}}');
      return '';
    }
    return String(val);
  });

  return out;
}

function render(source, scope, jobs, where) {
  const html = expand(source, scope, jobs, 0);
  const leftover = html.match(/<!--#(include|jobs)|\{\{/);
  if (leftover) fail(where + ': unexpanded directive near ' + leftover[0]);
  return html;
}

/* ---------------------------------------------------------------- sitemap */

function renderSitemap(jobs) {
  const live = jobs.filter(j => !j.draft);
  const newest = live.length ? live[0].date : new Date().toISOString().slice(0, 10);

  const entries = [
    { loc: SITE + '/', lastmod: newest, changefreq: 'weekly', priority: '1.0' },
    { loc: SITE + '/services', lastmod: newest, changefreq: 'monthly', priority: '0.9' },
    { loc: SITE + '/estimate', lastmod: newest, changefreq: 'monthly', priority: '0.9' },
    ...(live.length
      ? [{ loc: SITE + '/work/', lastmod: newest, changefreq: 'weekly', priority: '0.9' }]
      : []),
    { loc: SITE + '/about', lastmod: newest, changefreq: 'monthly', priority: '0.8' },
  ];

  for (const job of live) {
    entries.push({
      loc: job.absUrl, lastmod: job.date, changefreq: 'yearly', priority: '0.7',
    });
  }

  const body = entries.map(e => [
    '  <url>',
    '    <loc>' + e.loc + '</loc>',
    '    <lastmod>' + e.lastmod + 'T00:00:00+00:00</lastmod>',
    '    <changefreq>' + e.changefreq + '</changefreq>',
    '    <priority>' + e.priority + '</priority>',
    '  </url>',
  ].join('\n')).join('\n');

  return '<?xml version="1.0" encoding="UTF-8"?>\n'
    + '<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n'
    + body + '\n</urlset>\n';
}

/* ------------------------------------------------------------------ build */

function build() {
  const jobs = loadJobs();
  const report = { changed: [], upToDate: [], removed: [] };

  const v = { css: assetVersion('styles/site.css'), js: assetVersion('js/site.js') };

  // 1. Static pages at the site root.
  const sources = fs.readdirSync(PAGES).filter(f => f.endsWith('.html')).sort();
  if (!sources.length) fail('no page sources found in src/pages/');
  for (const name of sources) {
    const src = fs.readFileSync(path.join(PAGES, name), 'utf8');
    writeIfChanged(path.join(ROOT, name), render(src, { v }, jobs, name), report);
  }

  // 2. One page per job, plus the work index.
  const jobTemplate = fs.readFileSync(path.join(TEMPLATES, 'job.html'), 'utf8');
  const expected = new Set(['index.html']);
  for (const job of jobs) {
    expected.add(job.slug + '.html');
    const html = render(jobTemplate, { nav: 'work', job: job, v }, jobs, 'job:' + job.slug);
    writeIfChanged(path.join(WORK_DIR, job.slug + '.html'), html, report);
  }

  if (jobs.some(j => !j.draft)) {
    const indexTemplate = fs.readFileSync(path.join(TEMPLATES, 'work-index.html'), 'utf8');
    writeIfChanged(path.join(WORK_DIR, 'index.html'),
      render(indexTemplate, { nav: 'work', v }, jobs, 'work-index'), report);
  } else {
    // Nothing live: drop the index so /work/ returns a real 404 rather than
    // serving an empty grid. Draft job pages are still generated, so a
    // reviewer can open them directly from the pull request.
    expected.delete('index.html');
  }

  // 3. Delete pages whose job JSON is gone, so a removed job does not linger
  //    as an orphaned URL that Google keeps serving.
  if (fs.existsSync(WORK_DIR)) {
    for (const f of fs.readdirSync(WORK_DIR)) {
      if (f.endsWith('.html') && !expected.has(f)) {
        report.removed.push('work/' + f);
        if (!CHECK) fs.unlinkSync(path.join(WORK_DIR, f));
      }
    }
  }

  // 4. Sitemap, derived from whatever is live.
  writeIfChanged(path.join(ROOT, 'sitemap.xml'), renderSitemap(jobs), report);

  // 5. Report.
  const live = jobs.filter(j => !j.draft).length;
  for (const f of report.changed) console.log('  ' + (CHECK ? 'STALE   ' : 'wrote   ') + f);
  for (const f of report.removed) console.log('  ' + (CHECK ? 'ORPHAN  ' : 'deleted ') + f);
  console.log('  ' + report.upToDate.length + ' file(s) already up to date');
  console.log('\n' + jobs.length + ' job(s): ' + live + ' live, ' + (jobs.length - live) + ' draft.');

  const thin = jobs.filter(j => !j.draft && j.wordCount < 60);
  if (thin.length) {
    console.log('\nWARNING: these live jobs have very little written detail and will');
    console.log('read as thin auto-generated pages to Google. Add to "story", or set');
    console.log('"draft": true until someone writes them up:');
    for (const j of thin) console.log('  - ' + j.slug + ' (' + j.wordCount + ' words)');
  }

  const stale = report.changed.length + report.removed.length;
  if (CHECK && stale) {
    console.error('\n' + stale + ' file(s) out of date. Run: node build.js');
    process.exit(1);
  }
}

try {
  build();
} catch (err) {
  console.error('build failed: ' + err.message);
  process.exit(1);
}
