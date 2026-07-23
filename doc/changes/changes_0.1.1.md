# n8n-nodes-exasol 0.1.1, released 2026-07-23

Code name: Bug fixes

## Summary

Patch release fixing two issues found shortly after the 0.1.0 release: a build config
duplicate and the credential test button not working in the n8n UI.

## Bug Fixes

* #34: Removed `package.json` from the `tsconfig.json` `include` array.
* #36: Fixed credential test being unreachable by n8n.
