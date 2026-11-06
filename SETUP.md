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
- `src/worker.js`: checks the Access sign-in on every request, calls Todoist's API with your token, and stores temp tasks in Workers KV (namespace `docket`, kept 14 days).
- `wrangler.toml`: Worker settings. Secrets are never in the repository.
