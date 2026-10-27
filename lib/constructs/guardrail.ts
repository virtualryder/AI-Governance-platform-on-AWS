import { Stack } from 'aws-cdk-lib';
import * as bedrock from 'aws-cdk-lib/aws-bedrock';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as kms from 'aws-cdk-lib/aws-kms';
import { Construct } from 'constructs';
import { GuardrailConfig, PlatformConfig } from '../config/platform-config';

export interface PlatformGuardrailProps {
  config: PlatformConfig;
  /** CMK used to encrypt the guardrail. */
  encryptionKey: kms.Key;
}

/** Bedrock content-filter categories. PROMPT_ATTACK supports input filtering only (output = NONE). */
const CONTENT_FILTER_TYPES = ['HATE', 'INSULTS', 'SEXUAL', 'VIOLENCE', 'MISCONDUCT', 'PROMPT_ATTACK'] as const;

/**
 * Account guardrail (versioned) plus the ungoverned-inference deny. The guardrail is built from
 * config: content filters at one strength, PII block/anonymize, and denied topics. A snapshot
 * `CfnGuardrailVersion` is always created so downstream enforcement pins an immutable version
 * (SRA omits this; PORT-MAP calls for adding it).
 *
 * `ungovernedInferenceDenyPolicy` is the key enforcement artefact: it denies any Bedrock inference
 * call that carries no `bedrock:GuardrailIdentifier` (the Null-condition pattern). In a single
 * account it is attached to agent/execution roles (step 3); org mode lifts the same statement into
 * an SCP for true account-wide enforcement.
 */
export class PlatformGuardrail extends Construct {
  readonly guardrail: bedrock.CfnGuardrail;
  readonly version: bedrock.CfnGuardrailVersion;
  /** Guardrail identifier (ID) for wiring into inference calls / enforcement conditions. */
  readonly guardrailId: string;
  readonly ungovernedInferenceDenyPolicy?: iam.ManagedPolicy;

  constructor(scope: Construct, id: string, props: PlatformGuardrailProps) {
    super(scope, id);
    const { config, encryptionKey } = props;
    const g: GuardrailConfig = config.governance.guardrail;
    const stack = Stack.of(this);

    const contentPolicyConfig =
      g.contentFilterStrength === 'NONE'
        ? undefined
        : {
            filtersConfig: CONTENT_FILTER_TYPES.map((type) => ({
              type,
              inputStrength: g.contentFilterStrength,
              // PROMPT_ATTACK is input-only; Bedrock rejects a non-NONE output strength for it.
              outputStrength: type === 'PROMPT_ATTACK' ? 'NONE' : g.contentFilterStrength,
            })),
          };

    const piiEntitiesConfig = [
      ...g.piiEntitiesToBlock.map((type) => ({ type, action: 'BLOCK' })),
      ...g.piiEntitiesToAnonymize.map((type) => ({ type, action: 'ANONYMIZE' })),
    ];

    this.guardrail = new bedrock.CfnGuardrail(this, 'Guardrail', {
      name: `governed-ai-${config.customerName}-${config.environment}`,
      description: `Governed AI baseline guardrail for ${config.customerName} (${config.environment})`,
      blockedInputMessaging: g.blockedMessage,
      blockedOutputsMessaging: g.blockedMessage,
      kmsKeyArn: encryptionKey.keyArn,
      contentPolicyConfig,
      sensitiveInformationPolicyConfig: piiEntitiesConfig.length ? { piiEntitiesConfig } : undefined,
      topicPolicyConfig: g.deniedTopics.length
        ? {
            topicsConfig: g.deniedTopics.map((t) => ({
              name: t.name,
              definition: t.definition,
              examples: t.examples,
              type: 'DENY',
            })),
          }
        : undefined,
    });

    // Immutable snapshot of the current configuration.
    this.version = new bedrock.CfnGuardrailVersion(this, 'Version', {
      guardrailIdentifier: this.guardrail.attrGuardrailId,
      description: 'Baseline version pinned by platform enforcement.',
    });
    this.guardrailId = this.guardrail.attrGuardrailId;

    // Deny any inference call that does not attach a guardrail (ungoverned inference).
    if (g.enforceAccountLevel) {
      this.ungovernedInferenceDenyPolicy = new iam.ManagedPolicy(this, 'UngovernedInferenceDeny', {
        description: 'Denies Bedrock inference that does not carry a guardrail identifier.',
        statements: [
          new iam.PolicyStatement({
            sid: 'DenyUngovernedInference',
            effect: iam.Effect.DENY,
            actions: [
              'bedrock:InvokeModel',
              'bedrock:InvokeModelWithResponseStream',
              'bedrock:Converse',
              'bedrock:ConverseStream',
            ],
            resources: [`arn:${stack.partition}:bedrock:*::foundation-model/*`],
            conditions: {
              Null: { 'bedrock:GuardrailIdentifier': 'true' },
            },
          }),
        ],
      });
    }
  }
}
