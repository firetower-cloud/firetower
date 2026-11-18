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
 * A type as this check compares them: the set of primitive types it may be,
 * the set of enum values if it has one, and a label for the message.
 *
 * **The type is a set, not a string, because this contract writes it as one.**
 * `Option<T>` generates OpenAPI 3.1's `{"type": ["string", "null"]}` — the
 * `nullable` keyword appears zero times in `api/openapi.json` and type arrays
 * appear 237 times — so comparing the joined string made `null|string` and
 * `string` simply unequal, in either direction.
 */
function typeOf(schema) {
  if (!schema || typeof schema !== "object") return { types: null, values: null, label: "unknown" };
  const types = Array.isArray(schema.type) ? [...schema.type] : schema.type ? [schema.type] : null;
  const values = Array.isArray(schema.enum) ? schema.enum.map(String) : null;
  const base = types ? [...types].sort().join("|") : "unknown";
  return {
    types: types ? new Set(types) : null,
    values: values ? new Set(values) : null,
    label: values ? `${base}<${[...values].sort().join(",")}>` : base,
  };
}

/** Is every member of `a` in `b`? A missing set means "not modelled". */
const within = (a, b) => !a || !b || [...a].every((v) => b.has(v));

/**
 * **Whether narrowing is a breach depends on which side of the call it is on,
 * and that is the whole of this.**
 *
 * The old version applied one `widened()` in both loops, so direction was
 * never considered and two perfectly safe changes were reported as breaches:
 * a response field going `string|null` → `string`, and a request field going
 * `string` → `string|null`. Both were real — `Option<String>` → `String` on a
 * handler fails the build — and a check that cries wolf is a check people
 * learn to override, which is worse than the case it catches given this one
 * is the guard rail under the whole additive-only promise.
 *
 * * **A response** may produce *fewer* kinds of thing than it used to and
 *   nothing breaks: a reader that coped with `string|null` copes with
 *   `string`. What breaks a reader is a response producing something it could
 *   not before. So: breach if the new set is not contained in the old.
 * * **A request** may accept *more* than it used to and nothing breaks: a
 *   caller sending `string` is still fine against `string|null`. What breaks a
 *   caller is the server accepting less. So: breach if the old set is not
 *   contained in the new.
 *
 * Enum values are compared on the request side only. Dropping a variant the
 * server used to accept breaks a caller that stored it — that is the narrowing
 * most likely to happen by accident.
 *
 * **The response side is silent on enum values, and that silence is a
 * decision resting on a condition nothing here verifies.** It is safe *because
 * clients are required to tolerate values they do not know* — §05's "hide what
 * the server cannot serve rather than rendering a screen that will fail", and
 * the client half of it is #451's. Nothing in this script, or anywhere in CI,
 * checks that they do: a total `Record<SessionStatus, …>` with no fallback
 * renders an unknown status as `undefined` rather than failing loudly, which
 * has been found in the desktop client and filed separately.
 *
 * It is written down here because the alternative is worse in a specific way.
 * Flagging a response enum that gained a variant would fire on something
 * routine, and a check people learn to override stops catching the removals
 * too — which is the whole point of it. But a silence whose reason is not
 * recorded reads, to the next person, as "response enums are free". That is
 * exactly how the one-directional comparison this replaced came to look
 * deliberate.
 *
 * The same line means a response-only enum may also *lose* a variant, which
 * reads as asymmetric and is intended: a value a reader will never receive
 * again cannot hurt it, and anything a client sends back travels in a request,
 * where values are compared.
 */
const responseKept = (was, now) => within(now.types, was.types);
const requestKept = (was, now) => within(was.types, now.types) && within(was.values, now.values);

/** Every operation in a document, as `METHOD /path` → the operation object. */
function operations(doc) {
  const out = new Map();
  for (const [path, item] of Object.entries(doc.paths ?? {})) {
    for (const [method, operation] of Object.entries(item)) {
      if (["parameters", "summary", "description", "servers"].includes(method)) continue;
      // The path item travels with the operation so its shared `parameters`
      // are not lost on the way.
      out.set(`${method.toUpperCase()} ${path}`, { operation, item });
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

/**
 * An operation's query and path parameters, as `in:name` → the parameter.
 *
 * These were not looked at at all, which is different from the "a change this
 * does not model passes" above: *one of the four promises lives here too.* An
 * optional query parameter made required breaks every existing caller exactly
 * as a request body field does, and there are 43 optional parameters across
 * 137 operations to do it to. A narrowed parameter type and a deleted
 * parameter were equally silent.
 *
 * `parameters` may also sit on the path item, shared by every method under it.
 * This contract has none there today and no `$ref` parameters either, but both
 * are legal, so the path item's are merged in and a `$ref` is left alone rather
 * than guessed at.
 */
function parameters(pathItem, operation) {
  const out = new Map();
  for (const p of [...(pathItem.parameters ?? []), ...(operation.parameters ?? [])]) {
    if (!p || p.$ref) continue;
    out.set(`${p.in}:${p.name}`, p);
  }
  return out;
}

/** Everything `now` no longer promises that `was` did. */
export function breaches(was, now) {
  const found = [];
  const before = operations(was);
  const after = operations(now);

  for (const [name, { operation, item }] of before) {
    const now_ = after.get(name);
    if (!now_) {
      found.push(breach(name, "the path is gone. A client calling it gets a 404 with nothing to catch."));
      continue;
    }
    const still = now_.operation;

    // Query and path parameters, on exactly the same footing as request body
    // fields and for the same reason: they are the request. The direction is
    // the request direction throughout — a parameter may come to accept more
    // and nothing breaks; what breaks a caller is accepting less.
    const hadParams = parameters(item, operation);
    const hasParams = parameters(now_.item, still);
    for (const [key, had] of hadParams) {
      const has = hasParams.get(key);
      if (!has) {
        found.push(breach(`${name} ?${had.name}`, `the ${had.in} parameter is gone. A caller still sending it is now ignored.`));
        continue;
      }
      if (has.required && !had.required) {
        found.push(breach(`${name} ?${had.name}`, `the ${had.in} parameter was optional and is now required. Every existing call omitting it fails.`));
      }
      if (!requestKept(typeOf(resolve(was, had.schema)), typeOf(resolve(now, has.schema)))) {
        found.push(
          breach(`${name} ?${had.name}`, `the ${had.in} parameter was ${typeOf(resolve(was, had.schema)).label} and is now ${typeOf(resolve(now, has.schema)).label}, which no longer accepts everything it used to.`),
        );
      }
    }
    for (const [key, has] of hasParams) {
      if (has.required && !hadParams.has(key)) {
        found.push(breach(`${name} ?${has.name}`, `a new required ${has.in} parameter. Every existing call fails.`));
      }
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
        if (!responseKept(had.type, has.type)) {
          found.push(
            breach(`${name} → ${field}`, `the response field was ${had.type.label} and is now ${has.type.label}, which a reader of the old one may not expect.`),
          );
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
        if (has && !requestKept(had.type, has.type)) {
          found.push(
            breach(`${name} ← ${field}`, `the request field was ${had.type.label} and is now ${has.type.label}, which no longer accepts everything it used to.`),
          );
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
