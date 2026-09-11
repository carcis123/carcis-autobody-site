# Setup: staging, the Drive import, and Gemini

Everything in here is a one-time job, and every step needs a console I cannot
reach. Work top to bottom. Each step says what you should see when it worked.

Steps 1 and 2 are **done**. The `staging` branch is deployed and locked behind
Cloudflare Access. Steps 3 to 6 are still outstanding, and the Drive import
will not do anything until they are.

One gotcha already hit and fixed: Cloudflare's GitHub integration had silently
broken, so no push produced a build. If deployments ever stop appearing, look
for a warning banner on the project page and reconnect the Git repository.

---

## 1. Turn on the staging site

Cloudflare Pages already builds a preview for every branch. You are switching
it on for `staging` and locking it down.

1. Cloudflare dashboard, **Workers & Pages**, open the **`carcis-autobody`**
   project. Note the project name is NOT the repo name.
2. **Settings**, **Builds & deployments**, **Branch deployments**. Set preview
   branches to **All non-Production branches**, or list `staging` explicitly.
3. The `staging` branch is already pushed, so a deployment should appear under
   **Deployments** within a minute or two.

You should see: a URL like `https://staging.carcis-autobody.pages.dev`
serving the site with the new **Our Work** nav item.

### Lock the previews down

A preview is a full public copy of the site. Left open it is a duplicate that
Google can find and index.

4. Same project, **Settings**, **General**, find **Access policy** for preview
   deployments. Turn it on and restrict it to your email and Carlos's.

You should see: opening the preview URL in a private window now asks for a
Cloudflare Access login instead of showing the site. Verified working on
2026-09-11: the staging URL returns a 302 to `cloudflareaccess.com`.

### Do not give staging a custom domain

An earlier version of this document said to add `staging.carcisautobody.com`
as a custom domain pointed at the branch. **That does not work.** Cloudflare
Pages custom domains always serve the project's *production* deployment;
there is no way to bind one to a preview branch from that screen.

What happens if you try: you add a proxied CNAME from your subdomain to
`staging.<project>.pages.dev`, Cloudflare follows it, Pages has never heard of
that hostname, and every request returns **error 522, connection timed out**.
The CNAME is only half of it. A custom domain also has to be registered inside
the Pages project, and registering it would point the subdomain at `main`.

You do not need one. `https://staging.carcis-autobody.pages.dev` is permanent
for as long as the branch exists, and it is already behind Access.

If you ever genuinely want `beta.carcisautobody.com`, the supported route is a
second Pages project on the same repo with `staging` as *its* production
branch. Be aware that it would then be a production deployment, so the preview
Access policy would not cover it, and you would have to put a Zero Trust
Access application on that hostname. Without one it is a fully public,
crawlable duplicate of the whole site on a real subdomain.

### What is already handled in code

Analytics will not fire on any hostname except `carcisautobody.com` and
`www.carcisautobody.com`. Test bookings on staging cannot reach your Google Ads
conversion data. That check lives in `src/partials/head-open.html`.

### Confirm the soft-404 fix landed

Before this change, every unknown URL on the site returned the home page with
HTTP 200 instead of a 404. That meant a mistyped address looked to Google like
a real duplicate of the home page, and a deleted job page would have stayed
"alive" forever. A `404.html` at the repo root fixes it: Cloudflare Pages
serves that file with a real 404 status.

You should see, once this branch is live:

```
curl -s -o /dev/null -w '%{http_code}' https://staging.carcis-autobody.pages.dev/nope-9876/
```

printing `404`, not `200`. Production still prints `200` today; that is what
this branch fixes when it merges.

---

## 2. Check the build gate

Two workflows are now in the repo. The first, **Check the site is rebuilt**,
runs on every pull request and fails if someone edited a source file without
running `node build.js`.

You should see: a green check on the next pull request, and a red one if you
deliberately edit `src/partials/footer.html` and push without rebuilding.

---

## 3. Create the Google service account

This is what lets the workflow read the Drive folder. It is a robot account
with its own email address, and it only sees folders you share with it.

1. Go to the Google Cloud console and create a project, or pick an existing
   one. Name it something like `carcis-website`.
2. **APIs & Services**, **Library**, search for **Google Drive API**, enable it.
3. **APIs & Services**, **Credentials**, **Create credentials**, **Service
   account**. Name it `carcis-photo-import`. No roles are needed; Drive access
   comes from sharing the folder, not from a project role.
4. Open the new service account, **Keys**, **Add key**, **Create new key**,
   **JSON**. A `.json` file downloads.

You should see: a JSON file containing `"client_email"` and `"private_key"`.
Keep it out of the repo. It is a credential.

---

## 4. Share the Drive folder with it

1. Open the JSON file and copy the `client_email` value. It looks like
   `carcis-photo-import@carcis-website.iam.gserviceaccount.com`.
2. Open the shared Drive folder, **Share**, paste that address, give it
   **Viewer**, uncheck the notification email, share.
3. Copy the folder id from the folder's URL. In
   `https://drive.google.com/drive/u/1/folders/1J94FQkw...` the id is
   everything after `/folders/`.

You should see: the service account listed as a Viewer on the folder.

---

## 5. Get a Gemini API key

1. Go to Google AI Studio and create an API key, in the same Cloud project if
   it offers the choice.

This is separate from Gemini in Drive or Workspace. Those are for people
reading files in a browser; the workflow needs a key it can send requests with.

You should see: a key starting with `AIza`.

---

## 6. Put the three secrets in GitHub

GitHub repo, **Settings**, **Secrets and variables**, **Actions**, **New
repository secret**. Add exactly these names:

| Name | Value |
| --- | --- |
| `DRIVE_FOLDER_ID` | the folder id from step 4 |
| `GOOGLE_SERVICE_ACCOUNT_JSON` | the entire contents of the JSON file from step 3 |
| `GEMINI_API_KEY` | the key from step 5 |

Paste the whole JSON file for the second one, braces and all, on one line or
many. Do not paste just the private key.

Optionally add a **variable**, not a secret, named `GEMINI_MODEL` to pin a
different model. It defaults to `gemini-2.5-flash`.

---

## 7. First run

1. Make one test subfolder in the Drive folder. Name it like
   `2026-09-12 Toyota Corolla - rear bumper`. Put in two photos named
   `before-1.jpg` and `after-1.jpg`.
2. GitHub repo, **Actions**, **Import repair photos from Drive**, **Run
   workflow**.

You should see: the workflow succeed, and a pull request titled
`Drive import: 1 repair job(s)`.

Open it. Every job it creates is marked `"draft": true`, which means the page
is `noindex` and does not appear on the home page, the work index or the
sitemap. Read the draft, fix what Gemini got wrong, set `"draft": false`, run
`node build.js`, commit, merge.

After that it runs on its own every six hours.

---

## Troubleshooting

**"File not found" on the folder id.** The service account was not actually
added to the folder, or you copied a shortcut's id. Re-share the real folder.

**Photos skipped as unreadable.** Almost always iPhone HEIC files. On the
iPhone: Settings, Camera, Formats, **Most Compatible**. That makes the camera
save JPEG. Existing HEIC photos need re-exporting; the import logs each file it
could not read and carries on with the rest.

**The workflow is red but nothing was imported.** A folder failed. The log
names it. A failure is deliberately loud because it usually means a permission
or quota problem, not a bad photo.

**Gemini quota errors.** The free tier is rate limited. The import runs four
times a day and only touches new folders, so this normally only appears on a
first run over a large backlog. Re-run the workflow; already-imported folders
are skipped.

---

## Running costs

| Item | Cost |
| --- | --- |
| Cloudflare Pages, including previews | free |
| GitHub Actions, roughly 80 minutes a month | free, allowance is 2,000 |
| Google service account and Drive API | free |
| Gemini, a few calls a week | free tier, then cents |
