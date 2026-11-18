/**
 * The additive-only promise, on documents.
 *
 * What makes this worth testing rather than reading: the check has to fire on
 * four specific changes and stay quiet on everything else. A version that
 * found nothing would pass every pull request forever and nobody would notice;
 * a version that found something in every pull request would be turned off
 * within a week. Both failures are silent, so both are asserted.
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { breaches } from "./additive-only.mjs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");

/** A contract with one GET returning `schema`, and optionally one POST. */
const doc = ({ get, post, schemas = {}, path = "/api/v1/thing" } = {}) => ({
  openapi: "3.1.0",
  paths: {
    [path]: {
      ...(get ? { get: { responses: { 200: { content: { "application/json": { schema: get } } } } } } : {}),
      ...(post ? { post: { requestBody: { content: { "application/json": { schema: post } } }, responses: { 200: {} } } } : {}),
    },
  },
  components: { schemas },
});

const object = (properties, required = []) => ({ type: "object", properties, required });
const str = { type: "string" };
const num = { type: "integer" };

describe("what is no longer promised", () => {
  it("catches a path that is gone", () => {
    const was = doc({ get: object({ name: str }) });
    const now = { openapi: "3.1.0", paths: {}, components: { schemas: {} } };
    const found = breaches(was, now);
    assert.equal(found.length, 1);
    assert.match(found[0].where, /GET \/api\/v1\/thing/);
    assert.match(found[0].what, /the path is gone/);
  });

  it("catches a response field that is gone", () => {
    const was = doc({ get: object({ name: str, retired: str }) });
    const now = doc({ get: object({ name: str }) });
    const found = breaches(was, now);
    assert.equal(found.length, 1);
    assert.match(found[0].where, /retired/);
    assert.match(found[0].what, /response field is gone/);
  });

  it("catches a response field gone from inside a nested object", () => {
    // Three levels down is removed just as thoroughly as at the top, and this
    // is where it is most likely to happen without anybody noticing.
    const was = doc({ get: object({ host: object({ worker: object({ version: str, built: str }) }) }) });
    const now = doc({ get: object({ host: object({ worker: object({ version: str }) }) }) });
    const found = breaches(was, now);
    assert.equal(found.length, 1);
    assert.match(found[0].where, /host\.worker\.built/);
  });

  it("follows a $ref, so a renamed wrapper is not read as a removal", () => {
    const was = doc({
      get: { $ref: "#/components/schemas/Old" },
      schemas: { Old: object({ name: str }) },
    });
    const now = doc({
      get: { $ref: "#/components/schemas/New" },
      schemas: { New: object({ name: str }) },
    });
    assert.deepEqual(breaches(was, now), []);
  });

  it("catches a response that can now produce something it could not", () => {
    const was = doc({ get: object({ count: str }) });
    const now = doc({ get: object({ count: num }) });
    const found = breaches(was, now);
    assert.equal(found.length, 1);
    assert.match(found[0].what, /was string and is now integer/);

    // The same shape in this contract's own spelling: `Option<T>` is a type
    // array, so a response gaining `null` is a reader meeting one it never
    // had to handle.
    const gainsNull = doc({ get: object({ count: { type: ["string", "null"] } }) });
    assert.equal(breaches(was, gainsNull).length, 1);
  });

  it("catches a request that no longer accepts what it used to", () => {
    const was = doc({ post: object({ state: { type: "string", enum: ["queued", "running", "held"] } }) });
    // The narrowing most likely to happen by accident: somebody tidies a Rust
    // enum and a caller holding the old value can no longer send it back.
    const narrower = doc({ post: object({ state: { type: "string", enum: ["queued", "running"] } }) });
    assert.equal(breaches(was, narrower).length, 1);
    assert.match(breaches(was, narrower)[0].what, /held/);

    // And a request type array losing a member.
    const wasNullable = doc({ post: object({ name: { type: ["string", "null"] } }) });
    const nowStrict = doc({ post: object({ name: str }) });
    assert.equal(breaches(wasNullable, nowStrict).length, 1);
  });

  it("catches a request field that became required", () => {
    // Every existing client omits it, so every existing call starts failing
    // validation — which is a removal of the ability to call at all.
    const was = doc({ post: object({ name: str, scope: str }, ["name"]) });
    const now = doc({ post: object({ name: str, scope: str }, ["name", "scope"]) });
    const found = breaches(was, now);
    assert.equal(found.length, 1);
    assert.match(found[0].what, /was optional and is now required/);
  });

  it("catches a new required request field where every caller already sends", () => {
    const was = doc({ post: object({ name: str }, ["name"]) });
    const now = doc({ post: object({ name: str, scope: str }, ["name", "scope"]) });
    const found = breaches(was, now);
    assert.equal(found.length, 1);
    assert.match(found[0].what, /Every existing call fails/);
  });

  it("still catches a required field added inside something required", () => {
    // Nested, but on a path every caller already sends, so every caller
    // breaks. The narrowing below must not swallow this one.
    const was = doc({ post: object({ opts: object({ x: str }, ["x"]) }, ["opts"]) });
    const now = doc({ post: object({ opts: object({ x: str, y: str }, ["x", "y"]) }, ["opts"]) });
    const found = breaches(was, now);
    assert.equal(found.length, 1);
    assert.match(found[0].where, /opts\.y/);
  });
});

describe("what is still allowed, because the whole point is to add", () => {
  it("passes a new path", () => {
    const was = doc({ get: object({ name: str }) });
    const now = {
      ...doc({ get: object({ name: str }) }),
      paths: { ...doc({ get: object({ name: str }) }).paths, "/api/v1/new": { get: { responses: { 200: {} } } } },
    };
    assert.deepEqual(breaches(was, now), []);
  });

  it("passes a new response field, nested or not", () => {
    const was = doc({ get: object({ name: str }) });
    const now = doc({ get: object({ name: str, channel: str, host: object({ tag: str }) }) });
    assert.deepEqual(breaches(was, now), []);
  });

  it("passes a wholly new optional block with required fields inside it", () => {
    // Reported by QA as a false positive, and it is the commonest additive
    // shape there is: `opts?: { mode }`. No existing caller sends `opts` at
    // all, so nothing of theirs becomes invalid. The old rule flagged it as
    // "every existing client's call fails", which is both wrong and alarming —
    // and a check that fires on safe changes is one people learn to ignore,
    // which costs more than the case it catches.
    const was = doc({ post: object({ name: str }, ["name"]) });
    const now = doc({ post: object({ name: str, opts: object({ mode: str }, ["mode"]) }, ["name"]) });
    assert.deepEqual(breaches(was, now), []);
  });

  it("passes a required field added inside an array element or a map", () => {
    // An array can be empty and a map can have no keys, so neither is a place
    // every caller already sends.
    const wasArr = doc({ post: object({ items: { type: "array", items: object({ a: str }, ["a"]) } }, ["items"]) });
    const nowArr = doc({ post: object({ items: { type: "array", items: object({ a: str, b: str }, ["a", "b"]) } }, ["items"]) });
    assert.deepEqual(breaches(wasArr, nowArr), []);
  });

  it("passes a new optional request field", () => {
    const was = doc({ post: object({ name: str }, ["name"]) });
    const now = doc({ post: object({ name: str, channel: str }, ["name"]) });
    assert.deepEqual(breaches(was, now), []);
  });

  /**
   * The over-firing QA found, in this contract's own spelling.
   *
   * `nullable` appears zero times in `api/openapi.json` and type arrays appear
   * 237 times, because `Option<T>` generates OpenAPI 3.1's
   * `{"type": ["string", "null"]}`. Comparing the joined string made
   * `null|string` and `string` unequal in *either* direction, so two safe and
   * routine changes were reported as breaches — and `Option<String>` → `String`
   * on a real handler failed the build.
   */
  it("passes a response field that stops being null", () => {
    // Strictly more guarantee to every reader: one that coped with
    // `string|null` copes with `string`.
    const was = doc({ get: object({ ownerName: { type: ["string", "null"] } }) });
    const now = doc({ get: object({ ownerName: str }, ["ownerName"]) });
    assert.deepEqual(breaches(was, now), []);
  });

  it("passes a request field that starts accepting null", () => {
    // Strictly more accepted: a caller sending a string is still fine.
    const was = doc({ post: object({ name: str }, ["name"]) });
    const now = doc({ post: object({ name: { type: ["string", "null"] } }, []) });
    assert.deepEqual(breaches(was, now), []);
  });

  it("passes a new variant on a response enum", () => {
    // Deliberate. Adding one is routine, clients are expected to tolerate
    // values they do not know, and flagging it would be the next wolf — which
    // is the failure mode this whole check has to avoid to stay believed.
    const was = doc({ get: object({ state: { type: "string", enum: ["queued", "running"] } }) });
    const now = doc({ get: object({ state: { type: "string", enum: ["queued", "running", "paused"] } }) });
    assert.deepEqual(breaches(was, now), []);
  });

  it("passes a required *response* field becoming optional", () => {
    // Which direction is breaking depends on who reads it. A response field
    // that is no longer always sent is a real change, but it is not one this
    // promise covers — the promise is that the field still exists and still
    // has the type it had, which an optional field does.
    const was = doc({ get: object({ name: str }, ["name"]) });
    const now = doc({ get: object({ name: str }, []) });
    assert.deepEqual(breaches(was, now), []);
  });

  it("passes a document compared against itself", () => {
    // The positive control that matters most: the committed contract, as it
    // is, against itself. If this ever found something, every pull request
    // would be red and the check would be removed rather than believed.
    const contract = JSON.parse(readFileSync(join(ROOT, "api/openapi.json"), "utf8"));
    assert.deepEqual(breaches(contract, contract), []);
    const updater = JSON.parse(readFileSync(join(ROOT, "api/updater.json"), "utf8"));
    assert.deepEqual(breaches(updater, updater), []);
  });

  /**
   * The first operation whose 2xx response is a plain `$ref` to an object with
   * more than one property, as `[operation, schema name]`.
   *
   * Chosen by **reachability from a response**, not by taking the first schema
   * in `components`. An earlier version did the latter and passed here while
   * failing in CI, where a different merge commit put an unreferenced schema
   * first: removing a field from something nothing returns is correctly not a
   * breach, so the test was asserting on whichever schema happened to sort
   * first rather than on anything about the check.
   */
  function aReturnedSchema(contract) {
    for (const [path, item] of Object.entries(contract.paths)) {
      for (const [method, operation] of Object.entries(item)) {
        const ok = Object.entries(operation.responses ?? {}).find(([code]) => code.startsWith("2"));
        const ref = ok?.[1]?.content?.["application/json"]?.schema?.$ref;
        if (!ref) continue;
        const name = ref.replace("#/components/schemas/", "");
        const schema = contract.components?.schemas?.[name];
        if (schema?.type === "object" && Object.keys(schema.properties ?? {}).length > 1) {
          return { where: `${method.toUpperCase()} ${path}`, name };
        }
      }
    }
    throw new Error("no operation returns an object with more than one field — this test is reading a contract it does not recognise");
  }

  it("survives the real contract having a field taken out of it", () => {
    // Not a synthetic document: the committed contract with one field removed
    // from something an endpoint actually returns, which is the change this
    // exists to stop. Proves the check works at the size and shape of the thing
    // it will really read, including its `$ref` chains and its cycles.
    const contract = JSON.parse(readFileSync(join(ROOT, "api/openapi.json"), "utf8"));
    const { where, name } = aReturnedSchema(contract);
    const after = JSON.parse(JSON.stringify(contract));
    const dropped = Object.keys(after.components.schemas[name].properties)[0];
    delete after.components.schemas[name].properties[dropped];

    const found = breaches(contract, after);
    assert.ok(found.length > 0, `removing ${name}.${dropped}, returned by ${where}, was not noticed`);
    assert.ok(
      found.some((f) => f.where.endsWith(dropped) || f.where.includes(`.${dropped}`)),
      `${dropped} is not named in: ${found.map((f) => f.where).join(", ")}`,
    );
  });

  it("survives the real contract losing a path", () => {
    const contract = JSON.parse(readFileSync(join(ROOT, "api/openapi.json"), "utf8"));
    const after = JSON.parse(JSON.stringify(contract));
    const [gone] = Object.keys(after.paths);
    delete after.paths[gone];

    const found = breaches(contract, after);
    assert.ok(
      found.some((f) => f.where.includes(gone) && /path is gone/.test(f.what)),
      `${gone} is not named in: ${found.map((f) => f.where).join(", ")}`,
    );
  });
});
