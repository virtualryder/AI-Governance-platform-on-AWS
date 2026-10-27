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

/** 'aws' = commercial (default); 'aws-us-gov' = GovCloud (US) — gated on per-service availability. */
export type Partition = 'aws' | 'aws-us-gov';
/** How org-wide controls (declarative policy, SCPs, Guard hooks) are distributed. */
export type ControlTowerMode = 'auto' | 'enabled' | 'disabled';
/** Multi-account topology (from sample-agentcore-enterprise-platform presets). */
export type AccountStrategy = 'centralized' | 'distributed' | 'federated';
/** AgentCore Policy (Cedar) enforcement mode. */
export type CedarMode = 'LOG_ONLY' | 'ENFORCE';
/** AgentCore Runtime inbound protocol. A2A serves on :9000/ for agent-to-agent collaboration. */
export type RuntimeProtocol = 'HTTP' | 'MCP' | 'A2A';
/** Multi-agent orchestration shape. AWS recommends 'supervisor' for governed enterprise use. */
export type Orchestration = 'supervisor' | 'swarm' | 'graph' | 'workflow';
export type IdentityProvider = 'cognito' | 'entra' | 'okta' | 'ping';

/** A collaborator agent reachable over A2A across a Runtime boundary. */
export interface RemoteCollaborator {
  name: string;
  /** AgentCore Runtime ARN of the collaborator, or discover via Registry. */
  runtimeArn?: string;
  registryRecordId?: string;
  agentCardUrl?: string;
  /** A2A invoke authz is IAM (SigV4) or AgentCore Identity OBO token exchange — NOT Cedar. */
  auth?: 'iam' | 'obo';
  scopes?: string[];
}

/** Native multi-agent collaboration. In-process sub-agents share one Runtime container + one
 * trace; remote collaborators cross Runtime boundaries via A2A. Kill switch must fan out across
 * the whole graph; budgets are attributed per-agent and reconstructed via correlation IDs. */
export interface MultiAgentConfig {
  enabled: boolean;
  orchestration?: Orchestration;
  inProcessSubAgents?: string[];
  remoteCollaborators?: RemoteCollaborator[];
  /** AgentCore Memory namespace shared across collaborators, e.g. '/actor/{actorId}/case/{caseId}/'. */
  sharedMemoryNamespace?: string;
  /** Publish this agent to the AWS Agent Registry for governed discovery. */
  publishToRegistry?: boolean;
}

/** Per-user Gateway governance (from sample-per-user-governance-for-bedrock-agentcore-gateway):
 * interceptor-enforced allowlists, rate limits, token/USD budgets, and auto-downgrade. */
export interface PerUserGovernanceConfig {
  enabled: boolean;
  budgetTokens?: number;
  budgetUsd?: number;
  downgradeAtTokens?: number;
  fallbackModelId?: string;
  ratePerMinute?: number;
  /** Cognito-group -> allowed model-family entitlement. */
  allowedModelsByGroup?: Record<string, string[]>;
}

export interface PlatformConfig {
  customerName: string;
  environment: 'dev' | 'test' | 'prod';
  region: string;
  /** Commercial-first; GovCloud is a gated fast-follow. Defaults to 'aws' when omitted. */
  partition?: Partition;
  dataClassification: DataClassification;
  costCenter: string;
  hub?: { accountId: string; organizationId?: string };
  /** Org-mode foundation. When controlTower is present, ship via CfCT + service-managed
   * StackSets; otherwise plain self-managed StackSets. 'auto' detects at deploy time. */
  org?: {
    controlTower?: ControlTowerMode;
    managementAccountId?: string;
    agenticOuId?: string;
  };
  /** Multi-account topology. 'centralized' (default) keeps shared services + workloads together;
   * 'distributed'/'federated' add workload accounts and (federated) cross-account OAuth trust. */
  deployment?: {
    strategy?: AccountStrategy;
    workloadAccountIds?: string[];
    federation?: { issuerUrl?: string; audience?: string };
  };
  /** Inbound identity provider for short-lived user tokens. 'brokered' fronts an external IdP with
   * Cognito; 'direct' trusts the IdP issuer directly. */
  identity?: {
    provider?: IdentityProvider;
    mode?: 'brokered' | 'direct';
    issuerUrl?: string;
    allowedClients?: string[];
  };
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
    /** Cedar enforcement mode for the Gateway policy engine. Defaults to 'ENFORCE'. */
    cedarMode?: CedarMode;
    /** Runtime inbound protocol. Defaults to 'HTTP'; 'A2A' enables agent-to-agent collaboration. */
    protocol?: RuntimeProtocol;
    enableCodeInterpreter?: boolean;
    multiAgent?: MultiAgentConfig;
  };
  controls: {
    monthlyBudgetUsd: number;
    budgetAlertEmails: string[];
    killSwitch: boolean;
    humanInTheLoop: boolean;
    gatewayRequestsPerMinute: number;
    /** Per-user Gateway interceptor governance (allowlists, budgets, rate limits, auto-downgrade). */
    perUserGovernance?: PerUserGovernanceConfig;
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
  const ma = cfg.agentcore.multiAgent;
  if (ma?.enabled && ma.remoteCollaborators?.length && cfg.agentcore.protocol !== 'A2A')
    errs.push("remoteCollaborators require agentcore.protocol 'A2A' (agent-to-agent invoke)");
  const pug = cfg.controls.perUserGovernance;
  if (pug?.enabled && pug.downgradeAtTokens && !pug.fallbackModelId)
    errs.push('perUserGovernance.downgradeAtTokens requires a fallbackModelId');
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
