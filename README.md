# Crispy King Franchise Payroll — update distribution

This public repository is the update download source for the licensed local payroll application.

- Branch: `main`
- Update folder: `updates/`
- Feed: `https://raw.githubusercontent.com/marcolopez1995/ERTFranchiseePayroll/main/updates/latest.json`
- Newly issued product licenses are lifetime, with no expiry.

## Current status

The repository structure is prepared. A signed `latest.json` feed has not been published yet. The publisher must generate private keys locally and use the owner tools to build the first signed feed. No private keys, licenses or customer payroll data belong in this repository.

## Publish a release

1. In the owner package, initialize publisher keys once and keep them private.
2. Build the signed initial feed (option 6) or a newer update (option 4).
3. Copy the **contents** of `PublisherTools/ReleaseUploads` into `updates/`, including `.gitattributes`.
4. Commit versioned payloads and `latest.json` together, preserving their bytes and old releases.

Clients check at startup and every six hours while running. They verify publisher signatures and checksums, then install after a saved restart. Public files do not grant a software license.

Never upload the master package, PublisherTools, Private, issued licenses, payroll backups, Data, or certificate files.
