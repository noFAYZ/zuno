# Security Policy

## Supported versions

Only the latest release gets fixes. Zuno auto-updates; older versions are not patched.

## Reporting a vulnerability

Use GitHub's [private vulnerability reporting](https://github.com/noFAYZ/zuno/security/advisories/new)
— it is private until a fix ships. If that is unavailable, email m.faizanasad97@gmail.com
with `zuno security` in the subject.

Please do not open a public issue for a vulnerability.

Include what you have: affected version, OS, steps to reproduce, and what an attacker gains.
Expect a first reply within a week. This is a one-maintainer hobby project — there is no
bounty, and a fix lands in the next release rather than on a fixed SLA.

## Scope

Zuno is a desktop app that plays YouTube content locally. Things worth reporting:

- Remote content (video metadata, captions, thumbnails, URLs) escaping into command
  execution, file writes outside the app's own data directory, or the webview's privileged
  context.
- Anything that leaks the updater signing key, cookies, or the local cookie jar.
- A malicious or spoofed update passing signature verification.

Out of scope: YouTube's own terms of service, rate limits or bot checks, missing hardening
that is not exploitable, and vulnerabilities in a dependency that Zuno does not actually
reach.
