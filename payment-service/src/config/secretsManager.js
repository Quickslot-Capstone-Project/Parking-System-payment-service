const { GetSecretValueCommand, SecretsManagerClient } = require("@aws-sdk/client-secrets-manager");

const getSecretIds = () =>
  [
    process.env.PAYMENT_SECRETS_MANAGER_SECRET_ID,
    process.env.AWS_SECRETS_MANAGER_SECRET_ID,
    process.env.SECRETS_MANAGER_SECRET_ID,
  ]
    .filter(Boolean)
    .flatMap((value) => String(value).split(","))
    .map((value) => value.trim())
    .filter(Boolean);

const parseSecretValue = (secretValue, secretId) => {
  if (!secretValue.SecretString) {
    throw new Error(`Secret ${secretId} does not contain a SecretString`);
  }

  const parsed = JSON.parse(secretValue.SecretString);
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error(`Secret ${secretId} must be a JSON object`);
  }

  return parsed;
};

const shouldOverrideExisting = () => String(process.env.SECRETS_MANAGER_OVERRIDE_EXISTING || "true").toLowerCase() !== "false";

const loadSecretsIntoEnv = async () => {
  const secretIds = getSecretIds();
  if (!secretIds.length) {
    return { loaded: false, secretIds: [], keys: [] };
  }

  const client = new SecretsManagerClient({
    region: process.env.AWS_SECRETS_MANAGER_REGION || process.env.AWS_REGION || "us-east-1",
  });
  const overrideExisting = shouldOverrideExisting();
  const loadedKeys = new Set();

  for (const secretId of secretIds) {
    const response = await client.send(new GetSecretValueCommand({ SecretId: secretId }));
    const secret = parseSecretValue(response, secretId);

    Object.entries(secret).forEach(([key, value]) => {
      if (!key || value == null || (!overrideExisting && process.env[key] != null)) {
        return;
      }
      process.env[key] = String(value);
      loadedKeys.add(key);
    });
  }

  return { loaded: true, secretIds, keys: Array.from(loadedKeys).sort() };
};

module.exports = {
  loadSecretsIntoEnv,
};
