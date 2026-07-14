# n8n-nodes-exasol

n8n community nodes for [Exasol](https://www.exasol.com/).

## Installation

Follow the [n8n community node installation guide](https://docs.n8n.io/integrations/community-nodes/installation/) to install this package in your n8n instance.

Package name: `n8n-nodes-exasol`

## Credentials

The Exasol node uses **ExasolApi** credentials. You will need:

- **Host** – Exasol database hostname
- **Port** – WebSocket port (default: `8563`)
- **User** – Database username
- **Password** – Database password
- **Schema** _(optional)_ – Default schema for queries
- **Encryption** – Enable TLS (default: `true`)

## Example workflows

Importable demo workflows covering all operations — including using the node as an AI Agent
tool — live in [examples/](examples/README.md).

## Development

```bash
npm install
npm run build
npm run lint
```

To test locally, link the package into an n8n installation:

```bash
npm link
# In your n8n directory:
npm link n8n-nodes-exasol
```

## Resources

- [n8n community nodes documentation](https://docs.n8n.io/integrations/community-nodes/)
- [Exasol documentation](https://docs.exasol.com/)
- [exasol-driver-ts](https://github.com/exasol/exasol-driver-ts)

## License

[MIT](LICENSE)
