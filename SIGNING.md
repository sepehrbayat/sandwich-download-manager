# Code signing

Sandwich releases are currently **unsigned**. Windows SmartScreen shows *"Windows protected
your PC"* on first run, and users have to choose **More info → Run anyway**.

That warning is the single biggest obstacle to adoption for a free download manager, because
it is exactly the category people have been trained to distrust. This document records how
signing gets turned on once a certificate exists, so the work is a configuration change rather
than a project.

## Choosing a certificate

| Option | Rough cost | SmartScreen reputation | Notes |
|---|---|---|---|
| **Azure Artifact Signing** | ~$10/month | Inherits Microsoft's chain, good from day one | Cheapest by far. **Geographically restricted** — see below |
| **EV certificate** | ~$300–600/year | Immediate | Hardware token or cloud HSM; awkward to automate |
| **OV certificate** | ~$200–400/year | Accumulates with downloads over weeks | Cheapest traditional option, but early users still see the warning |
| Self-signed | free | none | Useless for distribution; the warning stays |

**Check eligibility before spending time on any of these.** Azure Artifact Signing public trust
certificates are limited to organizations in the US, Canada, the EU, the UK, Australia, New
Zealand, Japan, South Korea, Singapore, Switzerland, Norway and Israel — and *individual*
developers must be in the US or Canada. Commercial certificate authorities apply their own
jurisdictional and sanctions restrictions, which can rule out an applicant regardless of
willingness to pay.

If none of these routes are open, the honest fallback is to keep publishing unsigned, document
the warning plainly (the release notes already do), and publish SHA-256 checksums so the
download can be verified independently. That is what the project does today.

## Turning it on

Signing is kept out of the default build so an unsigned local build stays the normal path and
nothing silently fails when no certificate is present.

### With a certificate in the Windows store

Import the certificate, then find its thumbprint:

```
Get-ChildItem Cert:\CurrentUser\My -CodeSigningCert | Select-Object Subject, Thumbprint
```

Build with the signing overlay, supplying the thumbprint inline. Tauri does **not** expand
environment variables inside config files — a `$VAR` placeholder is passed to signtool
verbatim and fails — so the thumbprint goes in as JSON on the command line:

```
$identity = '{"bundle":{"windows":{"certificateThumbprint":"<thumbprint>"}}}'
npx @tauri-apps/cli@2 build --config apps/desktop/tauri.conf.json --config apps/desktop/tauri.signing.conf.json --config $identity
```

The overlay carries only the settings that are the same for every certificate: the digest
algorithm and the timestamp server.

### With Azure Artifact Signing

Install the signing client, then point the overlay's `signCommand` at it. The command receives
the file to sign as `%1`, so any signing tool can be substituted without touching the rest of
the build.

## Always timestamp

The overlay sets a timestamp server. Without one, every signature expires when the certificate
does — meaning installers released today would start warning again the moment the certificate
lapses, including copies people already downloaded. With a timestamp, signatures stay valid
past the certificate's own expiry.

## In CI

The workflow signs only when the `SIGNING_CERT_THUMBPRINT` secret is present, so forks and
pull requests continue to build unsigned rather than failing on a secret they cannot access.

## Verifying a signed build

```
signtool verify /pa /v "Sandwich Download Manager_0.1.1_x64-setup.exe"
```

Check that it reports a valid chain **and** a timestamp. A signature without a timestamp will
outlive its own validity.
