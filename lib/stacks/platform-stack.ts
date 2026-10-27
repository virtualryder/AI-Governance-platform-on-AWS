import { Stack, StackProps, Tags } from 'aws-cdk-lib';
import * as ssm from 'aws-cdk-lib/aws-ssm';
import { Construct } from 'constructs';
import { DeploymentMode, PlatformConfig, platformTags } from '../config/platform-config';

export interface PlatformStackProps extends StackProps {
  config: PlatformConfig;
  mode: DeploymentMode;
}

/** Base for every platform stack: applies standard tags and publishes discoverable metadata to SSM. */
export abstract class PlatformStack extends Stack {
  readonly config: PlatformConfig;
  readonly mode: DeploymentMode;
  /** SSM namespace other stacks and the harness use to discover platform resources. */
  readonly paramPrefix: string;

  protected constructor(scope: Construct, id: string, props: PlatformStackProps) {
    super(scope, id, props);
    this.config = props.config;
    this.mode = props.mode;
    this.paramPrefix = `/governed-ai/${props.config.customerName}/${props.config.environment}`;
    for (const [k, v] of Object.entries(platformTags(props.config))) Tags.of(this).add(k, v);
  }

  protected publish(name: string, value: string, description?: string): ssm.StringParameter {
    return new ssm.StringParameter(this, `Param${name.replace(/[^A-Za-z0-9]/g, '')}`, {
      parameterName: `${this.paramPrefix}/${name}`,
      stringValue: value,
      description,
    });
  }
}
