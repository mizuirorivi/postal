/**
 * Postal RPC contract.
 *
 * The server part registers these methods; the TUI part calls them through
 * `context.client.rpc(PostalRpc)` so connect, disconnect, and peer listing
 * report their real result instead of relying on an optimistic toast.
 */

const result = {
  type: "object",
  properties: {
    ok: { type: "boolean" },
    peerID: { type: "string" },
    title: { type: "string" },
    peers: {
      type: "array",
      items: {
        type: "object",
        properties: {
          id: { type: "string" },
          title: { type: "string" },
        },
        required: ["id"],
        additionalProperties: false,
      },
    },
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
          peerID: { type: "string", description: "Omit to disconnect every peer." },
        },
        required: ["sessionID"],
        additionalProperties: false,
      },
      output: result,
    },
    status: {
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
    presence: {
      input: {
        type: "object",
        properties: {
          sessions: {
            type: "array",
            items: {
              type: "object",
              properties: {
                id: { type: "string" },
                title: { type: "string" },
                state: { type: "string", enum: ["idle", "running", "unknown"] },
                pending: {
                  type: "array",
                  items: {
                    type: "object",
                    properties: {
                      id: { type: "string" },
                      type: { type: "string" },
                      source: { type: "string" },
                    },
                    additionalProperties: false,
                  },
                },
              },
              required: ["id", "state"],
              additionalProperties: false,
            },
          },
        },
        required: ["sessions"],
        additionalProperties: false,
      },
      output: result,
    },
  },
}
