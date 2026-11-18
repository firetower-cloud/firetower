#!/usr/bin/env node
/**
 * The API is additive-only, and this is what makes that a rule rather than an
 * aspiration.
 *
 *   node additive-only.mjs <the contract as it was> <the contract as it is>
 *
 * Independent channels mean a desktop copy and a control plane can be
 * arbitrarily far apart: beta runs ahead of general access by however many
 * releases nobody has promoted, and a copy is never downgraded, so there is no
 * version window that survives. What makes that skew safe is a promise instead
 * — nothing a client may already be reading is ever taken away — and the
 * promise is checkable here because the contract is generated and committed at
 * every version.
 *
 * What is taken on, stated plainly: **no removing a path, no removing a field
 * a client may read, no narrowing a type, and no making an optional request
 * field required.** Breaking one is now a decision rather than an oversight.
 *
 * ## What this deliberately does not do
 *
 * It does not check that the contract matches the handlers — `unchanged.sh`
 * already does that, and it is a different question. This one compares the
 * committed contract against its own predecessor, which is the only way to see
 * a removal: a document that no longer mentions a path agrees with handlers
 * that no longer serve it.
 *
 * It is also not a general OpenAPI differ. It answers four questions, and a
 * change it does not understand passes — because a check that fires on changes
 * nobody can act on is one somebody turns off.
 */
import { readFileSync } from "node:fs";

/** One thing that may no longer be done, with where it was found. */
const breach = (where, what) => ({ where, what });

/** The schemas a `$ref` chain lands on, so a renamed wrapper is not a removal. */
function resolve(doc, node, seen = new Set()) {
  let at = node;
  while (at && typeof at === "object" && typeof at.$ref === "string") {
    if (seen.has(at.$ref)) return null;
    seen.add(at.$ref);
    const name = at.$ref.replace("#/components/schemas/", "");
    at = doc.components?.schemas?.[name];
  }
  return at ?? null;
}

/**
 * Every property a reader could see in this schema, as `path → type`.
 *
 * Flattened across `allOf`/`oneOf`/`anyOf` and down through objects and
 * arrays, because a field removed three levels inside a response is removed
 * just as thoroughly as one at the top. A cycle stops at the node that closes
 * it — the contract has several, and a reader does not read forever either.
 */
export function fields(doc, schema, prefix = "", seen = new Set(), out = new Map(), always = true) {
  const at = resolve(doc, schema);
  if (!at || typeof at !== "object") return out;
  if (seen.has(at)) return out;
  seen.add(at);

  for (const key of ["allOf", "oneOf", "anyOf"]) {
    for (const part of at[key] ?? []) fields(doc, part, prefix, seen, out, always);
  }
  if (at.properties) {
    const required = new Set(at.required ?? []);
    for (const [name, value] of Object.entries(at.properties)) {
      const where = prefix ? `${prefix}.${name}` : name;
      const target = resolve(doc, value) ?? {};
      const isRequired = required.has(name);
      out.set(where, {
        type: typeOf(target),
        required: isRequired,
        nullable: !!target.nullable,
        // Is this field in *every* valid document of this shape? Only if it is
        // required and everything containing it is too. See `breaches` for why
        // that distinction decides whether a new required field is a breach.
        always: always && isRequired,
      });
      fields(doc, value, where, seen, out, always && isRequired);
    }
  }
  // Inside an array element or a free-form map, nothing is "always" present:
  // the array can be empty and the map can have no keys.
  if (at.items) fields(doc, at.items, `${prefix}[]`, seen, out, false);
  if (at.additionalProperties && typeof at.additionalProperties === "object") {
    fields(doc, at.additionalProperties, `${prefix}{}`, seen, out, false);
  }
  return out;
}

/**
 * A type as this check compares them.
 *
 * `enum` is carried along because dropping a variant narrows a type just as a
 * `string` becoming an `integer` does, and it is the narrowing most likely to
 * happen by accident — somebody tidies a Rust enum and a client that stored
 * the old value can no longer send it back.
 */
function typeOf(schema) {
  if (!schema || typeof schema !== "object") return "unknown";
  const base = Array.isArray(schema.type) ? [...schema.type].sort().join("|") : (schema.type ?? "unknown");
  return schema.enum ? `${base}<${[...schema.enum].map(String).sort().join(",")}>` : base;
}

/** Is `now` at least as wide as `was`? Equal counts; anything else is narrowing. */
function widened(was, now) {
  if (was === now) return true;
  // `string<a,b>` → `string<a,b,c>` adds a variant, which is additive. The
  // other direction is exactly the removal this is here for.
  const variants = (t) => t.match(/^(\w+)<(.*)>$/);
  const a = variants(was);
  const b = variants(now);
  if (a && b && a[1] === b[1]) return a[2].split(",").every((v) => b[2].split(",").includes(v));
  // An enum becoming the bare type it was drawn from accepts everything it
  // used to and more.
  if (a && !b && a[1] === now) return true;
  // `unknown` on either side is a shape this check does not model. Passing is
  // deliberate: a check that fires on changes nobody can act on gets turned off.
  return was === "unknown" || now === "unknown";
}

/** Every operation in a document, as `METHOD /path` → the operation object. */
function operations(doc) {
  const out = new Map();
  for (const [path, item] of Object.entries(doc.paths ?? {})) {
    for (const [method, operation] of Object.entries(item)) {
      if (["parameters", "summary", "description", "servers"].includes(method)) continue;
      out.set(`${method.toUpperCase()} ${path}`, operation);
    }
  }
  return out;
}

/** The schema of an operation's 2xx response body, if it has one. */
const responseBody = (operation) => {
  const ok = Object.entries(operation.responses ?? {}).find(([code]) => code.startsWith("2"));
  return ok?.[1]?.content?.["application/json"]?.schema ?? null;
};

const requestBody = (operation) => operation.requestBody?.content?.["application/json"]?.schema ?? null;

/** Everything `now` no longer promises that `was` did. */
export function breaches(was, now) {
  const found = [];
  const before = operations(was);
  const after = operations(now);

  for (const [name, operation] of before) {
    const still = after.get(name);
    if (!still) {
      found.push(breach(name, "the path is gone. A client calling it gets a 404 with nothing to catch."));
      continue;
    }

    // A response field a client may already be reading.
    const wasBody = responseBody(operation);
    const nowBody = responseBody(still);
    if (wasBody && !nowBody) {
      found.push(breach(name, "the response body is gone."));
    } else if (wasBody && nowBody) {
      const old = fields(was, wasBody);
      const fresh = fields(now, nowBody);
      for (const [field, had] of old) {
        const has = fresh.get(field);
        if (!has) {
          found.push(breach(`${name} → ${field}`, "the response field is gone. A client reading it gets undefined."));
          continue;
        }
        if (!widened(had.type, has.type)) {
          found.push(breach(`${name} → ${field}`, `the response field was ${had.type} and is now ${has.type}.`));
        }
      }
    }

    // A request field that was optional and is now required: every existing
    // client omits it, so every existing call starts failing validation.
    const wasRequest = requestBody(operation);
    const nowRequest = requestBody(still);
    if (wasRequest && nowRequest) {
      const old = fields(was, wasRequest);
      const fresh = fields(now, nowRequest);
      for (const [field, has] of fresh) {
        const had = old.get(field);
        if (has.required && had && !had.required) {
          found.push(breach(`${name} ← ${field}`, "the request field was optional and is now required."));
        }
        // **A new required field is only a breach if it lands somewhere every
        // caller already sends.** Adding a wholly new optional block with
        // required fields inside it — `opts?: { mode }` — is the commonest
        // additive shape there is, and no existing client sends `opts` at all,
        // so nothing of theirs becomes invalid. Flagging it was a false
        // positive, and a check that fires on safe changes is one people learn
        // to ignore, which costs more than the case it catches.
        //
        // `always` is what tells the two apart: required, inside something
        // required, all the way up.
        if (has.required && has.always && !had) {
          found.push(breach(`${name} ← ${field}`, "a new required request field, in a place every caller already sends. Every existing call fails."));
        }
      }
      for (const [field, had] of old) {
        const has = fresh.get(field);
        if (has && !widened(had.type, has.type)) {
          found.push(breach(`${name} ← ${field}`, `the request field was ${had.type} and is now ${has.type}.`));
        }
      }
    }
  }
  return found;
}

if (process.argv[1] && import.meta.url === `file://${process.argv[1]}`) {
  const [wasPath, nowPath] = process.argv.slice(2);
  if (!wasPath || !nowPath) {
    console.error("usage: additive-only.mjs <contract as it was> <contract as it is>");
    process.exit(64);
  }
  const found = breaches(JSON.parse(readFileSync(wasPath, "utf8")), JSON.parse(readFileSync(nowPath, "utf8")));
  if (found.length === 0) {
    console.log("The API only gained things. Nothing a client may be reading was taken away.");
    process.exit(0);
  }
  console.error("\nThe API is additive-only, and this change is not additive:\n");
  for (const { where, what } of found) console.error(`  ${where}\n    ${what}\n`);
  console.error(
    "Independent channels mean a desktop copy can be arbitrarily far from its control\n" +
      "plane, in either direction, and a copy is never downgraded — so nothing a client\n" +
      "may already be reading can be taken away. Add beside it and leave the old thing\n" +
      "in place; if the removal is genuinely intended, that is a decision to take\n" +
      "deliberately rather than in a pull request that happened to touch a handler.\n",
  );
  process.exit(1);
}
