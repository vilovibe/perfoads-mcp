# Security policy

## Reporting a vulnerability

Please report security issues privately. Do not open a public issue.

**Private disclosure address: contact@perfoads.com**

Include what you found, how to reproduce it, the version (`perfoads-mcp --version`), and the impact. We will acknowledge your report and keep you updated until it is fixed. Please give us reasonable time to fix it before disclosing.

## Supported versions

Only the latest release gets security fixes while the project is in alpha.

## Scope

This project handles Google Ads credentials and can change live ad accounts. Of special interest:

- Ways to apply a change without human approval (see the safety promise and its limits in the [README](README.md) and [docs/THREAT-MODEL.md](docs/THREAT-MODEL.md)).
- Prompt injection through ad data leading to a write.
- Leaks of refresh tokens, OAuth client secrets, approval codes or page tokens.
- Bypassing policy limits, the ops reserve or the kill switch.
- Attacks on the local approval page or the OAuth loopback listener.

Known limits that are documented (same-OS-user access without the [hardened setup](docs/HARDENED-SETUP.md), human steps done in a terminal an AI agent with a shell can change, browser-control tools reading an open approval page) are not vulnerabilities by themselves, but ways to make them narrower are welcome.
