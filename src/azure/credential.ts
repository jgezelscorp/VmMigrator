import { AzureCliCredential } from '@azure/identity';

export const ARM_SCOPE = 'https://management.azure.com/.default';

export interface AccessTokenInfo {
  token: string;
  expiresOnTimestamp: number;
}

/** Abstraction so the az CLI credential can be swapped for Entra/MSAL (phase 2, #11). */
export interface CredentialProvider {
  getToken(scope?: string): Promise<AccessTokenInfo>;
}

export class AzureCliCredentialProvider implements CredentialProvider {
  private readonly credential: AzureCliCredential;

  constructor(credential: AzureCliCredential = new AzureCliCredential()) {
    this.credential = credential;
  }

  async getToken(scope: string = ARM_SCOPE): Promise<AccessTokenInfo> {
    const result = await this.credential.getToken(scope);
    return { token: result.token, expiresOnTimestamp: result.expiresOnTimestamp };
  }
}
