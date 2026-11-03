// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Paweł Wilk

export {
  APP_DIR_NAME,
  isInside,
  PRODUCT_NAME,
  WORK_WITH_NOTE,
  resolveConfigDir,
  storePath,
  type ConfigDir,
  type ConfigDirInput,
} from "./paths.js";
export {
  busyAsStoreError,
  openStore,
  runMigrations,
  StoreBusyError,
  StoreOpenError,
  StoreVersionError,
  type Store,
} from "./db.js";
export { MIGRATIONS, type Migration } from "./migrations.js";
export { DATA_KEY_BYTES, DecryptError, decryptValue, encryptValue, newDataKey } from "./crypto.js";
export {
  describeKeyLocation,
  forgetDataKey,
  getDataKey,
  keyBackendOf,
  keyFileMode,
  keyFilePath,
  KeyUnavailableError,
  runCommand,
  SECURITY_COMMAND,
  type CommandResult,
  type CommandRunner,
  type DataKey,
  type KeyBackend,
  type KeyStoreDeps,
} from "./keyStore.js";
export {
  CREDENTIAL_PURPOSES,
  ENV_CREDENTIALS,
  credentialsInfo,
  deleteCredentials,
  loadCredential,
  loadOAuthCredentials,
  readEnvCredentials,
  saveCredential,
  type CredentialPurpose,
  type CredentialsInfo,
  type OAuthCredentials,
} from "./credentials.js";
export { listSavedAccounts, saveAccounts, type StoredAccount } from "./accounts.js";
export {
  clearSavedLimitWait,
  createStoreOpsCounter,
  type StoreOpsCounter,
  type StoreOpsPool,
} from "./opsUsage.js";
export { approvalHmacKey } from "./approvalKey.js";
export {
  childEnv,
  POSIX_SYSTEM_DIRS,
  resetProcessPath,
  SAFE_POSIX_PATH,
  safePath,
  systemCommand,
  windowsRoot,
} from "./system.js";
export {
  getInvocation,
  howToRun,
  PACKAGE_NAME,
  runParts,
  setInvocation,
  type Invocation,
} from "./invocation.js";
export { icaclsPath, restrictToOwner, type OwnerOnlyDeps } from "./ownerOnly.js";
