# OmniCode Work Action Approval System

Last updated: 2026-09-13

## Purpose

Work Mode uses one trusted approval pipeline for every registered connected-app
tool. The model can propose an action, but it cannot choose its permission mode,
reduce its risk, approve it, or call a connector executor directly.

The pipeline is:

`cloud or compatible Ollama model -> Tool Registry -> Permission Manager -> user approval when required -> connector executor -> safe activity history`

The Tool Registry validates schemas, connector scopes, timeouts, result bounds,
and the fixed metadata supplied by the connector. `PermissionManager` runs in the
Electron main process before every executor call. React only presents a pending
approval and returns the user's one-time choice.

## Approval modes

| Mode | Automatic actions | Actions that still ask |
| --- | --- | --- |
| Ask for approval | Harmless read-only actions without external side effects | All changes, communications, submissions, destructive operations, and hard boundaries |
| Approve for me | Harmless reads and low-risk, reversible, ordinary changes | Communication, external submission, sensitive-data transfer, destructive actions, medium/high risk, and hard boundaries |
| Full access | Ordinary non-critical actions allowed by the connector's access level | Critical, financial, account-security, irreversible destructive, and explicitly non-bypassable actions |

The default and migration fallback is **Ask for approval**. Full Access cannot be
enabled until the user acknowledges its dedicated warning. A global mode is
available in Work Mode and Settings, with optional per-connector overrides.
Static connector restrictions still apply: a connector configured as read-only
cannot write even when Full Access is selected.

## Tool metadata and dynamic risk

Every tool descriptor declares:

- action class and action category;
- low, medium, high, or critical risk;
- whether the action is reversible;
- whether it has an external side effect;
- normal, policy-controlled, or non-bypassable confirmation behavior.

These fields are application-owned metadata and are never accepted from a model
response. The backend raises the evaluated risk to critical when input contains
credential-like fields or when an action is bulk-sized. Message, file, webpage,
prompt, provider, and tool-result text are treated as untrusted content and
cannot lower this policy.

## Non-bypassable hard boundaries

Direct approval is required in every mode for:

- critical actions, including dynamically escalated bulk or credential-bearing
  actions;
- purchases, payments, financial transfers, and other financial actions;
- account-access and security changes;
- irreversible destructive actions;
- any connector operation explicitly registered with `confirmation: always`.

Approval applies to one exact tool call. Cancel and timeout resolve safely before
the connector executor runs. Closing/navigating the renderer or stopping the
request also cancels pending approvals. If the renderer is not ready, or already
has an approval visible, the main process uses a native macOS confirmation sheet
so concurrent calls cannot orphan or overwrite a request.

## Approval presentation

The Work approval card shows the connected app, risk, action, reason, and only
the important bounded parameters. Gmail send/reply cards show exact To, Cc,
Subject, message, and attachment names. Drive cards identify the selected item,
destination, name, type, content preview where appropriate, and recovery note
without exposing service IDs or local paths. Secret/token/password fields are
not projected into the card.

Cancel is the safe focused action. Approval is labeled **Approve once** (or the
specific send action in the native fallback), and never changes the persistent
mode.

## Persistence and privacy

Permission settings and activity are main-process user preferences under
Electron's per-user application-data directory, not workspace or project files.
Writes are atomic and use private `0600` file permissions. Corrupt, oversized,
or invalid permission data fails closed to Ask.

Activity retains at most 500 entries and contains only bounded operation
metadata: connector, tool, category, evaluated risk, approval mode, approval
result, completion result, and a redacted generic summary. It excludes tool
inputs, message bodies, recipients, file content, model output, OAuth tokens,
API keys, authorization headers, and credentials. Users can inspect and clear
the history from Work Mode.

## Connector behavior

| Connector | Ask | Approve for me | Full access |
| --- | --- | --- | --- |
| Managed Browser | Bounded public HTTPS reads run automatically | Same | Same; network and isolation boundaries remain enforced |
| Gmail reads | Run automatically | Run automatically | Run automatically |
| Gmail ordinary reversible changes | Ask | Run automatically when low risk | Run automatically |
| Gmail send/reply | Ask | Ask because it communicates externally | Run automatically only when non-critical and not otherwise hard-boundary |
| Google Drive reads | Run automatically | Run automatically | Run automatically |
| Drive ordinary reversible changes | Ask | Run automatically when low risk | Run automatically |
| Drive sensitive transfer/trash/native-save boundaries | Ask | Ask | Full may allow ordinary reversible operations; critical and explicitly always-confirm actions still ask |

Connector scopes, connection state, service validation, and workspace/file
boundaries remain separate checks and can block an action in any mode.

## Verification

- Full automated regression: 419 passed, 1 intentionally skipped, 0 failed.
- Permission tests cover every mode, connector read-only restrictions, critical
  boundaries, irreversible/destructive behavior, bulk messages, credential
  fields, cancellation, and invalid policy contexts.
- Prompt-injection fixtures from email, Drive, webpages, cloud models, and
  Ollama cannot skip the Permission Manager.
- Parameterized Work-agent tests prove OpenAI, Anthropic, Gemini, and compatible
  Ollama tool calls use the same gate.
- A multi-step Gmail-to-Drive workflow under Approve for me completes routine
  safe operations without repeated approval prompts.
- Packaged Intel UI verification covered the global selector, Full Access
  warning/cancel path, Settings modes, per-Gmail override persistence, safe
  automatic Gmail read, exact Gmail-send card, Cancel-before-network behavior,
  private Activity display, permission restoration, and zero renderer errors.
- The live Gmail test used an intentionally invalid recipient and was cancelled;
  no message was sent and no mailbox or Drive mutation was performed.

Broad per-task approval grants were deliberately not added. Approve for me
already prevents routine-action prompt spam while retaining explicit gates for
communications, sensitive transfer, destructive actions, and hard boundaries;
a model-influenced task grant would add a second, wider authorization surface.
