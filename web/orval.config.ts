import { defineConfig } from "orval";

/**
 * The Rust types are the source of truth. `just gen` writes the contract from
 * the handlers, then this turns it into a typed client, react-query hooks, and
 * validators — so a field renamed in Rust becomes a compile error here rather
 * than a runtime surprise.
 *
 * Nothing under `generated/` is edited by hand.
 */
export default defineConfig({
  firetower: {
    input: "../api/openapi.json",
    output: {
      // one file per resource, from the tag on each handler
      mode: "tags-split",
      target: "src/api/generated",
      schemas: "src/api/generated/model",
      client: "react-query",
      httpClient: "fetch",
      clean: true,
      override: {
        // the one hand-written file: base URL and bearer token live there
        mutator: { path: "./src/api/http.ts", name: "http" },
        // Return the body, not a { data, status, headers } wrapper. The mutator
        // already throws on failure, so the envelope buys nothing.
        fetch: { includeHttpResponseReturnType: false },
        // Deliberately does NOT set useQuery or useMutation: either one applies to
        // every operation, so forcing one turns the other kind inside out. The
        // HTTP method already decides this correctly.
        query: {
          signal: true,
          // Typed cache helpers — the event stream applies updates through these
          // rather than refetching.
          useSetQueryData: true,
          useGetQueryData: true,
        },
      },
    },
  },

  // Validators, kept out of the query layer. Used for the event stream, whose
  // frames the generator otherwise wouldn't type at all.
  firetowerZod: {
    input: "../api/openapi.json",
    output: {
      mode: "tags-split",
      target: "src/api/generated",
      client: "zod",
      fileExtension: ".zod.ts",
      clean: false,
    },
  },
});
