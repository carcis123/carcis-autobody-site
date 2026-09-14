#!/usr/bin/env node
/*
 * sync-form.js — turn Google Form submissions into job pages.
 *
 * Carlos and Kayla fill in the "Carcis job upload" form on their phone: the
 * vehicle, what they did, a few sentences about the job, and the before and
 * after photos. Google puts the answers in a spreadsheet and the photos in
 * Drive. This script reads rows that have not been imported yet, downsizes
 * the photos into the repo, asks Gemini to draft the write-up from the photos
 * plus what they typed, and writes one JSON file per job.
 *
 * It NEVER publishes on its own. Every job it creates is written with
 * "draft": true, which renders the page with noindex and keeps it out of the
 * sitemap, the home page and the work index. A human reads the draft in the
 * pull request, fixes what the model got wrong, sets draft to false and
 * merges. That review is the whole safety mechanism: the model is looking at
 * photographs of a car it has never seen, and it will get details wrong.
 *
 *   node tools/sync-form.js                 import anything new
 *   node tools/sync-form.js --dry-run       report what it would do, write nothing
 *   node tools/sync-form.js --force         re-import rows already imported
 *   node tools/sync-form.js --check-columns print the column mapping and stop
 *
 * Environment:
 *   FORM_SHEET_ID                the response spreadsheet's id
 *   GOOGLE_SERVICE_ACCOUNT_JSON  service account key, as JSON
 *   GEMINI_API_KEY               Google AI Studio key
 *   GEMINI_MODEL                 optional, defaults to gemini-3.6-flash
 *
 * Columns are matched on keywords, not exact text, so the form's wording can
 * be edited without breaking this. See COLUMNS below.
 */

'use strict';

const fs = require('fs');
const path = require('path');
const { google } = require('googleapis');
const sharp = require('sharp');

const ROOT = path.join(__dirname, '..');
const JOBS_DIR = path.join(ROOT, 'content', 'jobs');
const WORK_ASSETS = path.join(ROOT, 'assets', 'work');

const DRY_RUN = process.argv.includes('--dry-run');
const FORCE = process.argv.includes('--force');
const CHECK_COLUMNS = process.argv.includes('--check-columns');

// Google retires model ids periodically and the API names the replacement
// in its 404. Override with the GEMINI_MODEL repository variable rather
// than editing this, so a deprecation does not need a code change.
const MODEL = process.env.GEMINI_MODEL || 'gemini-3.6-flash';
/* Photos are committed to git, so size compounds forever. At 1400px/q82 a
   five-photo job cost 1.4 MB, roughly 150 MB a year at two jobs a week.
   1200px/q78 halves that with no visible loss: the widest slot any photo
   occupies is the 1180px page wrapper, and the job grid renders them at
   300-560px. If the repo ever does get uncomfortable, the real fix is moving
   images to R2 rather than degrading these further. */
const MAX_EDGE = 1200;         // longest side of a published photo, in pixels
const MAX_PHOTOS = 8;          // per job, to keep the repo from ballooning
const WEBP_QUALITY = 78;

const SERVICE_LABELS = {
  dent: 'Dent Repair',
  panel: 'Panel Repair',
  rust: 'Rust Repair',
  collision: 'Collision Repair',
  paint: 'Paint',
  'custom-paint': 'Custom Paint & Design',
  'custom-body': 'Custom Body Work',
};

/* Each column is found by testing the normalized header against these
   predicates, in order, first match wins. Keep them loose. */
const COLUMNS = {
  timestamp: h => h === 'timestamp',
  date: h => /finish|complet/.test(h) || (/\bdate\b/.test(h) && h !== 'timestamp'),
  year: h => /year/.test(h),
  make: h => /make/.test(h),
  model: h => /model/.test(h),
  color: h => /colou?r/.test(h),
  service: h => /work|service|what did you/.test(h),
  insurance: h => /insuran/.test(h),
  notes: h => /tell us|note|describe|about this job/.test(h),
  before: h => /before/.test(h),
  after: h => /after/.test(h),
  email: h => /e-?mail/.test(h),
};

/* ------------------------------------------------------------------ utils */

function need(name) {
  const v = process.env[name];
  if (!v) {
    console.error('missing required environment variable: ' + name);
    process.exit(1);
  }
  return v;
}

function normalizeHeader(h) {
  return String(h || '').toLowerCase().replace(/[^a-z0-9 ]+/g, ' ')
    .replace(/\s+/g, ' ').trim();
}

function slugify(s) {
  return String(s).toLowerCase()
    .normalize('NFKD').replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 70) || 'job';
}

/* Forms records a date answer as the sheet's locale string. Accept the common
   shapes and fall back to the submission timestamp. */
function toIsoDate(value, fallbackIso) {
  const s = String(value || '').trim();
  let m = s.match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (m) return m[1] + '-' + m[2] + '-' + m[3];
  m = s.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})/);     // M/D/YYYY
  if (m) {
    return m[3] + '-' + String(m[1]).padStart(2, '0') + '-'
      + String(m[2]).padStart(2, '0');
  }
  const parsed = Date.parse(s);
  if (!Number.isNaN(parsed)) return new Date(parsed).toISOString().slice(0, 10);
  return (fallbackIso || new Date().toISOString()).slice(0, 10);
}

/* A file-upload answer is a comma or newline separated list of Drive links. */
function fileIdsFrom(answer) {
  const out = [];
  const re = /(?:[?&]id=|\/d\/|\/file\/d\/)([A-Za-z0-9_-]{20,})/g;
  let m;
  while ((m = re.exec(String(answer || ''))) !== null) out.push(m[1]);
  return [...new Set(out)];
}

function serviceIdFrom(label) {
  const want = normalizeHeader(label);
  for (const [id, text] of Object.entries(SERVICE_LABELS)) {
    if (normalizeHeader(text) === want) return id;
  }
  // Fall back to a keyword sweep so a lightly reworded option still lands.
  if (/custom.*paint|design/.test(want)) return 'custom-paint';
  if (/custom.*body|build/.test(want)) return 'custom-body';
  for (const id of ['rust', 'dent', 'panel', 'collision', 'paint']) {
    if (want.includes(id)) return id;
  }
  return null;
}

/* ------------------------------------------------------------- google apis */

function googleAuth() {
  const creds = JSON.parse(need('GOOGLE_SERVICE_ACCOUNT_JSON'));
  return new google.auth.JWT({
    email: creds.client_email,
    key: creds.private_key,
    scopes: [
      'https://www.googleapis.com/auth/drive.readonly',
      'https://www.googleapis.com/auth/spreadsheets.readonly',
    ],
  });
}

async function readResponses(auth, sheetId) {
  const sheets = google.sheets({ version: 'v4', auth });
  const meta = await sheets.spreadsheets.get({ spreadsheetId: sheetId });
  const first = meta.data.sheets?.[0]?.properties?.title;
  if (!first) throw new Error('the spreadsheet has no sheets');

  const res = await sheets.spreadsheets.values.get({
    spreadsheetId: sheetId,
    range: "'" + first.replace(/'/g, "''") + "'",
    valueRenderOption: 'FORMATTED_VALUE',
  });

  const rows = res.data.values || [];
  if (!rows.length) return { headers: [], responses: [] };

  const headers = rows[0].map(normalizeHeader);
  const index = {};
  for (const [key, test] of Object.entries(COLUMNS)) {
    const at = headers.findIndex(h => h && test(h));
    if (at !== -1) index[key] = at;
  }

  if (!CHECK_COLUMNS) {
    for (const required of ['timestamp', 'before', 'after']) {
      if (index[required] === undefined) {
        throw new Error('could not find a "' + required + '" column in the form '
          + 'responses. Headers seen: ' + headers.filter(Boolean).join(' | '));
      }
    }
  }

  const responses = rows.slice(1)
    .filter(r => r && r.length && String(r[index.timestamp] || '').trim())
    .map((r, i) => {
      const get = key => (index[key] === undefined ? '' : String(r[index[key]] || '').trim());
      return {
        rowNumber: i + 2,          // 1-based, plus the header row
        timestamp: get('timestamp'),
        date: get('date'),
        year: get('year'),
        make: get('make'),
        model: get('model'),
        color: get('color'),
        service: get('service'),
        insurance: /^y/i.test(get('insurance')),
        notes: get('notes'),
        beforeIds: fileIdsFrom(get('before')),
        afterIds: fileIdsFrom(get('after')),
      };
    });

  return { headers, responses, index, sheetTitle: first };
}

async function download(auth, fileId) {
  const drive = google.drive({ version: 'v3', auth });
  const res = await drive.files.get(
    { fileId, alt: 'media', supportsAllDrives: true },
    { responseType: 'arraybuffer' }
  );
  return Buffer.from(res.data);
}

/* ----------------------------------------------------------------- gemini */

const RESPONSE_SCHEMA = {
  type: 'object',
  properties: {
    title: { type: 'string' },
    summary: { type: 'string' },
    story: { type: 'array', items: { type: 'string' } },
    photoAlts: { type: 'array', items: { type: 'string' } },
    uncertain: { type: 'array', items: { type: 'string' } },
    privacyIssues: { type: 'array', items: { type: 'string' } },
  },
  required: ['title', 'summary', 'story', 'photoAlts'],
};

const PROMPT = `You are drafting a case-study page for Carcis Autobody Repair, a
collision and paint shop in Vancouver, Washington, owned by Carlos and Kayla
Carrasco Cisneros. The page shows before and after photos of one repair.

The shop filled in a form with the facts, and those facts are authoritative.
The photos follow, before ones first.

Write the draft. Rules, in order of importance:

1. Do not invent facts. The vehicle, the service and the date come from the
   form; use them as given and never contradict them. Everything else must be
   visible in the photos or stated in the shop's own notes. Anything you are
   unsure about goes in the "uncertain" array instead of the page copy, so a
   human can confirm or delete it.
2. Do not invent customer stories, timelines, prices, or quotes from anyone.
3. Build the piece around the shop's notes. Those are the real detail and the
   reason the page is worth reading. Expand them with general knowledge about
   how this kind of repair is done. General technique is fine and encouraged.
   Presenting a guess about THIS car as fact is not.
4. Plain, direct trade voice. No marketing adjectives, no "stunning", no
   "transformation". Short sentences. No em dashes.
5. "story" is 2 to 4 paragraphs, 90 to 220 words total.
6. "summary" is one sentence under 160 characters, used as the meta
   description. It should read naturally and mention the vehicle and the work.
7. "title" names the vehicle and the work, under 70 characters.
8. "photoAlts" has exactly one entry per photo, in the same order, each a
   plain factual description for a screen reader. No keyword stuffing.
9. "privacyIssues" lists anything in any photo that identifies a customer or
   another person and must be hidden before the page is public: a readable
   license plate, a face, a name, an address, a VIN, paperwork, or a phone
   screen. Say which photo, counting from 1, and where in it, for example
   "photo 2: rear license plate, center of the bumper". Return an empty array
   only if you checked every photo and found nothing. Never mention these
   details in the page copy or the alt text.

The facts from the form:
`;

async function draftWithGemini(facts, photos) {
  const key = need('GEMINI_API_KEY');

  const factLines = [
    'Vehicle: ' + ([facts.year, facts.make, facts.model].filter(Boolean).join(' ') || 'not given'),
    'Color: ' + (facts.color || 'not given'),
    'Work done: ' + (SERVICE_LABELS[facts.serviceId] || 'not given'),
    'Completed: ' + facts.date,
    'Insurance claim: ' + (facts.insurance ? 'yes' : 'not stated'),
    '',
    "The shop's own notes:",
    facts.notes || '(none provided)',
    '',
    'Photos in order: '
      + photos.map(p => p.role || 'unlabelled').join(', '),
  ].join('\n');

  const parts = [{ text: PROMPT + factLines }];
  for (const p of photos) {
    parts.push({ inlineData: { mimeType: 'image/webp', data: p.buffer.toString('base64') } });
  }

  const url = 'https://generativelanguage.googleapis.com/v1beta/models/'
    + encodeURIComponent(MODEL) + ':generateContent';

  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-goog-api-key': key },
    body: JSON.stringify({
      contents: [{ role: 'user', parts }],
      generationConfig: {
        temperature: 0.4,
        responseMimeType: 'application/json',
        responseSchema: RESPONSE_SCHEMA,
      },
    }),
  });

  if (!res.ok) {
    const body = await res.text();

    // A retired model id is the one Gemini failure that recurs, and the API
    // helpfully names its own replacement. Surface that as an instruction
    // rather than making someone read a JSON blob in a CI log.
    const suggested = body.match(/use\s+models\/([A-Za-z0-9.\-]+)/);
    if (res.status === 404 && suggested) {
      throw new Error(
        'the model "' + MODEL + '" is no longer available. Google suggests "'
        + suggested[1] + '". Set the GEMINI_MODEL repository variable in GitHub '
        + '(Settings, Secrets and variables, Actions, Variables) to "'
        + suggested[1] + '" and re-run. No code change needed.');
    }
    throw new Error('Gemini request failed (' + res.status + '): ' + body.slice(0, 400));
  }

  const data = await res.json();
  const text = data?.candidates?.[0]?.content?.parts?.[0]?.text;
  if (!text) throw new Error('Gemini returned no content: ' + JSON.stringify(data).slice(0, 400));

  let draft;
  try {
    draft = JSON.parse(text);
  } catch {
    throw new Error('Gemini returned non-JSON: ' + text.slice(0, 400));
  }
  if (!Array.isArray(draft.story)) draft.story = [];
  if (!Array.isArray(draft.photoAlts)) draft.photoAlts = [];
  if (!Array.isArray(draft.privacyIssues)) draft.privacyIssues = [];
  return draft;
}

/* ------------------------------------------------------------------- jobs */

function existingJobs() {
  if (!fs.existsSync(JOBS_DIR)) return [];
  return fs.readdirSync(JOBS_DIR)
    .filter(f => f.endsWith('.json'))
    .map(f => {
      try { return JSON.parse(fs.readFileSync(path.join(JOBS_DIR, f), 'utf8')); }
      catch { return null; }
    })
    .filter(Boolean);
}

async function importResponse(auth, row, known) {
  const submittedIso = toIsoDate(row.timestamp, new Date().toISOString());
  const date = toIsoDate(row.date, row.timestamp);

  if (!FORCE && known.some(j => j._generated && j._generated.formTimestamp === row.timestamp)) {
    return { skipped: true, reason: 'already imported' };
  }

  const serviceId = serviceIdFrom(row.service);
  if (!serviceId) {
    return {
      skipped: true,
      reason: 'could not match "' + row.service + '" to a service. Valid: '
        + Object.values(SERVICE_LABELS).join(', '),
    };
  }

  const vehicle = {};
  if (row.year) vehicle.year = row.year;
  if (row.make) vehicle.make = row.make;
  if (row.model) vehicle.model = row.model;
  if (row.color) vehicle.color = row.color;

  const vehicleLabel = [row.year, row.make, row.model].filter(Boolean).join(' ');
  let slug = slugify([vehicleLabel, SERVICE_LABELS[serviceId]].filter(Boolean).join(' '));
  if (!FORCE) {
    let n = 2;
    const base = slug;
    while (known.some(j => j.slug === slug)) slug = base + '-' + n++;
  }

  const wanted = [
    ...row.beforeIds.map(id => ({ id, role: 'before' })),
    ...row.afterIds.map(id => ({ id, role: 'after' })),
  ].slice(0, MAX_PHOTOS);

  if (!wanted.length) return { skipped: true, reason: 'no photos attached' };

  const processed = [];
  const unreadable = [];
  for (let i = 0; i < wanted.length; i++) {
    const { id, role } = wanted[i];
    let raw;
    try {
      raw = await download(auth, id);
    } catch (err) {
      unreadable.push(id + ' (download failed: ' + String(err.message).split('\n')[0] + ')');
      continue;
    }
    try {
      const out = await sharp(raw)
        .rotate()
        .resize({ width: MAX_EDGE, height: MAX_EDGE, fit: 'inside', withoutEnlargement: true })
        .webp({ quality: WEBP_QUALITY })
        .toBuffer({ resolveWithObject: true });
      processed.push({
        buffer: out.data,
        width: out.info.width,
        height: out.info.height,
        role,
        name: role + '-' + (processed.filter(p => p.role === role).length + 1) + '.webp',
      });
    } catch (err) {
      // Almost always an iPhone HEIC. The prebuilt sharp binaries ship without
      // HEIF support, so the fix is at the camera: Settings, Camera, Formats,
      // Most Compatible. Skip the photo rather than losing the whole job.
      unreadable.push(id + ' (' + String(err.message).split('\n')[0] + ')');
    }
  }

  if (!processed.length) {
    return {
      skipped: true,
      reason: 'none of the ' + wanted.length + ' photos could be decoded. '
        + 'If they are iPhone HEIC files, set Camera to Most Compatible. '
        + unreadable.join('; '),
    };
  }

  const draft = await draftWithGemini({
    year: row.year, make: row.make, model: row.model, color: row.color,
    serviceId, date, insurance: row.insurance, notes: row.notes,
  }, processed);

  const photos = processed.map((p, i) => ({
    file: '/assets/work/' + slug + '/' + p.name,
    alt: draft.photoAlts[i] || (vehicleLabel + ', ' + p.role),
    width: p.width,
    height: p.height,
    role: p.role,
  }));

  const job = {
    _generated: {
      by: 'tools/sync-form.js',
      model: MODEL,
      importedAt: new Date().toISOString(),
      formTimestamp: row.timestamp,
      formRow: row.rowNumber,
      submittedOn: submittedIso,
      shopNotes: row.notes || null,
      uncertain: draft.uncertain || [],
      privacyIssues: draft.privacyIssues,
      skippedPhotos: unreadable,
      review: 'The vehicle, service and date came from the form and are the '
        + "shop's own answers. The title, summary, story and alt text are a "
        + 'Gemini draft. Check every claim, fix the voice, then set "draft" '
        + 'to false to publish.',
    },
    slug,
    date,
    title: draft.title,
    summary: draft.summary,
    service: serviceId,
    vehicle,
    insurance: row.insurance,
    draft: true,
    story: draft.story,
    photos,
  };

  if (DRY_RUN) return { slug, dryRun: true, photos: photos.length, job };

  const dir = path.join(WORK_ASSETS, slug);
  fs.mkdirSync(dir, { recursive: true });
  for (const p of processed) fs.writeFileSync(path.join(dir, p.name), p.buffer);

  fs.mkdirSync(JOBS_DIR, { recursive: true });
  fs.writeFileSync(
    path.join(JOBS_DIR, date + '-' + slug + '.json'),
    JSON.stringify(job, null, 2) + '\n'
  );

  return { slug, imported: true, photos: photos.length, job, uncertain: draft.uncertain || [] };
}

/* ------------------------------------------------------------------- main */

function reportToWorkflow(slugs) {
  if (!process.env.GITHUB_OUTPUT) return;
  fs.appendFileSync(process.env.GITHUB_OUTPUT,
    'imported=' + slugs.length + '\n' + 'slugs=' + slugs.join(',') + '\n');
}

async function main() {
  const sheetId = need('FORM_SHEET_ID');
  const auth = googleAuth();

  const { headers, responses, index, sheetTitle } = await readResponses(auth, sheetId);

  if (CHECK_COLUMNS) {
    console.log('Sheet tab: ' + sheetTitle);
    console.log(responses.length + ' response row(s)');
    console.log('');
    const byPos = {};
    for (const [field, at] of Object.entries(index)) byPos[at] = field;
    console.log('COLUMN'.padEnd(42) + 'MAPPED TO');
    headers.forEach((h, i) => {
      if (!h) return;
      const field = byPos[i];
      console.log(('  ' + h).slice(0, 40).padEnd(42) + (field || '-- ignored --'));
    });
    const missing = ['timestamp', 'date', 'service', 'notes', 'before', 'after']
      .filter(f => index[f] === undefined);
    console.log('');
    if (missing.length) {
      console.log('MISSING, the import will not work: ' + missing.join(', '));
      console.log('Rename those questions so they contain the keyword, or widen');
      console.log('the matcher in the COLUMNS block at the top of this file.');
      process.exit(1);
    }
    console.log('All required columns found.');

    // Reading the spreadsheet proves nothing about the photos. They live in
    // the form's own "(File responses)" folder, which is a separate share and
    // the thing most likely to have been missed. Prove access to a real file.
    const withPhoto = responses.find(r => r.beforeIds.length || r.afterIds.length);
    if (!withPhoto) {
      console.log('');
      console.log('No response has any photos attached yet, so Drive access is');
      console.log('still untested. Submit the form once with a photo and re-run.');
      return;
    }

    const fileId = (withPhoto.beforeIds[0] || withPhoto.afterIds[0]);
    const drive = google.drive({ version: 'v3', auth });
    try {
      const meta = await drive.files.get({
        fileId,
        fields: 'name, mimeType, size',
        supportsAllDrives: true,
      });
      const f = meta.data;
      console.log('');
      console.log('Drive access OK. Read "' + f.name + '" (' + f.mimeType
        + ', ' + Math.round((Number(f.size) || 0) / 1024) + ' KB).');
      if (/hei[cf]/i.test(f.mimeType || '') || /\.hei[cf]$/i.test(f.name || '')) {
        console.log('');
        console.log('WARNING: that is a HEIC file. It cannot be decoded and will be');
        console.log('skipped. On the iPhone: Settings, Camera, Formats, Most');
        console.log('Compatible, then re-take or re-export the photos.');
      }
      console.log('');
      console.log('Safe to run the import.');
    } catch (err) {
      console.log('');
      console.log('Drive access FAILED for file ' + fileId + ':');
      console.log('  ' + String(err.message).split(/\r?\n/)[0]);
      console.log('');
      console.log('The service account can read the spreadsheet but not the photos.');
      console.log('Share the "Carcis job upload (File responses)" folder in Drive');
      console.log('with the same service account address, as Viewer.');
      process.exit(1);
    }
    return;
  }
  if (!responses.length) {
    console.log('No form responses yet. Nothing to do.');
    console.log('Columns seen: ' + headers.filter(Boolean).join(' | '));
    reportToWorkflow([]);
    return;
  }

  const known = existingJobs();
  console.log(responses.length + ' form response(s), '
    + known.length + ' job(s) already in the repo.\n');

  const imported = [];
  const skipped = [];
  const failed = [];

  for (const row of responses) {
    const label = 'row ' + row.rowNumber + ' (' + row.timestamp + ')';
    try {
      const result = await importResponse(auth, row, known.concat(imported.map(i => i.job)));
      if (result.skipped) {
        skipped.push(label + ': ' + result.reason);
      } else {
        imported.push(result);
        console.log('imported  ' + label + ' -> ' + result.slug
          + ' (' + result.photos + ' photos)');
        for (const u of result.uncertain || []) console.log('    unsure: ' + u);
        for (const u of (result.job && result.job._generated.privacyIssues) || []) {
          console.log('    PRIVACY: ' + u);
        }
      }
    } catch (err) {
      failed.push(label + ': ' + err.message);
      console.error('FAILED    ' + label + ': ' + err.message);
    }
  }

  console.log('');
  for (const s of skipped) console.log('skipped   ' + s);
  console.log('\n' + imported.length + ' imported, ' + skipped.length + ' skipped, '
    + failed.length + ' failed.');

  reportToWorkflow(imported.map(i => i.slug));

  // A failed row is worth a red build: it usually means a permission problem
  // or a quota, not a bad photo, and silence would hide it for weeks.
  if (failed.length) process.exit(1);
}

main().catch(err => {
  console.error(err.stack || String(err));
  process.exit(1);
});
