# Docket: one-off setup

Docket runs as a Cloudflare Worker at https://docket.onthehouse.club, behind a Cloudflare Access sign-in. Every push to the `main` branch of this repository deploys automatically.

## 1. Todoist token
Todoist → Settings → Integrations → Developer → copy the API token.

## 2. Connect the repository to Cloudflare
Cloudflare dashboard (the On The House account) → Workers & Pages → Create → Import a repository → GitHub → `markwbradley/docket`.
Keep the defaults (no build command; deploy command `npx wrangler deploy`) and deploy.
This creates the Worker `docket` and the address `docket.onthehouse.club`. Until steps 3 and 4 are done it answers "Docket is locked", by design.

## 3. Lock it to you (Cloudflare Access)
Zero Trust → Access → Applications → Add an application → Self-hosted.
- Application name: Docket
- Session duration: 1 month
- Public hostname: `docket.onthehouse.club`
- Policy: Allow, Include → Emails → `mark@bradley.work`
- Login method: One-time PIN (the default)

Save, then copy the **Application Audience (AUD) Tag** from the application's overview.
Your team domain is under Zero Trust → Settings → Custom pages (it looks like `something.cloudflareaccess.com`).

## 4. Secrets on the Worker
Workers & Pages → docket → Settings → Variables and Secrets → Add, type **Secret**:
- `TODOIST_TOKEN`: the token from step 1
- `ACCESS_TEAM_DOMAIN`: e.g. `something.cloudflareaccess.com`
- `ACCESS_AUD`: the AUD tag from step 3

## 5. Open it
Go to https://docket.onthehouse.club, enter the emailed code, and you are in.
iPhone: Safari → Share → Add to Home Screen.

## How it is built
- `public/index.html`: the page.
- `src/worker.js`: checks the Access sign-in on every request, calls Todoist's API with your token, and stores temp tasks in Workers KV (created automatically on first deploy, kept 14 days).
- `wrangler.toml`: Worker settings. Secrets are never in the repository.

## What v3.1 added
- The left pane lists every task labelled `next`, under "Area › Project" headings with the project's outcome line.
- Tasks labelled `proposed` (filed by the daily email sweep) show at the top with Accept and Dismiss. Dismiss deletes the task after seven seconds unless undone; the Worker refuses to delete anything not labelled `proposed`.
- Ticking a `next` task opens a chooser for that project's next one. Making a task next where one exists asks first, then moves the label; the old task stays.
- On a phone, Today and Next are tabs.

## What v3.2 added
- A "Not today" button (↩) on each Todoist task in the Today list puts it back where it came from: no date, its old date, or due today without a time. Docket remembers where each task came from for the day, in the same storage as temp tasks.
- Completing a task shows Undo for eight seconds, fading out over the last one. Repeating tasks get no Undo, because Todoist has already moved them on.
- The next-action chooser has a close button, and says Close when the project has no tasks left.
