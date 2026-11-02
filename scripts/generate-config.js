#!/usr/bin/env node
/*
 * Config generator — turn the runbook §4 customer questionnaire into a validated standalone
 * config/<customer>.json, so an SA never hand-edits JSON. Scoped to the STANDALONE MVP (the pilot
 * path); hub/org configs are authored from the runbook. It fills safe MVP defaults (mirroring
 * config/standalone.example.json), applies a couple of smart defaults (PHI/CJIS -> 365d retention;
 * runtimeImageUri left as the placeholder so the Runtime is skipped until you build the image), and
 * then validates the result with the project's OWN loader (lib/config/platform-config.loadConfig) so
 * there is no drift between this tool and the real validator.
 *
 * Usage:
 *   node scripts/generate-config.js                 # interactive (walk the questionnaire)
 *   node scripts/generate-config.js --from answers.json [--out config/<name>.json] [--force]
 *   node scripts/generate-config.js --non-interactive --from answers.json
 *   npm run gen:config -- --from scripts/answers.example.json
 *
 * Answers file: a flat JSON of the keys prompted below (see scripts/answers.example.json). Any key
 * omitted uses its default.
 */
'use strict';
const fs = require('fs');
const path = require('path');
const readline = require('readline');

const REPO = path.resolve(__dirname, '..');
const ENUMS = {
  environment: ['dev', 'test', 'prod'],
  dataClassification: ['public', 'internal', 'confidential', 'phi', 'cjis'],
  contentFilterStrength: ['NONE', 'LOW', 'MEDIUM', 'HIGH'],
  cedarMode: ['LOG_ONLY', 'ENFORCE'],
  invocationLoggingOwnership: ['create', 'adopt', 'manage'],
};
const PLACEHOLDER = 'REPLACE_WITH_ECR_DIGEST_URI';

// Questionnaire: key -> {q, def, enum?, kind?} . kind: 'list' (comma-sep) | 'bool' | 'int'.
const Q = [
  ['customerName', 'Customer short name (a-z,0-9,-; 2-24 chars)', 'acme-mvp'],
  ['environment', 'Environment', 'dev', ENUMS.environment],
  ['region', 'AWS region', 'us-east-1'],
  ['dataClassification', 'Data classification', 'internal', ENUMS.dataClassification],
  ['costCenter', 'Cost center tag', 'ai-pilot'],
  ['reviewerGroup', 'Authorized caller Cognito group (use-case reviewer group)', 'csr-agents'],
  ['allowedModelIds', 'Approved foundation model id(s), comma-separated', 'anthropic.claude-sonnet-4-5-20250929-v1:0', null, 'list'],
  ['useCaseManifest', 'Use-case manifest path', 'use-cases/citizen-311/manifest.yaml'],
  ['contentFilterStrength', 'Guardrail content-filter strength', 'HIGH', ENUMS.contentFilterStrength],
  ['invocationLoggingOwnership', 'Bedrock invocation-logging ownership (create refuses to overwrite an existing config)', 'create', ENUMS.invocationLoggingOwnership],
  ['monthlyBudgetUsd', 'Monthly budget (USD)', '50', null, 'int'],
  ['budgetAlertEmails', 'Budget alert email(s), comma-separated', 'ai-pilot-owners@example.com', null, 'list'],
  ['cloudTrailDataEvents', 'Capture AgentCore/Lambda data events in CloudTrail?', 'y', null, 'bool'],
  ['humanInTheLoop', 'Human-in-the-loop sign-off for consequential actions?', 'y', null, 'bool'],
  ['killSwitch', 'Deploy the kill switch?', 'y', null, 'bool'],
  ['detectiveConfigRules', 'Deploy SRA-style detective AWS Config rules (needs a Config recorder)?', 'n', null, 'bool'],
];

function parseVal(kind, raw) {
  if (kind === 'list') return String(raw).split(',').map((s) => s.trim()).filter(Boolean);
  if (kind === 'bool') return /^(y|yes|true|1)$/i.test(String(raw).trim());
  if (kind === 'int') return Number(String(raw).trim());
  return String(raw).trim();
}
function validateAnswer(key, def, enm, kind, val) {
  if (key === 'customerName' && !/^[a-z0-9-]{2,24}$/.test(val)) return 'must be 2-24 chars of a-z, 0-9, -';
  if (enm && !enm.includes(val)) return `must be one of: ${enm.join(', ')}`;
  if (kind === 'int' && (!Number.isFinite(val) || val <= 0)) return 'must be a number > 0';
  if (kind === 'list' && val.length === 0) return 'need at least one value';
  return null;
}

async function askAll(answersFromFile, nonInteractive) {
  const out = {};
  let rl;
  if (!nonInteractive) rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  const ask = (prompt) => new Promise((res) => rl.question(prompt, res));
  for (const [key, q, def, enm, kind] of Q) {
    let val;
    if (answersFromFile && Object.prototype.hasOwnProperty.call(answersFromFile, key)) {
      const raw = answersFromFile[key];
      val = kind ? parseVal(kind, Array.isArray(raw) ? raw.join(',') : raw) : String(raw);
    } else if (nonInteractive) {
      val = parseVal(kind, def);
    } else {
      // interactive: loop until valid
      for (;;) {
        const hint = enm ? ` [${enm.join('/')}]` : '';
        const raw = (await ask(`${q}${hint} (default: ${def}): `)).trim() || def;
        val = parseVal(kind, raw);
        const err = validateAnswer(key, def, enm, kind, val);
        if (!err) break;
        process.stdout.write(`  ! ${err}\n`);
      }
    }
    const err = validateAnswer(key, def, enm, kind, val);
    if (err) throw new Error(`answer '${key}': ${err}`);
    out[key] = val;
  }
  if (rl) rl.close();
  return out;
}

function buildConfig(a) {
  const phiOrCjis = a.dataClassification === 'phi' || a.dataClassification === 'cjis';
  return {
    _comment:
      'Generated by scripts/generate-config.js (standalone MVP). Build the image, then set ' +
      'agentcore.runtimeImageUri to the immutable digest (…@sha256:…) and deploy.',
    customerName: a.customerName,
    environment: a.environment,
    region: a.region,
    dataClassification: a.dataClassification,
    costCenter: a.costCenter,
    identity: {
      provider: 'cognito',
      mode: 'brokered',
      humanAuth: {
        enabled: true,
        groups: [a.reviewerGroup],
        callbackUrls: ['https://localhost/callback'],
        enableUserPasswordAuth: true,
      },
    },
    governance: {
      // PHI/CJIS require >= 365-day retention (enforced by the validator); default 30 otherwise.
      logRetentionDays: phiOrCjis ? 365 : 30,
      invocationLogging: true,
      invocationLoggingOwnership: a.invocationLoggingOwnership,
      cloudTrailDataEvents: a.cloudTrailDataEvents,
      guardrail: {
        enabled: true,
        contentFilterStrength: a.contentFilterStrength,
        piiEntitiesToBlock: ['US_SOCIAL_SECURITY_NUMBER', 'CREDIT_DEBIT_CARD_NUMBER'],
        piiEntitiesToAnonymize: ['EMAIL', 'PHONE'],
        deniedTopics: [
          {
            name: 'LegalAdvice',
            definition: 'Providing definitive legal advice to members of the public.',
            examples: ['Am I legally required to repay this?'],
          },
        ],
        blockedMessage: "This request can't be completed under this organization's AI use policy.",
        // Binds the ungoverned-inference deny to the governed runtime role (NOT account-wide — that's org mode).
        denyUngovernedInference: true,
      },
    },
    agentcore: {
      _comment_image: 'Set runtimeImageUri to the IMMUTABLE DIGEST printed by use-cases/_harness/build-image.sh (…@sha256:…), not a tag.',
      runtimeImageUri: PLACEHOLDER,
      useCaseManifest: a.useCaseManifest,
      accessTokenValidityMinutes: 15,
      allowedModelIds: a.allowedModelIds,
      cedarMode: 'ENFORCE',
      enableMemory: false,
      enableBrowser: false,
      enableCodeInterpreter: false,
      enableObservability: false,
    },
    controls: {
      monthlyBudgetUsd: a.monthlyBudgetUsd,
      budgetAlertEmails: a.budgetAlertEmails,
      killSwitch: a.killSwitch,
      humanInTheLoop: a.humanInTheLoop,
      gatewayRequestsPerMinute: 60,
      detectiveConfigRules: a.detectiveConfigRules,
    },
  };
}

// Validate with the project's OWN loader (no drift). Returns null on success or the error message.
function validateWithLoader(outPath) {
  const loaderJs = path.join(REPO, 'lib', 'config', 'platform-config.js');
  if (!fs.existsSync(loaderJs)) return { built: false };
  try {
    // eslint-disable-next-line global-require, import/no-dynamic-require
    const { loadConfig } = require(loaderJs);
    loadConfig(path.relative(REPO, outPath).split(path.sep).join('/'));
    return { built: true, ok: true };
  } catch (e) {
    return { built: true, ok: false, message: e && e.message ? e.message : String(e) };
  }
}

function argval(flag) {
  const i = process.argv.indexOf(flag);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

(async () => {
  if (process.argv.includes('--help') || process.argv.includes('-h')) {
    process.stdout.write(fs.readFileSync(__filename, 'utf8').split('\n').slice(2, 21).join('\n') + '\n');
    return;
  }
  const fromPath = argval('--from');
  const nonInteractive = process.argv.includes('--non-interactive') || (!!fromPath && !process.stdin.isTTY);
  const answersFromFile = fromPath ? JSON.parse(fs.readFileSync(fromPath, 'utf8')) : null;

  const answers = await askAll(answersFromFile, nonInteractive && !!answersFromFile);
  const cfg = buildConfig(answers);

  const outPath = path.resolve(argval('--out') || path.join(REPO, 'config', `${answers.customerName}.json`));
  if (fs.existsSync(outPath) && !process.argv.includes('--force')) {
    process.stderr.write(`\nRefusing to overwrite ${outPath} (pass --force to replace).\n`);
    process.exit(1);
  }
  fs.mkdirSync(path.dirname(outPath), { recursive: true });
  fs.writeFileSync(outPath, JSON.stringify(cfg, null, 2) + '\n');
  process.stdout.write(`\nWrote ${path.relative(REPO, outPath)}\n`);

  const v = validateWithLoader(outPath);
  if (!v.built) {
    process.stdout.write('\n[validate] compiled loader not found — run `npm run build`, then validate with:\n');
    process.stdout.write(`  npx cdk synth --quiet -c mode=standalone -c configFile=${path.relative(REPO, outPath).split(path.sep).join('/')} -c nag=true --profile <p>\n`);
  } else if (v.ok) {
    process.stdout.write('[validate] PASS — config satisfies the platform validator.\n');
  } else {
    process.stderr.write(`[validate] FAIL — ${v.message}\n`);
    process.exit(1);
  }

  process.stdout.write('\nNext:\n');
  process.stdout.write('  1. build + push the image:  ./use-cases/_harness/build-image.sh --profile <p> --region ' + answers.region + ' --repo govai-' + answers.customerName + ' --tag v1\n');
  process.stdout.write('  2. paste the printed digest into agentcore.runtimeImageUri\n');
  process.stdout.write('  3. deploy:  npx cdk deploy --all -c mode=standalone -c configFile=' + path.relative(REPO, outPath).split(path.sep).join('/') + ' --profile <p>\n');
})().catch((e) => {
  process.stderr.write(`\nError: ${e.message}\n`);
  process.exit(1);
});
