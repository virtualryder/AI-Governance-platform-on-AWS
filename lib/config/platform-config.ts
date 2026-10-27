import * as fs from 'fs';
import * as path from 'path';

export type DeploymentMode = 'standalone' | 'hub' | 'spoke' | 'org';
export type DataClassification = 'public' | 'internal' | 'confidential' | 'phi' | 'cjis';
export type FilterStrength = 'NONE' | 'LOW' | 'MEDIUM' | 'HIGH';

export interface GuardrailConfig {
  enabled: boolean;
  /** Strength applied to HATE, INSULTS, SEXUAL, VIOLENCE, MISCONDUCT, PROMPT_ATTACK input filters. */
  contentFilterStrength: FilterStrength;
  /** Bedrock PII entity types to anonymize or block, e.g. US_SOCIAL_SECURITY_NUMBER. */
  piiEntitiesToBlock: string[];
  piiEntitiesToAnonymize: string[];
  deniedTopics: { name: string; definition: string; examples?: string[] }[];
  blockedMessage: string;
  /** Enforce on every Bedrock inference call in this account (account-level enforcement). */
  enforceAccountLevel: boolean;
}

export interface PlatformConfig {
  customerName: string;
  environment: 'dev' | 'test' | 'prod';
  region: string;
  dataClassification: DataClassification;
  costCenter: string;
  hub?: { accountId: string; organizationId?: string };
  governance: {
    logRetentionDays: number;
    invocationLogging: boolean;
    cloudTrailDataEvents: boolean;
    guardrail: GuardrailConfig;
  };
  agentcore: {
    enableBrowser: boolean;
    enableMemory: boolean;
    memoryEventExpiryDays: number;
    accessTokenValidityMinutes: number;
    allowedModelIds: string[];
  };
  controls: {
    monthlyBudgetUsd: number;
    budgetAlertEmails: string[];
    killSwitch: boolean;
    humanInTheLoop: boolean;
    gatewayRequestsPerMinute: number;
  };
}

export function loadConfig(configFile: string): PlatformConfig {
  const full = path.resolve(configFile);
  if (!fs.existsSync(full)) throw new Error(`Config file not found: ${full}`);
  const cfg = JSON.parse(fs.readFileSync(full, 'utf-8')) as PlatformConfig;
  validate(cfg);
  return cfg;
}

function validate(cfg: PlatformConfig): void {
  const errs: string[] = [];
  if (!/^[a-z0-9-]{2,24}$/.test(cfg.customerName)) errs.push('customerName must be 2-24 chars of a-z, 0-9, -');
  if (cfg.agentcore.accessTokenValidityMinutes < 5 || cfg.agentcore.accessTokenValidityMinutes > 60)
    errs.push('accessTokenValidityMinutes should be 5-60 (short-lived tokens)');
  if (cfg.governance.logRetentionDays < 365 && ['phi', 'cjis'].includes(cfg.dataClassification))
    errs.push('phi/cjis workloads should retain logs >= 365 days');
  if (cfg.controls.monthlyBudgetUsd <= 0) errs.push('monthlyBudgetUsd must be > 0');
  if (errs.length) throw new Error(`Invalid platform config:\n - ${errs.join('\n - ')}`);
}

export function platformTags(cfg: PlatformConfig): Record<string, string> {
  return {
    Platform: 'governed-ai',
    Customer: cfg.customerName,
    Environment: cfg.environment,
    DataClassification: cfg.dataClassification,
    CostCenter: cfg.costCenter,
  };
}
