# @system/host source

- [index.ts](index.ts): the socket server and client, and the table type;
- [operations.ts](operations.ts): the rows of the Work operations, over `Services`;
- [process.ts](process.ts): `serveHost`, the table on `$DSH_HOME/system/host.sock` for a Host process (stale socket removed, start and stop logged);
- [api.ts](api.ts): the API reference generated from the table.

See the [package README](../README.md) for the protocol.
