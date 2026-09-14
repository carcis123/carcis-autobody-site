#!/usr/bin/env node
/*
 * sync-form.js — turn Google Form submissions into job pages.
 *
 * Carlos and Kayla fill in the "Carcis job upload" form on their phone: the
 * vehicle, what they did, a few sentences about the job, and the before and
 * after photos. Google puts the answers in a spreadsheet and the photos in
 * Drive. For each row not imported yet, this script:
 *
 *   1. downsizes the photos
 *   2. asks Gemini to draft the page, fix typos in the form's vehicle fields,
 *      strip personal details out of the shop's notes, and box every license
 *      plate, face, name, document or screen it can see
 *   3. pixelates those boxes
 *   4. sends the redacted photos back to Gemini to confirm nothing personal
 *      is still readable, and redacts again if something is
 *   5. writes one JSON file per job, plus the redacted photos
 *
 * Personal information is removed automatically but never assumed gone.
 * Anything the model saw and could not redact, or a check that did not finish,
 * goes into _generated.privacyIssues, and build.js refuses to publish that job
 * until a person has looked and set _generated.privacyReviewed to true.
 *
 * It NEVER publishes on its own. Every job it creates is written with
 * "draft": true, which renders the page with noindex and keeps it out of the
 * sitemap, the home page and the work index. A human reads the draft in the
 * pull request, fixes what the model got wrong, sets draft to false and
 * merges.
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
const PREVIEW_QUALITY = 85;    // what Gemini sees; a little sharper helps it read plates
const VERIFY_ROUNDS = 2;       // re-check passes after the first redaction

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

function firstLine(s) {
  return String(s).split(/\r?\n/)[0];
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

/* ------------------------------------------------------- American English */

/* The site is written in American English. The prompt asks for it, and this
   catches what slips through, in the copy and in the form's own answers.
   Word-boundary matches only, so "Greyhound" and "centerline" are left alone. */
const AMERICAN = [
  ['colours', 'colors'], ['coloured', 'colored'], ['colour', 'color'],
  ['greys', 'grays'], ['grey', 'gray'],
  ['centres', 'centers'], ['centred', 'centered'], ['centre', 'center'],
  ['millimetres', 'millimeters'], ['millimetre', 'millimeter'],
  ['metres', 'meters'], ['metre', 'meter'],
  ['neighbouring', 'neighboring'], ['neighbours', 'neighbors'], ['neighbour', 'neighbor'],
  ['favourite', 'favorite'],
  ['realised', 'realized'], ['realise', 'realize'],
  ['organised', 'organized'], ['organise', 'organize'],
  ['customised', 'customized'], ['customise', 'customize'],
  ['recognised', 'recognized'], ['recognise', 'recognize'],
  ['analysed', 'analyzed'], ['analyse', 'analyze'],
  ['tyres', 'tires'], ['tyre', 'tire'],
  ['aluminium', 'aluminum'], ['behaviour', 'behavior'], ['labour', 'labor'],
  ['windscreen', 'windshield'], ['number plates', 'license plates'],
  ['number plate', 'license plate'], ['bonnet', 'hood'],
];

function toAmerican(text) {
  if (typeof text !== 'string') return text;
  let out = text;
  for (const [uk, us] of AMERICAN) {
    out = out.replace(new RegExp('\\b' + uk + '\\b', 'gi'), m => {
      if (m.length > 1 && m === m.toUpperCase()) return us.toUpperCase();
      if (m[0] === m[0].toUpperCase()) return us[0].toUpperCase() + us.slice(1);
      return us;
    });
  }
  return out;
}

/* ----------------------------------------------------------- personal data */

const PII_LIST = 'license plates (front, rear, temporary or dealer tags), faces, '
  + "people's names, name tags or handwriting, street addresses, phone numbers, "
  + 'email addresses, VINs, insurance or repair paperwork, phone or computer '
  + 'screens, and anything else that identifies the customer or another person';

/* A backstop for the model, not a replacement for it: patterns that are
   unambiguous enough to strip mechanically wherever text is stored or shown. */
function scrubText(text) {
  if (text === null || text === undefined) return text;
  return String(text)
    .replace(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi, '[removed]')
    .replace(/(?:\+?1[\s.-]?)?\(?\b\d{3}\)?[\s.-]?\d{3}[\s.-]?\d{4}\b/g, '[removed]')
    .replace(/\b[A-HJ-NPR-Z0-9]{17}\b/g, '[removed]');
}

function cleanCopy(text) {
  return scrubText(toAmerican(String(text || ''))).trim();
}

/* --------------------------------------------------------- vehicle typos */

function editDistance(a, b) {
  const dp = Array.from({ length: a.length + 1 }, (_, i) => [i]);
  for (let j = 1; j <= b.length; j++) dp[0][j] = j;
  for (let i = 1; i <= a.length; i++) {
    for (let j = 1; j <= b.length; j++) {
      dp[i][j] = Math.min(
        dp[i - 1][j] + 1,
        dp[i][j - 1] + 1,
        dp[i - 1][j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
    }
  }
  return dp[a.length][b.length];
}

/* The model is trusted to fix spelling, not to change what the shop said.
   A proposed value is only taken if it is close to what was typed; anything
   further away is logged and the shop's own answer is kept. */
function acceptCorrection(field, original, proposed) {
  const a = String(original || '').trim();
  const b = String(proposed || '').trim();
  if (!a) return { value: '' };                 // never invent a field left blank
  if (!b) return { value: a };
  if (field === 'year') {
    // A valid-looking year is never second-guessed: 2023 and 2024 are one
    // keystroke apart but different cars. Only an impossible year is fixed.
    const plausible = y => /^\d{4}$/.test(y) && +y >= 1900 && +y <= new Date().getFullYear() + 1;
    if (plausible(a) || b === a) return { value: a };
    if (plausible(b) && editDistance(a, b) <= 2) return { value: b };
    return { value: a, rejected: b };
  }
  const na = a.toLowerCase().replace(/\s+/g, '');
  const nb = b.toLowerCase().replace(/\s+/g, '');
  if (na === nb) return { value: b };
  const limit = Math.max(2, Math.round(na.length * 0.4));
  if (editDistance(na, nb) <= limit) return { value: b };
  return { value: a, rejected: b };
}

/* ------------------------------------------------------------------ photos */

async function decodePhoto(raw) {
  const out = await sharp(raw)
    .rotate()
    .resize({ width: MAX_EDGE, height: MAX_EDGE, fit: 'inside', withoutEnlargement: true })
    .removeAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true });
  return {
    pixels: out.data,
    info: { width: out.info.width, height: out.info.height, channels: out.info.channels },
  };
}

function rawInput(photo) {
  return { raw: photo.info };
}

function toWebp(photo, quality) {
  return sharp(photo.pixels, rawInput(photo)).webp({ quality }).toBuffer();
}

/* Pixelate boxes in Gemini's spatial format: box_2d is [ymin, xmin, ymax, xmax]
   normalized to 0-1000. Boxes are padded, because model boxes are approximate
   and a clipped character is still a readable character. Blocks are sized so
   the longest side of any region is at most ten blocks across, which leaves
   nothing legible. Works on raw pixels so repeated passes never recompress. */
async function pixelate(photo, boxes) {
  const W = photo.info.width;
  const H = photo.info.height;
  const composites = [];
  const applied = [];
  const unusable = [];

  for (const item of boxes) {
    const label = String((item && item.label) || 'item');
    const v = Array.isArray(item && item.box_2d) ? item.box_2d.map(Number) : [];
    if (v.length !== 4 || v.some(n => !Number.isFinite(n))) { unusable.push(label); continue; }
    let [ymin, xmin, ymax, xmax] = v;
    if (Math.max(ymin, xmin, ymax, xmax) <= 1) {
      ymin *= 1000; xmin *= 1000; ymax *= 1000; xmax *= 1000;
    }
    if (ymax <= ymin || xmax <= xmin) { unusable.push(label); continue; }

    let left = xmin / 1000 * W;
    let top = ymin / 1000 * H;
    let right = xmax / 1000 * W;
    let bottom = ymax / 1000 * H;
    const padX = (right - left) * 0.15 + 4;
    const padY = (bottom - top) * 0.15 + 4;
    left = Math.max(0, Math.floor(left - padX));
    top = Math.max(0, Math.floor(top - padY));
    right = Math.min(W, Math.ceil(right + padX));
    bottom = Math.min(H, Math.ceil(bottom + padY));
    const w = right - left;
    const h = bottom - top;
    if (w < 4 || h < 4) { unusable.push(label); continue; }

    const block = Math.max(16, Math.round(Math.max(w, h) / 10));
    const small = await sharp(photo.pixels, rawInput(photo))
      .extract({ left, top, width: w, height: h })
      .resize(Math.max(2, Math.round(w / block)), Math.max(2, Math.round(h / block)), { fit: 'fill' })
      .raw()
      .toBuffer({ resolveWithObject: true });
    const tile = await sharp(small.data, {
      raw: { width: small.info.width, height: small.info.height, channels: small.info.channels },
    })
      .resize(w, h, { kernel: 'nearest', fit: 'fill' })
      .png()
      .toBuffer();
    composites.push({ input: tile, left, top });
    applied.push({ label, left, top, width: w, height: h });
  }

  if (composites.length) {
    const out = await sharp(photo.pixels, rawInput(photo))
      .composite(composites)
      .removeAlpha()
      .raw()
      .toBuffer({ resolveWithObject: true });
    photo.pixels = out.data;
    photo.info = { width: out.info.width, height: out.info.height, channels: out.info.channels };
  }
  return { applied, unusable };
}

/* Route model boxes to their photo and pixelate them. Anything that cannot be
   placed or drawn becomes an unresolved privacy issue rather than being
   silently dropped. */
async function redactAll(photos, items, stage) {
  const applied = [];
  const unresolved = [];
  const byPhoto = photos.map(() => []);
  for (const it of Array.isArray(items) ? items : []) {
    const n = Number(it && it.photo);
    if (Number.isInteger(n) && n >= 1 && n <= photos.length) byPhoto[n - 1].push(it);
    else unresolved.push('photo ' + (it && it.photo) + ': ' + ((it && it.label) || 'item')
      + ' could not be matched to a photo');
  }
  for (let i = 0; i < photos.length; i++) {
    if (!byPhoto[i].length) continue;
    const r = await pixelate(photos[i], byPhoto[i]);
    for (const a of r.applied) applied.push({ photo: i + 1, label: a.label, stage });
    for (const u of r.unusable) {
      unresolved.push('photo ' + (i + 1) + ': ' + u + ' was found but its position was unusable');
    }
  }
  return { applied, unresolved };
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

const BOX_ITEM = {
  type: 'object',
  properties: {
    photo: { type: 'integer' },
    label: { type: 'string' },
    box_2d: { type: 'array', items: { type: 'integer' } },
  },
  required: ['photo', 'label', 'box_2d'],
};

const DRAFT_SCHEMA = {
  type: 'object',
  properties: {
    title: { type: 'string' },
    summary: { type: 'string' },
    story: { type: 'array', items: { type: 'string' } },
    photoAlts: { type: 'array', items: { type: 'string' } },
    vehicle: {
      type: 'object',
      properties: {
        year: { type: 'string' },
        make: { type: 'string' },
        model: { type: 'string' },
        color: { type: 'string' },
      },
    },
    corrections: { type: 'array', items: { type: 'string' } },
    notesRedacted: { type: 'string' },
    redactions: { type: 'array', items: BOX_ITEM },
    privacyIssues: { type: 'array', items: { type: 'string' } },
    uncertain: { type: 'array', items: { type: 'string' } },
  },
  required: ['title', 'summary', 'story', 'photoAlts', 'vehicle', 'notesRedacted', 'redactions'],
};

const VERIFY_SCHEMA = {
  type: 'object',
  properties: {
    remaining: { type: 'array', items: BOX_ITEM },
  },
  required: ['remaining'],
};

const DRAFT_PROMPT = `You are drafting a case-study page for Carcis Autobody Repair, a
collision and paint shop in Vancouver, Washington, owned by Carlos and Kayla
Carrasco Cisneros. The page shows before and after photos of one repair. The
shop filled in a form, and the photos follow in the order listed at the end,
numbered from 1.

Rules, in order of importance:

1. Protect privacy. This page is public.
   a. Never put personal information in the title, summary, story or alt
      text: names, phone numbers, email addresses, addresses, license plates,
      VINs, claim or policy numbers, or anything about the customer's own
      business, where they bought the car, or what they use it for.
   b. "redactions": box every one of these, in every photo, even when small,
      partly hidden, reflected or at an angle: ${PII_LIST}. One entry per item.
      "photo" is the photo number, counting from 1. "box_2d" is
      [ymin, xmin, ymax, xmax] as integers from 0 to 1000 relative to that
      photo, drawn generously around the whole item. Most photos of the front
      or back of a car show a readable license plate, so look for it.
   c. "notesRedacted": the shop's notes with any of that information replaced
      by [removed]. Keep all of the repair detail. If nothing needs removing,
      return the notes unchanged.
   d. "privacyIssues": anything personal you can see but cannot box. Leave it
      empty when everything is boxed.
2. Do not invent facts. The service and the date come from the form; use them
   as given. Everything else must be visible in the photos or stated in the
   notes. Anything you are unsure about goes in "uncertain" instead of the
   page copy.
3. Fix typos in the form's vehicle fields and nothing more. "vehicle" returns
   the year, make, model and color with spelling and capitalization corrected
   to the manufacturer's real names and ordinary color words. For example
   "Modle 3" becomes "Model 3" and "Matalic grey" becomes "Metallic Gray".
   Never change it to a different vehicle or a different color. If you are
   not sure what was meant, return the field exactly as given and say so in
   "uncertain". List every change in "corrections", written like
   "model: Modle 3 -> Model 3".
4. Write in American English everywhere: color, gray, center, meter, tire,
   hood, trunk, windshield, license plate.
5. Do not invent customer stories, timelines, prices, or quotes from anyone.
6. Build the piece around the shop's notes. Those are the real detail and the
   reason the page is worth reading. Expand them with general knowledge about
   how this kind of repair is done. General technique is fine and encouraged.
   Presenting a guess about THIS car as fact is not.
7. Plain, direct trade voice. No marketing adjectives, no "stunning", no
   "transformation". Short sentences. No em dashes.
8. "story" is 2 to 4 paragraphs, 90 to 220 words total. "summary" is one
   sentence under 160 characters for the meta description, and mentions the
   vehicle and the work. "title" names the vehicle and the work in under 70
   characters. Use the corrected vehicle names in all three.
9. "photoAlts" has exactly one entry per photo, in the same order, each a
   plain factual description for a screen reader with no personal
   information and no keyword stuffing.

The facts from the form:
`;

const VERIFY_PROMPT = `These photos are about to be published on a public website.
Personal information has already been pixelated in them, and the pixelated
blocks can be ignored. Check every photo, numbered from 1 in the order given,
for anything personal that is still readable or recognizable: ${PII_LIST}.

Return each remaining item in "remaining". "photo" is the photo number,
counting from 1. "box_2d" is [ymin, xmin, ymax, xmax] as integers from 0 to
1000 relative to that photo, drawn generously around the item. Return an
empty array only if you checked every photo and nothing personal is readable.`;

async function callGemini(parts, schema, temperature) {
  const key = need('GEMINI_API_KEY');
  const url = 'https://generativelanguage.googleapis.com/v1beta/models/'
    + encodeURIComponent(MODEL) + ':generateContent';

  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-goog-api-key': key },
    body: JSON.stringify({
      contents: [{ role: 'user', parts }],
      generationConfig: {
        temperature,
        responseMimeType: 'application/json',
        responseSchema: schema,
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
  try {
    return JSON.parse(text);
  } catch {
    throw new Error('Gemini returned non-JSON: ' + text.slice(0, 400));
  }
}

function imageParts(previews) {
  return previews.map(buf => ({ inlineData: { mimeType: 'image/webp', data: buf.toString('base64') } }));
}

async function draftWithGemini(facts, photos, previews) {
  const factLines = [
    'Year: ' + (facts.year || 'not given'),
    'Make: ' + (facts.make || 'not given'),
    'Model: ' + (facts.model || 'not given'),
    'Color: ' + (facts.color || 'not given'),
    'Work done: ' + (SERVICE_LABELS[facts.serviceId] || 'not given'),
    'Completed: ' + facts.date,
    'Insurance claim: ' + (facts.insurance ? 'yes' : 'not stated'),
    '',
    "The shop's own notes:",
    facts.notes || '(none provided)',
    '',
    'Photos in order: ' + photos.map((p, i) => (i + 1) + ' ' + p.role).join(', '),
  ].join('\n');

  const draft = await callGemini(
    [{ text: DRAFT_PROMPT + factLines }, ...imageParts(previews)], DRAFT_SCHEMA, 0.4);

  for (const key of ['story', 'photoAlts', 'corrections', 'redactions', 'privacyIssues', 'uncertain']) {
    if (!Array.isArray(draft[key])) draft[key] = [];
  }
  if (!draft.vehicle || typeof draft.vehicle !== 'object') draft.vehicle = {};
  return draft;
}

async function verifyWithGemini(previews) {
  const verdict = await callGemini(
    [{ text: VERIFY_PROMPT }, ...imageParts(previews)], VERIFY_SCHEMA, 0);
  return Array.isArray(verdict.remaining) ? verdict.remaining : null;
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

  const wanted = [
    ...row.beforeIds.map(id => ({ id, role: 'before' })),
    ...row.afterIds.map(id => ({ id, role: 'after' })),
  ].slice(0, MAX_PHOTOS);

  if (!wanted.length) return { skipped: true, reason: 'no photos attached' };

  // 1. Download and downsize. Pixels stay raw until the very end, so however
  //    many redaction passes run, each photo is compressed exactly once.
  const photos = [];
  const unreadable = [];
  for (const { id, role } of wanted) {
    let raw;
    try {
      raw = await download(auth, id);
    } catch (err) {
      unreadable.push(id + ' (download failed: ' + firstLine(err.message) + ')');
      continue;
    }
    try {
      const decoded = await decodePhoto(raw);
      photos.push({
        ...decoded,
        role,
        name: role + '-' + (photos.filter(p => p.role === role).length + 1) + '.webp',
      });
    } catch (err) {
      // Almost always an iPhone HEIC. The prebuilt sharp binaries ship without
      // HEIF support, so the fix is at the camera: Settings, Camera, Formats,
      // Most Compatible. Skip the photo rather than losing the whole job.
      unreadable.push(id + ' (' + firstLine(err.message) + ')');
    }
  }

  if (!photos.length) {
    return {
      skipped: true,
      reason: 'none of the ' + wanted.length + ' photos could be decoded. '
        + 'If they are iPhone HEIC files, set Camera to Most Compatible. '
        + unreadable.join('; '),
    };
  }

  // 2. Draft, correct the vehicle fields, and find personal information.
  const previews = await Promise.all(photos.map(p => toWebp(p, PREVIEW_QUALITY)));
  const draft = await draftWithGemini({
    year: row.year, make: row.make, model: row.model, color: row.color,
    serviceId, date, insurance: row.insurance, notes: row.notes,
  }, photos, previews);

  // 3. Redact what it found.
  const privacyIssues = draft.privacyIssues.map(s => cleanCopy(s));
  const redactions = [];
  const firstPass = await redactAll(photos, draft.redactions, 'draft');
  redactions.push(...firstPass.applied);
  privacyIssues.push(...firstPass.unresolved);

  // 4. Show the model the redacted photos and ask what is still readable.
  //    Fail closed: an unfinished or unclean check blocks publishing.
  let verifiedClean = false;
  let checks = 0;
  try {
    for (let round = 1; round <= VERIFY_ROUNDS; round++) {
      checks = round;
      const redactedPreviews = await Promise.all(photos.map(p => toWebp(p, PREVIEW_QUALITY)));
      const remaining = await verifyWithGemini(redactedPreviews);
      if (remaining === null) throw new Error('the check returned no result');
      if (!remaining.length) { verifiedClean = true; break; }
      const pass = await redactAll(photos, remaining, 'check ' + round);
      redactions.push(...pass.applied);
      privacyIssues.push(...pass.unresolved);
      if (round === VERIFY_ROUNDS) {
        for (const it of remaining) {
          privacyIssues.push('photo ' + it.photo + ': ' + (it.label || 'item')
            + ' was still readable on the last check and was redacted again without being re-checked');
        }
      }
    }
  } catch (err) {
    privacyIssues.push('the automatic privacy check did not finish: ' + firstLine(err.message));
  }

  // 5. Take the model's spelling fixes only where they stay close to what the
  //    shop typed.
  const vehicle = {};
  const corrections = [];
  const correctionsRejected = [];
  for (const field of ['year', 'make', 'model', 'color']) {
    const original = String(row[field] || '').trim();
    if (!original) continue;
    const r = acceptCorrection(field, original, draft.vehicle[field]);
    const value = field === 'color' ? toAmerican(r.value) : r.value;
    vehicle[field] = value;
    if (value !== original) corrections.push(field + ': ' + original + ' -> ' + value);
    if (r.rejected) {
      correctionsRejected.push(field + ': kept "' + original + '", the model suggested "' + r.rejected + '"');
    }
  }

  const vehicleLabel = [vehicle.year, vehicle.make, vehicle.model].filter(Boolean).join(' ');
  let slug = slugify([vehicleLabel, SERVICE_LABELS[serviceId]].filter(Boolean).join(' '));
  if (!FORCE) {
    let n = 2;
    const base = slug;
    while (known.some(j => j.slug === slug)) slug = base + '-' + n++;
  }

  const notesStored = typeof draft.notesRedacted === 'string'
    ? cleanCopy(draft.notesRedacted) || null
    : '[not stored: the notes could not be checked for personal information]';

  const photoEntries = photos.map((p, i) => ({
    file: '/assets/work/' + slug + '/' + p.name,
    alt: cleanCopy(draft.photoAlts[i]) || (vehicleLabel + ', ' + p.role),
    width: p.info.width,
    height: p.info.height,
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
      shopNotes: notesStored,
      corrections,
      correctionsRejected,
      redactions,
      privacyChecks: checks,
      privacyVerifiedClean: verifiedClean,
      privacyIssues,
      uncertain: draft.uncertain.map(s => cleanCopy(s)),
      skippedPhotos: unreadable,
      review: 'Personal information in the photos and notes was redacted '
        + 'automatically; look at every photo anyway. The vehicle fields are '
        + "the shop's answers with typos fixed (see corrections), and the "
        + 'service and date are as submitted. The title, summary, story and alt '
        + 'text are a Gemini draft. Check every claim, fix the voice, then set '
        + '"draft" to false to publish.',
    },
    slug,
    date,
    title: cleanCopy(draft.title),
    summary: cleanCopy(draft.summary),
    service: serviceId,
    vehicle,
    insurance: row.insurance,
    draft: true,
    story: draft.story.map(p => cleanCopy(p)).filter(Boolean),
    photos: photoEntries,
  };

  const result = {
    slug, imported: true, photos: photoEntries.length, job,
    corrections, redacted: redactions.length, privacyIssues,
    uncertain: job._generated.uncertain,
  };

  if (DRY_RUN) return Object.assign(result, { imported: false, dryRun: true });

  const dir = path.join(WORK_ASSETS, slug);
  fs.mkdirSync(dir, { recursive: true });
  for (const p of photos) {
    fs.writeFileSync(path.join(dir, p.name), await toWebp(p, WEBP_QUALITY));
  }

  fs.mkdirSync(JOBS_DIR, { recursive: true });
  fs.writeFileSync(
    path.join(JOBS_DIR, date + '-' + slug + '.json'),
    JSON.stringify(job, null, 2) + '\n'
  );

  return result;
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
      console.log('  ' + firstLine(err.message));
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
        if (!result.dryRun) imported.push(result);
        console.log((result.dryRun ? 'would import ' : 'imported  ') + label + ' -> '
          + result.slug + ' (' + result.photos + ' photos)');
        for (const c of result.corrections || []) console.log('    corrected: ' + c);
        if (result.redacted) console.log('    redacted: ' + result.redacted + ' item(s)');
        for (const u of result.uncertain || []) console.log('    unsure: ' + u);
        for (const u of result.privacyIssues || []) console.log('    PRIVACY: ' + u);
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

if (require.main === module) {
  main().catch(err => {
    console.error(err.stack || String(err));
    process.exit(1);
  });
} else {
  // Exposed for local tests of the parts that need no credentials.
  module.exports = {
    toAmerican, scrubText, cleanCopy, acceptCorrection, editDistance,
    decodePhoto, toWebp, pixelate, redactAll,
  };
}
