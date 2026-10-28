import * as budgets from 'aws-cdk-lib/aws-budgets';
import { Construct } from 'constructs';
import { PlatformConfig } from '../config/platform-config';

export interface PlatformBudgetProps {
  config: PlatformConfig;
}

/**
 * Monthly cost budget with email alerts at 80% (actual) and 100% (forecasted). The budget-action
 * cost kill switch (APPLY_IAM_POLICY attaching a Bedrock-deny to the agent runtime role) is added
 * in slice 2 once a runtime role exists to target — it is meaningless without a principal that
 * actually calls bedrock:InvokeModel.
 */
export class PlatformBudget extends Construct {
  readonly budget: budgets.CfnBudget;

  constructor(scope: Construct, id: string, props: PlatformBudgetProps) {
    super(scope, id);
    const { config } = props;
    const emails = config.controls.budgetAlertEmails;

    const subscribers = emails.map((address) => ({ subscriptionType: 'EMAIL', address }));

    this.budget = new budgets.CfnBudget(this, 'Budget', {
      budget: {
        budgetName: `govai-${config.customerName}-${config.environment}`,
        budgetType: 'COST',
        timeUnit: 'MONTHLY',
        budgetLimit: { amount: config.controls.monthlyBudgetUsd, unit: 'USD' },
      },
      notificationsWithSubscribers: [
        {
          notification: {
            notificationType: 'ACTUAL',
            comparisonOperator: 'GREATER_THAN',
            threshold: 80,
            thresholdType: 'PERCENTAGE',
          },
          subscribers,
        },
        {
          notification: {
            notificationType: 'FORECASTED',
            comparisonOperator: 'GREATER_THAN',
            threshold: 100,
            thresholdType: 'PERCENTAGE',
          },
          subscribers,
        },
      ],
    });
  }
}
