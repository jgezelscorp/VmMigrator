# Work Routing

How to decide who handles what.

## Routing Table

| Work Type | Route To | Examples |
|-----------|----------|----------|
| Architecture, SKU mapping rules, triage, review | Lead | Design docs, migration safety model |
| Discovery/pre-check/migration/post-check engines, API, scripts | Backend | ARM REST calls, resize + rollback |
| Web UI, VM selection, progress views | Frontend | Auto-detect list, manual select |
| Bicep demo, CI/CD, repo bootstrap | Infra | /demo v1/v2/v3 VMs, workflows |
| Tests, E2E, quality gate | Tester | Mocked ARM units, demo-VM E2E |
| Session logging, decision merge | Scribe | Background only |
| Backlog monitoring | Ralph | Issue/PR watch |
| Responsible AI / safety review | Rai | Destructive-action guardrails |
| Claim verification (docs, SKU facts) | Fact Checker | Verify research against MS Learn |

## Issue Routing

| Label | Action | Who |
|-------|--------|-----|
| `squad` | Triage: analyze issue, assign `squad:{member}` label | Lead |
| `squad:{name}` | Pick up issue and complete the work | Named member |

### How Issue Assignment Works

1. When a GitHub issue gets the `squad` label, the **Lead** triages it — analyzing content, assigning the right `squad:{member}` label, and commenting with triage notes.
2. When a `squad:{member}` label is applied, that member picks up the issue in their next session.
3. Members can reassign by removing their label and adding another member's label.
4. The `squad` label is the "inbox" — untriaged issues waiting for Lead review.

## Rules

1. **Eager by default** — spawn all agents who could usefully start work, including anticipatory downstream work.
2. **Scribe always runs** after substantial work, always as `mode: "background"`. Never blocks.
3. **Quick facts → coordinator answers directly.** Don't spawn an agent for "what port does the server run on?"
4. **When two agents could handle it**, pick the one whose domain is the primary concern.
5. **"Team, ..." → fan-out.** Spawn all relevant agents in parallel as `mode: "background"`.
6. **Anticipate downstream work.** If a feature is being built, spawn the tester to write test cases from requirements simultaneously.
7. **Issue-labeled work** — when a `squad:{member}` label is applied to an issue, route to that member. The Lead handles all `squad` (base label) triage.
