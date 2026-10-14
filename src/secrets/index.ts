export {
  type Channels,
  type GithubCliSecrets,
  type GithubSecretsBlock,
  type McpCredential,
  type McpSlice,
} from './schema'

export { createSecretsStoreForAgent, SecretsBackend } from './storage'

export { type Secret } from './resolve'

export { hydrateChannelEnvFromSecrets } from './hydrate'

export {
  type GithubCliProvisionResult,
  type GithubCliProvisionRunner,
  provisionGithubCliStore,
} from './provision-github-cli-store'

export {
  type ExportGithubCliStoreResult,
  exportGithubCliStoreForAgent,
  exportGithubCliStoreIfApplicable,
} from './export-github-cli-store'

export {
  type ProviderRefreshEntry,
  type ProviderRefreshOutcome,
  type RefreshProviderOAuthResult,
  refreshProviderOAuthCredentials,
  refreshProviderOAuthForAgent,
} from './refresh-provider-oauth'
