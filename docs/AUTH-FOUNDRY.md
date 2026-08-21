# Foundry / AOAI Auth — atlas

The atlas API in `atlas/api/src/functions/generateLesson.ts` calls Microsoft
Foundry's Azure OpenAI gpt-4o-mini deployment to generate lessons inline. The
Foundry account has `disableLocalAuth: true`, so API keys are blocked — every
request must carry an AAD bearer token.

SWA Free tier has no managed identity, so we authenticate via a dedicated
**Service Principal** whose credentials live in SWA App Settings (encrypted at
rest). The `openai` Node SDK + `DefaultAzureCredential` pick up the SP via the
`EnvironmentCredential` chain.

## Resources

| What | Value |
| --- | --- |
| Service principal | `<service-principal-name>` |
| App ID (client ID) | `<application-client-id>` |
| SP object ID | `<service-principal-object-id>` |
| Tenant ID | `<tenant-id>` |
| RBAC role | **Cognitive Services User** |
| Role scope | `/subscriptions/<subscription-id>/resourceGroups/<resource-group>/providers/Microsoft.CognitiveServices/accounts/<account>` |
| Foundry endpoint | `https://<account>.cognitiveservices.azure.com/` |
| Deployment | `gpt-4o-mini` |
| API version | `2024-08-01-preview` |
| Token scope | `https://cognitiveservices.azure.com/.default` |

## SWA App Settings (atlas-swa, atlas-rg)

| Key | Purpose |
| --- | --- |
| `AZURE_CLIENT_ID` | SP app ID |
| `AZURE_CLIENT_SECRET` | SP password (rotate yearly) |
| `AZURE_TENANT_ID` | Tenant |
| `FOUNDRY_AOAI_ENDPOINT` | Cognitive endpoint |
| `FOUNDRY_DEPLOYMENT` | `gpt-4o-mini` |
| `FOUNDRY_API_VERSION` | `2024-08-01-preview` |

## Rotating the secret

The SP secret expires ~1 year after creation. To rotate:

```pwsh
# 1. Create a new password (revokes old one if same display name reused)
$reset = az ad app credential reset `
  --id $env:AZURE_CLIENT_ID `
  --display-name "atlas-swa-rotated-$(Get-Date -Format yyyyMMdd)" `
  --years 1 `
  2>$null | ConvertFrom-Json

# 2. Push the new secret into SWA App Settings
az staticwebapp appsettings set `
  --name atlas-swa `
  --resource-group atlas-rg `
  --setting-names "AZURE_CLIENT_SECRET=$($reset.password)"
```

Verify it landed:

```pwsh
az staticwebapp appsettings list `
  --name atlas-swa --resource-group atlas-rg `
  --query "properties.AZURE_CLIENT_SECRET" -o tsv | ForEach-Object { $_.Length }
# Expected: 40
```

The Functions runtime picks up new App Settings on the next cold start
(usually within seconds — no redeploy required).

## Why a Service Principal (not Managed Identity)?

SWA Free tier does not support managed identities. The supported alternatives
are:

1. **Service Principal credentials in App Settings** ← what we do
2. Upgrading to SWA Standard ($9/mo) to get a managed identity

Option 1 is fine for a research project; the secret is encrypted at rest, only
admins of the SWA can read it, and it has the minimum role on a single account.
