import { defineConfig } from "orval";

/**
 * The same contract the web console is generated from, `api/openapi.json`,
 * turned into this client's own typed SDK. The one hand-written file is the
 * mutator, `src/client/http.ts`, which knows which server is current.
 *
 * Nothing under `src/api/generated/` is edited by hand; `just gen` rewrites it.
 */
export default defineConfig({
  firetower: {
    input: "../api/openapi.json",
    output: {
      mode: "tags-split",
      target: "src/api/generated",
      schemas: "src/api/generated/model",
      client: "react-query",
      httpClient: "fetch",
      clean: true,
      override: {
        mutator: { path: "./src/client/http.ts", name: "http" },
        fetch: { includeHttpResponseReturnType: false },
        query: { signal: true, useSetQueryData: true, useGetQueryData: true },
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
