import * as ssm from 'aws-cdk-lib/aws-ssm';
import * as kms from 'aws-cdk-lib/aws-kms';
import { Construct } from 'constructs';
import { PlatformStack, PlatformStackProps } from './platform-stack';
import { KillSwitch } from '../constructs/kill-switch';
import { PlatformBudget } from '../constructs/budgets';
import { HumanInTheLoop } from '../constructs/hitl';
import { DetectiveRules } from '../constructs/detective-rules';
import { ObservabilityLink } from '../constructs/observability-link';
import { applyControlsNagSuppressions } from './controls-nag-suppressions';

/**
 * Controls layer (Task 4): layered kill switch, monthly budget + alerts, and the HITL approval
 * state machine. Slice 2 adds the per-user interceptor + ledger (gateway-attached) and a Service
 * Catalog product. Reads the evidence CMK (baseline) and gateway/engine discovery (agent platform)
 * from SSM. Deployed in standalone and spoke modes.
 */
export class ControlsStack extends PlatformStack {
  readonly killSwitch?: KillSwitch;
  readonly budget: PlatformBudget;
  readonly hitl?: HumanInTheLoop;
  readonly detective?: DetectiveRules;
  readonly observabilityLink?: ObservabilityLink;

  constructor(scope: Construct, id: string, props: PlatformStackProps) {
    super(scope, id, props);

    const keyArn = ssm.StringParameter.valueForStringParameter(this, `${this.paramPrefix}/baseline/evidence-key-arn`);
    const encryptionKey = kms.Key.fromKeyArn(this, 'EvidenceKey', keyArn);

    // The kill switch is an opt-in control (controls.killSwitch); it was previously created regardless.
    if (this.config.controls.killSwitch) {
      this.killSwitch = new KillSwitch(this, 'KillSwitch', {
        config: this.config,
        paramPrefix: this.paramPrefix,
        encryptionKey,
      });
    }

    this.budget = new PlatformBudget(this, 'Budget', { config: this.config });

    if (this.config.controls.humanInTheLoop) {
      // Wire the executor to the use-case's consequential-action Lambda (published by AgentPlatform,
      // which Controls depends on). Only read it when a use-case manifest is deployed.
      const executorTargetArn = this.config.agentcore.useCaseManifest
        ? ssm.StringParameter.valueForStringParameter(this, `${this.paramPrefix}/agent-platform/consequential-target-arn`)
        : undefined;
      this.hitl = new HumanInTheLoop(this, 'Hitl', { config: this.config, encryptionKey, executorTargetArn });
    }

    if (this.config.controls.detectiveConfigRules) {
      this.detective = new DetectiveRules(this, 'Detective', { config: this.config });
    }

    // Gate 3: spoke shares telemetry into the hub's OAM sink (when a remote hub sink is configured).
    if (this.config.hub?.oamSinkArn) {
      this.observabilityLink = new ObservabilityLink(this, 'ObservabilityLink', {
        config: this.config,
        sinkArn: this.config.hub.oamSinkArn,
      });
    }

    if (this.killSwitch) {
      this.publish('controls/kill-switch-fn-arn', this.killSwitch.fn.functionArn, 'Kill switch Lambda ARN');
    }
    if (this.hitl) {
      this.publish('controls/hitl-state-machine-arn', this.hitl.stateMachine.stateMachineArn, 'HITL state machine ARN');
      this.publish('controls/hitl-approval-topic-arn', this.hitl.approvalTopic.topicArn, 'HITL approval SNS topic ARN');
      this.publish('controls/hitl-approvals-table', this.hitl.approvals.tableName, 'HITL approvals ledger table');
    }
    this.publish('controls/version', '0.1.0', 'Controls stack version');

    applyControlsNagSuppressions(this, {
      hasHitl: !!this.hitl,
      hasDetective: !!this.detective,
      hasKillSwitch: !!this.killSwitch,
    });
  }
}
