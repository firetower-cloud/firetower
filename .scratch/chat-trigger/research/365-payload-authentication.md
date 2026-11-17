# What each chat platform signs, and what a relay could not forge

Research for #365, under the map #362. Whether a relay carrying chat events
**inward** to a private control plane can be untrusted, and what exactly the
control plane can verify about a payload that reached it second-hand.

Every claim below has a primary-source URL. Where a thing could not be
established from a primary source it says **not established** rather than
guessing. The hypothesis under test — *these platforms sign what they send
with a secret the control plane itself can hold, so a relay forwarding opaque
signed bytes can neither forge nor tamper* — **holds for two of five delivery
paths and fails for the other three**, including the one each of Discord and
Teams would actually use for an `@mention`.

`api.slack.com/...` 302s to `docs.slack.dev/...` and
`discord.com/developers/docs/...` 301s to `docs.discord.com/developers/...`.
The citations are the post-redirect URLs; they are the same primary sources
the ticket names.

---

## 1. The verdict

Per **delivery path**, not per platform — because on both Discord and Teams the
answer changes with the path, and that is the finding.

| Platform | Path | Per-message signature | Relay can be |
|---|---|---|---|
| **Slack** | Events API over HTTP | HMAC-SHA256 over `v0:{ts}:{raw body}` | **Untrusted** for forgery and tampering. Partially trusted overall: it reads every prompt and can withhold or delay undetectably. |
| **Slack** | Socket Mode | **None** — "no need to verify or validate inbound events" | **Must be trusted.** But Socket Mode is outbound, so it needs no relay at all. |
| **Discord** | Gateway (a real `@mention`) | **None** — the *connection* is authenticated, once, by `Identify` | **Must be trusted.** A relay in front of a gateway connection cannot be verified end to end, at all. |
| **Discord** | HTTP interactions (`/firetower …`) | Ed25519 over `{X-Signature-Timestamp}{raw body}` | **Untrusted** for forgery and tampering, and the verifying key is *public*, so the relay can be made to pre-verify without gaining the power to forge. Partially trusted overall. |
| **Teams** | Bot Framework bot | **None over the body.** A JWT bearer binds the caller | **Must be trusted.** A relay can rewrite the text, the author and the conversation and keep a valid token. |
| **Teams** | Outgoing webhook | HMAC-SHA256 over the UTF-8 body | **Untrusted** for forgery and tampering — but the path cannot post back later, so it cannot carry this map's destination. |

So: **Slack can take an untrusted relay. Discord and Teams cannot**, for the
gesture the destination describes. Discord's `@mention` arrives over a
transport with no per-message authentication whatsoever, and Teams' bot
transport authenticates the caller rather than the message. Neither failure is
fixable by the receiver being careful.

The direction of travel is what breaks the push relay's trick. `docs/mobile.md`
can blind its relay because **the control plane is the encryptor**. Inbound,
the encryptor is Slack, Discord or Microsoft, and none of the three documents
any facility for encrypting an event payload to a key the app holds (§5).
The relay terminates the platform's TLS, so it reads the plaintext. There is
no arrangement in which an inbound relay sees ciphertext.

## 2. The three sentences

What an opt-in setting would have to show somebody. One per platform, in the
register of `docs/mobile.md`'s *a delivery token and an encrypted blob, to
push.usefiretower.com*. The relay's host name is not decided by this ticket;
it would follow `push.usefiretower.com`'s convention.

**Slack.** *Everything you type after `@Firetower` in a Slack channel — the
words, the channel, your Slack account and the time — passes through
Firetower's chat relay, which can read it, on its way to this machine; the
relay cannot alter it or invent a message, because this machine checks Slack's
own signature over the exact bytes Slack signed, but it can delay what you
send or drop it silently, and replies go from this machine straight to Slack
without it.*

**Discord.** *A Discord mention cannot be verified second-hand: Discord does
not sign what it sends over a gateway connection, so a relay carrying mentions
could read your prompt **and** invent prompts this machine could not tell from
yours — Discord mentions therefore arrive only over a connection this machine
opens itself, and a relay is possible only for a `/firetower` command, whose
text Discord signs and whose every word the relay would still read.*

**Teams.** *Microsoft signs the caller, not the message: a Teams request
proves only that something holding a Microsoft-issued token for this app made
the call, so a relay carrying Teams mentions could rewrite your words, your
name and the channel they came from, and this machine could not tell — a Teams
relay has to be trusted completely, and it reads every prompt.*

All three say the relay can read the prompt, because on every inbound path it
can.

---

## 3. The evidence, per platform

### Slack — the hypothesis holds, over HTTP

**What is signed, and with what.** Concatenate `v0:` + the
`X-Slack-Request-Timestamp` header + `:` + the raw request body; HMAC-SHA256
it with the app's signing secret; compare the hex digest against
`X-Slack-Signature`. The docs give the basestring as
`v0:1531420618:token=xyzz...` and say to "Hash the resulting string, using the
signing secret as a key, and taking the hex digest of the hash."
[verifying-requests-from-slack](https://docs.slack.dev/authentication/verifying-requests-from-slack)

The secret is the app's signing secret, which every install of a Slack app
holds. The control plane can hold it; the relay must not — see the asymmetry
note below.

**Does it cover everything that matters?** Yes. The signature covers the whole
body, and the `app_mention` body carries the workspace, the channel, the
author, the text and two timestamps:

```json
{
    "token": "XXYYZZ", "team_id": "T123ABC456", "api_app_id": "A123ABC456",
    "event": {
        "type": "app_mention", "user": "U061F7AUR",
        "text": "<@U0LAN0Z89> is it everything a river should be?",
        "ts": "1515449522.000016", "channel": "C123ABC456",
        "event_ts": "1515449522000016"
    },
    "type": "event_callback", "event_id": "Ev123ABC456", "event_time": 123456789
}
```

[app_mention](https://docs.slack.dev/reference/events/app_mention/) (scope
`app_mentions.read`), wrapper fields at
[the Events API](https://docs.slack.dev/apis/events-api/). `team_id` is in the
signed bytes, so routing on which workspace it came from is safe. The author
is `event.user`, not the `<@…>` markup in the text — read the field, never the
text.

**Replay.** Slack's own guidance is to "verify that the timestamp does not
differ from local time by more than five minutes"
([same page](https://docs.slack.dev/authentication/verifying-requests-from-slack)).
The timestamp is in the basestring, so a relay cannot move it. The delivery id
is `event_id`, "A unique identifier for this specific event, globally unique
across all workspaces" — and deduplication is unambiguously the receiver's
job, because Slack retries: "Your app should respond to the event request with
an HTTP 2xx *within three seconds*", and "After a failure, we'll retry three
times, backing off exponentially" — "nearly immediately", "after 1 minute",
"after 5 minutes" — each carrying `x-slack-retry-num` of `1`, `2` or `3` and
an `x-slack-retry-reason`
([the Events API](https://docs.slack.dev/apis/events-api/)). A three-second
budget across a relay to a machine that may be asleep makes duplicates a
certainty, not an edge case.

**The asymmetry that decides where the secret lives.** HMAC is symmetric:
whatever can verify a Slack signature can also mint one. So the signing secret
must live only in the control plane's vault — `Key::shared(…)` shape, per
`crates/ft-server/src/vault.rs:67`, a secret belonging to the install rather
than to anybody in it — and must never be given to the relay for
"pre-validation". A relay that holds the signing secret is a fully trusted
relay wearing a signature as a disguise.

**The path that needs no relay.** Socket Mode is the control plane dialling
out, which is a posture it already has (`fleet.rs`, `notify.rs`). The app-level
token (`xapp-…`) opens a WebSocket via `apps.connections.open`. But the
payloads are **not signed**: "While acknowledging each event is required,
there's no need to verify or validate inbound events, because you're receiving
the events over a pre-authenticated WebSocket… Note that this is a different
pattern from receiving events directly over HTTP, where validation is required
for each event."
[using-socket-mode](https://docs.slack.dev/apis/events-api/using-socket-mode/)
Two consequences. Socket Mode removes the relay question for Slack entirely,
because nothing is in the middle. And a relay *in front of* Socket Mode would
have to be trusted absolutely, so the two options do not compose: take the
relay with the signed HTTP path, or take Socket Mode without a relay. One
distribution fact belongs to another ticket but is load-bearing for a built-in
integration: "Apps using Socket Mode are *not* currently allowed in the public
Slack Marketplace" (same page).

**For completeness on the HTTP path.** The Request URL is proven once with a
`url_verification` challenge that must be echoed back with HTTP 200, Slack
verifies the TLS certificate, and "When responding to real events, always use
the more secure signing secret process to verify Slack requests' authenticity"
([using-http-request-urls](https://docs.slack.dev/apis/events-api/using-http-request-urls/)).
A relay answers the challenge, so the relay's certificate and name are what
Slack knows — the control plane's name never appears, which is the point.

### Discord — the hypothesis fails for mentions, and this is the decisive fact

**The signature is real, and it covers HTTP interactions only.** "Each
interaction is sent with the following headers: `X-Signature-Ed25519` as a
signature" and "`X-Signature-Timestamp` as a timestamp"; the verification is
Ed25519 over the concatenation, `verify(f'{timestamp}{body}'.encode(),
bytes.fromhex(signature))`, against the application public key from the
Developer Portal; "If the signature fails validation, your app should respond
with a `401` error code."
[interactions/overview](https://docs.discord.com/developers/interactions/overview)

**And then the sentence that decides the whole relay question for Discord, on
the same page:** "By default your app will receive interactions via a Gateway
connection, but you can opt-in to HTTP-based interactions by adding a
**Interactions Endpoint URL**." The Ed25519 scheme is the HTTP endpoint's
scheme. It is not a property of Discord events in general.

**The gateway authenticates a connection, once.** The handshake is "App sends
an Identify (opcode `2`) event to perform the initial handshake with the
Gateway", carrying `"token"`, over `wss://gateway.discord.gg/?v=10&encoding=json`.
There is no signature header, no per-event MAC and no per-event credential
anywhere in the gateway protocol: authenticity of a gateway event rests
entirely on the TLS session and the bot token that opened it.
[events/gateway](https://docs.discord.com/developers/events/gateway)

The consequence is categorical. **A relay in front of a gateway connection is
the gateway client.** It holds the bot token, it terminates the TLS, and
everything it forwards onward is bytes of its own making. Nothing in a gateway
event can be checked second-hand — not the author, not the channel, not the
text, not the time. A relay carrying Discord mentions could invent
`@Firetower rm -rf and force-push` attributed to the install's owner and the
control plane would have no mechanism, even in principle, to notice. Per-
connection authentication is not a weaker version of per-message signing; for
a second-hand receiver it is no authentication at all.

**And `@mention` text only exists on the gateway.** The HTTP-deliverable event
set is closed and does not contain a guild message event. Discord's webhook
events are "one-way events sent to your app over HTTP", carry the same
`X-Signature-Ed25519` / `X-Signature-Timestamp` pair and "must" be validated —
but the available types are `APPLICATION_AUTHORIZED`,
`APPLICATION_DEAUTHORIZED`, `ENTITLEMENT_CREATE`, `ENTITLEMENT_UPDATE`,
`ENTITLEMENT_DELETE`, `QUEST_USER_ENROLLMENT`, `LOBBY_MESSAGE_CREATE`,
`LOBBY_MESSAGE_UPDATE`, `LOBBY_MESSAGE_DELETE`, `GAME_DIRECT_MESSAGE_CREATE`,
`GAME_DIRECT_MESSAGE_UPDATE` and `GAME_DIRECT_MESSAGE_DELETE`. No guild
channel message, and the page is explicit that the two mechanisms are
alternatives: "If your app is using Gateway events, you don't need to
configure a Webhook Events URL." It also warns that webhook events "are not
realtime or guaranteed to be in order."
[events/webhook-events](https://docs.discord.com/developers/events/webhook-events)

**So the only signed way to say something to a Discord app is an interaction.**
A slash command, a message context-menu command, or a component. The signed
body carries `id`, `application_id`, `type`, `data`, `guild_id`, `channel_id`,
`member`, `user`, `token`, `version` and `app_permissions`; "Interaction
`tokens` are valid for **15 minutes**" and you "**must send an initial
response within 3 seconds** of receiving the event"
([receiving-and-responding](https://docs.discord.com/developers/interactions/receiving-and-responding)).
Channel, guild and author are signed fields. The *text* is signed only in the
shape the command defines — a string option's value, or a `custom_id` — not as
free-form channel prose. Time is the signed `X-Signature-Timestamp` header;
the interaction object itself carries no timestamp field.

**One Ed25519 property worth keeping.** The verifying key is the application's
**public** key, so verification and forgery are different capabilities here,
unlike Slack. A Discord relay can be required to verify every request before
forwarding it — useful, because Discord polices the endpoint it knows about:
it runs "automated, routine security checks against your endpoint, including
purposefully sending you invalid signatures. If you fail the validation, we
will remove your interactions URL and alert you via email and System DM"
([interactions/overview](https://docs.discord.com/developers/interactions/overview)).
Those checks hit the relay. The relay must reject them correctly, and the
control plane must still re-verify independently, because the relay's verdict
is not evidence.

**Replay on the interaction path.** Discord documents no timestamp tolerance —
**not established**. The timestamp is signed, so the receiver can impose its
own window, and should. The delivery id is the interaction `id`; the docs do
not state that it is globally unique (**not established**, though it is a
snowflake). The 3-second response deadline and 15-minute token mean a replayed
interaction can no longer be *answered* — but it can still *start an agent*,
which is the harm that matters here.

**The honest shape for Discord.** The control plane opens its own gateway
connection — outbound, long-lived, exactly `fleet.rs`'s posture — and no relay
exists to distrust. `MESSAGE_CONTENT` is a privileged intent, but it is not
needed for this gesture: apps without it still receive "Content in which the
app is mentioned", alongside content in their own messages, content in DMs
with the app, and the content of a message a context-menu command is used on
([message content intent](https://docs.discord.com/developers/events/gateway#message-content-intent)).
So an `@Firetower …` mention arrives with its text, without the privileged
intent, over a connection nothing sits in the middle of.

### Teams — the JWT survives being proxied, and that is exactly the problem

**What is sent.** Delivery is an inbound POST, and only one: "When someone
sends a message, Microsoft Teams posts it to your agent. Teams sends a JSON
object to your agent's messaging endpoint, and it allows only one endpoint for
messaging."
[build-conversational-capability](https://learn.microsoft.com/en-us/microsoftteams/platform/bots/build-conversational-capability)
The body is an Activity: `id`, `timestamp`, `localTimestamp`, `serviceUrl`,
`channelId: "msteams"`, `from.id` / `from.aadObjectId`, `conversation.id`,
`recipient`, `text`, `entities` (the mention entities), and
`channelData.tenant.id` (same page's sample payload).

**What authenticates it.** "When the Bot Connector service sends a request to
your bot, it specifies a signed JWT token in the `Authorization` header." The
bot fetches `https://login.botframework.com/v1/.well-known/openidconfiguration`,
then the keys at `.../v1/.well-known/keys` (refresh "at least once every 24
hours"), and must check: Bearer scheme; valid JWT; `iss` equal to
`https://api.botframework.com`; `aud` equal to the bot's Microsoft App ID;
within validity, "Industry-standard clock-skew is 5 minutes"; a valid RS256
signature against a key from that document; and — the one body-touching
requirement — that "The token contains a 'serviceUrl' claim with value that
matches the `serviceUrl` property at the root of the Activity object of the
incoming request."
[bot-framework-rest-connector-authentication](https://learn.microsoft.com/en-us/azure/bot-service/rest-api/bot-framework-rest-connector-authentication)

**Does it survive being proxied? Yes — and it proves nothing about the
payload.** All seven checks are properties of the token, not of the bytes it
travelled with. A relay forwarding the `Authorization` header verbatim hands
the control plane a token that passes every one of them while the body beside
it is whatever the relay wants, as long as `serviceUrl` is left alone. The
author (`from.aadObjectId`), the conversation, the tenant, the timestamp and
the text are all unbound. A Teams relay can therefore forge a prompt from any
person in the tenant and the control plane cannot distinguish it from a real
one. **The hypothesis is refuted for Teams bots.** Microsoft says the same
thing about the token in the other direction — "Anyone that possesses the
token may use it to perform operations on behalf of your bot" (same page) —
which is the definition of a bearer credential and the reason it cannot stand
in for a body signature.

The window is not narrow. The doc's own example token has `nbf` 1481049243 and
`exp` 1481053143 — an hour — plus five minutes of permitted skew. A relay
needs one real delivery to hold a forging licence for that long.

Teams also warns, for a different reason, that the message text is not
evidence of anything: "don't rely on the text in the message to retrieve any
information about the user. It's possible for the person sending the message to
alter it. Therefore, use the `entities` object"
([channel-and-group-conversations](https://learn.microsoft.com/en-us/microsoftteams/platform/bots/how-to/conversations/channel-and-group-conversations)).
When the text becomes an agent's prompt, that warning applies twice over —
once to the sender, once to anything in the middle.

**Teams does have one body-signed path, and it is triggered by an `@mention`.**
An outgoing webhook "acts as a bot and searches for messages in channels using
**@mention**", and it is authenticated with a real body MAC: "To ensure that
your service is receiving calls only from actual Teams clients, Teams provides
an HMAC code in the HTTP `hmac` authorization header… Microsoft Teams uses
standard SHA256 HMAC cryptography. You must convert the body to a byte array
in UTF8", keyed on "the byte array of the security token provided by Teams
when you registered the Outgoing Webhook", base64-compared — `Authorization:
HMAC 03TCao0i55H1eVKUusZOTZRjtvYTs+mO41mPL+R1e1U=`. The secret is per install
and durable: "The HMAC security token doesn't expire and is unique for each
configuration."
[add-outgoing-webhook](https://learn.microsoft.com/en-us/microsoftteams/platform/webhooks-and-connectors/how-to/add-outgoing-webhook)

So a relay in front of an outgoing webhook **could** be untrusted for forgery.
The path cannot carry this map's destination, though, and the same page says
why:

- Team-scoped and public-channel only — "Webhooks are scoped at the team
  level", "The users can only message an Outgoing Webhook in public channels
  and not within the personal or private scope", and the setup is manual "for
  each" team.
- No other API access — "They can't access any other APIs, such as retrieve
  the roster or list of channels in a team."
- Synchronous, and short: "Teams issues a synchronous HTTP request to your
  service and your code gets five seconds to respond to the message before the
  connection times out and terminates."

Five seconds and no proactive messaging means the reply must *be* the response
to the POST. An agent that starts work and answers when it is done cannot use
this path to answer, which is half the destination ("the answer comes back
where it was asked"). Also note the basestring is the body alone, with no
timestamp — the signature itself bounds replay not at all. Freshness is
available only from `timestamp` *inside* the signed body, and no tolerance is
documented: **not established**, the receiver's to choose.

**Dedup and retries for Teams.** The delivery id is the Activity's `id`, "ID
that uniquely identifies the activity on the channel"; `timestamp` is "Date
and time that the message was sent in the UTC time zone, expressed in ISO-8601
format"
([connector API reference](https://learn.microsoft.com/en-us/azure/bot-service/rest-api/bot-framework-rest-connector-api-reference)).
Note "on the channel" — not globally — so a dedup key should be
`(tenant, conversation, activity id)`. Whether the Bot Connector retries a
failed delivery, and with what schedule: **not established**. On the bot path
`id` is unsigned anyway, so for a relay that can forge, dedup is not a
defence.

---

## 4. The signature coverage table

What is inside the authenticated bytes on each path. "the prompt" is the text
an agent would be launched with.

| | Workspace / tenant | Channel | Author | The prompt | Time |
|---|---|---|---|---|---|
| Slack, Events API | `team_id` ✓ | `event.channel` ✓ | `event.user` ✓ | `event.text` ✓ | `event.ts`, `event_time`, and the signed request timestamp ✓ |
| Slack, Socket Mode | — | — | — | — | — (nothing is signed) |
| Discord, gateway | — | — | — | — | — (nothing is signed) |
| Discord, interactions | `guild_id` ✓ | `channel_id` ✓ | `member.user` ✓ | only as the command's option values / `custom_id` ◐ | signed `X-Signature-Timestamp` ✓ |
| Teams, bot | ✗ | ✗ | ✗ | ✗ | ✗ (only `serviceUrl`, via the token's claim) |
| Teams, outgoing webhook | `channelData.tenant.id` ◐ | `conversation.id` ✓ | `from.id` / `from.aadObjectId` ✓ | `text` ✓ | `timestamp` ✓ |

◐ Discord: free-form channel prose is never signed; a signed prompt has to be
typed into a command's argument. ◐ Teams: the body is "a standard Azure bot
service messaging schema" Activity, so these are the Activity's fields — which
of them Teams populates for an *outgoing webhook* specifically is **not
established**.

## 5. What a relay learns anyway

On every inbound path that needs a relay, the relay terminates the platform's
TLS. It therefore sees, in the clear: the prompt, the workspace or tenant id,
the channel id, the author id, the time, and the cadence — which is every
field the message has. It also sees which installs are busy, when, and how
often.

**Can it be avoided? No.** Blinding requires the sender to encrypt to a key
the receiver holds, and inbound the sender is Slack, Discord or Microsoft.
None of the three documents any facility for encrypting an event payload to an
app-supplied key; no such feature was found on any of the primary sources
above (**not established** — stated as a gap rather than as an absence
proof). The push relay's *"the relay sees a token and a blob"* is available
precisely because the control plane is the encryptor there; reverse the
direction and the property is gone.

There is exactly one arrangement where a third party sees ciphertext, and it
is not a relay: a dumb TCP tunnel in front of an **outbound** connection the
control plane itself terminates TLS on — Slack Socket Mode, the Discord
gateway. Then the middle learns nothing and can forge nothing, because it is
not a party to the TLS session. But an outbound connection needs no relay in
the first place, which is the real finding: the way to keep the prompt private
is to not need a relay.

So **"the relay can read your prompt" is an unavoidable term of taking one**,
on all three platforms, and the opt-in setting must say so. This is a strictly
weaker promise than the one `docs/mobile.md` makes, and the claim it preserves
has to be written down differently: the control plane still never exposes
itself and the worker still never dials out, but *the relay learns the prompt*.

## 6. What a relay can still do

Signatures bound forgery. They bound nothing else.

| | Possible? | What it means for a trigger that starts an agent | What the receiver can do |
|---|---|---|---|
| **Withhold** | Yes, undetectably | A mention silently never runs. The person in the channel sees no answer and assumes Firetower is broken, or worse, assumes the work is happening. | Nothing, from the payload alone: no signed path gives a gap-detectable sequence — Slack's `event_id` is not sequential, and Discord says webhook events are not ordered. Detectable only by the control plane asking the platform directly, which is an outbound call it can already make. |
| **Delay** | Yes | An agent starts minutes or hours after the sentence that asked for it, when nobody is watching and the branch has moved. A delay also eats the platform's ack budget — three seconds on Slack and Discord, five on a Teams outgoing webhook — so a relay must ack *on the platform's behalf*, which makes it the queue, not a pipe. | Reject a payload whose signed timestamp is older than a chosen window. Slack hands you five minutes; Discord and Teams document no window, so the receiver picks one. |
| **Reorder** | Yes | Two mentions in one thread arrive backwards; the second instruction runs first. Low stakes for independent launches, high stakes for a correction ("ignore that, I meant main"). | Order on the signed timestamp, not on arrival. |
| **Replay** | Yes, within the window | The same prompt starts a second agent — spending the same subscription, holding the same git token, pushing a second branch. This is the one a relay can do with *valid, unforgeable* bytes, and so the one that matters most. | Deduplicate on the delivery id, which is what `migrations/server/20261111120000_schedules.sql:8` already anticipates: *"a delivery id to deduplicate on"*. Slack `event_id`; Discord interaction `id`; Teams `(tenant, conversation, activity id)`. Dedup must be durable, not in-memory, and it must be the receiver's job — Slack's three documented retries guarantee duplicates on the honest path, before any relay is involved. |

Replay plus withhold is the composite worth naming: a relay that drops the
real delivery and replays it at a moment of its choosing controls *when* an
agent runs without ever forging anything. The timestamp window is the only
instrument against that, which is why a platform that signs no timestamp
(Teams' outgoing webhook) is weaker than it first appears.

## 7. Gaps — not established

Each of these would change a detail, not the verdict.

- **Whether Slack re-signs a retry with a fresh timestamp**, or resends the
  original timestamp and signature. It matters: the third retry is sent "after
  5 minutes", which is exactly the tolerance Slack recommends, so a strict
  five-minute check against an original timestamp would reject it. The docs
  describe the retry schedule and the headers but not the signing of retries.
- **Whether Discord states anywhere that an interaction `id` is globally
  unique.** It is a snowflake and behaves that way; the receiving docs do not
  say it.
- **Any documented Discord or Teams timestamp tolerance.** Neither publishes
  one. Slack's five minutes is the only number any of the three gives.
- **Whether the Bot Connector retries a failed delivery to a bot**, and with
  what schedule and what headers. Nothing found.
- **Which Activity fields Teams populates for an outgoing webhook**
  specifically, beyond "a standard Azure bot service messaging schema".
- **Whether any of the three can encrypt an event payload to an app-held
  key.** No such facility found; recorded as a gap, not as proof of absence.
- **Whether any outbound transport exists for receiving Teams channel
  activities** — the analogue of Socket Mode or the gateway. Bot Framework
  streaming extensions and the Direct Line App Service extension are
  Azure-co-location features for a bot hosted in App Service, not a dial-out
  an arbitrary self-hosted machine can use, and nothing primary was found that
  says otherwise. This belongs to the transport ticket, but it is the reason
  Teams is the platform where the relay question is unavoidable and the
  platform where the relay cannot be made safe.

---

## 8. What this rules in and out

Not decisions — the decisions are #371's. What the evidence forces.

- **Slack is in, with an untrusted relay, if a relay is taken.** The signature
  covers everything that matters, the secret can live in the vault and never
  on the relay, and the residual exposure is confidentiality and availability,
  stated plainly in the setting. Slack is also the platform that needs no
  relay at all, at the price of the Marketplace.
- **Discord mentions are out for any relay.** Not "risky" — unverifiable. The
  gateway signs nothing, and a relay in front of it is indistinguishable from
  an attacker with a keyboard. Discord via the control plane's own outbound
  gateway connection is sound, and the privileged intent is not needed for a
  mention. A `/firetower …` command over a signed interactions endpoint is the
  only shape in which a Discord relay can be untrusted, and it changes what
  the user types.
- **Teams is out for an untrusted relay, both ways.** The bot path cannot be
  verified second-hand because the JWT binds the caller; the outgoing-webhook
  path can be verified but cannot answer later. A Teams integration that goes
  through a Firetower-operated relay is committing its users to a third party
  that can start agents in their name, with their git token, against their
  repositories. That is the sentence #371 has to weigh, and it should be
  weighed against shipping Teams only for installs that expose their own
  endpoint (shape 2 in `deploy/.env.example`), where there is no relay to
  trust.
