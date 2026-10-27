import { Duration, RemovalPolicy, Stack } from 'aws-cdk-lib';
import * as cognito from 'aws-cdk-lib/aws-cognito';
import { Construct } from 'constructs';
import { PlatformConfig } from '../config/platform-config';

export interface InboundIdentityProps {
  config: PlatformConfig;
}

/**
 * Inbound identity for the Gateway's CUSTOM_JWT authorizer. Two shapes, selected by config:
 *  - `direct` + an `issuerUrl`: trust an external IdP (Entra/Okta/Ping) directly — no Cognito.
 *  - otherwise (default/`brokered`, provider `cognito`): stand up a Cognito user pool that mints
 *    short-lived tokens (validity from `accessTokenValidityMinutes`), with a resource server and a
 *    client-credentials app client as the reference machine caller. Use-cases add user-facing clients.
 *
 * Exposes a uniform `discoveryUrl` + `allowedClients` so the Gateway construct is identical either way.
 */
export class InboundIdentity extends Construct {
  /** OIDC discovery document URL the Gateway authorizer validates tokens against. */
  readonly discoveryUrl: string;
  /** Token issuer (OIDC `iss`). */
  readonly issuer: string;
  /** Client IDs / audiences the Gateway accepts. */
  readonly allowedClients: string[];
  readonly userPool?: cognito.UserPool;
  readonly userPoolClient?: cognito.UserPoolClient;

  constructor(scope: Construct, id: string, props: InboundIdentityProps) {
    super(scope, id);
    const { config } = props;
    const stack = Stack.of(this);
    const identity = config.identity ?? {};

    if (identity.mode === 'direct' && identity.issuerUrl) {
      // Trust the external IdP directly.
      this.issuer = identity.issuerUrl.replace(/\/$/, '');
      this.discoveryUrl = `${this.issuer}/.well-known/openid-configuration`;
      this.allowedClients = identity.allowedClients ?? [];
      return;
    }

    // Broker with Cognito.
    const isProd = config.environment === 'prod';
    this.userPool = new cognito.UserPool(this, 'Pool', {
      userPoolName: `governed-ai-${config.customerName}-${config.environment}`,
      selfSignUpEnabled: false,
      // PLUS plan enables threat protection (compromised-credential detection). ~$0 at zero MAUs
      // since the reference client is M2M client-credentials (no signing-in users).
      featurePlan: cognito.FeaturePlan.PLUS,
      // TOTP only — no SMS. Avoids a generated SMS role, and TOTP is stronger than SMS for the
      // user-facing clients a use-case adds later.
      mfa: cognito.Mfa.OPTIONAL,
      mfaSecondFactor: { otp: true, sms: false },
      passwordPolicy: {
        minLength: 12,
        requireLowercase: true,
        requireUppercase: true,
        requireDigits: true,
        requireSymbols: true,
      },
      accountRecovery: cognito.AccountRecovery.EMAIL_ONLY,
      removalPolicy: isProd ? RemovalPolicy.RETAIN : RemovalPolicy.DESTROY,
    });

    // OAuth2 token endpoint for the client-credentials flow needs a user pool domain.
    this.userPool.addDomain('Domain', {
      cognitoDomain: { domainPrefix: `governed-ai-${config.customerName}-${config.environment}` },
    });

    const resourceServerId = 'gateway';
    const invokeScope = new cognito.ResourceServerScope({
      scopeName: 'invoke',
      scopeDescription: 'Invoke governed gateway tools',
    });
    const resourceServer = this.userPool.addResourceServer('ResourceServer', {
      identifier: resourceServerId,
      scopes: [invokeScope],
    });

    this.userPoolClient = this.userPool.addClient('MachineClient', {
      userPoolClientName: 'agentcore-machine',
      generateSecret: true,
      accessTokenValidity: Duration.minutes(config.agentcore.accessTokenValidityMinutes),
      authFlows: {},
      oAuth: {
        flows: { clientCredentials: true },
        scopes: [cognito.OAuthScope.resourceServer(resourceServer, invokeScope)],
      },
    });

    this.issuer = `https://cognito-idp.${stack.region}.amazonaws.com/${this.userPool.userPoolId}`;
    this.discoveryUrl = `${this.issuer}/.well-known/openid-configuration`;
    this.allowedClients = [this.userPoolClient.userPoolClientId];
  }
}
