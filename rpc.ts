/**
 * Postal RPC contract.
 *
 * The server part registers these methods; the TUI part calls them through
 * `context.client.rpc(PostalRpc)` so connect/disconnect report their real
 * result instead of relying on an optimistic toast.
 */

const result = {
  type: "object",
  properties: {
    ok: { type: "boolean" },
    peerID: { type: "string" },
    title: { type: "string" },
    error: { type: "string" },
  },
  required: ["ok"],
  additionalProperties: false,
} as const

export const PostalRpc = {
  id: "postal",
  events: {},
  methods: {
    connect: {
      input: {
        type: "object",
        properties: {
          sessionID: { type: "string" },
          peerID: { type: "string" },
        },
        required: ["sessionID", "peerID"],
        additionalProperties: false,
      },
      output: result,
    },
    disconnect: {
      input: {
        type: "object",
        properties: {
          sessionID: { type: "string" },
        },
        required: ["sessionID"],
        additionalProperties: false,
      },
      output: result,
    },
  },
}
