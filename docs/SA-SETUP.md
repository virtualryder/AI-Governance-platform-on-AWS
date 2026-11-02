# SA day-0 setup

Get from a fresh machine to "I can build, test, and run the acceptance harness." This expands runbook
§5 Prerequisites with install detail and the gotchas that bite new SAs. Target end state: `npm test`
green and `scripts/acceptance/preflight.sh` passing against a real account.

Read [`docs/CONCEPTS.md`](CONCEPTS.md) first so the steps mean something. Unknown terms:
[`GLOSSARY.md`](../GLOSSARY.md).

## 1. Tools to install

| Tool | Version | Why | Check |
|---|---|---|---|
| Node.js | **22 LTS** (tested 22–24) | CDK (TypeScript infra) | `node -v` |
| npm | bundled with Node | deps + scripts | `npm -v` |
| AWS CLI | **v2** | all AWS calls | `aws --version` |
| Python | **3.12–3.13** (tested) | control-handler tests, image build helpers | `python --version` |
| Docker Desktop | current, with **buildx** | synth/test/deploy bundle a Lambda via a Docker build image; Runtime image is ARM64 | `docker info`, `docker buildx version` |
| jq | 1.6+ | JSON wrangling in scripts | `jq --version` |
| git | current | clone | `git --version` |
| bash | **4.3+** | the acceptance scripts | `bash --version` |

CDK itself is **not** installed globally — it's pinned in `package.json` and run via `npx cdk …`.
Running a bare `cdk` will usually fail ("command not found"); always use `npx cdk` or the `npm run`
scripts.

Very new runtimes (Node 25+, Python 3.14+) are untested here and may hit missing prebuilt wheels or
tooling edge cases — if the local gate (step 3) misbehaves on a bleeding-edge runtime, drop to Node 22
LTS / Python 3.13 before debugging further.

### Per-OS notes
- **macOS:** `brew install node awscli python jq`; Docker Desktop from docker.com. bash via
  `brew install bash` (macOS ships an old 3.2 — the acceptance scripts want 4.3+).
- **Linux:** your package manager for node/awscli/python/jq/docker; bash is already current.
- **Windows:** install Node, AWS CLI v2, Python, Docker Desktop, and **Git for Windows** (gives you
  Git Bash + a bash 5.x). **Run all shell scripts and `aws`/`cdk` commands from Git Bash**, not
  PowerShell/cmd.
  - **jq** is NOT bundled and preflight hard-fails without it. Install it: `winget install jqlang.jq`
    (or `choco install jq`, or download `jq.exe` from jqlang.github.io and put it on your PATH — e.g.
    `~/bin`, no admin needed). Verify `jq --version` in Git Bash before running preflight.
  - *MSYS path-mangling gotcha:* Git Bash rewrites a leading-slash argument into a Windows path, which
    corrupts SSM parameter names like `/governed-ai/...`. If a `get-parameter` fails with a weird
    path, prefix the command with `MSYS_NO_PATHCONV=1` (or run that call from PowerShell). The
    acceptance scripts are written to avoid this, but you'll hit it in ad-hoc commands.
  - Line endings: the repo is LF; Git may warn "LF will be replaced by CRLF" — harmless.

## 2. AWS access

You deploy/validate against the **acceptance sandbox**, never a personal or production account.

```bash
# Configure a NAMED profile (SSO is preferred; access keys work too).
aws configure sso            # or: aws configure --profile <name>
# Verify it resolves to the INTENDED account — profile names can lie.
aws sts get-caller-identity --profile <name> --query Account --output text
```

- Rule: **name the profile explicitly on every command** (`--profile <name>`). Never rely on the
  default profile.
- The acceptance scripts and runbook bake in an **account guard** (`EXPECT_ACCOUNT`) that aborts if the
  profile resolves to the wrong account — set it and trust it.

## 3. Repo setup

```bash
git clone <repo-url> && cd "AI-Governance-platform-on-AWS"   # or your checkout dir

# TypeScript infra
npm ci                 # exact, locked install
npm run build          # tsc — must be clean

# Python control-handler tests (use a venv)
python -m venv .venv && . .venv/bin/activate        # Windows Git Bash: . .venv/Scripts/activate
python -m pip install -r requirements-dev.txt        # pinned pytest + boto3

# Make sure Docker is running (synth/test bundle a Lambda via a public ECR build image)
docker info >/dev/null && echo "docker OK"

# Full local gate
npm test               # jest template assertions (needs Docker)
npm run test:lambda    # pytest behavioral tests
npx cdk synth --quiet -c mode=standalone -c nag=true   # synth + cdk-nag, standalone mode
```

Expected: build clean, jest + pytest green, synth with **0** nag findings. These are the same gates CI
runs; if they pass locally you have a sane environment.

## 4. Bootstrap + preflight the account

```bash
npx cdk bootstrap aws://<account>/<region> --profile <name>   # once per account/region

cd scripts/acceptance
PROFILE=<name> EXPECT_ACCOUNT=<account> R=<region> CUST=<customer> ENV=dev ./preflight.sh
```

`preflight.sh` is read-only and **exits 0 before your first deploy**: it checks tools, the account
guard, and CDK bootstrap, and when it sees the platform isn't deployed yet it prints a "not deployed
yet — expected" note (not a failure) and stops there. After you deploy (runbook §12b), re-run it and
the platform-discovery checks turn into PASS (a missing one post-deploy is then a real failure).

## 5. Common setup failures → fixes

| Symptom | Cause | Fix |
|---|---|---|
| `cdk: command not found` | CDK isn't global | use `npx cdk …` / `npm run …` |
| `npm test` hangs or errors pulling an image | Docker not running / no network to public ECR | start Docker Desktop; allow outbound to `public.ecr.aws` |
| `get-parameter` fails with a mangled `/C:/...` name | Git Bash MSYS path-mangling | prefix `MSYS_NO_PATHCONV=1`, or run from PowerShell |
| pytest import/collection errors | wrong Python / deps not installed | activate the venv; `pip install -r requirements-dev.txt` |
| acceptance script: `syntax error` / weird quoting | bash 3.2 (old macOS) | install bash 4.3+ and run with it |
| `AccessDenied` / wrong account on a deploy | wrong profile | `aws sts get-caller-identity --profile <name>`; never use default |
| nag findings after an edit | a resource lost a required property/suppression | read the finding; fix the resource or add a *justified* suppression (never blanket) |

## You're ready when

- [ ] `node -v` ≥ 22, `aws --version` v2, `python --version` ≥ 3.12, `docker info` works, `jq`/`bash` present
- [ ] `npm ci && npm run build` clean
- [ ] `npm test` and `npm run test:lambda` green
- [ ] `npx cdk synth -c mode=standalone -c nag=true` → 0 nag findings
- [ ] a named profile resolves to the **intended** account (`get-caller-identity`)
- [ ] `scripts/acceptance/preflight.sh` passes (before first deploy it exits 0 with a "not deployed
      yet" note; the platform-discovery checks become PASS after you deploy)

Next: deploy and validate per [`docs/runbooks/DEPLOYMENT.md`](runbooks/DEPLOYMENT.md) §12b, then run
`scripts/acceptance/run-acceptance.sh`.
