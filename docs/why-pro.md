# Why is the core free? (And what do you actually sell?)

Short version: **everything in the npm package is free, permanently** — the proxy,
the policy engine, all 4 rule packs, the audit log, `explain`, rate limits, every
client integration. Nothing is cropped, nothing is time-limited, nothing phones home.

The paid tier sells three things that cannot be taken from a fork:
**content that requires ongoing human maintenance, report formats that auditors
accept, and a human who answers when something breaks.** No license keys gate any
functionality — a key only marks organizational authorization and unlocks content
downloads. If that ever changes, forking this repo is trivial and everyone knows it.

## The tiers

> **Prices below are indicative assumptions pending demand validation.** Nothing is
> on sale; no payment link exists. Per the project plan, prices stay unprinted on any
> sales surface until a waitlist confirms willingness to pay (see "Current status").

| | **Core** | **Pro** (~$39, one-time) | **Pro Annual** (~$79/yr) | **Enterprise** (~$1.5k–5k/yr) |
|---|---|---|---|---|
| stdio proxy + policy engine | ✅ | ✅ | ✅ | ✅ |
| 4 rule packs, 30 rules | ✅ | ✅ | ✅ | ✅ |
| JSONL audit (policyHash, 30-day retention) | ✅ | ✅ | ✅ | ✅ |
| `explain` / `check` / `demo` / all clients | ✅ | ✅ | ✅ | ✅ |
| **Compliance mapping packs** (SOC2 / PCI-DSS / 等保 2.0 → rule IDs) | — | ✅ v1 | ✅ + quarterly additions | ✅ + custom entries |
| **Audit weekly report template** (deny trends, top rules, anomalies) | — | ✅ | ✅ | ✅ |
| **CI gate report template** (PR-comment format for `--fail-on deny`) | — | ✅ | ✅ | ✅ |
| **Policy review checklist** (12 questions before go-live) | — | ✅ | ✅ | ✅ |
| Quarterly new mapping packs | — | — | ✅ | ✅ |
| Email support (48h SLA) | — | — | ✅ | ✅ priority |
| Strategy review call + signed authorization letter | — | — | — | ✅ |
| Liability cap clause (capped at fees paid) | — | — | — | ✅ |
| Custom rule packs for your codebase | — | — | — | ✅ |
| GitHub Sponsors badge | — | — | — | — (Sponsor tier opens at 500+ stars) |

## Why functionality stays free

Because in an open-source CLI, a functional paywall is a **three-line patch away
from nothing**. Users fork, delete the license check, and you have converted a
trust asset into a support burden. Selling gates in this distribution model means
selling something your users can delete — and knowing it.

What forks cannot delete: the *upkeep* of tracking SOC2 CC6.1/CC6.6/CC6.7/CC7.2/CC7.3
clause text against rule behavior, the *credibility* of a report format an auditor
has accepted before, and the *existence* of someone who answers within 48 hours.
Those are human costs, paid continuously. That is the entire business.

## What a Pro mapping pack actually contains (no hand-waving)

Each mapping is a reviewed table: **compliance clause text → AgentGuard rule ID →
the evidence file that clause maps to** (which audit field, which log entry format).

Example row shape (from the SOC2 sample in progress):

```text
CC6.7  — Restrict movement of data to authorized users
  → secrets-read-env            (blocks .env file reads)
  → secrets-shell-read          (blocks bash: cat .env / env dumps)
  → secrets-key-file            (blocks private-key reads)
  Evidence: audit JSONL, decision=deny entries with policyHash
```

The sample will be **published in this repo for public review before anyone is
asked to pay for anything**. If the mapping is wrong or thin, say so in an issue —
that is the validation process working.

## Current status (read this before assuming)

**As of this writing, Pro does not exist as a product.** It is in the demand-
validation stage defined in the project plan: a SOC2 sample is being built first,
a waitlist will follow, and **a payment link will only appear after at least a few
people have explicitly said they would pay $39 for the pack**. If validation fails,
the packs become a Sponsor perk and this file documents why that decision was made.

No payment links exist yet. Nothing here is on sale. This document exists so the
boundary between free and paid is legible *before* money is involved, not after.

## Why this model at all

Same logic as Semgrep's rules / Trivy's DB / Tailscale's free tier: the open
artifact earns trust and distribution; the paid artifact is human work that the
open artifact cannot self-generate. For a security tool specifically, the audit
story ("here is exactly what my agent was blocked from doing, per clause, per
policy version") is the thing compliance-bound teams ask for — and it is the
thing that survives a fork, because it is not code.
