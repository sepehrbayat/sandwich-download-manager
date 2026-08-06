# Signing

Two unrelated kinds of signing meet in this project. Do not confuse them:

1. **Updater signing (active today, required).** Every release artifact carries a minisign
   signature that installed copies verify before applying an update. Without it the updater
   refuses the artifact. This is what stops a compromised download path from shipping a
   malicious "update" to every user.
2. **Authenticode / SmartScreen signing (not yet active).** The Windows certificate story
   below — what removes the "Windows protected your PC" warning on first install.

## Updater signing

The private key lives at `~/.tauri/sandwich-updater.key` on the release machine and **must
never enter the repository**. The matching public key is baked into
`apps/desktop/tauri.conf.json` (`plugins.updater.pubkey`).

**Back the private key up somewhere safe.** Losing it means every installed copy rejects all
future updates — they verify against the public key they shipped with — and the only recovery
is asking users to reinstall by hand. Rotating the key has the same cost; treat it as
permanent.

Release builds must sign their updater artifacts:

```
# The variable takes the key file's PATH (or the key text itself). There is no _PATH variant —
# Tauri silently ignores unknown variables and then complains the private key is missing.
$env:TAURI_SIGNING_PRIVATE_KEY = "$env:USERPROFILE\.tauri\sandwich-updater.key"
npx @tauri-apps/cli@2 build --config apps/desktop/tauri.conf.json
```

Then author the manifest and upload it with the release:

```
powershell -ExecutionPolicy Bypass -File tools/make-latest-json.ps1 -Version <x.y.z>
```

**Every release must include a `latest.json` asset.** Installed apps poll
`releases/latest/download/latest.json`; a release published without it makes every older
install's update check fail until the next correct release.

# Code signing (Authenticode)

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

Build with the signing overlay, supplying the thumbprint through a small throwaway config
file. Two traps make the obvious alternatives fail: Tauri does **not** expand environment
variables inside config files (a `$VAR` placeholder reaches signtool verbatim), and inline
JSON on the command line loses its quotes on the way into `npx`, because PowerShell uses
legacy quoting for `.cmd` shims:

```
'{"bundle":{"windows":{"certificateThumbprint":"<thumbprint>"}}}' |
  Set-Content "$env:TEMP\authenticode.conf.json" -Encoding ascii
npx @tauri-apps/cli@2 build --config apps/desktop/tauri.conf.json --config apps/desktop/tauri.signing.conf.json --config "$env:TEMP\authenticode.conf.json"
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
signtool verify /pa /v "Sandwich Download Manager_0.2.0_x64-setup.exe"
```

Check that it reports a valid chain **and** a timestamp. A signature without a timestamp will
outlive its own validity.
