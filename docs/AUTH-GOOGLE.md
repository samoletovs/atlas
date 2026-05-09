# Atlas Google Authentication Runbook

## Current status

Atlas is deployed at `https://atlas.naurolabs.com` on Azure Static Web Apps Free tier (`atlas-swa` in `atlas-rg`). The app UI points users at `/.auth/login/google?post_login_redirect_uri=/`, but the deployed SWA provider chain currently falls back to Microsoft Entra ID instead of Google.

The production symptom is:

1. `https://atlas.naurolabs.com/.auth/login/google?post_login_redirect_uri=/`
2. redirects through `https://identity.7.azurestaticapps.net/.redirect/google?...`
3. then ends at `https://login.microsoftonline.com/common/oauth2/v2.0/authorize?.../.auth/login/aad/callback...`

That final provider must be `accounts.google.com`, not `login.microsoftonline.com`.

## What was verified

- `/.auth/login/done` returns `200`, so the old auth callback navigation-fallback loop is fixed.
- `/.auth/me` returns anonymous JSON when logged out.
- Adding `GOOGLE_CLIENT_ID` and `GOOGLE_CLIENT_SECRET` as app settings alone does not enable Google on this SWA.
- A Google SWA invitation still falls back to AAD, so this is not a frontend button issue.
- Azure Portal Authentication for `atlas-swa` Simple mode lists Entra ID and GitHub, not Google.
- Custom authentication is the supported path for Google on new/current SWA resources, and that requires SWA Standard.

## Decision point

Do not upgrade `atlas-swa` to Standard without explicit approval. Standard is a recurring cost (~EUR 8/month per app). Until that approval exists, keep the stricter smoke tests in place so CI does not falsely report Google auth as healthy.

## Fix path after approval

1. Upgrade the SWA:

   ```powershell
   az staticwebapp update -g atlas-rg -n atlas-swa --sku Standard
   ```

2. Create or reuse a Google OAuth web client.

   Add authorized JavaScript origin:

   ```text
   https://atlas.naurolabs.com
   ```

   Add authorized redirect URI:

   ```text
   https://atlas.naurolabs.com/.auth/login/google/callback
   ```

3. Store Google credentials in SWA app settings:

   ```powershell
   az staticwebapp appsettings set `
     -g atlas-rg `
     -n atlas-swa `
     --setting-names GOOGLE_CLIENT_ID=<client-id> GOOGLE_CLIENT_SECRET=<client-secret>
   ```

4. Add the custom Google provider block to `staticwebapp.config.json` only after the Standard upgrade is approved:

   ```json
   {
     "auth": {
       "identityProviders": {
         "google": {
           "registration": {
             "clientIdSettingName": "GOOGLE_CLIENT_ID",
             "clientSecretSettingName": "GOOGLE_CLIENT_SECRET"
           }
         }
       }
     }
   }
   ```

5. Deploy atlas.

6. Verify the final provider hop:

   ```powershell
   npx playwright test tests/smoke.spec.ts --reporter=line
   ```

   The smoke test must show `/.auth/login/google` ultimately reaches `accounts.google.com` and never reaches `login.microsoftonline.com`.

## Notes

- Do not add `/.auth/*` to `navigationFallback.exclude`; doing so can reintroduce the old `/.auth/login/done` 404 loop.
- Temporary Google app settings used during investigation were removed. Current app settings should only include Atlas runtime settings such as Cosmos, App Insights, `NODE_ENV`, and `ATLAS_USER_ID` until the Standard/custom-auth path is approved.
