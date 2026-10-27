import * as fs from 'fs';
import * as path from 'path';

const CEDAR_ROOT = path.join(__dirname, '..', '..', 'policies', 'cedar');

/**
 * Load a Cedar policy file and render its per-gateway placeholders. Policies live in files
 * (CLAUDE.md rule 7), never inline. `{{GATEWAY_ARN}}` is replaced with the gateway ARN — which is a
 * CDK token string at synth, so `.replace` embeds the token and CloudFormation resolves it.
 */
export function renderCedarPolicy(relativePath: string, vars: { gatewayArn: string }): string {
  const full = path.join(CEDAR_ROOT, relativePath);
  const template = fs.readFileSync(full, 'utf-8');
  return template.replace(/\{\{GATEWAY_ARN\}\}/g, vars.gatewayArn);
}
