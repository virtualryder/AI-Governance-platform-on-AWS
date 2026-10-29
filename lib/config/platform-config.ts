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
    /** Organization ID (o-xxxx). Required to roll the baseline Guard hook org-wide via StackSets
     * (scopes cross-account read of the central Guard rules by `aws:PrincipalOrgID`). */
    organizationId?: string;
    /** SCP-exempt deployer role name (the kingpin the lifted SCPs reference). Default derived from customerName. */
    deployerRoleName?: string;
    /** Name prefix for governed agent roles the inference-perimeter SCP allows. Default `govai-<customer>-governed`. */
    governedRolePrefix?: string;
    /** Evidence bucket name prefix the control-plane-integrity SCP protects. Default `govai-<customer>`. */
    evidenceBucketPrefix?: string;
    /** Guardrail ARN(:version) the Bedrock org declarative policy pins as the org floor. */
    orgGuardrailArn?: string;
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
    /** Cedar enforcement mode for the Gateway policy engine. Defaults to 'ENFORCE'. A forbid policy
     * (incl. the emergency kill switch) only blocks when the engine enforces, so governed deployments
     * must enforce. 'LOG_ONLY' is rejected by the loader unless `acknowledgeNonEnforcingCedar` is true. */
    cedarMode?: CedarMode;
    /** Explicit, auditable acknowledgment that a 'LOG_ONLY' (non-enforcing / observe-only) Cedar
     * deployment is intended. Required to deploy with `cedarMode: 'LOG_ONLY'`. */
    acknowledgeNonEnforcingCedar?: boolean;
    /** Runtime inbound protocol. Defaults to 'HTTP'; 'A2A' enables agent-to-agent collaboration. */
    protocol?: RuntimeProtocol;
    enableCodeInterpreter?: boolean;
    multiAgent?: MultiAgentConfig;
    /** ECR image URI for the AgentCore Runtime. Runtime/RuntimeEndpoint are only created when set
     * (the image is produced by the use-case harness, step 6). */
    runtimeImageUri?: string;
    /** Repo-relative path to a use-case manifest (use-cases/<name>/manifest.yaml). When set, the
     * use-case tool Lambdas, gateway targets (MCP tool schema), and tool-scoped Cedar policies are
     * deployed onto the gateway/engine. */
    useCaseManifest?: string;
    /** Enable CloudWatch Transaction Search (AgentCore Observability). Defaults to true. */
    enableObservability?: boolean;
    /** Percentage of spans indexed from CloudWatch Logs to X-Ray (cost control). Defaults to 5. */
    observabilityIndexingPercentage?: number;
    /** Attach the rendered baseline Cedar policies to the gateway's policy engine. Defaults to
     * FALSE: AgentCore's automated reasoning rejects a blanket permit over "any future tools", and
     * deny-by-default already governs an empty gateway. Opt in only once tool-scoped policies the
     * engine will accept exist (the use-case renders them). */
    attachBaselineCedarPolicies?: boolean;
    /** CloudWatch Omni upgrade (hub mode) — the next-gen unified/agent observability experience that
     * supersedes the classic governance dashboard. An Omni **domain** is created out-of-band during
     * Omni onboarding (console + SSO; there is no CloudFormation domain resource), so this is gated on
     * `domainId`. When set, the hub provisions an `AWS::CloudWatch::Space` (the space operator /
     * data-access role is created here, trusting `cloudwatch.amazonaws.com`) that auto-discovers
     * topology and surfaces golden metrics across the account/Region. */
    omni?: {
      /** Omni domain id (`d-...`) from onboarding. Required to create the Space. */
      domainId: string;
      /** Space name (`^[a-z0-9]+(-[a-z0-9]+)*$`, 3–64). Defaults to `govai-<customer>-<env>`. */
      spaceName?: string;
      /** Attach `CloudWatchOmniAWSIntegrationPolicy` so Omni can discover resources for the Context
       * Graph. Defaults to true. */
      enableContextGraph?: boolean;
      /** Attach `CloudWatchOmniModelInferencePolicy` for eval-driven agent observability (model
       * invocation in evaluations). Defaults to false. */
      enableModelInference?: boolean;
      /** Optional CMK ARN for Space encryption. The key must carry the `cw-omni` tag and allow the
       * space role (customer-managed outside this stack). Omitted → Omni-managed encryption. */
      kmsKeyArn?: string;
      /** Optional role Omni assumes for AgentCore agent evaluation. */
      agentCoreEvaluationRoleArn?: string;
      /** Optional Omni dashboard body (`AWS::CloudWatch::OmniDashboard`). Omitted → rely on Omni's
       * auto-discovered dashboards; the body schema is not synthesized here to avoid guessing it. */
      dashboardBody?: string;
    };
  };
  controls: {
    monthlyBudgetUsd: number;
    budgetAlertEmails: string[];
    killSwitch: boolean;
    humanInTheLoop: boolean;
    /** Deploy SRA-style detective AWS Config rules (guardrails present, invocation logging on).
     * Requires an AWS Config recorder in the account (Control Tower / landing zone). Defaults to false. */
    detectiveConfigRules?: boolean;
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
  if (cfg.agentcore.cedarMode === 'LOG_ONLY' && !cfg.agentcore.acknowledgeNonEnforcingCedar)
    errs.push(
      "agentcore.cedarMode 'LOG_ONLY' is non-enforcing (observe-only): forbid policies and the kill " +
        'switch will NOT block. Set agentcore.acknowledgeNonEnforcingCedar:true to deploy it deliberately, ' +
        "or use 'ENFORCE' (default).",
    );
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
