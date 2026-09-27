# Vercel deployment

This guide describes the intended Vercel project settings for Sibambo Editor. No Vercel project or deployment is included in this repository snapshot; use [Verification and release status](verification.md) for the current evidence.

## Create the project

Import this GitHub repository as its own Vercel project. Use the **SvelteKit** framework preset (or its automatic detection), set **Root Directory** to `apps/editor`, and enable **Include source files outside of the Root Directory in the Build Step** so the app can compile the shared `packages/*` and `tooling/research` sources.

Keep the SvelteKit adapter's output handling. The app configuration selects `@sveltejs/adapter-vercel` in Vercel's build environment and `@sveltejs/adapter-node` for local development/builds. Leave the framework's build command at its default initially; if a command override is needed, use `bun run build` from the app root.

## Bun workspace installation

The workspace manifest and `bun.lock` are at the repository root, above `apps/editor`. Bun 1.3.10 successfully ran `bun install --frozen-lockfile` from both the repository root and `apps/editor` in the local checkout. Vercel's documentation says package-manager selection uses lockfiles and the install path follows the configured Root Directory, but does not explicitly define this non-Turborepo Bun workspace case. The hosted installation remains unverified. Check the first hosted build log to confirm that Vercel recognizes the root `bun.lock` and resolves the `workspace:*` packages before sharing or promoting that deployment.

Vercel's documentation confirms app-root projects and outside-root shared source, but does not explicitly describe this non-Turborepo Bun workspace install case. Do not treat the local install as proof of hosted installation behavior. The platform's published guidance is [Using Monorepos](https://vercel.com/docs/monorepos), [Monorepos FAQ](https://vercel.com/docs/monorepos/monorepo-faq), [Package Managers](https://vercel.com/docs/package-managers), and [Configuring a Build](https://vercel.com/docs/builds/configure-a-build).

## Data and domain boundaries

Use the default Vercel domain for an initial deployment. Editor keeps imported model data in page memory and does not provide hosted model storage or account synchronization. Connecting a legacy live domain is a separate cutover requiring its own data and rollback evidence.
