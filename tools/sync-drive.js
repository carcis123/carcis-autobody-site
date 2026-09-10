#!/usr/bin/env node
/*
 * sync-drive.js — turn a Drive folder of repair photos into job pages.
 *
 * Carlos and Kayla make one subfolder per finished job in the shared Drive
 * folder and drop the photos in. This script finds subfolders that have not
 * been imported yet, downsizes the photos into the repo, asks Gemini to draft
 * the write-up from the images, and writes one JSON file per job.
 *
 * It NEVER publishes on its own. Every job it creates is written with
 * "draft": true, which renders the page with noindex and keeps it out of the
 * sitemap, the home page and the work index. A human reads the draft in the
 * pull request, fixes what the model got wrong, sets draft to false and
 * merges. That review is the whole safety mechanism: the model is looking at
 * photographs of a car it knows nothing about, and it will get details wrong.
 *
 *   node tools/sync-drive.js            import anything new
 *   node tools/sync-drive.js --dry-run  report what it would do, write nothing
 *   node tools/sync-drive.js --force    re-import folders already imported
 *
 * Environment:
 *   DRIVE_FOLDER_ID              the shared folder's id
 *   GOOGLE_SERVICE_ACCOUNT_JSON  service account key, as JSON
 *   GEMINI_API_KEY               Google AI Studio key
 *   GEMINI_MODEL                 optional, defaults to gemini-2.5-flash
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

const MODEL = process.env.GEMINI_MODEL || 'gemini-2.5-flash';
const MAX_EDGE = 1400;         // longest side of a published photo, in pixels
const MAX_PHOTOS = 6;          // per job, to keep the repo from ballooning
const WEBP_QUALITY = 82;

const SERVICES = ['dent', 'panel', 'rust', 'collision', 'paint',
  'custom-paint', 'custom-body'];

/* ------------------------------------------------------------------ utils */

function need(name) {
  const v = process.env[name];
  if (!v) {
    console.error('missing required environment variable: ' + name);
    process.exit(1);
  }
  return v;
}

function slugify(s) {
  return s.toLowerCase()
    .normalize('NFKD').replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 70) || 'job';
}

/* Folder names look like "2026-08-28 Toyota RAV4 - rear collision".
   The leading date is optional; without it we fall back to Drive's own
   created time for the folder. */
function parseFolderName(name, createdTime) {
  const m = name.match(/^(\d{4}-\d{2}-\d{2})[\s_-]+(.*)$/);
  if (m) return { date: m[1], label: m[2].trim() };
  return { date: (createdTime || new Date().toISOString()).slice(0, 10), label: name.trim() };
}

/* "before-1.jpg", "Before 2.HEIC" and "rav4_before.jpg" all count as before.
   A filename with neither word is still published, just not in the slider. */
function roleFromFilename(name) {
  const n = name.toLowerCase();
  if (/(^|[^a-z])before([^a-z]|$)/.test(n)) return 'before';
  if (/(^|[^a-z])after([^a-z]|$)/.test(n)) return 'after';
  return null;
}

const ROLE_ORDER = { before: 0, after: 1, unlabelled: 2 };
function roleRank(name) {
  return ROLE_ORDER[roleFromFilename(name) || 'unlabelled'];
}

/* ------------------------------------------------------------------ drive */

function driveClient() {
  const creds = JSON.parse(need('GOOGLE_SERVICE_ACCOUNT_JSON'));
  const auth = new google.auth.JWT({
    email: creds.client_email,
    key: creds.private_key,
    scopes: ['https://www.googleapis.com/auth/drive.readonly'],
  });
  return google.drive({ version: 'v3', auth });
}

async function listAll(drive, query, fields) {
  const out = [];
  let pageToken;
  do {
    const res = await drive.files.list({
      q: query,
      fields: 'nextPageToken, files(' + fields + ')',
      pageSize: 200,
      pageToken,
      supportsAllDrives: true,
      includeItemsFromAllDrives: true,
    });
    out.push(...(res.data.files || []));
    pageToken = res.data.nextPageToken;
  } while (pageToken);
  return out;
}

async function download(drive, fileId) {
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
    service: { type: 'string', enum: SERVICES },
    vehicle: {
      type: 'object',
      properties: {
        year: { type: 'string' },
        make: { type: 'string' },
        model: { type: 'string' },
        color: { type: 'string' },
      },
    },
    story: { type: 'array', items: { type: 'string' } },
    photoAlts: { type: 'array', items: { type: 'string' } },
    uncertain: { type: 'array', items: { type: 'string' } },
  },
  required: ['title', 'summary', 'service', 'story', 'photoAlts'],
};

const PROMPT = `You are drafting a case-study page for Carcis Autobody Repair, a
collision and paint shop in Vancouver, Washington, owned by Carlos and Kayla
Carrasco Cisneros. The page shows before and after photos of one repair.

You will be given the folder name the shop used, any notes they typed, and the
photos in order.

Write the draft. Rules, in order of importance:

1. Do not invent facts. Describe only what is visible in the photos or stated
   in the folder name and notes. If you cannot tell the model year, do not
   guess one. If you cannot tell whether it went through insurance, do not say.
   Anything you are unsure about goes in the "uncertain" array instead of the
   page copy, so a human can confirm or delete it.
2. Do not invent customer stories, timelines, prices, or quotes from anyone.
3. Write about the technique and what the repair involved. That is what makes
   the page worth reading and worth ranking. General knowledge about how a
   repair of this type is done is fine and encouraged. Presenting a guess about
   THIS car as fact is not.
4. Plain, direct trade voice. No marketing adjectives, no "stunning", no
   "transformation". Short sentences. No em dashes.
5. "story" is 2 to 4 paragraphs, 60 to 200 words total.
6. "summary" is one sentence under 160 characters, used as the meta description.
7. "title" names the vehicle and the work, under 70 characters.
8. "photoAlts" has exactly one entry per photo, in the same order, each a plain
   factual description for a screen reader. No keyword stuffing.
9. "service" must be the single closest match from the allowed list.

Folder name: `;

async function draftWithGemini(label, notes, photos) {
  const key = need('GEMINI_API_KEY');
  const parts = [{ text: PROMPT + label + '\n\nShop notes: ' + (notes || '(none provided)')
    + '\n\nThe ' + photos.length + ' photos follow in order.' }];

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
    throw new Error('Gemini request failed (' + res.status + '): ' + body.slice(0, 400));
  }

  const data = await res.json();
  const text = data?.candidates?.[0]?.content?.parts?.[0]?.text;
  if (!text) throw new Error('Gemini returned no content: ' + JSON.stringify(data).slice(0, 400));

  let draft;
  try {
    draft = JSON.parse(text);
  } catch (e) {
    throw new Error('Gemini returned non-JSON: ' + text.slice(0, 400));
  }

  if (!SERVICES.includes(draft.service)) draft.service = 'collision';
  if (!Array.isArray(draft.story)) draft.story = [];
  if (!Array.isArray(draft.photoAlts)) draft.photoAlts = [];
  return draft;
}

/* ------------------------------------------------------------------ jobs */

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

async function importFolder(drive, folder, known) {
  const { date, label } = parseFolderName(folder.name, folder.createdTime);
  const slug = slugify(label);

  if (!FORCE && known.some(j => j.driveFolderId === folder.id)) {
    return { skipped: true, slug, reason: 'already imported' };
  }
  if (!FORCE && known.some(j => j.slug === slug)) {
    return { skipped: true, slug, reason: 'slug already used by another job' };
  }

  const files = await listAll(
    drive,
    "'" + folder.id + "' in parents and trashed = false",
    'id, name, mimeType, size'
  );

  const images = files
    .filter(f => f.mimeType && f.mimeType.startsWith('image/'))
    .sort((a, b) => a.name.localeCompare(b.name, 'en', { numeric: true }));

  if (!images.length) return { skipped: true, slug, reason: 'no images in folder' };

  // Before photos first, then after, then anything unlabelled.
  images.sort((a, b) => roleRank(a.name) - roleRank(b.name));
  const chosen = images.slice(0, MAX_PHOTOS);

  const notesFile = files.find(f => /^notes\.txt$/i.test(f.name));
  let notes = '';
  if (notesFile) notes = (await download(drive, notesFile.id)).toString('utf8').trim();

  // Downsize before anything else. The originals stay in Drive as the archive;
  // only web-sized WebP lands in git, and Gemini sees the smaller copies too.
  const processed = [];
  const unreadable = [];
  for (let i = 0; i < chosen.length; i++) {
    const file = chosen[i];
    const raw = await download(drive, file.id);
    const role = roleFromFilename(file.name);

    let out;
    try {
      out = await sharp(raw)
        .rotate()
        .resize({ width: MAX_EDGE, height: MAX_EDGE, fit: 'inside', withoutEnlargement: true })
        .webp({ quality: WEBP_QUALITY })
        .toBuffer({ resolveWithObject: true });
    } catch (err) {
      // Almost always an iPhone HEIC. The prebuilt sharp binaries ship without
      // HEIF support, so the fix is at the camera, not here: Settings, Camera,
      // Formats, Most Compatible. Skip the photo instead of losing the job.
      unreadable.push(file.name);
      console.warn('    unreadable, skipping: ' + file.name
        + ' (' + String(err.message).split('\n')[0] + ')');
      continue;
    }

    processed.push({
      buffer: out.data,
      width: out.info.width,
      height: out.info.height,
      role,
      name: (role || 'photo') + '-' + (i + 1) + '.webp',
      sourceName: file.name,
    });
  }

  if (!processed.length) {
    return {
      skipped: true, slug,
      reason: 'none of the ' + chosen.length + ' photos could be decoded'
        + (unreadable.length ? ' (' + unreadable.join(', ') + ')' : '')
        + '. If these are iPhone HEIC files, set Camera to Most Compatible.',
    };
  }

  const draft = await draftWithGemini(label, notes, processed);

  const photos = processed.map((p, i) => {
    const entry = {
      file: '/assets/work/' + slug + '/' + p.name,
      alt: draft.photoAlts[i] || (label + ', photo ' + (i + 1)),
      width: p.width,
      height: p.height,
    };
    if (p.role) entry.role = p.role;
    return entry;
  });

  const job = {
    _generated: {
      by: 'tools/sync-drive.js',
      model: MODEL,
      importedAt: new Date().toISOString(),
      driveFolder: folder.name,
      shopNotes: notes || null,
      uncertain: draft.uncertain || [],
      skippedPhotos: unreadable,
      review: 'Copy below is a Gemini draft from the photos. Check every claim, '
        + 'fix the voice, then set "draft" to false to publish.',
    },
    slug,
    driveFolderId: folder.id,
    date,
    title: draft.title,
    summary: draft.summary,
    service: draft.service,
    vehicle: draft.vehicle || {},
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

  return { slug, imported: true, photos: photos.length, uncertain: draft.uncertain || [] };
}

/* ------------------------------------------------------------------ main */

/* The workflow branches on this, so it must be written on every exit path
   that is not a crash. An unset output would read as "something to publish". */
function reportToWorkflow(slugs) {
  if (!process.env.GITHUB_OUTPUT) return;
  fs.appendFileSync(process.env.GITHUB_OUTPUT,
    'imported=' + slugs.length + '\n' + 'slugs=' + slugs.join(',') + '\n');
}

async function main() {
  const folderId = need('DRIVE_FOLDER_ID');
  const drive = driveClient();

  const folders = await listAll(
    drive,
    "'" + folderId + "' in parents and mimeType = 'application/vnd.google-apps.folder' and trashed = false",
    'id, name, createdTime'
  );

  if (!folders.length) {
    console.log('No job subfolders found in the Drive folder. Nothing to do.');
    reportToWorkflow([]);
    return;
  }

  const known = existingJobs();
  console.log(folders.length + ' folder(s) in Drive, ' + known.length + ' job(s) already in the repo.\n');

  const imported = [];
  const skipped = [];
  const failed = [];

  for (const folder of folders) {
    try {
      const result = await importFolder(drive, folder, known.concat(imported.map(i => i.job || i)));
      if (result.skipped) {
        skipped.push(folder.name + ' (' + result.reason + ')');
      } else {
        imported.push(result);
        console.log('imported  ' + folder.name + ' -> ' + result.slug
          + ' (' + result.photos + ' photos)');
        for (const u of result.uncertain || []) console.log('    unsure: ' + u);
      }
    } catch (err) {
      failed.push(folder.name + ': ' + err.message);
      console.error('FAILED    ' + folder.name + ': ' + err.message);
    }
  }

  console.log('');
  for (const s of skipped) console.log('skipped   ' + s);
  console.log('\n' + imported.length + ' imported, ' + skipped.length + ' skipped, '
    + failed.length + ' failed.');

  reportToWorkflow(imported.map(i => i.slug));

  // A folder that fails is worth a red build: it usually means a permission
  // problem or a quota, not a bad photo, and silence would hide it for weeks.
  if (failed.length) process.exit(1);
}

main().catch(err => {
  console.error(err.stack || String(err));
  process.exit(1);
});
