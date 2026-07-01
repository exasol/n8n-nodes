# n8n-nodes-exasol 0.1.0, released T.B.D.

Code name: Initial release

## Summary

Initial release of the Exasol n8n community node. Provides credentials (host, port, user, password, schema) with live WebSocket connection testing and a single Execute Query operation for running raw SQL against an Exasol database.

## Features

* Exasol credentials with live WebSocket credential test
* Execute Query operation — raw SQL execution against Exasol

## Dependency Updates

### Compile Dependency Updates

* Added `@exasol/exasol-driver-ts:^0.4.0`
* Added `ws:^8.21.0`

### Development Dependency Updates

* Added `@n8n/node-cli:*`
* Added `@types/jest:^30.0.0`
* Added `@types/ws:^8.18.1`
* Added `eslint:9.39.4`
* Added `jest:^30.0.0`
* Added `n8n-workflow:>=2.0.0`
* Added `prettier:3.8.3`
* Added `release-it:^20.2.1`
* Added `ts-jest:^29.4.0`
* Added `typescript:5.9.3`
