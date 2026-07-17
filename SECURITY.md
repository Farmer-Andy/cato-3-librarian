# Security Policy

## Reporting a vulnerability

Please report security issues privately, not through a public issue or pull request.

- Email `security@<yourdomain>` with a description, reproduction steps, and impact. **Operator: replace `<yourdomain>` with a real contact address before publishing this repo.**
- Or open a private report through GitHub Security Advisories: the repository's **Security** tab, then **Report a vulnerability**.

Please allow a reasonable window for a fix before any public disclosure.

## Supported versions

This is a template repository. Deployments derived from it are your own, so the guidance here covers the template code in this repo, not any instance you run from it. Keep your deployment on a current checkout and apply upstream fixes as they land.

## Security-relevant design

Two mechanisms in this template are load-bearing for safety, and their exact boundaries are documented in the [Security section of the README](README.md#security): the tiered permission model with the admin DDL approval gate, and the append-only audit trail. Read those boundaries before you rely on either in production.
