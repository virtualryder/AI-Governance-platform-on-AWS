import * as logs from 'aws-cdk-lib/aws-logs';

/** RetentionDays enum values (days) in ascending order, for mapping a numeric config value. */
const RETENTION_DAYS = [
  1, 3, 5, 7, 14, 30, 60, 90, 120, 150, 180, 365, 400, 545, 731, 1096, 1827, 2192, 2557, 2922, 3288, 3653,
];

/** Smallest RetentionDays enum value >= the configured days (so we never retain less than asked). */
export function toRetentionDays(days: number): logs.RetentionDays {
  const picked = RETENTION_DAYS.find((d) => d >= days) ?? RETENTION_DAYS[RETENTION_DAYS.length - 1];
  return picked as logs.RetentionDays;
}
