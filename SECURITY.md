# Security policy

## Reporting a vulnerability

Please use **GitHub Security Advisories** for this repository:

1. Open the repository's **Security** tab.
2. Choose **Advisories** → **Report a vulnerability**.
3. Include the affected version, the smallest reproduction you can share, and
   the impact you observed.

If the private reporting form is unavailable, open a normal issue that asks the
maintainer to establish a private channel, but **do not include vulnerability
details, credentials, or personal data in that issue**.

Do not disclose a suspected vulnerability publicly before the maintainer has
had a reasonable chance to assess and fix it. This project has no bug-bounty
program and does not offer payment for reports.

## What not to publish

Never include any of the following in a public issue, pull request, discussion,
or screenshot:

- API keys, tokens, cookies, passwords, private keys, or `.env` contents;
- real user prompts, assistant messages, tool output, file contents, or
  repository data that is not yours to share;
- a working exploit against a deployed instance or another person's data.

Redact secrets and personal data first. If a report needs a secret to reproduce
a parsing or redaction bug, use an obviously fake value of the same shape.

## Response expectations

Reports are handled on a best-effort basis by a small maintainer team. There is
**no service-level agreement and no guaranteed response time**. The intended
targets, not promises, are:

- initial acknowledgement: about 5 business days;
- an assessment and next-step plan: about 10 business days;
- a fix or mitigation: depends on severity and maintainer availability.

If a report is accepted, the maintainer will coordinate disclosure in the
advisory and credit the reporter unless the reporter asks to stay anonymous.

## Scope

The plugin runs locally and makes no network requests of its own. Reports about
DSH itself, a provider, or a third-party plugin should go to that project.
Reports about secrets appearing in local files, redaction bypasses, path
traversal, unsafe deserialization, or a way to make the plugin act outside its
documented DSH APIs are in scope.

Supported versions receive fixes on a best-effort basis; this project is
pre-1.0 software and does not maintain long-term support branches.
