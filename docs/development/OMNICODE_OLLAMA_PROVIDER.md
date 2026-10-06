# Ollama Provider

Last updated: 2026-09-27

Ollama is a first-class local provider in Code, Work, and Omni. It uses the
same agent runtime, ToolRegistry, schema validation, PermissionManager, and
approval UI as cloud providers. The provider adapter translates Ollama
messages; it never executes a tool itself.

## Configuration

Open **Settings → AI Providers → Ollama · local**. The default endpoint is
`http://127.0.0.1:11434`. Advanced users may select another HTTP loopback
address or port. Remote hosts, HTTPS endpoints, embedded credentials, and
non-loopback addresses are rejected.

The provider card reports Connected, Not running, Unreachable, or Checking;
tests the configured endpoint; enumerates installed models from `/api/tags`;
shows model metadata from `/api/show`; selects an installed model; and pulls or
removes models behind native confirmation. The separate Models view remains
available for the curated coding-model catalog and load/unload controls.

## Model capabilities

OmniCode reads Ollama's `/api/show` capability list instead of assuming that
every local model supports the same protocol. Model metadata records native
tools, structured output, streaming, vision, and embeddings separately.

Models that declare `tools` use Ollama's native tool schema. Completion models
without native tools may use the provider-independent structured adapter. The
adapter requests one schema-constrained action at a time, maps only fixed wire
names back to ToolRegistry IDs, limits input size, rejects unknown tools, gives
one repair attempt for malformed output, and blocks an identical repeated tool
request from reaching ToolRegistry. ToolRegistry still validates the selected
tool's real argument schema before PermissionManager or execution.

Large Omni catalogs are reduced by a provider-neutral request/tool-family
selector before any provider adapter sees them (maximum 16 action tools). The
original descriptors and execution routes are unchanged. In structured mode,
the visible `omni.update-plan` prerequisite is offered by itself, single-tool
arguments use that tool's actual JSON schema, and a repeated exact call is
forced into a final-answer repair instead of being executed twice. These rules
also reduce context for stronger local models; none grants extra authority.

The structured adapter does not make a small model reliably agentic. A model
may still answer without selecting a tool, stop after a recoverable tool error,
or fail to plan a longer workflow. Hard step/tool limits remain active.

## phi3:mini on the 2026-09-27 Apple Silicon test host

- Ollama: 0.34.4
- Model digest prefix: `4f2222927938`
- Model: Phi-3 Mini 128K Instruct, 3.8B, Q4_0
- Declared capabilities: `completion`
- Native tools: unsupported; Ollama returns HTTP 400
- Structured JSON: supported in direct and agent-loop probes
- Streaming, system messages, and multi-turn chat: supported
- Tool-result continuation: supported, but not consistently reliable on
  broader or repeated multi-step prompts
- `/api/show` advertises 131,072 tokens, but the running model used a 4,096-token
  context on this host. The unreduced Omni catalog was observed at 4,489 prompt
  tokens and was truncated; relevant-tool selection removed that truncation.

The latest gated run passed 3 of 6 strict live cases: capability discovery, a
real model-selected read-only ToolRegistry call and continuation (1.163 s), and
streaming (166 ms, six chunks). It failed the broader package inspection,
ordered failure-recovery, and write/read workflow because Phi-3 repeated or
selected the wrong file operation and produced incomplete final summaries.
Those failures remain visible; the normal suite does not depend on them.

A built-app Omni Invisible task subsequently completed with a model-authored
visible plan, one real `runtime.detect` call, and a final response. A managed
browser task successfully opened `https://example.com`, but Phi-3 then wandered
through unnecessary browser tools and reached an approval boundary instead of
finishing. This establishes real local-tool operation, not reliable complex
agent parity for this 3.8B model.

The real gated suite is:

```zsh
OMNICODE_TEST_OLLAMA=1 OMNICODE_TEST_OLLAMA_MODEL=phi3:mini npm test
```

Normal `npm test` never requires Ollama. The live suite must remain separate
because model availability, output, and latency are host-dependent.

## Google Workspace privacy

Local Ollama is eligible for minimum-context Gmail and Drive tool results.
OAuth access tokens, refresh tokens, client secrets, and authorization headers
are never model context. Connector results pass through the same bounded
sanitizer and provenance policy used for cloud providers. Ollama models whose
names indicate an Ollama-hosted cloud route remain blocked from Google
Workspace content.

## Voice and Omni

Voice transcription is independent of the selected AI provider. The native
speech helper requires Apple's on-device recognizer; it does not silently fall
back to cloud speech. A final transcript enters the same OmniController path as
typed input, and an Ollama-driven action still uses the normal tool and
approval pipeline. TTS uses the local macOS `say` provider.

On this host the arm64 helper reported `en-US`, recognizer available,
`onDevice: true`, and streaming support. Microphone and Speech Recognition
permissions remained `not-determined`; a normal permission request was made,
but the logged-in graphical session was at `loginwindow`, so no user decision
or real transcript was obtained. Do not interpret capability availability as
proof that on-device recognition actually ran. TTS did run: interruption was
accepted after 183 ms and a complete test utterance finished in 2.416 s.
