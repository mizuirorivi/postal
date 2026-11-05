# UIGraph artifacts

This repository describes its architecture in UIGraph artifacts: `.uigraph.yaml`, `.uigraph/services/*.yaml`, and the files under `.uigraph/`. The UIGraph viewer reads them, so keep them true to the code.

## When to update

Update artifacts only when your change does one of these. For any other change, do nothing here.

| Your change | Update |
|---|---|
| Adds, removes, or changes an HTTP, GraphQL, or gRPC endpoint, or its request or response fields | The spec listed under `apis` |
| Adds or changes a migration, ORM model, or DDL | The schema listed under `databases`, and each entry under `queries` that uses the changed tables |
| Starts or stops calling another service, datastore, or third-party API | `dependencies` in that service's config |
| Changes a flow that a diagram shows | That diagram's `.mmd` file |
| Adds a deployable service | A new config at `.uigraph/services/<service-name>.yaml` |
| Makes a doc listed under `docs` wrong | That doc |

## How to update

1. Read `.uigraph.yaml`, and `.uigraph/services/*.yaml` when the change is in another service. They list every artifact and its file. Open only the files your change affects, and do not explore the rest of `.uigraph/`.
2. Change only what your code change made wrong. Keep the existing structure, names, and order.
3. Base every change on code you read. Never invent endpoints, dependencies, tables, or flows.
4. In diagrams, never write `style`, `classDef`, `class`, `linkStyle`, or colors.
5. Run `npx --yes uigraph sync` and fix every problem it reports.

When you are not sure whether your change affects an artifact, leave the artifact as it is and say so in your summary.
