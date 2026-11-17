# Transports that reach a private control plane — Slack, Discord, Teams

Research for [#363](https://github.com/firetower-cloud/firetower/issues/363), under the map
[#362](https://github.com/firetower-cloud/firetower/issues/362). Every claim carries a primary
citation — api.slack.com / docs.slack.dev, discord.com/developers, learn.microsoft.com. Where a
claim is version- or date-sensitive it says so. Where a thing could not be established from a
primary source it says **not established** rather than guessing.

Researched 17 November 2026. **The Teams answer changed this month** and is the single most
perishable fact in this document — see §4.

---

## 1. The answer

All three platforms can reach a control plane that nothing on the internet can reach, over a
long-lived **outbound** connection the process already knows how to hold (`fleet.rs`). Teams is
the one with a caveat, and it is a date, not a wall.

| Platform | Transport | Inbound endpoint? | What opens it → where, with what | Mention | Slash command | Button | Reply needs inbound? | Verdict |
|---|---|---|---|---|---|---|---|---|
| **Slack** | **Socket Mode** | **No** | The app calls `apps.connections.open` → `wss://wss-*.slack.com/link/?ticket=…`, authenticated by an app-level token (`xapp-`, scope `connections:write`) in the `Authorization` header | ✅ `app_mention` | ✅ | ✅ Block Kit actions, modals, menus | No | **Served as-is today.** Cost is a Marketplace listing, which one-app-per-install never wanted |
| Slack | HTTP Request URL | Yes | Slack POSTs to a URL you publish | ✅ | ✅ | ✅ | No | Needs shape 2 plus an opened port. The only route to the Marketplace |
| **Discord** | **Gateway** | **No** | The app opens a WSS connection to the Gateway and sends `Identify` (op 2) with the bot token | ✅ `MESSAGE_CREATE` | ✅ `INTERACTION_CREATE` | ✅ `INTERACTION_CREATE` | No | **Served as-is today.** Outbound by design; interactions ride the same socket unless you opt out |
| Discord | Interactions Endpoint URL | Yes | Discord POSTs, Ed25519-signed | ❌ | ✅ | ✅ | No | Mutually exclusive with gateway interactions. Strictly worse here |
| **Teams** | **ACS socket mode** (public preview) | **No** | The agent POSTs `https://{amer\|emea\|apac}.botapi.skype.com/v3/websockets/connect` with a client-credentials bearer token (scope `https://api.botframework.com/.default`), gets a one-shot `https://<instance>.service.signalr.net/…` URL + token, then opens a **SignalR** connection to it | ✅ message activity | ✅ targeted message activity | ✅ `invoke` / `adaptiveCard/action` | No | **Served, on a preview transport.** New bots only, tenant-gated, Teams Store ineligible |
| Teams | Graph change notifications → **Azure Event Hubs** | **No** | The control plane consumes from an Event Hub in the *customer's* Azure subscription; Graph is the producer | ✅ `chatMessage` (`$filter` on mentions) | ⚠️ as message text only | ❌ | **Yes, in effect** — see §4.3 | Mentions only. A fallback, not a transport |
| Teams | Azure Relay hybrid connection | **No, for the control plane** | A listener in the control plane dials out to `wss://<ns>.servicebus.windows.net/$hc/<path>`; the Bot Connector is an anonymous HTTP *sender* | ✅ | ✅ | ✅ | No | Mechanically consistent with both protocol specs; **no Microsoft doc sanctions it for the Teams channel**. Unverified |
| Teams | HTTPS messaging endpoint | **Yes** | ACS POSTs each activity to the URL in the bot registration | ✅ | ✅ | ✅ | No | The baseline: *"Teams must reach your bot over public HTTPS."* The thing the map exists to avoid [[33]] |
| Teams | Outgoing webhook | **Yes** | Teams POSTs to a per-team callback URL, HMAC-SHA256 signed | ✅ only | ❌ | ❌ `openURL` actions only | No | Mention-triggered and inbound-only. Named here so it is ruled out once |

Two further tables below carry the remaining columns the ticket names: §2 what each transport
forbids or costs, §3 what the platform-side setup costs a person. Then §4–§6 are the per-platform
detail, §7 is how this reframes the relay question, §8 is the gaps.

---

## 2. What each transport forbids or costs

| | Slack Socket Mode | Discord Gateway | Teams ACS socket mode |
|---|---|---|---|
| **Distribution** | *"Apps using Socket Mode are not currently allowed in the public Slack Marketplace."* [[1]] *"If you intend to submit your app to be available for use in the Slack Marketplace, using HTTP is a requirement."* [[2]] Org-wide deployment is still allowed [[1]] | Verification is *"required for apps in 100+ guilds"* [[3]] | *"Distribution via Teams Store: Not supported"*; *"Bots published to the Teams Store must use an HTTPS endpoint."* [[4]][[5]] |
| **Privilege gates** | Socket Mode is *"only available for apps using granular permissions"* [[1]] | `MESSAGE_CONTENT` is privileged. *"Apps with fewer than 10,000 users can access privileged intents by enabling them in the Developer Portal."* Above that, review. Verified apps need the intent *approved*. Identifying with an unapproved privileged intent closes the socket with `4014` [[3]] | Preview, and *"only available for newly created bots and agents"*; a `403` can also mean socket mode *"isn't available for your tenant yet"* [[4]][[5]] |
| **Connection count** | *"up to 10 open WebSocket connections at the same time"*; *"each payload may be sent to any of the connections"* [[1]] | 2500 guilds per shard, above which sharding is mandatory [[3]]. 1000 `IDENTIFY` per 24 h; `max_concurrency` identifies per 5 s [[3]] | **4 open sockets per agent per region**, and you must connect in *every* region (`amer`, `emea`, `apac`) or lose that region's conversations. `429` + `Retry-After` past the limit [[4]][[5]] |
| **One connection, how many workspaces** | Many. An app-level token *"represent[s] your app across organizations, including installations by all individual users on all workspaces"* [[6]]; the envelope carries `team_id` and `authorizations`, and *"only one event is sent regardless of how many workspaces within the organization your app is installed on"* [[7]] | Many — one gateway connection carries every guild the bot is in, up to the shard cap [[3]] | Many, for a multi-tenant app registration (use `botframework.com` as the tenant when getting the token) [[8]] |
| **Reconnect** | URL *"is created at runtime … and it refreshes regularly"*; a warning ~10 s before disconnect and a `refresh_requested` message; *"you'll need to handle connection refreshes once every few hours"* [[1]] | `Resume` *"allows your app to replay any lost events starting from the last sequence number it received"* [[3]] | Token lifetime 60 min, one socket per token; replace ~60 s early with `x-ms-socket-replaces-connection-id`; `SocketClosing` notices carry a `code` and a `reconnect` boolean; backoff 1/2/4/8 then 15 s [[5]][[8]] |
| **Redelivered or lost while disconnected** | **Lost.** *"you may lose events until you establish a connection to your WebSocket URL"* [[1]]. Unacknowledged envelopes carry `retry_attempt` / `retry_reason`, and *"your app has to respond to the request within 3 seconds by `ack()`. Otherwise, the Slack Platform may retry"* [[9]][[10]] — but the Socket Mode retry *schedule* is not documented (the HTTP schedule is: immediately, 1 min, 5 min [[11]]) | **Replayed on Resume**, lost on a fresh `Identify` [[3]] | **Lost, and no fallback.** *"ACS doesn't deliver activities in a region unless your agent has an active WebSocket connection in that region. It doesn't fall back to a previously saved HTTPS endpoint."* And *"No retry on the socket. ACS sends each activity once, to one socket … It doesn't resend it on another socket."* Duplicates are still possible — dedupe on activity `id`; ordering is not guaranteed [[4]] |
| **Rate limits** | `apps.connections.open` is Tier 3, *"50+ per minute"* [[12]]. *"Event deliveries currently max out at 30,000 per workspace/team per app per 60 minutes."* [[11]] `chat.postMessage` *"generally allows posting one message per second per channel, while also maintaining a workspace-wide limit"* [[13]] | 120 gateway events per connection per 60 s, *"apps that surpass the limit are immediately disconnected"*. REST: *"All bots can make up to 50 requests per second"*; invalid requests capped at 10,000 per 10 min per IP [[3]][[14]] | 25 s to reply (`deadlineMs`); 1 MB reply size [[4]] |
| **Reply deadline** | Ack within 3 s over the socket; `response_url` *"can be sent up to 5 times within 30 minutes of receiving the payload"* [[15]] | *"you must send an initial response within 3 seconds"*; interaction tokens *"are valid for 15 minutes"* [[16]] | 25 s, carried per delivery as `deadlineMs` [[4]] |
| **Reliability posture, stated** | *"To have the highest possible reliability for application connectivity, we recommend using HTTP for production applications."* [[2]] | No such caveat — the gateway *is* the production transport | *"We recommend using an HTTPS messaging endpoint for agents in production."* [[4]] |

---

## 3. What the platform-side setup costs a person

A self-hosted install means every customer creates their own app. These are the screens.

**Slack — 8 steps, 6 screens.** `api.slack.com/apps` → **Create New App** (from a manifest, which
collapses scopes, events, the slash command and interactivity into one paste) → **Basic
Information** → *Add a new App-Level Token* with the `connections:write` scope, copy the `xapp-`
token → **Socket Mode** → *Enable Socket Mode* → **OAuth & Permissions** → bot scopes
`app_mentions:read`, `chat:write`, `commands` → **Event Subscriptions** → *Enable Events* →
*Subscribe to bot events* → `app_mention` → **Install to Workspace**, copy the `xoxb-` bot token.
Then `/invite` the app to each channel it should hear. Two secrets leave the browser: the
app-level token and the bot token. [[1]][[17]][[18]][[19]]

**Discord — 5 steps, 2 screens.** Developer Portal → **Create App** → **Bot** page → *Reset Token*,
copy it; privileged intents are toggles on this same page (**not needed for the mention case** —
see §5) → **Installation** page → Installation Contexts, and under *Default Install Settings* add
the `bot` and `applications.commands` scopes plus `Send Messages` → copy the **Install Link**, open
it, *Add to Server*. One secret: the bot token. Slash commands are then registered over the API,
not in a screen. [[20]]

**Teams — the longest by a distance.** A Microsoft Entra app registration (app ID + client secret,
or a managed identity), a bot registration, an app manifest, and a Teams app package that someone
with permission uploads or that an admin approves. Socket mode itself is three clicks once the bot
exists: Teams Developer Portal → **Tools > Bot management** → select the bot → **Configure** →
under **Delivery method** select **Socket mode** → **Save**; *"When Socket Mode is on appears,
start your bot … A public HTTPS endpoint or development tunnel isn't required."* Or one command:
`teams app create --name "My agent" --messaging-mode socket` (Teams CLI **≥ 3.1.0**), or
`teams app update <app-id> --messaging-mode socket`. Three secrets/identifiers: app ID, tenant ID,
client secret. [[5]]

---

## 4. Microsoft Teams — the one expected to force inbound, and no longer does

### 4.1 ACS socket mode — the answer, dated

Microsoft shipped an outbound-only transport for Teams agents. It is in **public preview**; the
docs carry `ms.date: 2026-11-06`, were updated `2026-11-13`, and the Microsoft 365 developer blog
announced it on **17 November 2026** — the day this was researched — as the feature that *"lets
developers run and test an agent in Teams without setting up a public HTTPS messaging endpoint or
development tunnel"* [[34]]. Everything in this section is liable to change before GA.

> **Socket mode** — You turn on socket mode in the agent's bot registration; no endpoint is needed.
> When your agent starts, it opens outbound WebSocket connections to ACS. ACS sends each activity
> over one of those connections, and your agent's response goes back over HTTPS. [[4]]

> **Network** — Outbound connections only, on port 443. No inbound connectivity, no tunnel, no
> public URL. [[4]]

> Socket mode is built on Azure SignalR Service. **Your agent never sees an inbound connection.** [[4]]

**The wire, exactly.** The agent gets a token from
`https://login.microsoftonline.com/<tenant-id>/oauth2/v2.0/token` by client credentials for the
scope `https://api.botframework.com/.default` — *"In socket mode, the same token also authenticates
the connect request."* It then calls:

```http
POST https://{geo}.botapi.skype.com/v3/websockets/connect
Authorization: Bearer <token>
Content-Length: 0
```

`{geo}` is `amer`, `emea` or `apac`. The `200 OK` carries `url`
(`https://<instance>.service.signalr.net/client/?hub=bothub&asrs.op=…`), a single-use
`accessToken`, `expiresIn: 3600` and `protocolVersion: 1`. The agent opens a **SignalR** connection
to that URL, waits for `SocketReady`, then handles an `Activity` client method per delivery and
returns a reply frame on the same call. [[8]]

**This is SignalR, not a bare WebSocket.** *"You can't use a plain WebSocket library unless you
implement the SignalR hub protocol yourself."* The documented clients are `@microsoft/signalr`
(JS) and `Microsoft.AspNetCore.SignalR.Client` ≥ 7.0 (.NET), and the client must support *client
results* — returning a value from a handler. *"There's no Microsoft-supported SignalR client for
Python."* **For Rust there is none either, so Firetower would be implementing the SignalR JSON hub
protocol by hand** — the connect handshake, the invocation/completion frames, the 15 s keep-alive
and 30 s server timeout. That is the real engineering cost of this row, and it is not large but it
is not zero. [[8]]

**It carries all three event kinds.** *"With either delivery method, your agent sends messages and
other requests to ACS the same way … and receives the same activities with the same payloads."*
ACS *"sends your agent activity data in real time, such as messages, card actions, installs,
reactions, and meeting events."* The worked example envelope in the protocol doc is literally
`{"type": "invoke", "name": "adaptiveCard/action", …}` — a button press. [[4]][[8]]

Slash commands are message activities, so they ride the same path: a Teams slash command requires
`"supportsTargetedMessages": true` and `commandLists[].triggers: ["slash"]` in the manifest, and
*"Invoking a command from the menu switches the compose box to targeted messaging mode for the
agent and inserts the name of the command as the message text."* The agent's *"message handler is
responsible for using the contents of the message to determine whether it should be interpreted as
a command invocation"* — Teams does not parse it for you, unlike Slack. [[21]]

**The one thing that is structurally different, and it matters for §7.** There is no per-activity
signature on the socket:

> You don't need to validate activities on the socket: ACS authenticated your agent when it
> connected, and only ACS can send on the socket. [[8]]

Compare the HTTPS endpoint, where every request carries a JWT the bot must verify against
`https://login.botframework.com/v1/.well-known/openidconfiguration` with issuer
`https://api.botframework.com`, audience the bot's app ID, and a `serviceUrl` claim matching the
activity. [[22]][[8]]

**What it costs.** Preview; new bots only; tenant rollout gated (`403 Socket mode is not enabled
for this bot` also means *"isn't available for your tenant yet"*); 4 sockets per agent per region;
must connect in all three regions; 25 s reply deadline; 1 MB reply cap; **no retry and no HTTPS
fallback** when disconnected; no ordering guarantee; and Teams Store distribution is unsupported.
The Teams SDK sample also notes that *"Socket mode starts no HTTP listener or public endpoint, so
tabs, remote functions, OAuth callbacks, and other browser routes are unavailable"* — worth
knowing before chat-account linking is designed. [[4]][[5]]

### 4.2 Why the other outbound candidates are not it

**Bot Framework streaming / Direct Line App Service extension.** Real, and the only network
isolation Azure AI Bot Service documents — *"The only way to do this in the Azure AI Bot Service is
to use the Direct Line App Service extension."* But it is **Direct Line only**, requires a Windows
Azure App Service (*"not currently supported in a Linux App Service"*), and since *"September 1,
2023, it is strongly advised to employ the Azure Service Tag method"* with DL-ASE *"limited to
highly specific scenarios."* It does not serve the Teams channel, and it replaces one hosting
constraint with a worse one. [[23]][[24]]

**Teams outgoing webhook.** Mention-triggered and inbound: *"Callback URL: The HTTPS endpoint that
accepts JSON payloads and receives POST requests from Teams."* Scoped to one team, created per team
through *Manage team > Apps > Create an outgoing webhook*, authenticated by an HMAC-SHA256 over the
body with a per-configuration secret, 5 s to respond, *"can't access any other APIs"*, public
channels only, and *"can't use any card actions except for `openURL`"*. Ruled out. [[25]]

**Long polling.** Not established — no Microsoft document describes a polling transport for the
Teams channel. Direct Line v3 offers HTTP GET polling for *clients*, not for bots, and Direct Line
is not the Teams channel.

### 4.3 Graph change notifications to Azure Event Hubs — a real outbound receive, for mentions only

Worth recording because it is outbound-only and first-party:

> Webhooks aren't suited for receiving change notifications in high throughput scenarios **or when
> the receiver can't expose a publicly available notification URL**. As an alternative, you can use
> Azure Event Hubs. … You don't rely on publicly exposed notification URLs. The Event Hubs SDK
> relays the notifications to your application. [[26]]

The `notificationUrl` becomes
`EventHub:https://<namespace>.servicebus.windows.net/eventhubname/<hub>?tenantId=<domain>` (RBAC)
or the Key Vault secret form; the customer provisions an Event Hubs namespace and either grants the
**Microsoft Graph Change Tracking** principal (`0bf30f3b-4a52-48df-9a82-234910c4a086`) the *Azure
Event Hubs Data Sender* role or stores a connection string in Key Vault. Graph does not validate
the URL for Event Hubs. [[26]]

Subscribing to `/teams/{team-id}/channels/{channel-id}/messages` with
`$filter=mentions/any(u: u/mentioned/user/id eq '<id>')` gives exactly the mentions. Application
permission is `ChannelMessage.Read.Group` (resource-specific consent) or `ChannelMessage.Read.All`.
Latency is *"less than 10 seconds"* average, 1 minute maximum. [[27]][[28]]

What rules it out as *the* transport:

- **No buttons.** Adaptive Card actions are `invoke` activities to a bot. They are not Graph
  resources and no subscription produces them.
- **Slash commands only as text.** A slash command's targeted-ness is a Bot Framework activity
  property; whether it is visible on a Graph `chatMessage` is **not established**.
- **Three-day leash.** `chatMessage` subscriptions max out at 4,320 minutes, and any
  `expirationDateTime` beyond one hour *requires* a `lifecycleNotificationUrl` — which for a
  private control plane means a second Event Hubs destination, not a URL. 1 subscription per app
  per channel; 10,000 Teams subscriptions per organization, shared across every Teams
  subscription kind. [[27]][[28]]
- **1 MB Event Hubs message cap**, needing a blob storage account (`blobStoreUrl`) for anything
  larger. [[26]]
- **It does not solve replying.** `POST /teams/{id}/channels/{id}/messages` lists delegated
  `ChannelMessage.Send` and, for application access, only `Teamwork.Migrate.All` — *"Application
  permissions are only supported for migration."* So Graph alone cannot post a channel reply
  app-only. But the RSC table lists `ChannelMessage.Send.Group` — *"Send messages to this team's
  channels"* — as **App-only**. **Two Microsoft docs disagree and this is not established**; it
  needs a live test before anyone designs on it. The safe reading is that replying needs the Bot
  Connector, which means you need a bot anyway, which means socket mode is the better row.
  [[29]][[28]]
- Metering: a Microsoft Q&A answer states metering was removed from the Teams APIs on 25 August
  2025 and that selecting Model A / Model B is no longer required. **Q&A is not a primary doc** —
  treat the cost of `getAllMessages`-class APIs as unconfirmed.

### 4.4 Azure Relay hybrid connections — mechanically plausible, undocumented for Teams

Two primary specs, read together, describe a route in which **the customer operates the relay in
their own Azure subscription** and the control plane still never listens:

1. The listener dials out. *"To indicate readiness to the service that a listener is ready to accept
   connections, it creates an outbound WebSocket connection."* *"Either or both parties can be
   behind NATs or firewalls."* Hybrid connections relay HTTP requests as well as WebSockets. [[30]]
2. Senders can be anonymous. *"Sender authorization with the Relay endpoint is turned on by default,
   but is OPTIONAL. The owner of the Hybrid Connection can choose to allow anonymous senders."*
   (`az relay hyco create --requires-client-authorization false`.) [[30]][[31]]
3. And — the load-bearing sentence — the Bot Connector's own bearer token survives the hop:
   *"Only if Relay authorization is turned on, and if the request headers contain an `Authorization`
   header, and neither of the prior expressions is present, the header will be evaluated and
   stripped. **Otherwise, the `Authorization` is always passed on as-is.**"* [[30]]

So an anonymous hybrid connection as the bot's messaging endpoint would forward the activity *and*
its Microsoft-issued JWT to a listener that dialled out, and the control plane could do the full
§4.1 JWT validation end to end — exactly the "relay forwards opaque authenticated bytes" property
the map wants. Its documented limits: 64 kB request/response bodies on the control channel (larger
requires a rendezvous socket), 32 kB of headers, a 60 s response deadline, up to 25 concurrent
listeners per hybrid connection, and `502` when no listener is attached. [[30]]

**But no Microsoft document says this works for the Teams channel**, Azure AI Bot Service documents
only DL-ASE for isolation [[23]], and this was not tested. Record it as a researched possibility
with a named failure mode, not as an option on the table. If ACS socket mode leaves preview in good
shape, nobody should build this.

---

## 5. Discord — outbound by design, and cheaper than the ticket assumed

The Gateway is the normal transport: *"Apps open secure WebSocket connections with Discord to
receive events about actions that take place in a server/guild."* The app fetches a WSS URL, opens
it, and sends `Identify` (opcode `2`) carrying the bot token. [[3]]

**`MESSAGE_CONTENT` is not needed for the thing Firetower does.** This corrects the ticket's
assumption. `MESSAGE_CREATE` is gated by the ordinary `GUILD_MESSAGES` intent (`1 << 9`).
`MESSAGE_CONTENT` (`1 << 15`) is *"a unique privileged intent that isn't directly associated with
any Gateway events"*; it governs whether content fields are populated. And:

> Apps **without** the intent will receive empty values in fields that contain user-inputted content
> with a few exceptions: Content in messages that an app sends, Content in DMs with the app,
> **Content in which the app is mentioned**, Content of the message a message context menu command
> is used on. [[3]]

`@Firetower fix the flaky login test` is a message in which the app is mentioned. **Its text
arrives with no privileged intent at all.** The privileged intent only becomes necessary if
Firetower ever wants to read messages it was not mentioned in — thread context, for instance.

**Both thresholds, separated.** The ticket's "believed 100 guilds" conflates two mechanisms:

- *"For verified apps (required for apps in 100+ guilds), the intent must also be approved after the
  verification process to use the intent."* [[3]]
- *"Apps with fewer than 10,000 users can access privileged intents by enabling them in the
  Developer Portal. When an app has more than 10,000 unique users who can see your app across all
  the servers it's in, it requires review for continued access to Privileged Intents."* [[3]]

100+ guilds triggers **verification**; 10,000+ users triggers **privileged-intent review**. A
per-install bot in one guild reaches neither, and in the mention case does not touch privileged
intents regardless. Identifying with an unapproved privileged intent closes the connection with
close code `4014`. [[3]]

**Interactions arrive over the gateway, and that was the open question.** Confirmed:

> Your app can receive interactions in one of two ways: via Interaction Create gateway event or via
> outgoing webhook — and these two methods are mutually exclusive. … To use the webhook approach,
> you must configure an Interactions Endpoint URL for your app. [[16]]

No Interactions Endpoint URL means `INTERACTION_CREATE` on the socket. So **slash commands and
button presses need no inbound endpoint** — which is the stronger half of the Discord answer. The
response is still an outbound call: *"If you are receiving Interactions over the gateway, you have
to respond via HTTP"* — `POST /interactions/<id>/<token>/callback`, *"within 3 seconds"*, with the
token valid *"for 15 minutes"*. [[16]]

**Replying is outbound.** `POST /channels/{id}/messages` with the bot token, or the interaction
callback above. Global REST limit 50 requests/second; per-route buckets keyed by `channel_id` /
`guild_id` / `webhook_id`; invalid requests capped at 10,000 per 10 minutes per IP. [[14]]

**Reconnect is the best of the three.** `Resume` *"allows your app to replay any lost events
starting from the last sequence number it received. After Resuming, your app will receive the missed
events in the same way it would have had the connection had stayed active."* A fresh `Identify`
replays nothing. [[3]]

---

## 6. Slack — Socket Mode carries everything, and gives up only the Marketplace

> Socket Mode allows your app to use the Events API and interactive features — **without** exposing
> a public HTTP **Request URL**. [[1]]

The connection is opened by the app calling `apps.connections.open` with an app-level token in the
`Authorization` header (*"passing it as a POST parameter will result in an error"*), which returns a
temporary `wss://wss-*.slack.com/link/?ticket=…&app_id=…`. The method is Tier 3, *"50+ per
minute"*. The token is an app-level token (`xapp-`) holding the `connections:write` scope, which
*"allows your app to call the `apps.connections.open` method to initiate a WebSocket connection"*.
[[1]][[12]][[32]]

An app-level token is not an installation credential: *"App-level tokens represent your app across
organizations, including installations by all individual users on all workspaces in a given
organization."* [[6]]

**It carries all three.** Socket Mode delivers Events API events, slash commands, Block Kit button
interactions, App Home interactions, modal submissions and dynamic menu suggestions. [[1]] The bare
mention is `app_mention`, needing the `app_mentions:read` scope; note that *"messages sent to your
app in direct message conversations are not dispatched via `app_mention`"* — a DM needs
`message.im`, which is a second subscription if DMs ever matter. [[19]]

**Multi-workspace install survives.** Socket Mode apps can still be distributed — the OAuth flow
and the socket coexist, and the Java SDK guide shows *"a single Java process [managing] both Socket
Mode connections and the web app for OAuth flow"*, noting *"Socket mode is fully supported for
distributed apps."* The envelope's `team_id` says which workspace an event came from, and
`authorizations` *"describes one of the installations that this event is visible to"*. What is
given up is the listing: *"Apps using Socket Mode are not currently allowed in the public Slack
Marketplace."* [[9]][[11]][[1]]

That cost lands precisely nowhere for one-app-per-install, and lands squarely on a single shared
Firetower Slack app. **If Firetower ever ships one shared Slack app instead of an app per install,
Socket Mode is off the table and the reachability problem returns in full.** That is the shape of
the trade, and it is worth writing into the spec rather than discovering later.

**Replying is outbound, with a deadline but no inbound counterpart.** `chat.postMessage` is an
ordinary outbound HTTPS call, limited to roughly *"one message per second per channel"* with short
bursts allowed. `response_url` is also an outbound POST *by the app*, usable *"up to 5 times within
30 minutes of receiving the payload"* — a deadline on the control plane's own call, not a
requirement that anything reach it. The 3-second acknowledgement for interactive payloads is met by
acking the `envelope_id` on the socket. [[13]][[15]][[1]]

---

## 7. What this changes about the relay question

Five things, for the relay ticket to take as input rather than re-derive.

**1. Reachability no longer forces a relay anywhere.** All three platforms have a first-party,
outbound-only transport that carries mentions, slash commands and buttons. The map was written
expecting Teams to be the hard negative; as of this month it is not. The relay evaluation should be
reframed from *"can we reach these platforms at all"* to *"is a relay worth it for reliability,
for Teams' preview status, or for a shared-app distribution model"* — three much narrower
questions.

**2. The signature mitigation the map hoped for does not exist on Teams socket mode.** The map's
note reasons that a chat relay could be survivable because *"these platforms sign what they send
with a secret the control plane itself can hold."* For Slack and Discord that holds. For Teams
socket mode it does not: *"You don't need to validate activities on the socket: ACS authenticated
your agent when it connected."* There is no per-activity signature to verify end to end, so a
relay in front of Teams socket mode would be **fully trusted with injecting prompts**, not blinded.
The good news is that this is moot while socket mode exists — but if anyone proposes relaying
Teams, this is the fact that kills the mitigation.

**3. For Teams, the relay can be customer-operated rather than Firetower-operated.** Both §4.3 and
§4.4 put the relay inside the customer's own Azure subscription: Graph → Event Hubs is documented
and supported; Azure Relay is undocumented for Teams but preserves the Bot Framework JWT end to end
and therefore satisfies the map's "the relay learns nothing / cannot forge" terms better than a
Firetower-operated relay would. "The customer points at a relay they own" is a third option
alongside "Firetower operates one" and "no relay".

**4. Nothing buffers for you, and the three platforms disagree about what that means.** Discord
replays on `Resume`; Slack may simply lose events and documents no Socket Mode retry schedule;
Teams socket mode explicitly does not deliver and does not fall back to a saved HTTPS endpoint.
If a mention that was never delivered is indistinguishable from one nobody sent, the transcript
design has to say what happens — and a relay that *queued* would be buying something real here,
which is a better argument for it than reachability ever was.

**5. Every platform forces the approval decision to be asynchronous.** Slack wants an ack in 3
seconds, Discord an initial interaction response in 3 seconds, Teams a reply in 25. Against the
map's central tension — a mention's prompt is not approved — that means the acknowledgement in the
channel cannot be the approval. The only shapes that fit are acknowledge-then-approve-out-of-band
(the `response_url`'s 30 minutes, Discord's 15-minute token, or a fresh outbound post) or
pre-approve-the-envelope. There is no synchronous-approval design available on any of the three.

---

## 8. Gaps — not established

- **The exact Socket Mode retry schedule.** Slack documents the HTTP Events API schedule
  (immediately, 1 min, 5 min [[11]]) and the SDKs expose `retry_attempt` / `retry_reason` on Socket
  Mode requests [[10]], and a Slack-authored SDK guide says the platform *"may retry"* after a
  missed 3-second ack [[9]], but no api.slack.com / docs.slack.dev page states the schedule for
  Socket Mode. Assume at-least-once with an unknown schedule, dedupe on `envelope_id`.
- **Whether a Teams slash command's targeted-ness is visible in Graph.** It is an activity property
  on the Bot Framework path; nothing says whether a Graph `chatMessage` payload carries it. Only
  matters if §4.3 is ever used.
- **`ChannelMessage.Send.Group`.** The RSC reference lists it as App-only [[28]]; the
  `chatMessage` create reference says application permissions are migration-only [[29]]. Needs a
  live test.
- **Azure Relay in front of the Teams channel (§4.4).** Consistent with both protocol specs; no
  Microsoft document sanctions it; not tested. Specifically unverified: whether Azure Bot Service
  accepts a `servicebus.windows.net` messaging endpoint without additional validation, and whether
  the 64 kB control-channel body limit is ever exceeded by a Teams activity.
- **Teams metering.** The claim that metering was removed from the Teams APIs on 25 August 2025
  comes from a Microsoft Q&A answer, not a primary doc.
- **Teams socket mode behaviour at GA.** Public preview, new bots only, tenant-gated, documented 11
  days before this was written. The region list (`amer`, `emea`, `apac`), the 4-socket cap, the 25 s
  deadline and the Store exclusion are all explicitly subject to change.
- **Slack Socket Mode connection distribution across many installs.** The docs give a 10-connection
  cap per app and say any payload may land on any connection [[1]], and that one event is sent
  regardless of how many workspaces in an org have the app [[11]]. What they do not say is whether
  a single app installed in *many unrelated* workspaces also multiplexes onto those same ≤10
  connections. Irrelevant for one-app-per-install; load-bearing for a shared app.
- **A Rust SignalR client.** None found; the Teams socket-mode protocol requires the SignalR JSON
  hub protocol with client results. Implementation cost, not a blocker, but it belongs in the
  estimate.

---

## Citations

1. Using Socket Mode — https://docs.slack.dev/apis/events-api/using-socket-mode/
2. Comparing HTTP & Socket Mode — https://docs.slack.dev/apis/events-api/comparing-http-socket-mode/
3. Discord Gateway (connection, intents, privileged intents, sharding, limits) — https://docs.discord.com/developers/events/gateway
4. Choose how agents receive activity data from Teams — https://learn.microsoft.com/en-us/microsoftteams/platform/agents-in-teams/agent-connectivity
5. Configure the delivery method for an agent — https://learn.microsoft.com/en-us/microsoftteams/platform/agents-in-teams/configure-delivery-methods-for-agents
6. Token types (app-level tokens) — https://docs.slack.dev/authentication/tokens
7. The Events API (authorizations, `team_id`) — https://docs.slack.dev/apis/events-api/
8. Connect an agent to Teams without an SDK — https://learn.microsoft.com/en-us/microsoftteams/platform/agents-in-teams/connect-agent-without-sdk
9. Socket Mode (Java Slack SDK guide) — https://docs.slack.dev/tools/java-slack-sdk/guides/socket-mode/
10. `slack_sdk.socket_mode.request` — https://docs.slack.dev/tools/python-slack-sdk/reference/socket_mode/request.html
11. The Events API (rate limits, retries) — https://docs.slack.dev/apis/events-api/
12. `apps.connections.open` — https://docs.slack.dev/reference/methods/apps.connections.open
13. Rate limits — https://docs.slack.dev/apis/web-api/rate-limits
14. Discord rate limits — https://docs.discord.com/developers/topics/rate-limits
15. Handling user interaction (`response_url`, 3-second ack) — https://docs.slack.dev/interactivity/handling-user-interaction/
16. Receiving and Responding to Interactions — https://docs.discord.com/developers/interactions/receiving-and-responding
17. Creating an app from app settings — https://docs.slack.dev/app-management/quickstart-app-settings/
18. Installing with OAuth — https://docs.slack.dev/authentication/installing-with-oauth/
19. `app_mention` event — https://docs.slack.dev/reference/events/app_mention/
20. Building your first Discord app — https://docs.discord.com/developers/quick-start/getting-started
21. Expose slash commands from agents and apps — https://learn.microsoft.com/en-us/microsoftteams/platform/agents-in-teams/agent-slash-commands
22. Authenticate requests with the Bot Connector API — https://learn.microsoft.com/en-us/azure/bot-service/rest-api/bot-framework-rest-connector-authentication
23. About network isolation in Azure AI Bot Service — https://learn.microsoft.com/en-us/azure/bot-service/dl-network-isolation-concept
24. Direct Line App Service extension — https://learn.microsoft.com/en-us/azure/bot-service/bot-service-channel-directline-extension
25. Create an outgoing webhook — https://learn.microsoft.com/en-us/microsoftteams/platform/webhooks-and-connectors/how-to/add-outgoing-webhook
26. Receive change notifications through Azure Event Hubs — https://learn.microsoft.com/en-us/graph/change-notifications-delivery-event-hubs
27. Change notifications for messages in Teams channels and chats — https://learn.microsoft.com/en-us/graph/teams-changenotifications-chatmessage
28. Resource-specific consent — https://learn.microsoft.com/en-us/microsoftteams/platform/graph-api/rsc/resource-specific-consent and change notifications overview — https://learn.microsoft.com/en-us/graph/change-notifications-overview
29. Create chatMessage in a channel — https://learn.microsoft.com/en-us/graph/api/chatmessage-post
30. Azure Relay Hybrid Connections protocol guide — https://learn.microsoft.com/en-us/azure/azure-relay/relay-hybrid-connections-protocol
31. `az relay hyco` — https://learn.microsoft.com/en-us/cli/azure/relay/hyco
32. `connections:write` scope — https://docs.slack.dev/reference/scopes/connections.write/
33. Exposing your local app with a tunnel — https://learn.microsoft.com/en-us/microsoftteams/platform/teams-sdk/developer-tools/local-tunnels
34. New capabilities for building digital teammates in Microsoft Teams (17 Nov 2026) — https://devblogs.microsoft.com/microsoft365dev/new-capabilities-for-building-digital-teammates-in-microsoft-teams/

[1]: https://docs.slack.dev/apis/events-api/using-socket-mode/
[2]: https://docs.slack.dev/apis/events-api/comparing-http-socket-mode/
[3]: https://docs.discord.com/developers/events/gateway
[4]: https://learn.microsoft.com/en-us/microsoftteams/platform/agents-in-teams/agent-connectivity
[5]: https://learn.microsoft.com/en-us/microsoftteams/platform/agents-in-teams/configure-delivery-methods-for-agents
[6]: https://docs.slack.dev/authentication/tokens
[7]: https://docs.slack.dev/apis/events-api/
[8]: https://learn.microsoft.com/en-us/microsoftteams/platform/agents-in-teams/connect-agent-without-sdk
[9]: https://docs.slack.dev/tools/java-slack-sdk/guides/socket-mode/
[10]: https://docs.slack.dev/tools/python-slack-sdk/reference/socket_mode/request.html
[11]: https://docs.slack.dev/apis/events-api/
[12]: https://docs.slack.dev/reference/methods/apps.connections.open
[13]: https://docs.slack.dev/apis/web-api/rate-limits
[14]: https://docs.discord.com/developers/topics/rate-limits
[15]: https://docs.slack.dev/interactivity/handling-user-interaction/
[16]: https://docs.discord.com/developers/interactions/receiving-and-responding
[17]: https://docs.slack.dev/app-management/quickstart-app-settings/
[18]: https://docs.slack.dev/authentication/installing-with-oauth/
[19]: https://docs.slack.dev/reference/events/app_mention/
[20]: https://docs.discord.com/developers/quick-start/getting-started
[21]: https://learn.microsoft.com/en-us/microsoftteams/platform/agents-in-teams/agent-slash-commands
[22]: https://learn.microsoft.com/en-us/azure/bot-service/rest-api/bot-framework-rest-connector-authentication
[23]: https://learn.microsoft.com/en-us/azure/bot-service/dl-network-isolation-concept
[24]: https://learn.microsoft.com/en-us/azure/bot-service/bot-service-channel-directline-extension
[25]: https://learn.microsoft.com/en-us/microsoftteams/platform/webhooks-and-connectors/how-to/add-outgoing-webhook
[26]: https://learn.microsoft.com/en-us/graph/change-notifications-delivery-event-hubs
[27]: https://learn.microsoft.com/en-us/graph/teams-changenotifications-chatmessage
[28]: https://learn.microsoft.com/en-us/microsoftteams/platform/graph-api/rsc/resource-specific-consent
[29]: https://learn.microsoft.com/en-us/graph/api/chatmessage-post
[30]: https://learn.microsoft.com/en-us/azure/azure-relay/relay-hybrid-connections-protocol
[31]: https://learn.microsoft.com/en-us/cli/azure/relay/hyco
[32]: https://docs.slack.dev/reference/scopes/connections.write/
