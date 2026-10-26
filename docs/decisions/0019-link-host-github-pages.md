# 0019: Hosting rota.davebuilds.design on GitHub Pages

- **Status:** proposed (accepted when Dave merges). The proof (below) is pending until the site is deployed and the DNS record is live.
- **Date:** 2026-10-26
- **Decided by:** Dave
- **Related:** issue #35, ADR 0009 (App Links), ADR 0015 and 0017 (invite links), `.agents/rules/security.md`, `AGENTS.md` (Stack: free plans only)

## Problem

The app declares Android App Links for `https://rota.davebuilds.design` (`/invite`, `/magic`, `/reset`, `/checkout`, `autoVerify`). The host did not exist, so Android reported the domain as unverified (state `1024`, no response) and a link tapped in a real inbox opened the browser, not the app. Android verifies the links by fetching `https://rota.davebuilds.design/.well-known/assetlinks.json`, so something free has to serve that file, plus a small page for people who open a link without the app.

## Options considered

1. **Cloudflare Pages (or Workers static assets).** The zone is already on Cloudflare, but the rule is free plans only, with spending blocked. Cloudflare's docs do not say whether a card is needed or whether Free usage can ever be billed, so they could not settle it. Dave then checked the account: it has Workers Free **and R2 Paid** (usage-billed, renews 9 Nov) with a card on file. Spending is therefore **not** blocked on this account, and Rota's hosting should not live there. Rejected.
2. **GitHub Pages**, from this public repo, deployed by a GitHub Actions workflow. Chosen (below).
3. **Serve the file from the API host.** The deployment provider is still undecided (`AGENTS.md`), and the links must work before it is. Not available yet; it could replace this later.

## Decision

GitHub Pages, deploying the `site/` folder of this repo with `.github/workflows/pages.yml`, served at `rota.davebuilds.design`. DNS stays on Cloudflare with two records, both DNS only (the grey cloud):

- a **TXT** `_github-pages-challenge-<user>` that verifies the domain with GitHub, so no other GitHub account can claim `rota.davebuilds.design` (already added by Dave in Cloudflare before this PR, for the parent domain `davebuilds.design`);
- a **CNAME** `rota` pointing at `hennit-dave.github.io` (the account's default Pages address, not a repository's own `*.pages.github.com` name).

`site/` holds:

- `.well-known/assetlinks.json` with **one** fingerprint, the EAS keystore's: `72:BB:1D:01:1D:1F:C0:38:17:CA:D0:86:D9:20:BB:A3:EF:60:11:D1:72:EF:37:4D:CB:14:D0:2C:59:35:98:3D`. Dave read it on expo.dev (Project settings, Credentials, `design.davebuilds.rota`, uploaded 22 Oct), and the emulator's installed app reports the same SHA-256, so the installed app is the EAS build and the key is unique to this project.
- `404.html`, the landing page for `/invite/*`, `/magic/*`, `/reset/*` and `/checkout/*` when the app is not installed. Plain HTML and inline CSS: no script, no analytics, no font or image from another site, and nothing that reads, shows or sends the URL.
- `index.html`, a one-paragraph root page.
- `site.test.mjs`, the checks the workflow runs before every deploy.

The workflow **fails the deploy if `.well-known/assetlinks.json` is missing** or malformed (it runs `site.test.mjs`, which also checks the package name against `app/app.config.ts`, the fingerprint format, and that the pages stay static).

## Why

Verified from GitHub's own docs, 2026-10-26:

- GitHub Free includes Pages in public repositories ([plans](https://docs.github.com/en/get-started/learning-about-github/githubs-plans)). This repo is public.
- The Pages limits are soft: 1 GB site, 100 GB a month bandwidth, 10 builds an hour (not applied to workflow deploys) ([limits](https://docs.github.com/en/pages/getting-started-with-github-pages/github-pages-limits)). Over them GitHub "may not be able to serve your site" or sends an email; the docs mention no charge. Rate-limited requests get `429`.
- "GitHub Actions usage is free for standard GitHub-hosted runners in public repositories" ([plans](https://docs.github.com/en/get-started/learning-about-github/githubs-plans)), so the deploy workflow costs nothing.
- Pages from a branch can only publish the root or `/docs` (which holds the ADRs), so a workflow deploy of `site/` is the clean way; no `CNAME` file is used or needed with a workflow ([custom domain](https://docs.github.com/en/pages/configuring-a-custom-domain-for-your-github-pages-site/managing-a-custom-domain-for-your-github-pages-site)).
- A subdomain takes a `CNAME` and GitHub recommends verifying the domain first, which also covers immediate subdomains ([verifying](https://docs.github.com/en/pages/configuring-a-custom-domain-for-your-github-pages-site/verifying-your-custom-domain-for-github-pages)).

Checked by request against live GitHub Pages sites, not in GitHub's docs: a `.json` file is served `200` with `content-type: application/json; charset=utf-8` and no redirect, and a path with no file answers **HTTP 404**.

## Consequences

- **Terms note, accepted by Dave (2026-10-26).** GitHub says Pages "is not intended for or allowed to be used as a free web-hosting service to run your online business", including a site "primarily directed at... providing commercial software as a service". This site is a link-association file and a static fallback page for a graduation project, which is read as acceptable. If Rota became a real business, the host would have to move (the API host, once chosen, can serve the same files).
- **The landing page is served as `404.html`, with HTTP status 404. Dave accepted this.** GitHub Pages has no rewrites or wildcards, so a custom `404.html` is the only fallback for `/invite/<token>` and the rest. People see the page normally; only the status code is 404. (I checked that a missing path is a 404; I did not separately check the status of a custom `404.html`, which is what the proof will show.)
- **The token is in the URL path, so GitHub's servers see it in their request logs.** Any host would. The page never reads or shows it, sends no referrer (`no-referrer`), and loads nothing from anywhere. A leaked link alone cannot join anyone, because acceptance is tied to the invited account (ADR 0015).
- **Hidden-folder trap (it happened).** Pages artifacts leave out folders that start with a dot, which includes `.well-known`. The first deploy used `actions/upload-pages-artifact@v4` with `include-hidden-files: true`, but **that input only exists from v5.0.0**: v4 ignored it with a warning (`Unexpected input(s) 'include-hidden-files'`), the artifact had no `.well-known`, the deploy "succeeded", and `assetlinks.json` answered 404. A test that only checked the workflow text had passed. The fix: v5, a staged `_site/` folder without the test file, and a step after the deploy that fetches the live file and fails the workflow unless it answers `200`, `application/json`, with no redirect.
- **Only the EAS fingerprint is listed.** If a local debug build is ever used to test the links, its own signing fingerprint must be added to `assetlinks.json` separately (a different key, so Android would not verify the links for it otherwise).
- **Risk, open until proven:** the JSON is served as `application/json; charset=utf-8`. Android's verifier should accept the `charset` suffix, but only the proof shows it.
- **A second owner of the name is blocked, not the name taken:** the TXT record must stay in DNS for good, or the domain falls out of GitHub's verification.
- **Revisit when:** the deployment provider is chosen (it could serve the same files), GitHub changes the Pages terms or limits, or a second signing key (for example Play App Signing) is added.

## Evidence

Pending until the site is deployed and the CNAME is live:

- `curl -sI https://rota.davebuilds.design/.well-known/assetlinks.json` shows `200`, `content-type: application/json` and no `location` header.
- `curl -sI https://rota.davebuilds.design/invite/anything` shows the `404.html` page.
- `adb shell pm verify-app-links --re-verify design.davebuilds.rota`, then `adb shell pm get-app-links design.davebuilds.rota` shows `rota.davebuilds.design` as verified.
- Tapping a real invite link in Gmail opens the app.

Already shown (this PR): `node --test site/site.test.mjs` passes 4 checks, mutation-checked (removing `assetlinks.json`, or adding a script tag to the page, fails them).
