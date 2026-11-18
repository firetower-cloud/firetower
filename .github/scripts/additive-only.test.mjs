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

  it("catches a narrowed type", () => {
    const was = doc({ get: object({ count: str }) });
    const now = doc({ get: object({ count: num }) });
    const found = breaches(was, now);
    assert.equal(found.length, 1);
    assert.match(found[0].what, /was string and is now integer/);
  });

  it("catches a dropped enum variant, and allows an added one", () => {
    // The narrowing most likely to happen by accident: somebody tidies a Rust
    // enum and a client holding the old value can no longer send it back.
    const was = doc({ get: object({ state: { type: "string", enum: ["queued", "running", "held"] } }) });
    const narrower = doc({ get: object({ state: { type: "string", enum: ["queued", "running"] } }) });
    const wider = doc({ get: object({ state: { type: "string", enum: ["queued", "running", "held", "paused"] } }) });
    assert.equal(breaches(was, narrower).length, 1);
    assert.match(breaches(was, narrower)[0].what, /held/);
    assert.deepEqual(breaches(was, wider), []);
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

  it("catches a new request field that is required", () => {
    const was = doc({ post: object({ name: str }, ["name"]) });
    const now = doc({ post: object({ name: str, scope: str }, ["name", "scope"]) });
    const found = breaches(was, now);
    assert.equal(found.length, 1);
    assert.match(found[0].what, /every existing client's call fails/);
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

  it("passes a new optional request field", () => {
    const was = doc({ post: object({ name: str }, ["name"]) });
    const now = doc({ post: object({ name: str, channel: str }, ["name"]) });
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

  it("survives the real contract having a field taken out of it", () => {
    // Not a synthetic document: the committed contract with one response field
    // removed, which is the change this exists to stop. Proves the check works
    // at the size and shape of the thing it will actually read, including its
    // `$ref` chains and its cycles.
    const contract = JSON.parse(readFileSync(join(ROOT, "api/openapi.json"), "utf8"));
    const after = JSON.parse(JSON.stringify(contract));
    const [name, schema] = Object.entries(after.components.schemas).find(
      ([, s]) => s.type === "object" && Object.keys(s.properties ?? {}).length > 1,
    );
    const dropped = Object.keys(schema.properties)[0];
    delete schema.properties[dropped];

    const found = breaches(contract, after);
    assert.ok(found.length > 0, `removing ${name}.${dropped} was not noticed`);
    assert.ok(
      found.some((f) => f.where.endsWith(dropped) || f.where.includes(`.${dropped}`)),
      `${dropped} is not named in: ${found.map((f) => f.where).join(", ")}`,
    );
  });
});
