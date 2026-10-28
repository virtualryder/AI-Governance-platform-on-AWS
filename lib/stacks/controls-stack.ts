import * as ssm from 'aws-cdk-lib/aws-ssm';
import * as kms from 'aws-cdk-lib/aws-kms';
import { Construct } from 'constructs';
import { PlatformStack, PlatformStackProps } from './platform-stack';
import { KillSwitch } from '../constructs/kill-switch';
import { PlatformBudget } from '../constructs/budgets';
import { HumanInTheLoop } from '../constructs/hitl';
import { applyControlsNagSuppressions } from './controls-nag-suppressions';

/**
 * Controls layer (Task 4): layered kill switch, monthly budget + alerts, and the HITL approval
 * state machine. Slice 2 adds the per-user interceptor + ledger (gateway-attached) and a Service
 * Catalog product. Reads the evidence CMK (baseline) and gateway/engine discovery (agent platform)
 * from SSM. Deployed in standalone and spoke modes.
 */
export class ControlsStack extends PlatformStack {
  readonly killSwitch: KillSwitch;
  readonly budget: PlatformBudget;
  readonly hitl?: HumanInTheLoop;

  constructor(scope: Construct, id: string, props: PlatformStackProps) {
    super(scope, id, props);

    const keyArn = ssm.StringParameter.valueForStringParameter(this, `${this.paramPrefix}/baseline/evidence-key-arn`);
    const encryptionKey = kms.Key.fromKeyArn(this, 'EvidenceKey', keyArn);

    this.killSwitch = new KillSwitch(this, 'KillSwitch', {
      config: this.config,
      paramPrefix: this.paramPrefix,
    });

    this.budget = new PlatformBudget(this, 'Budget', { config: this.config });

    if (this.config.controls.humanInTheLoop) {
      this.hitl = new HumanInTheLoop(this, 'Hitl', { config: this.config, encryptionKey });
    }

    this.publish('controls/kill-switch-fn-arn', this.killSwitch.fn.functionArn, 'Kill switch Lambda ARN');
    if (this.hitl) {
      this.publish('controls/hitl-state-machine-arn', this.hitl.stateMachine.stateMachineArn, 'HITL state machine ARN');
      this.publish('controls/hitl-approval-topic-arn', this.hitl.approvalTopic.topicArn, 'HITL approval SNS topic ARN');
    }
    this.publish('controls/version', '0.1.0', 'Controls stack version');

    applyControlsNagSuppressions(this, { hasHitl: !!this.hitl });
  }
}
