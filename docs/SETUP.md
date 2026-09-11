# Setup: staging, the job upload form, and Gemini

Every step here needs a console I cannot reach. Work top to bottom. Each step
says what you should see when it worked.

Steps 1 and 2 are **done**. The `staging` branch is deployed and locked behind
Cloudflare Access. The rest is still outstanding, and the job import will not
do anything until it is finished.

One gotcha already hit and fixed: Cloudflare's GitHub integration had silently
broken, so no push produced a build. If deployments ever stop appearing, look
for a warning banner on the project page and reconnect the Git repository.

---

## 1. Staging — done

The Cloudflare Pages project is named **`carcis-autobody`**, not
`carcis-autobody-site` like the repo.

Staging lives at `https://staging.carcis-autobody.pages.dev`, built from the
`staging` branch, and is behind a Cloudflare Access policy. Verified: the URL
returns a 302 to `cloudflareaccess.com` for anyone not signed in.

### Do not give staging a custom domain

An earlier version of this document said to add `staging.carcisautobody.com`
as a custom domain pointed at the branch. **That does not work.** Cloudflare
Pages custom domains always serve the project's *production* deployment; there
is no way to bind one to a preview branch from that screen.

What happens if you try: you add a proxied CNAME from your subdomain to
`staging.<project>.pages.dev`, Cloudflare follows it, Pages has never heard of
that hostname, and every request returns **error 522, connection timed out**.
The CNAME is only half of it. A custom domain also has to be registered inside
the Pages project, and registering it would point the subdomain at `main`.

You do not need one. The `pages.dev` address is permanent for as long as the
branch exists, and pull request previews get their own URLs anyway.

If you ever genuinely want `beta.carcisautobody.com`, the supported route is a
second Pages project on the same repo with `staging` as *its* production
branch. Be aware it would then be a production deployment, so the preview
Access policy would not cover it, and you would have to put a Zero Trust
Access application on that hostname. Without one it is a fully public,
crawlable duplicate of the whole site on a real subdomain.

### What is already handled in code

Analytics will not fire on any hostname except `carcisautobody.com` and
`www.carcisautobody.com`. Test bookings on staging cannot reach your Google
Ads conversion data. That check lives in `src/partials/head-open.html`.

---

## 2. The build gate — done

**Check the site is rebuilt** runs on every pull request and fails if someone
edited a source file without running `node build.js`.

---

## 3. Create the Google Form

The shop fills in one form per finished job. It gives structured answers
instead of folder names someone has to remember, and Google puts the photos in
Drive and the answers in a spreadsheet automatically.

1. Go to https://forms.new and title it **Carcis job upload**.
2. Add these questions, in this order. The exact wording is flexible; the
   importer matches columns on the bolded keyword, not the full sentence.

| # | Question | Type | Required |
| --- | --- | --- | --- |
| 1 | Date the job was **finished** | Date | yes |
| 2 | Vehicle **year** | Short answer | no |
| 3 | Vehicle **make** | Short answer | yes |
| 4 | Vehicle **model** | Short answer | yes |
| 5 | **Colour** | Short answer | no |
| 6 | What **work** did you do? | Multiple choice | yes |
| 7 | Was this an **insurance** claim? | Multiple choice | no |
| 8 | **Tell us** about this job | Paragraph | yes |
| 9 | **Before** photos | File upload | yes |
| 10 | **After** photos | File upload | yes |

3. Question 6 options, spelled exactly: Dent Repair, Panel Repair, Rust
   Repair, Collision Repair, Paint, Custom Paint & Design, Custom Body Work.
   These map to the seven services on the site. A reworded option is still
   matched by keyword, but a brand new one makes the row skip.
4. Question 7 options: Yes, No.
5. Questions 9 and 10: choose **File upload**, accept the warning, then set
   **Specific file types** to Image, **Maximum number of files** to 5, and
   **Maximum file size** to 10 MB.
6. On question 8, add this description via the three-dot menu:

   > Two or three sentences, like you would tell the customer standing next to
   > the car. What came in, what you did, anything unusual about the match or
   > the parts.

7. **Settings**: turn on **Collect email addresses**. Turn off "Limit to 1
   response".
8. **Responses** tab, click the Sheets icon, **Create new spreadsheet**.

You should see: a new spreadsheet whose first row is the question headers.
Copy its id from the URL, the long string between `/d/` and `/edit`.

File upload requires respondents to be signed in to a Google account. That is
Google's rule and cannot be turned off.

---

## 4. Create the Google service account

This is what lets the workflow read the spreadsheet and the photos. It is a
robot account with its own email address, and it only sees what you share with
it.

1. Go to the Google Cloud console and create a project, or pick an existing
   one. Name it something like `carcis-website`.
2. **APIs & Services**, **Library**. Enable **both**:
   - Google Drive API
   - Google Sheets API
3. **APIs & Services**, **Credentials**, **Create credentials**, **Service
   account**. Name it `carcis-job-import`. No roles are needed; access comes
   from sharing, not from a project role.
4. Open the new service account, **Keys**, **Add key**, **Create new key**,
   **JSON**. A `.json` file downloads.

You should see: a JSON file containing `"client_email"` and `"private_key"`.
Keep it out of the repo. It is a credential.

---

## 5. Share the spreadsheet and the photo folder with it

1. Open the JSON file and copy the `client_email` value. It looks like
   `carcis-job-import@carcis-website.iam.gserviceaccount.com`.
2. Open the **response spreadsheet**, **Share**, paste that address, give it
   **Viewer**, uncheck the notification email, share.
3. After the first submission, Drive will contain a folder called **Carcis job
   upload (File responses)**. Share that folder with the same address as
   **Viewer** too.

Both are required. The spreadsheet holds the answers, the folder holds the
photos, and they are separate permissions. Missing the second one is the most
common cause of a failed import.

You should see: the service account listed as a Viewer on both.

---

## 6. Get a Gemini API key

1. Go to Google AI Studio and create an API key, in the same Cloud project if
   it offers the choice.

This is separate from Gemini in Drive or Workspace. Those are for people
reading files in a browser; the workflow needs a key it can send requests with.

You should see: a key starting with `AIza`.

---

## 7. Put the three secrets in GitHub

GitHub repo, **Settings**, **Secrets and variables**, **Actions**, **New
repository secret**. Add exactly these names:

| Name | Value |
| --- | --- |
| `FORM_SHEET_ID` | the spreadsheet id from step 3 |
| `GOOGLE_SERVICE_ACCOUNT_JSON` | the entire contents of the JSON file from step 4 |
| `GEMINI_API_KEY` | the key from step 6 |

Paste the whole JSON file for the second one, braces and all. Do not paste just
the private key.

Optionally add a **variable**, not a secret, named `GEMINI_MODEL` to pin a
different model. It defaults to `gemini-2.5-flash`.

---

## 8. First run

1. Submit the form yourself once, with two photos, as a test.
2. GitHub repo, **Actions**, **Import repair jobs from the Google Form**,
   **Run workflow**.

You should see: the workflow succeed, and a pull request titled
`Job import: 1 repair job(s)`.

Open it. Every job is marked `"draft": true`, which means the page is
`noindex` and does not appear on the home page, the work index or the sitemap.
The vehicle, service and date are the shop's own answers and can be trusted.
The title, summary, story and alt text are a Gemini draft. Read them, fix what
is wrong, set `"draft": false`, run `node build.js`, commit, merge.

After that it runs on its own every six hours.

---

## Troubleshooting

**"could not find a timestamp/before/after column".** The importer prints the
headers it actually saw. Compare them with the table in step 3 and either
rename the question or widen the matcher in `tools/sync-form.js`.

**Permission denied on the spreadsheet or a photo.** The service account is
missing from one of the two shares in step 5. Both are required.

**A row is skipped with "could not match ... to a service".** Someone edited
the question 6 options into something the seven services do not cover.

**Photos skipped as unreadable.** Almost always iPhone HEIC files. On the
iPhone: Settings, Camera, Formats, **Most Compatible**. That makes the camera
save JPEG. The import logs each file it could not read and carries on with the
rest; if none of a row's photos decode, the whole row is skipped.

**The workflow is red but nothing was imported.** A row failed. The log names
it. A failure is deliberately loud because it usually means a permission or
quota problem, not a bad photo.

**Gemini quota errors.** The free tier is rate limited. The import runs four
times a day and only touches new rows, so this normally only appears on a
first run over a backlog. Re-run the workflow; imported rows are skipped.

---

## Running costs

| Item | Cost |
| --- | --- |
| Cloudflare Pages, including previews | free |
| Google Forms, Sheets and Drive | free |
| GitHub Actions, roughly 80 minutes a month | free, allowance is 2,000 |
| Google service account | free |
| Gemini, a few calls a week | free tier, then cents |
