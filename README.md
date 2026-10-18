# ghcr-webhook-router

A generic webhook router that receives GitHub Container Registry (GHCR) `package` (`published`) webhooks and sends `repository_dispatch` events to target repositories.

Minimizes the latency from image push to GitOps manifest update without hardcoding manifest repository information into application repositories.

## Environment Variables

All configuration is injected via environment variables (parsed by [`evp-ts`](https://github.com/fumieval/evp-ts)).

| Variable                 | Required | Default                  | Description                                                                                                  |
| :----------------------- | :------: | :----------------------- | :----------------------------------------------------------------------------------------------------------- |
| `PORT`                   |    -     | `3000`                   | Server listening port                                                                                        |
| `WEBHOOK_SECRET`         |    ✅    | -                        | Secret used to verify GitHub webhook HMAC signatures                                                         |
| `TARGET_REPOS`           |    ✅    | -                        | Comma-separated list of target repositories to dispatch events to (e.g., `kgtkr/public-cd,kgtkr/private-cd`) |
| `DISPATCH_EVENT_TYPE`    |    -     | `ghcr_package_published` | The `event_type` name sent in `repository_dispatch`                                                          |
| `GITHUB_APP_ID`          |    *1    | -                        | GitHub App ID                                                                                                |
| `GITHUB_APP_PRIVATE_KEY` |    *1    | -                        | GitHub App private key (PEM format or base64-encoded string)                                                 |
| `GITHUB_TOKEN`           |    *1    | -                        | Personal Access Token (when not using a GitHub App)                                                          |
| `TAG_INCLUDE_REGEX`      |    -     | `undefined`              | Regular expression for tags to process (e.g., `^\d{17}-[0-9a-f]{7}(-.*)?$`)                                  |
| `TAG_EXCLUDE_REGEX`      |    -     | `-(amd64\|arm64)$`       | Regular expression for tags to exclude                                                                       |
| `PACKAGE_INCLUDE_REGEX`  |    -     | `undefined`              | Regular expression for image names to process (e.g., `^ghcr\.io/kgtkr/.*`)                                   |
| `DEBOUNCE_MS`            |    -     | `5000`                   | Debounce window in milliseconds to suppress rapid consecutive webhooks for the same image                    |

> \*1: Either `GITHUB_TOKEN` or both (`GITHUB_APP_ID` and `GITHUB_APP_PRIVATE_KEY`) are required.

## Dispatched `client_payload`

```json
{
  "event_type": "ghcr_package_published",
  "client_payload": {
    "registry": "ghcr.io",
    "owner": "kgtkr",
    "package": "kgtkr.net",
    "image": "ghcr.io/kgtkr/kgtkr.net",
    "tag": "20261017-8d3e086",
    "digest": "sha256:..."
  }
}
```

## GitHub App Setup

1. Go to **Settings > Developer Settings > GitHub Apps > New GitHub App**.
2. Configure the following:
   - **Webhook URL**: `https://<your-ingress-domain>/webhook`
   - **Webhook secret**: Any secret string (set this to `WEBHOOK_SECRET`)
   - **Repository permissions**:
     - `Contents`: **Read & write** (to send `repository_dispatch` events)
     - `Packages`: **Read-only** (optional)
   - **Subscribe to events**:
     - `Package` (published)
3. After creating the app, click **Generate a private key** to download the `.pem` file.
4. Under **Install App**, install the app to your account for target repositories (or All repositories).

## Example Receiver Workflow (Manifest Repository)

`.github/workflows/on-image-push.yaml` in the target repository (configured in `TARGET_REPOS`):

```yaml
name: on-image-push

on:
  repository_dispatch:
    types:
      - ghcr_package_published

concurrency:
  group: renovate-${{ github.event.client_payload.image }}
  cancel-in-progress: false

jobs:
  renovate:
    runs-on: ubuntu-latest
    steps:
      - name: Checkout
        uses: actions/checkout@v6

      - name: Generate GitHub App Token
        id: app-token
        uses: actions/create-github-app-token@v2
        with:
          app-id: ${{ secrets.RENOVATE_APP_ID }}
          private-key: ${{ secrets.RENOVATE_APP_PRIVATE_KEY }}

      - name: Renovate Single Package
        uses: renovatebot/github-action@v43.0.0
        with:
          token: ${{ steps.app-token.outputs.token }}
        env:
          RENOVATE_REPOSITORIES: ${{ github.repository }}
          RENOVATE_FORCE: >-
            {
              "dependencyDashboard": false,
              "branchPrefix": "renovate-dispatch/${{ github.event.client_payload.package }}/"
            }
          RENOVATE_PACKAGE_RULES: >-
            [
              {
                "matchPackageNames": ["*"],
                "enabled": false
              },
              {
                "matchPackageNames": ["${{ github.event.client_payload.image }}"],
                "enabled": true
              }
            ]
```

## Development Commands (Vite+)

```bash
# Install dependencies
npm install

# Start development server
npm run dev

# Check formatting, linting, and types
npm run check

# Run tests (Vitest)
npm run test

# Build for production (bundles into a single dist/index.mjs file)
npm run build
```
