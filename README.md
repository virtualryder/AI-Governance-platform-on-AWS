# Governed AI Agent Platform (Amazon Bedrock AgentCore)

A repeatable, CDK-deployable AI governance landing zone for SLG and HCLS customers, plus a harness for
building the first governed use case. Built with Shashi (SLG) and David (HCLS).

**Start here:** `docs/ARCHITECTURE.md` (why hub-and-spoke + standalone) · `CLAUDE.md` (build rules and plan)

## Deployment modes
| Mode | Use when | Command |
|---|---|---|
| `standalone` | Pilot in one existing or new account | `npx cdk deploy --all -c mode=standalone -c configFile=config/<customer>.json` |
| `hub` | Dedicated AI governance account | `npx cdk deploy --all -c mode=hub ...` |
| `spoke` | Each agent/workload account | `npx cdk deploy --all -c mode=spoke ...` |
| `org` | Management or delegated-admin account | `npx cdk deploy --all -c mode=org ...` |

## Develop
```powershell
npm install
npm run build        # type-check
npm test             # template assertions
npm run synth:standalone
npm run nag          # cdk-nag AwsSolutions + HIPAA packs
```
Copy `config/platform.example.json` to `config/<customer>.json` for each customer.

## Status
Scaffold complete; all four modes synth. Governance controls are built in phases (see `CLAUDE.md`).
