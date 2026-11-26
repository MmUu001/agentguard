# SOC 2 Mapping Sample — AgentGuard audit evidence → Trust Services Criteria

> **Status: SAMPLE for public review** (Pro content pack item #1). Comment on the
> mapping via GitHub issues — that review IS the validation process.
>
> Mapping basis: AICPA Trust Services Criteria 2017 (Points of Focus revised 2022),
> Security category. Clause titles cross-checked against the published TSC index.
> Rule set basis: AgentGuard v0.2.x (4 packs, 30 rules). Field names verified against
> `src/audit/writer.ts` (`AuditRecord`).

## What this is (and is not)

A SOC 2 audit is an **organizational** examination: policies, risk assessment,
operating effectiveness over time. AgentGuard does not make you compliant. What it
does produce is **technical-control evidence for the AI-agent tool-call surface** —
a slice that auditors increasingly ask about ("what can your AI agents do, and do
you have logs?") and that most teams cannot currently answer with anything.

This table maps 5 criteria to the rule IDs and audit fields that serve as evidence
for that slice. Everything outside that slice (MFA, physical access, vendor
management, policies) is not covered and not claimed.

## Criteria covered

| Criterion | Title (TSC 2017/PoF 2022) |
|---|---|
| CC6.1 | Logical access security software, infrastructure and architecture |
| CC6.6 | Protecting against threats from outside the system boundary |
| CC6.7 | Data in transmission, movement and removal |
| CC7.2 | Monitoring for anomalies indicative of threats |
| CC7.3 | Evaluating security events |

## Mapping

### CC6.1 — Logical access security *(restrict unauthorized access to credentials)*

| Rule ID | Blocks | Evidence field |
|---|---|---|
| `secrets-read-env` | Read of `.env` files | `audit: decision=deny, ruleId` |
| `secrets-read-key-file` | Private-key / cloud-credential file reads | same |
| `secrets-read-multiple-env` / `secrets-read-multiple-key` | Batch reads containing credential files | same |
| `secrets-shell-read` | `bash: cat .env` and equivalents | same |
| `secrets-shell-key-file` | `bash` reads of private keys | same |
| `secrets-shell-env-dump` | Full environment-variable dumps | same |
| `secrets-cloud-metadata-command` / `secrets-cloud-metadata-url` | Cloud instance-metadata endpoints (temporary-credential theft) | same |

### CC6.6 — Threats from outside the boundary *(external payloads, internal exposure)*

| Rule ID | Blocks | Evidence field |
|---|---|---|
| `core-pipe-to-shell` | `curl … \| bash` — remote payload executed directly | `audit: decision=deny, ruleId` |
| `net-internal-address-command` / `net-internal-address-url` | Agent-driven access to internal addresses (boundary-internal systems reachable by an externally-influenced agent) | same |

### CC6.7 — Data in transmission, movement and removal *(restrict movement to authorized destinations)*

| Rule ID | Blocks | Evidence field |
|---|---|---|
| `secrets-leak-body` / `secrets-leak-content` / `secrets-leak-text` / `secrets-leak-description` | Outbound content (issue bodies, PR descriptions, HTTP payloads) containing credential-shaped strings | `audit: decision=deny, ruleId` |
| `core-write-system-path` | Writes to system / credential directories | same |
| `core-force-push` / `git-push-delete` | Remote history overwrite / remote branch deletion | same |
| `git-reset-hard` / `git-clean-fdx` / `git-checkout-discard` | Destructive removal of working-tree and untracked data | same |

### CC7.2 — Monitoring for anomalies *(the audit stream itself)*

| Mechanism | Evidence |
|---|---|
| JSONL audit stream — every tool call recorded: `ts`, `tool`, `decision`, `ruleId`, `reason`, `policyHash`, `dryRun`, `session`, `agent`, args (clipped) | `~/.agentguard/audit/<date>.jsonl` |
| `policyHash` in every record — policy changes are detectable as a hash switch across the timeline | same |
| 30-day retention + daily rotation | directory listing |

### CC7.3 — Evaluating security events *(query and reproduce)*

| Command | Purpose | Evidence |
|---|---|---|
| `agentguard audit list --decision deny --since 7d` | Event retrieval for incident review | command output |
| `agentguard audit export --format csv` | Export in a format accepted by reviewers | CSV file |
| `agentguard audit stats --since 7d` | Deny-trend and top-rule summary for management reporting | command output |
| `agentguard explain --tool … --command …` | Reproduce any single verdict, offline | command output |

## Verification

Every mapping above is reproducible without trusting this document:

```bash
agentguard check                                   # rule inventory + sample verdicts
agentguard explain --policy packs/secrets.yaml \
  --tool bash --command "cat .env"                 # CC6.1 row, live
agentguard audit export --format csv               # CC7.3 evidence, exportable
```

## Stated boundaries

1. **Tool evidence ≠ SOC 2 compliance.** This mapping evidences the technical
   tool-call slice of 5 criteria. The examination covers policies, risk
   assessment, and operating effectiveness — use this as one input, not a substitute.
2. **Lexical path matching is best-effort** — Windows junctions and `\\?\` prefixes
   defeat it (reported during launch, fix tracked). Deny rules for system paths
   should be presented to auditors as preventive controls with known limitations.
3. **Clause text is not quoted verbatim here.** Titles are cross-checked against
   the published TSC index; auditors should work from the AICPA document.
4. Rule IDs are stable within v0.2.x; the `policyHash` field binds each audit
   record to the exact policy content in force — present both together.
