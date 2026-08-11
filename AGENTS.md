# Workspace instructions

- For GitHub repository, branch, commit, pull-request, issue, and review operations, prefer the installed GitHub connector.
- Do not require local `gh` authentication when the connector can perform the requested operation.
- Use local `git` or `gh` only for capabilities the connector does not provide, and explain the specific gap first.
- For user-requested repository changes, once the requested implementation and relevant tests are complete, publish the work on a separate branch and open a draft pull request through the GitHub connector. Skip publication only when the user explicitly asks not to publish or the request is read-only (for example: inspect, explain, review, or report status).
