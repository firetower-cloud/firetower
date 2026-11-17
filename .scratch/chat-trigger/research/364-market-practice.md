# What self-hosted products do about a control plane the chat platform cannot reach

Research for [#364](https://github.com/firetower-cloud/firetower/issues/364), under the map at
[#362](https://github.com/firetower-cloud/firetower/issues/362). Blocks
[#371](https://github.com/firetower-cloud/firetower/issues/371), the relay decision.

A survey, not a position. The question was asked in these words — *"We should evaluate adding a
relay or something, I don't know what's the standard practice in the market"* — so the deliverable
is names and what each vendor tells its own self-hosting users, read from that vendor's
documentation. Every row carries a URL. Where a vendor's docs are silent it says **not
established** rather than guessing — §6 collects those, and one of them is a product whose
behaviour everybody assumes they know. Read on 17 November 2026, which matters more than usual
here: one of the central facts is eleven days old, and three of these products' answers are
deprecated or switched off.

**The answer in one paragraph.** A vendor-operated **chat** relay is **unusual**: across the forty
products below, exactly **one** ships one in production — **Atlassian's Jira Data Center for
Microsoft Teams**, which has the self-hosted app *dial out* to an Azure SignalR hub so the
instance never has to be reachable at all. The near misses are Home Assistant's **cloudhooks** (a
general webhook relay, paid, per-webhook opt-in), **Grafana Cloud** relaying push and SMS for
OnCall OSS (not chat, switched off in 2026), **Botpress** (mandatory — and it got there by
deleting self-hosting), and two vendor tunnels, **n8n's `hooks.n8n.cloud`** and **Coder's
`*.try.coder.app`**, which their own docs scope to development and one of which was discontinued
on 2 March 2026. What is *normal* splits cleanly by product generation. The enterprise
dev-tools tier **requires inbound and says so**: GitLab ("the GitLab instance must be allowed to
receive requests from `https://slack.com`"), Sentry, Atlassian's Slack apps for Jira, Confluence
and Bitbucket DC — which also want anonymous access on specific paths — Mattermost's Teams
connector, n8n, Windmill, Activepieces, Rasa, and most pointedly, because it is the same feature
Firetower wants, **OpenHands Enterprise**: *"No Slack Socket Mode. Your OHE install must be
reachable from the public internet."* The newer self-hosted AI tier does the opposite and takes
**the platform's own outbound transport**: **Onyx** ("connects to Slack over Socket Mode, so your
deployment does not need a public URL"), **Langflow**, **Letta**, **Switch**, **Lightdash**,
Teleport's native reviews, and Rocket.Chat's SlackBridge. The rest ship only the outbound half
(Jenkins, Grafana, GitLab for Teams, Gitea/Forgejo, Sourcegraph) or decline the feature outright —
Grafana OnCall's Teams integration is "available exclusively on Grafana Cloud". **Teams is what
forced the relay question, and eleven days before this was written Microsoft shipped a socket
mode for it**: outbound only, "no inbound connectivity, no tunnel, no public URL", built on the
same Azure SignalR service Atlassian hand-rolled its relay on — in public preview, not
Store-distributable, and adopted by nobody in this survey yet. Relays that carry notifications
*outward* are by contrast universal: seven of seven products with a store-published mobile app
run or use one, which is `docs/mobile.md`'s argument exactly. Measured against Firetower's four
terms, **one of those seven meets all four** (Zulip on Server 12.0+); the rest are default-on and
two paywall the privacy-preserving mode. So Firetower's bar is **stricter than the market's**, and
the terms it is missing are the ones the market makes most often: *"you may run the relay
yourself"*, and a statement of what the relay **retains** — because "the relay learns nothing" is
a claim no surveyed vendor makes and every surveyed relay would fail.

---

## 1. Product × approach

The five approaches are the ticket's: **1** require inbound reachability · **2** the platform's
own outbound transport (Socket Mode, the Discord Gateway, long polling) · **3** poll · **4** ship
or recommend a tunnel · **5** operate a vendor relay. "Outbound only" means the feature needs
none of them, because the product only ever dials out.

| Product | Chat feature | Approach | What the vendor tells self-hosters | Source |
|---|---|---|---|---|
| **GitLab Self-Managed** | GitLab for Slack app | **1** | "your network must allow inbound and outbound connections between GitLab and Slack" — "For Slash commands and other features, the GitLab instance must be allowed to **receive** requests from `https://slack.com`". The Slack-directory app is GitLab.com only; self-managed builds its own from a manifest. | https://docs.gitlab.com/administration/settings/slack_app/ |
| **GitLab Self-Managed** | Microsoft Teams | **Outbound only** — there is no inbound Teams feature to ship | You paste a Power Automate "When an HTTP request is received" URL, so **Microsoft hosts the inbound endpoint** and GitLab only POSTs out. | https://docs.gitlab.com/user/project/integrations/microsoft_teams/ |
| **Sentry self-hosted** | Slack, Discord, Teams | **1** (+ **4** for local dev) | Every Request URL is `{YOUR_DOMAIN}/extensions/…`; on Discord: "The verification will fail if you … don't have your server properly exposed to the internet." ngrok is offered only "if you're doing local Sentry development". | https://develop.sentry.dev/integrations/discord/ |
| **Jenkins** | Slack plugin | **Outbound only** | The manifest Jenkins hands you declares no request URLs, no event subscriptions and `socket_mode_enabled: false`. It calls `chat.postMessage`; nothing calls it. | https://plugins.jenkins.io/slack/ |
| **Jenkins** | Inbound webhooks generally | **4** | jenkins.io's own post on firewalls: "Unless your laptop is addressable to the whole web … the webhooks won't be able to flow", and recommends subscribing to **smee.io** with an outgoing connection. | https://www.jenkins.io/blog/2019/01/07/webhook-firewalls/ |
| **Sourcegraph self-hosted** | Code monitoring → Slack | **Outbound only** | An incoming-webhook URL you paste. No reachability language anywhere. | https://sourcegraph.com/docs/code_monitoring/how-tos/slack |
| **Sourcegraph self-hosted 6.12+** | Slack Integration (Deep Search in Slack) | **Not established** | It consumes the Events API (`app_mentions:read`, `channels:history`) through a wizard-generated manifest, and the docs never say whether delivery is HTTP or Socket Mode, nor mention reachability. Not inferred here. | https://sourcegraph.com/docs/slack-integration |
| **Grafana** (self-hosted alerting) | Slack / Teams contact points | **Outbound only** | A webhook URL or a bot token. For Teams: a Power Automate workflow "that accepts Webhook requests" — again Microsoft holds the endpoint. | https://grafana.com/docs/grafana/latest/alerting/configure-notifications/manage-contact-points/integrations/configure-slack/ |
| **Grafana OnCall OSS** (archived 2026) | Slack | **1** + **4** | "Grafana OnCall must be accessible through HTTPS. For development purposes, use localtunnel. For production purposes, consider establishing a proper web server with HTTPS termination." The shipped app manifest sets `socket_mode_enabled: false`. | https://github.com/grafana-cold-storage/oncall/blob/dev/docs/sources/set-up/open-source/index.md |
| **Grafana OnCall OSS** | Telegram | **1** + **4**, with a real **2/3** fallback | Webhook host "must … be publicly available … consider using a reverse proxy (e.g. ngrok)", *or* `FEATURE_TELEGRAM_LONG_POLLING_ENABLED` (default off) — the only first-party outbound-transport fallback for a chat platform in the whole survey. | same |
| **Grafana OnCall OSS** | Microsoft Teams | **Declined** | "This integration is available exclusively on Grafana Cloud." A Grafana-published Marketplace app whose bot endpoint terminates in Grafana Cloud. | https://github.com/grafana-cold-storage/oncall/blob/dev/docs/sources/manage/notify/ms-teams/index.md |
| **Grafana OnCall OSS** | Mobile push, SMS, phone | **5** | "Grafana OnCall OSS relies on Grafana Cloud as on relay for push notifications." Opt-out exists for SMS/phone (bring your own Twilio); not for push. What the relay receives: **not established**. Shut off 24 March 2026. | same |
| **Jira / Confluence Data Center** | Slack (official Atlassian app) | **1** | "Slack requires that the Jira instance is accessible through the internet via a secure connection (HTTPS)", with `<baseUrl>/rest/slack/latest/*` whitelisted and — the part that stings — "Make sure those paths allows 'anonymous' requests". Documented fallback: notification-only, via your own app. | https://confluence.atlassian.com/slack/use-slack-and-jira-data-center-applications-together-966662163.html |
| **Bitbucket Data Center** | Slack | **1** | Same wording, same whitelist, same notifications-only degradation. | https://confluence.atlassian.com/slack/use-slack-and-bitbucket-data-center-together-974387205.html |
| **Jira Data Center** | **Microsoft Teams** | **5** — the only production chat relay found | Atlassian runs the middle on Azure: "Jira Data Center app establishes a connection with Azure SignalR Hub". Nothing on the page asks for the instance to be reachable. The *user's device* needs network access to Jira, for authentication only. | https://confluence.atlassian.com/msteamsjiraserver/configuring-firewall-1563231385.html |
| **Jira / Confluence DC** | Mobile push | **5** | "No user or message content is sent to the service, only notification IDs, and we don't store any data." Off-VPN the device cannot fetch the body, so the notification degrades to "1 new notification". | https://confluence.atlassian.com/jirasoftwareserver/jira-data-center-mobile-app-966063511.html |
| **Mattermost** | Microsoft Teams Sync | **1**, and the docs never admit it | Graph change notifications are POSTed to `SiteURL/plugins/com.mattermost.msteams-sync/changes`; the only hint in the docs is a "Webhook secret … that Microsoft Teams will use to send messages to Mattermost". No polling fallback exists. | https://docs.mattermost.com/integrations-guide/microsoft-teams-sync |
| **Mattermost** | Jira plugin | **1** | "Mattermost receives a stream of events from the Jira server via a configured webhook" — and "Jira only allows webhooks to connect to the standard ports 80 and 443. You need to set up a proxy". | https://docs.mattermost.com/integrations-guide/jira |
| **Mattermost** | Mobile push | **5**, self-hostable | HPNS by default; or run `mattermost-push-proxy` yourself "on-premises behind your firewall … Mattermost clients don't need any inbound connectivity" — at the cost of building your own apps. | https://docs.mattermost.com/deployment-guide/mobile/host-your-own-push-proxy-service |
| **Rocket.Chat** | SlackBridge | **2 — Socket Mode** | The documented app manifest sets `socket_mode_enabled: true` with an app-level token scoped `connections:write`. | https://docs.rocket.chat/docs/slackbridge |
| **Rocket.Chat** | Microsoft Teams Bridge | **1** + **4** | "If it's a localhost URL, exposing the localhost port to the internet requires a tunnel service like Ngrok", and the Graph subscription expires if Rocket.Chat is offline too long. | https://docs.rocket.chat/docs/microsoft-teams-bridge |
| **Rocket.Chat** | Mobile push | **5** | `gateway.rocket.chat`, on by default, content visible unless you buy Premium, 10,000 notifications a month on Community. | https://docs.rocket.chat/docs/push |
| **Zulip** self-hosted | Incoming webhook integrations | **1** | The third party POSTs to a URL on your Zulip server, so a SaaS source must be able to reach it. | https://zulip.readthedocs.io/en/latest/webhooks/incoming-webhooks-overview.html |
| **Zulip** self-hosted | Bots and outgoing webhooks | **Outbound only** | `zulip-run-bot` runs anywhere and dials the API; the Botserver is called *by* the Zulip server, so both can sit inside the private network. | https://zulip.com/api/running-bots |
| **Zulip** self-hosted | Mobile push | **5**, and the only relay meeting Firetower's four terms | Opt-in (`ZULIP_SERVICE_PUSH_NOTIFICATIONS`, default `False`), E2EE on Server 12.0+ so "content and metadata … are not visible to Apple, Google, or Zulip's Mobile Push Notification Service", and registration prints what it would send and makes you accept it. | https://zulip.readthedocs.io/en/stable/production/mobile-push-notifications.html |
| **Matrix / Synapse + Element** | Mobile push | **5**, genuinely self-hostable | `element-hq/sygnal` is published and supported; matrix.org runs one for the store apps, and Element says plainly "We as Element Company retain and use that key on our Push infrastructure", which is why your own gateway means your own app build. The **client** chooses the gateway, not the admin. | https://docs.element.io/latest/element-server-suite-classic/advanced-configuration/notifications-mdm-push-gateway/ |
| **Nextcloud** | Mobile push | **5** | `push-notifications.nextcloud.com`, payload encrypted to the device's public key; "we … reduced the available information to a bare minimum". The server needs only outbound access. No admin-facing setting at all. | https://github.com/nextcloud/notifications/blob/master/docs/push-v2.md |
| **Home Assistant** | Slack, Discord | **Outbound only** | Discord, verbatim: "This integration is for outgoing messages only. It cannot read incoming Discord messages or use them as triggers for automations." | https://www.home-assistant.io/integrations/discord/ |
| **Home Assistant** | Telegram | **3** (polling) or **1** | Polling: "Your Home Assistant instance does not have to be exposed to the internet." Webhooks: the opposite. Both shipped, side by side, as separate integrations. | https://www.home-assistant.io/integrations/telegram_polling/ |
| **Home Assistant** | Inbound webhooks | **5** (cloudhooks) or **1** | "Cloudhooks give webhooks a public URL, so the companion apps work away from home" — `hooks.nabu.casa/<id>`, relayed down the instance's existing outbound connection, and only for webhooks taken out of `local_only` (which defaults to `true`). Official remote-access advice is Cloud, **VPN (Tailscale / ZeroTier)**, reverse proxy, or port forwarding. | https://www.home-assistant.io/triggers/webhook/ · https://contributors.home-assistant.io/architecture/platform/cloud/ |
| **n8n** self-hosted | Slack / Teams triggers | **1**; **4** dev-only | "An n8n instance that Microsoft can reach over HTTPS"; the Slack approvals page is blunter — "Your n8n instance to be reachable from Slack over public HTTPS … an instance running on localhost won't work." No Socket Mode, and no Discord Trigger node at all. | https://docs.n8n.io/build/build-and-manage-agents/microsoft-teams/set-up-the-teams-channel |
| **n8n** self-hosted | The built-in tunnel | **5 → retired** | `hooks.n8n.cloud`, flagged in the source as "Use only for testing and development!", removed in n8n 2.0, and **the hosted service was discontinued on 2 March 2026**; the docs now point at ngrok, localtunnel or Cloudflare Tunnel. | https://blog.n8n.io/n8n-tunnel-service-discontinued/ |
| **Coder** self-hosted | Slack / Teams notifications | **Outbound only** | Coder POSTs to a webhook; for Teams you build a workflow with the "When a Teams webhook request is received" trigger. Agents and clients dial the control plane, so the access URL need not be public. | https://coder.com/docs/admin/monitoring/notifications/teams |
| **Coder** self-hosted | The dev tunnel | **5/4**, PoC only | `*.try.coder.app`, used automatically when no access URL is set: "For proof-of-concept deployments, you can use Coder's tunnel. For production deployments, we recommend setting an access URL." The relay is open source (`coder/wgtunnel`) and repointable with `--wg-tunnel-host`. | https://coder.com/docs/install/docker |
| **Gitpod / Ona** self-hosted | SCM webhooks; no chat integration | **1**, with a self-owned public endpoint | "For prebuilds, inbound connectivity is required as they use webhooks to be triggered." Private-network installs can tick "public services", which stands up a public endpoint **in the customer's own AWS account** — not a vendor relay. | https://ona.com/docs/enterprise/reference/networking-data-flows |
| **GitHub Enterprise Server** | Slack / Teams chat integration | **1** (implied); reachability **not established** | "The GitHub app in the Slack Marketplace cannot be used with GitHub Enterprise Server" — you register a private app against your instance instead. The docs never state a reachability requirement, so this row says so rather than inferring one. | https://docs.github.com/en/enterprise-server@3.21/integrations/how-tos/slack/integrate-github-with-slack |
| **Teleport** self-hosted | Slack access requests (default plugin) | **Outbound only** | Notify out, then bounce the reviewer into Teleport's own UI to authenticate before approving. | https://goteleport.com/docs/identity-governance/access-requests/plugins/slack/ |
| **Teleport** self-hosted | Slack native reviews | **2 — Socket Mode** | "enable Socket Mode. This will allow the Teleport Slack plugin to build a WebSocket connection with the Slack server in order to process Access Request reviews from Slack", with an `xapp-…` token scoped `connections:write`. | https://goteleport.com/docs/identity-governance/access-requests/plugins/slack-review/ |
| **Bitwarden** self-hosted | Mobile push | **5**, default on, repointable | "By default, your self-hosted Bitwarden server is configured to communicate with Bitwarden's push relay service"; `PUSH_RELAY_URI` points elsewhere, and Bitwarden publishes the record it keeps. | https://bitwarden.com/help/configure-push-relay/ |
| **Gitea / Forgejo** | Slack, Discord | **Outbound only** | Outgoing webhooks that transform an internal event into a platform-shaped POST. No inbound chat feature exists. | https://docs.gitea.com/usage/webhooks |
| **Supabase** self-hosted | — | **Not applicable** | No first-party chat integration exists; the Slack entry in the catalog is a partner-maintained Postgres FDW, and the Slack-bot material is sample Edge Function code. | https://supabase.com/partners/catalog/slack |
| **OpenHands Enterprise** — self-hosted AI agent, mention-to-start-work | Slack | **1**, stated as a limitation | "**No Slack Socket Mode.** Your OHE install must be reachable from the public internet", with "**Inbound HTTPS from the public internet** terminates at your OHE ingress on `https://app.<your-base-domain>/slack/*`". Its mention handling is Firetower's design exactly: strip the `<@BOT_ID>`, use the remainder as the initial prompt, fetch surrounding history as context. | https://docs.openhands.dev/enterprise/integrations/slack |
| **OpenClaw** — self-hosted AI agent | Slack | **2 by default**, with **1** and **5** offered | "Socket Mode (default)", and "Pick Socket Mode for … on-prem networks that can reach `*.slack.com` outbound but cannot accept inbound HTTPS"; HTTP is for "running multiple Gateway replicas behind a load balancer"; relay mode exists and is **trusted**, not blinded. | https://docs.openclaw.ai/channels/slack/transports |
| **Onyx** (formerly Danswer) — self-hosted assistant with a Slack bot | Slack | **2 — Socket Mode** | "Onyx validates the tokens and connects to Slack over Socket Mode, so your deployment does not need a public URL." Self-hosters paste a manifest with `socket_mode_enabled: true` and `connections:write`. Discord is a Gateway client; Teams exists only as a read-only indexing connector. | https://docs.onyx.app/admins/getting_started/slack_bot_setup |
| **Langflow** self-managed | Slack, Teams | **2** + **3**, with **1** as the alternative | The best-designed answer in the survey. Socket Mode runs in a separate `langflow listeners` process — "Use listeners when Langflow is not reachable from the public internet" and "Do not add a Service or Ingress. The listener accepts no provider traffic." For Teams, `auto` "chooses a Graph notification subscription when ingress is enabled … otherwise it uses Graph delta polling". | https://docs.langflow.org/bundles-slack · https://docs.langflow.org/deployment-trigger-listeners |
| **Letta** self-hosted | Slack, Discord, Telegram | **2**, one transport per platform | "Telegram uses long-polling, Slack uses Socket Mode, Discord uses the gateway WebSocket" — and Letta *Cloud* instead uses a vendor-operated Slack connection. The two-tier split, stated in one sentence. | https://docs.letta.com/self-hosting/channels |
| **Switch** (self-hosted agent rooms) | Slack, Discord, Mattermost, Telegram | **2** — and **1** for Teams | Slack, Discord, Mattermost and Telegram pages all say "Nothing needs to be publicly reachable." Teams breaks the pattern: "Microsoft pushes messages to Switch … **Microsoft must be able to reach it from the internet**." | https://docs.switchagents.ai/switch-rooms/deploy/messaging-apps/microsoft-teams |
| **Lightdash** self-hosted (@-mentionable AI agent) | Slack | **2**, with a trap worth copying | "Socket Mode … can be useful … when you cannot expose your Lightdash instance to the public internet" — but "Socket Mode only covers events and interactions. Slack still downloads chart images for link unfurls and AI agent replies from your instance's `SITE_URL` … so those paths must be reachable from the internet over HTTPS for images to appear in Slack." | https://docs.lightdash.com/self-host/customize-deployment/configure-a-slack-app-for-lightdash |
| **Rasa** (open source) | Slack, Teams | **1** + **4** | "To receive messages, you will need a publicly available URL for Slack to reach your bot … If you are running locally, you can test channels using ngrok." Socket Mode is not supported; the feature request was closed by a migration bot, not by an implementation. | https://rasa.com/docs/reference/channels/slack |
| **Activepieces** self-hosted | Slack, Teams | **1** + **4**, and it tells you to disable approach 2 | "Turn **Socket Mode off** for your Slack app … While Socket Mode is on, Slack delivers events over a WebSocket connection and never POSTs to the Request URL … so the trigger silently never fires." `AP_FRONTEND_URL` "must be reachable by third parties". Its Teams triggers *poll*. | https://www.activepieces.com/docs/install/configure-operate/setup-app-webhooks |
| **Dify** self-hosted | Slack, Discord, Teams | **1** | `TRIGGER_URL` "must point to a public domain or IP address they can reach"; the Discord trigger is webhook-only and says the Gateway is "intentionally out of scope". Silent on the unreachable self-hoster. | https://docs.dify.ai/en/self-host/deploy/configuration/environments |
| **Windmill** self-hosted | Slack | **1** | "warning These URLs must be publicly accessible: `<YOUR INSTANCE URL>/api/oauth/slack_events` - for @mention triggers". On cloud it is Windmill's app; self-hosted it is yours. | https://www.windmill.dev/docs/advanced/setup_oauth |
| **Botpress** | Slack, Teams | **5**, mandatory — by deleting self-hosting | "Botpress v12 has been officially sunset … This includes all other self-hosted or locally installed versions of Botpress." Every event now lands on `webhook.botpress.cloud`, which their manifest hard-codes alongside `socket_mode_enabled: false`. The integration code is MIT; the relay runtime is not published. | https://botpress.com/docs/integrations/integration-guides/slack/ |
| **Goose** (Block), **AnythingLLM** | Telegram only | **3** | Both ship Telegram long polling and nothing else, because Telegram makes polling first-class: "Use this method to receive incoming updates using long polling." AnythingLLM is blunt about the consequence — "**Requires your instance to be running**". | https://docs.anythingllm.com/channels/telegram · https://core.telegram.org/bots/api#getupdates |
| **Mattermost Agents** | Mattermost | **Approach zero** — own the chat server | A plugin inside your own Mattermost: "@mention Agent bots by their username … in any thread". Nothing crosses a network boundary, and the docs talk about air-gapped environments rather than reachability. | https://docs.mattermost.com/end-user-guide/agents |
| **Khoj**, **Trigger.dev** | Slack / WhatsApp | **5**, cloud-tier | Khoj: "you need to setup a Khoj Cloud account"; Trigger.dev's Slack agents register a hosted endpoint. What either relay reads, and whether a self-hosted install can terminate the platform's requests itself: **not established**. | https://docs.khoj.dev/clients/whatsapp |
| **Flowise**, **LibreChat**, **Lobe Chat**, **SWE-agent** | — | **No first-party chat trigger found** | Chat platforms appear only as outbound tools or as OAuth login providers. Flowise never addresses inbound-blocked servers at all. Recorded because absence is part of the answer: most self-hosted AI products do not ship this feature. | https://docs.flowiseai.com/using-flowise/agentflowv2 |
| **Open WebUI** | — | **The inversion worth noting** | Its "Apps" model has Open WebUI dial out: "An app runs on its own server. Open WebUI opens the connection to the app, so Open WebUI itself can stay on a private network with no public callback address." | https://docs.openwebui.com/features/channels/apps |

---

## 2. The platform layer decides most of this, and the four platforms disagree

Before any product's choice means anything: **all four** chat platforms now ship a transport that
needs no inbound HTTP — three of them for years, and Teams since 6 November 2026. Most of the
variance in the table above is this fact and its history, not a difference of opinion between
vendors.

| Platform | Pull transport | What the platform says |
|---|---|---|
| **Slack** | **Socket Mode** — outbound WebSocket | "Socket Mode helps developers working behind a corporate firewall, or who have other security concerns that don't allow exposing a static HTTP endpoint." |
| **Discord** | **The Gateway** — outbound WebSocket, and it is the default | "By default, your app receives interactions over the Gateway (a persistent WebSocket connection)"; an Interactions Endpoint URL is the *alternative*, not the baseline. |
| **Google Chat** | **A Cloud Pub/Sub topic as the app's endpoint** | Documented under the title *Build a Google Chat app behind a firewall with Pub/Sub*: "This architecture for a Chat app is useful if your organization has a firewall, which can prevent Chat from sending messages to your Chat app." |
| **Microsoft Teams** | **Socket mode — eleven days old, public preview** | "You turn on socket mode in the agent's bot registration; **no endpoint is needed**… Outbound connections only, on port 443. No inbound connectivity, no tunnel, no public URL." Before this, nothing: an HTTPS messaging endpoint, a public `notificationUrl` for Graph, and polling barred by contract. |

**Slack's Socket Mode is free of charge and expensive in a different currency — and the currency
is narrower than it first looks.** The same docs that recommend it for firewalled apps also say
"Apps using Socket Mode are _not_ currently allowed in the public Slack Marketplace" and "If you
intend to submit your app to be available for use in the Slack Marketplace, using HTTP is a
requirement" — but, importantly, **"Socket mode is fully supported for distributed apps."** So
multi-workspace OAuth distribution is fine; only the *Marketplace listing* is barred. What
actually binds is the connection ceiling: "Socket Mode allows your app to maintain up to 10 open
WebSocket connections at the same time", and the app-level token is per *app*, not per install.
Langflow spells out what that means in one sentence of security advice: "An app-level token is
the app's whole event stream: every workspace the app is installed in, every conversation it can
see." A single Firetower-owned app holding sockets for many installs is therefore both capped at
ten and a firehose of everybody's events — which is the real reason a distributed app ends up on
HTTP, and the real reason an install-owned app ends up on Socket Mode.

- https://docs.langflow.org/bundles-slack
- https://docs.slack.dev/apis/events-api/using-socket-mode/
- https://docs.slack.dev/apis/events-api/comparing-http-socket-mode/
- https://docs.discord.com/developers/interactions/overview
- https://developers.google.com/workspace/chat/quickstart/pub-sub

**Polling Slack has been closed off since 2025.** For apps distributed outside the Marketplace,
`conversations.history` is "rate limited to 1 request per minute" with the `limit` parameter
"reduced to 15 objects", from 29 May 2025 for new apps and from 3 March 2026 for existing
installations. Approach 3 is therefore not available on Slack to a product in Firetower's
position, whatever anyone thinks of its elegance.
https://docs.slack.dev/changelog/2025/05/29/rate-limit-changes-for-non-marketplace-apps/

**Polling Teams is barred by the terms of use, in writing.** This is the hardest single fact in
the survey, because it removes the fallback everyone reaches for:

> If your app polls to see whether a resource has changed, you can only do that once per day. …
> If you need to hear about changes more frequently than that, you should create a subscription
> to that resource and receive change notifications (webhooks). … Apps that don't follow these
> polling requirements will be considered in violation of the Microsoft APIs Terms of Use. This
> may result in additional throttling or the suspension or termination of your use of the
> Microsoft APIs.

https://learn.microsoft.com/en-us/graph/api/resources/teams-api-overview — *Polling requirements*.
`chatMessage: delta` exists and works; using it on a loop does not. So for Teams the options are
an inbound endpoint, something that holds one for you, or no Teams.

**What the platforms sign, which is what decides whether a relay can be blinded.** The map's
hypothesis holds for two of three, confirmed against the platforms' own docs:

- **Slack** signs `'v0:' + timestamp + ':' + request_body` with HMAC-SHA256 under the app's
  signing secret, in `X-Slack-Signature`, and tells the app to "verify that the timestamp does
  not differ from local time by more than five minutes".
  https://docs.slack.dev/authentication/verifying-requests-from-slack/
- **Discord** signs HTTP interactions Ed25519, `X-Signature-Ed25519` plus
  `X-Signature-Timestamp`, verified against the application's hex-encoded `verify_key`; an app
  that fails verification must answer 401.
  https://docs.discord.com/developers/interactions/overview
- **Teams** signs nothing per message, on either path, and this is the finding that decides the
  Teams half of #371. On HTTPS, "Your agent validates the bearer token on every incoming
  request" — a Microsoft-issued JWT, verifiable but bearer-shaped, so whoever holds it can
  replay it. In socket mode there is no per-activity credential at all: "ACS authenticates your
  agent once, when it connects. Your agent can trust that activities received over the
  authenticated socket come from Teams. It doesn't need to authenticate each activity
  separately", and the socket is opened with "the token from its Microsoft Entra app
  registration, the same token it uses to send messages".
  https://learn.microsoft.com/en-us/microsoftteams/platform/agents-in-teams/agent-connectivity

A relay that carries opaque bytes and lets the control plane verify them itself is therefore
buildable for Slack and Discord and **not buildable for Teams**: there is nothing per-message to
verify, and a relay holding the socket would have to hold the agent's own Entra credential. A
Teams relay is a trusted relay by construction. Nobody surveyed has built a blinded one for any
platform — see §5.3.

---

## 3. The relays that exist, and what they promise

Two populations, and conflating them is the single easiest mistake to make here.

### 3.1 Relays that carry events *inward* — rare, and mostly labelled development-only

| Relay | Who runs it | Production? | Opt-in / default | What it can read | Opt out | Open source / self-hostable |
|---|---|---|---|---|---|---|
| **Jira Data Center for Microsoft Teams** — `msteams-jira-server.service.signalr.net`, `*.msteams-atlassian.com` | **Atlassian**, on Azure | **Yes** | Opt-in: you install the app | Everything — issue data passes through it in clear | Don't install it; lose the integration | No |
| **Home Assistant cloudhooks** — `hooks.nabu.casa/<id>` | Nabu Casa (paid subscription) | **Yes** | Opt-in twice: subscribe, *and* flip that webhook off `local_only` (default `true`) | The webhook body | Yes; keep local webhooks | Relay is `NabuCasa/snitun` (GPL-3.0); self-hosting undocumented |
| **Atlassian "application tunnels"** (DC → Cloud connectors) | Atlassian | Yes | Opt-in: pick "Private network" at setup | Whatever the connector forwards | Yes | No |
| **Botpress** — `webhook.botpress.cloud` | Botpress | **Yes**, and mandatory | Neither — it is the only option, since v12 self-hosting was sunset | Raw channel messages: its manifest asks for `channels:history`, `im:history`, `users:read.email` | No | Integration code is MIT; the relay runtime is not published |
| **Coder dev tunnel** — `*.try.coder.app` | Coder | **No** — "For proof-of-concept deployments" | Default when no access URL is set | All traffic | Set an access URL | **Yes** — `coder/wgtunnel`, override with `--wg-tunnel-host` |
| **n8n tunnel** — `hooks.n8n.cloud` | n8n | **No** — "Use only for testing and development!" | Opt-in flag | All webhook bodies | n/a | Built on `@n8n/localtunnel`; **hosted service discontinued 2 March 2026** |
| **smee.io** | GitHub, for Probot | **No** | Opt-in | Everything, to anybody with the URL | n/a | Yes |

**The honest summary of that table**: one vendor — Atlassian — runs an inbound chat relay for a
*self-hosted* product in production, and it runs it for **Teams**, which is the platform that left
it no choice. Home Assistant runs the only other production-grade one, and it is a general
webhook relay rather than a chat relay. Botpress's is mandatory because there is no longer a
self-hosted Botpress to be unreachable. Everything else in the inward column is a development
tool whose own documentation tells you not to ship it, and one of those has since been switched
off.

**The shape Atlassian chose is worth more than the fact that it exists.** The Jira DC app
**dials out**: "Jira Data Center app establishes a connection with Azure SignalR Hub
(https://msteams-jira-server.service.signalr.net)", and the firewall page lists only outbound
hosts — nowhere does Atlassian ask for the instance to be reachable from the internet.
https://confluence.atlassian.com/msteamsjiraserver/configuring-firewall-1563231385.html
The reachability burden it could not remove it moved onto the *user's device* instead: "To
successfully authenticate in the app, it's required for user to have direct network access to
Jira Data Center. This may mean connecting VPN."
https://confluence.atlassian.com/msteamsjiraserver/authenticating-jira-user-in-teams-1562378373.html
That is a Firetower-shaped trade and worth copying consciously: the relay carries the *event*,
and anything that needs the control plane itself is done by a client that can already reach it.

### 3.2 Relays that carry notifications *outward* — unanimous, and this is where Firetower's terms came from

Every self-hosted product with a store-published mobile app runs or uses a vendor relay, for the
reason `docs/mobile.md:562` already gives. The interesting part is not *whether* — it is how few
of them hold themselves to Firetower's four terms.

| Relay | Opt-in per server | Off by default | Relay cannot read the payload | Says plainly what leaves | Self-hostable |
|---|---|---|---|---|---|
| **Zulip** — `push.zulipchat.com` | **Yes** (`ZULIP_SERVICE_PUSH_NOTIFICATIONS`, plus `manage.py register_server`) | **Yes** — `False` in `default_settings.py`, commented out in the prod template | **Yes** on Server 12.0+ — XSalsa20-Poly1305 to a per-device key; content *and* metadata opaque | **Yes** — registration prints the data it would send and makes you accept it | Code is (`zilencer`); running your own with the store apps is not a documented path |
| **Mattermost** — `*.push.mattermost.com` (HPNS) | No | **No** — a fresh config ships `SendPushNotifications` true, pointed at TPNS | **No** by default; `id_loaded` (IDs only, app fetches the body) is **Enterprise-only** | Yes — settings reference plus a linked DPA | **Yes** — `mattermost-push-proxy`, but then you must ship your own apps |
| **Rocket.Chat** — `gateway.rocket.chat` | Consent-gated, not setting-gated | **No** — `Push_enable_gateway` defaults true | **No** on Community; content-hiding is Premium and force-disabled below it | **Yes** — the best-worded setting found anywhere (below) | Custom gateway supported by config; the service's source: not established |
| **Nextcloud** — `push-notifications.nextcloud.com` | No — the *device* supplies the proxy URL | **No** | **Yes** — RSA-OAEP to the device's public key; proxy verifies, re-signs, forwards | **No admin-facing setting exists at all** | Protocol published; the service's source: not established |
| **Matrix / Element** — `matrix.org/_matrix/push/v1/notify` | **No, structurally** — the *client* registers the pusher URL; Synapse has no allowlist | No | Optional — `event_id_only`, and Synapse's `push.include_content` defaults **true** | Sample payload, not a commitment | **Yes** — `element-hq/sygnal`, a supported path |
| **Bitwarden** — `push.bitwarden.com` | No | **No** — "By default, your self-hosted Bitwarden server is configured to communicate with Bitwarden's push relay service" | Yes — no decrypted data, and nothing stored | Yes, including what it *records* | **Yes** — `PUSH_RELAY_URI` points elsewhere |
| **Jira / Confluence DC** — `mobile-server-push-notification.atlassian.net` | Admin-level on/off | Not established | **Yes** — "No user or message content is sent to the service, only notification IDs, and we don't store any data" | Yes | No |

**One of seven meets Firetower's four terms in full, and it is Zulip on Server 12.0+.** Everything
else fails term 1 or term 2, usually both, because the relay is the out-of-the-box default rather
than a choice. Two fail term 3 outright on their free tier, and in both cases the
privacy-preserving mode is a paid SKU — Mattermost's `id_loaded` is Enterprise, Rocket.Chat's
content-hiding is Premium and *force-disabled* without a licence. One — Nextcloud — has the
strongest cryptography in the set and **no admin-facing setting whatsoever**, so term 4 is
satisfied only by a markdown file in a GitHub repository.

The best single piece of wording in the survey is Rocket.Chat's setting label, and it is worth
stealing outright for the Firetower setting `docs/mobile.md:582` promises: *"Hide message content
from Apple and Google (and the Gateway, if enabled) … Rocket.Chat sends only a message ID. The
mobile app then fetches the message directly from your server before displaying it, so the
content never passes through Apple, Google, or the gateway."*
https://docs.rocket.chat/docs/push

**So Firetower's bar is stricter than the market's, not looser.** That is the answer to the second
headline question, and it is worth saying in the spec rather than leaving implied.

### 3.3 The terms in common use that Firetower's four are missing

Ranked by how much they would change the design or the copy.

1. **"You may run the relay yourself."** The most common extra promise, and the one this audience
   asks for first. Mattermost publishes `mattermost-push-proxy` with Docker images and says
   "Deploy the MPNS on your own infrastructure — whether on-premises behind your firewall or in
   your public cloud … Mattermost clients don't need any inbound connectivity"
   (https://docs.mattermost.com/deployment-guide/mobile/host-your-own-push-proxy-service).
   Element ships `element-hq/sygnal` as a supported path. Bitwarden takes a URL:
   `PUSH_RELAY_URI`. Coder's tunnel has `--wg-tunnel-host` over `coder/wgtunnel`. Firetower's four
   terms say nothing about this, and the ticket asks the question directly — the market answer is
   **yes, with a documented catch**: every one of them notes that running your own relay means
   shipping your own client app, because the APNs key is the thing that cannot be delegated. For
   a *chat* relay that catch does not apply, which makes "self-hostable" a cheaper promise to make
   here than it is for push.
2. **What the relay retains, as distinct from what it can read.** "Cannot read" and "keeps
   nothing" are different claims and the market makes both separately. Bitwarden publishes the
   record it keeps: "For each self-hosted server that uses the Bitwarden push relay service,
   Bitwarden collects a record including a timestamp for the most recent connection to the service
   and the initiating server's installation ID" (https://bitwarden.com/help/configure-push-relay/).
   Mattermost: "Mattermost doesn't store any notification data." Atlassian: "we don't store any
   data." Zulip bounds it — tokens for "as long as a device's registration is active".
   **This is where `docs/mobile.md`'s "the relay learns nothing" is an overclaim by market
   standards.** Every relay surveyed learns at minimum that an install exists and when it last
   connected, and a chat relay learns more than a push relay does, because it has to know which
   install a Slack team maps to in order to route at all. The claim should be the one Bitwarden
   makes: here is exactly what it learns, and it is this short list.
3. **A published legal instrument, not just a sentence in the docs.** Mattermost links a Data
   Processing Addendum from the setting itself as "an explicit privacy policy for the contents of
   unencrypted messages". Zulip makes you accept three documents interactively at
   `register_server` time. Rocket.Chat makes acceptance of its cloud privacy terms a *functional
   precondition* — the gateway does not work until you agree. A relay that carries prompts into
   an agent that spends somebody's money will be asked for this.
4. **Whether the relay is metered, and what happens when the meter runs out.** Four of five push
   relays are commercially gated: Zulip above 10 users, Mattermost HPNS on Professional or
   Enterprise, Rocket.Chat at 10,000 notifications a month, and Nextcloud **silently** above
   roughly 1,000 seen users unless you buy Enterprise. The failure mode to avoid is Nextcloud's:
   a limit enforced in a code path with no setting and no notice.
5. **The operator chooses the relay, not the client.** Matrix fails this absolutely — the client
   calls `pushers/set` with whatever gateway URL it likes and Synapse has no allowlist, so a
   server admin satisfied about terms 1–4 can be routed around by an app. Nextcloud fails it
   quietly: the device supplies `proxyServer`. Firetower's mobile design has the same hazard
   latent in it, and a chat transport chosen per server rather than per client avoids it.
6. **What the user sees when the relay is off or fails.** Mattermost documents the degraded push
   ("a generic push notification is displayed without message content or sender name"),
   Rocket.Chat documents the string ("you have a new message"), Atlassian documents the off-VPN
   stub ("1 new notification"). Firetower's equivalent is "anybody who will not accept that keeps
   the webhook", which is a route rather than a degradation — for a chat trigger the degraded
   state is *the mention does nothing*, and that needs a sentence.
7. **Metadata and timing honesty.** Zulip discloses the side channels it cannot close — "The
   Push Notification Service, and indirectly Apple and Google, can observe the timing, delivery
   priority, and size of each push notification" — and Synapse ships a mitigation for it,
   `push.jitter_delay`, "useful for mitigating timing attacks". Nobody does both. A relay that
   sees *when* each organisation's channel gets busy is in the same position.

Not established for any relay in the survey: a third-party audit or attestation.



## 4. Teams, which forced the question until eleven days ago

Teams was not a harder version of the Slack problem; it was a different problem, because every
escape hatch the other platforms offer was missing and one of them is closed by contract rather
than by engineering. **That changed on 6 November 2026**, which is recent enough that it has to be
read as a development rather than as settled practice.

**The new fact, and it is the most consequential thing in this survey.** Microsoft now ships a
**socket mode** for Teams agents: "You turn on socket mode in the agent's bot registration; no
endpoint is needed. When your agent starts, it opens outbound WebSocket connections to ACS", and
on the network row of Microsoft's own comparison table, "**Outbound connections only, on port
443. No inbound connectivity, no tunnel, no public URL.**" It is built on Azure SignalR Service —
*the same service Atlassian hand-rolled its Jira DC relay on top of*, which is a strong signal
that the shape was right. The caveats are real and should be read as a whole:

| | |
|---|---|
| Status | "Socket mode is in public preview and only available for newly created bots and agents. **We recommend using an HTTPS messaging endpoint for agents in production.**" |
| Distribution | "Distribution via Teams Store — **Not supported**." The same wall Slack puts in front of Socket Mode. |
| Scale | "Up to 4 open connections per agent in each region", and you must connect in **every** region — `amer`, `emea`, `apac` — or "it won't receive activities from conversations in that region". |
| Delivery | 25 s to reply (`deadlineMs`), 1 MB replies, 60-minute socket tokens, **no retry**: "ACS sends each activity once, to one socket." |
| When you are offline | "ACS doesn't deliver activities in a region unless your agent has an active WebSocket connection in that region. It doesn't fall back to a previously saved HTTPS endpoint." |
| Firewall | Outbound 443 to `login.microsoftonline.com`, `*.botapi.skype.com`, `*.service.signalr.net` and the activity's `serviceUrl` hosts. "Proxies and firewalls must allow WebSocket upgrades and long-lived connections." |

https://learn.microsoft.com/en-us/microsoftteams/platform/agents-in-teams/agent-connectivity
(page dated 2026-11-06, updated 2026-11-13) and
https://learn.microsoft.com/en-us/microsoftteams/platform/agents-in-teams/configure-delivery-methods-for-agents

**Nobody in the survey has adopted it.** Every Teams integration read for this ticket still
requires inbound, including ones that use a pull transport on every other platform — Switch does
Socket Mode on Slack, the Gateway on Discord and long polling on Telegram, and still says of
Teams that "Microsoft pushes messages to Switch, so the connection runs its own listener behind
your HTTPS ingress… **Microsoft must be able to reach it from the internet**"
(https://docs.switchagents.ai/switch-rooms/deploy/messaging-apps/microsoft-teams). That is an open
gap today and a reason for the spec to treat Teams as *behind* Slack and Discord rather than
alongside them.

**What it was before, which is still what Microsoft recommends for production.** "Teams is an
entirely cloud-based product, it requires all
services it accesses to be available publicly using HTTPS endpoints. Therefore, to enable your
app to work within Teams, you need to either publish the code to the cloud of your choice or make
our local running instance externally accessible. We can do the latter with tunneling software."
https://learn.microsoft.com/en-us/microsoftteams/platform/concepts/build-and-test/debug

**Microsoft's own answer to the problem is a Microsoft-operated tunnel.** The current developer
guidance is that "Dev Tunnels is Microsoft's tunneling service, built into Visual Studio, VS
Code, and the Microsoft 365 Agents Toolkit" and is the recommended way to give a locally running
bot a public HTTPS messaging endpoint, with ngrok and Cloudflare Tunnel named as equivalents.
https://learn.microsoft.com/en-us/microsoftteams/platform/teams-sdk/developer-tools/local-tunnels

So the platform vendor ships approach 4, operates it itself, and scopes it to development. That
is the closest thing to a blessing a relay gets anywhere in this survey — and it is still only
blessed for development.

**The four ways out, and what each costs:**

| Way out | Status |
|---|---|
| **Socket mode** | **New, outbound only, and the answer if it survives preview** — but preview, not Store-distributable, four sockets per region, and no delivery at all while you are disconnected. |
| Inbound HTTPS endpoint for the Bot Framework | Works, and is still the recommended production shape. It is exactly what `deploy/.env.example` exists to avoid. |
| Graph change notifications instead of a bot | No help: a subscription requires a public `notificationUrl`. Same wall, different door. |
| Poll `chatMessage: delta` | **Barred by the Microsoft APIs Terms of Use** — once per day, see §2. Not a transport. |

**The five resolutions actually observed**, which is the useful part of this section:

| Resolution | Who | What it costs |
|---|---|---|
| **Ship only the outbound half, and let Microsoft hold the endpoint** | GitLab, Grafana, Coder, Jenkins' O365 Connector plugin | Nothing, and it buys nothing either — you can post *into* Teams, which is not the feature. All three now tell you to create a Power Automate / Teams workflow with a "When an HTTP request is received" trigger and paste its URL, so the inbound listener lives in Microsoft's cloud. |
| **Require inbound and say so** | Sentry (`{YOUR_DOMAIN}/extensions/msteams/webhook/`), n8n, Rocket.Chat's Teams bridge (with ngrok named), OpenHands for Slack | Exactly what `deploy/.env.example` refuses. Sentry adds a tenant-governance tax on top: custom apps must be enabled in the Teams Admin Center and an admin must approve the app. |
| **Require inbound and never mention it** | Mattermost's MS Teams Sync — Graph POSTs to `SiteURL/plugins/…/changes`, with no polling fallback and no reachability note anywhere in the docs | The worst of the five: an operator reading the docs cannot tell that the feature needs an inbound path until it silently does not work. |
| **Make it cloud-only** | Grafana OnCall: "This integration is available exclusively on Grafana Cloud"; Botpress, by sunsetting self-hosting altogether | The self-hosted install does not get the feature. Honest, and the cheapest thing to build. |
| **Run a relay, dialled outbound** | Atlassian's Jira Data Center for Microsoft Teams | A service to operate forever, and a vendor in the path of issue data. It is the only one of the five that delivers the feature to an unreachable instance. |

**And a sixth shape that the ticket's five approaches do not enumerate: a relay the *customer*
owns.** Two precedents, both for exactly this problem:

- **n8n's Teams channel** has you create an **Azure Bot in your own Azure subscription** (free F0
  tier, resource group `n8n-agents`); Teams talks to that bot, and "The Azure Bot forwards it to
  your n8n instance". It is a Microsoft-hosted hop that the customer owns — though in n8n's case
  it does not solve reachability, because the bot still POSTs inward.
  https://docs.n8n.io/build/build-and-manage-agents/microsoft-teams/set-up-the-teams-channel
- **Gitpod/Ona's "public services" option** stands up a public API Gateway with a static DNS name
  **in the customer's own AWS account** purely to terminate OIDC and webhooks, with the stated
  boundary that "The added API gateway does not expose your entire instance to the public
  Internet". https://ona.com/docs/enterprise/reference/networking-data-flows

For Firetower this is a real third option beside "expose yourself" and "trust our relay": a
small, published, customer-deployed receiver that the control plane long-polls, with no Firetower
service in the path and no inbound port on the control plane. It is more setup than a vendor
relay and less trust, and it is the shape a security-led install will ask for whether or not it
is offered.


---

## 5. Five things the survey turned up that change how to frame the relay question

### 5.1 For Slack and Discord the problem is not reachability. It is distribution.

Socket Mode and the Discord Gateway both remove the inbound endpoint completely, for free, today.
What Socket Mode costs is the Slack Marketplace listing — not distribution, which it supports —
and the app-level token's scope, which is the whole app across every workspace it is installed in.
So the real fork is not *"relay or expose yourself"*, it is:

| | What the install does | What Firetower ships | What it costs |
|---|---|---|---|
| **One Firetower app, listed** | Clicks *Add to Slack* | HTTP endpoints, so **something must be reachable** — the install, or a relay standing in for it | A relay in the path of every install, forever |
| **One Firetower app, Socket Mode** | Clicks *Add to Slack* | Firetower holds the sockets, because the app-level token is Firetower's | A relay by another name, capped at **ten** concurrent connections, carrying every install's events down one pipe |
| **An app per install** | Creates an app from a Firetower-published manifest, pastes two tokens | Socket Mode, outbound only, nothing in the middle | The Marketplace listing, and about five minutes of setup per workspace |

**The second is what the market does.** GitHub Enterprise Server's own documentation says "The
GitHub app in the Slack Marketplace cannot be used with GitHub Enterprise Server" and walks the
admin through registering a private Slack app instead
(https://docs.github.com/en/enterprise-server@3.21/integrations/how-tos/slack/integrate-github-with-slack).
GitLab says the same of its own listing — "The GitLab for Slack app distributed through the Slack
App Directory only works with GitLab.com. On GitLab Self-Managed, you can create your own copy of
the GitLab for Slack app from a manifest file" — and Sourcegraph states the principle outright:
"As Sourcegraph is enterprise software, we favor a 'create the app yourself' workflow, guiding
the site administrator through the app creation process"
(https://sourcegraph.com/blog/deep-search-slack-agent-lessons). Sentry, Grafana OnCall, Teleport,
OpenHands, Onyx, Langflow, Letta, Switch and Lightdash all ship the same wizard. **A self-hosted
product with a Marketplace listing is the rare bird — rarer than the relay.**

**Two products ship both halves and name the trade-off, which is the clearest evidence in the
survey.** Langflow: "Hosted Langflow uses the Events API only: its Slack app is listed in the
Slack Marketplace, and Marketplace apps cannot use Socket Mode", while self-managed instances and
Desktop get Socket Mode. Letta: self-hosted channels use Socket Mode, the Discord gateway and
Telegram long polling, and Letta *Cloud* instead uses a vendor-operated Slack connection. The
market has settled on **cloud tier = vendor's app on HTTP; self-hosted tier = your app on Socket
Mode** — and Firetower only has the second tier.

**Why so few take Socket Mode even so, which is worth knowing before choosing it.** Two vendors
hand you a manifest with `socket_mode_enabled: false` written into it — Jenkins and Grafana
OnCall — and only three products in the survey use a platform pull transport for chat at all
(Rocket.Chat's SlackBridge, Teleport's native reviews, OpenClaw by default). The stated reason is
horizontal scale: OpenClaw picks HTTP when "running multiple Gateway replicas behind a load
balancer", and Slack caps an app at ten concurrent WebSocket connections. Neither constraint
binds a single-process control plane, which is what Firetower is — so the reason the market
mostly skips Socket Mode is a reason that does not apply here.

That reframes #371. A relay bought for reachability is one argument; a relay bought to make
*Add to Slack* work for a self-hosted install is a different and much more product-shaped one,
and it should be argued on those terms rather than smuggled in as a network fix.

### 5.2 The market's answer to "something outside makes my machine run work" is a runner, not a relay

Firetower is not the first product to need an unreachable machine to execute work that an
internet-facing system decided to start. The dominant answer in the industry is the CI runner,
and it is the exact inversion of an inbound relay — the vendor holds the queue and the private
machine **pulls**:

> The self-hosted runner uses an HTTP(S) _long poll_ that opens a connection to GitHub
> Enterprise Server for 50 seconds, and if no response is received, it then times out and creates
> a new long poll. … **Only an outbound connection from the runner to your GitHub Enterprise
> Server instance is required. There is no need for an inbound connection from your GitHub
> Enterprise Server instance to the runner.**

https://docs.github.com/en/enterprise-server@3.2/actions/hosting-your-own-runners/about-self-hosted-runners.
GitLab Runner is the same shape, and so is every hosted CI product with on-prem execution. Nobody
files this under "exotic"; it is how the category works.

Two consequences for the relay question:

1. **A relay that the control plane long-polls is a strictly better shape than one that POSTs
   inward**, and it is the shape with overwhelming market precedent. It keeps
   `deploy/.env.example`'s claim literally true — every connection is still outbound, the control
   plane still exposes nothing, and the inbound/outbound distinction the map calls "what is new"
   simply does not arise. It also degrades honestly: an install that is off keeps nothing queued
   or drops it, which is a policy choice rather than a lost HTTP request.
2. **The injection risk the map raises is the risk the whole CI industry already accepted, and
   its documented mitigation is scope rather than refusal.** GitHub's own hardening guide says a
   "Self-hosted runners should almost never be used for public repositories on GitHub, because
   any user can open pull requests against the repository and compromise the environment"
   (https://docs.github.com/en/actions/reference/security/secure-use). The answer was never "do
   not let a remote control plane start work here"; it was "be explicit about who may, and what
   the work may reach". That maps exactly onto `schedules.owner_id`, `repo_of(owner_id, …)` and
   the envelope-approval question already open on the map.

### 5.3 No inbound relay in the market forwards opaque bytes, so Firetower's design has no prior art to copy

Every inbound relay found that is not a dev-only toy works by being **trusted**, not by being
blind. Atlassian's terminates the Teams side itself and necessarily sees the issue data;
Botpress's terminates Slack and asks for `channels:history`; and the two that get closest to
Firetower's proposed design still do not reach it:

- **OpenClaw**, a self-hosted agent product, documents a *relay mode* in which "a trusted router
  owns the single Slack Socket Mode connection, chooses a destination gateway, and forwards a
  typed event over an authenticated websocket", and says so explicitly: "Treat the bearer token
  and router route table as part of the Slack authorization boundary: routed events enter the
  normal Slack message handler as authorized activations." The router can even assert a default
  identity. Slack's signature is verified at the router, not at the gateway that runs the work.
  https://docs.openclaw.ai/channels/slack/transports
- **smee.io**, operated by GitHub for Probot development, is the generic version, and GitHub's own
  docs tell you not to use it: "Smee is intended for development and testing only. Smee channels
  are not authenticated or secure, so anyone with your webhook proxy URL can see the payloads
  sent to it."
  https://docs.github.com/en/webhooks/testing-and-troubleshooting-webhooks/testing-webhooks

So the "forward signed bytes, verify end to end at the control plane" design in #362's notes is
not standard practice — it is **better** than standard practice, and that cuts both ways. There
is no prior art to borrow, and the claim only holds where the signature covers the payload: it
does on Slack and Discord, and on Teams it **cannot** (§2 — there is no per-message credential in
socket mode and only a replayable bearer on HTTPS). A relay whose Teams path is "trust the router"
while its Slack path is "verify the signature" would be one relay with two trust models. Better
to notice that now and either accept it in writing or not ship a Teams relay at all.

### 5.4 The conservative market pattern is the opposite direction: notify out, act back in the product

Worth stating because it is the fallback if a relay is refused, and because the most
security-minded vendor surveyed chose it as the default. Teleport ships two Slack access-request
plugins. The plain one only sends messages and links reviewers back into Teleport's own web UI to
authenticate before approving. The `slack-review` variant lets people approve inside Slack, and
does it with Socket Mode — "Head to the **Socket Mode** tab and enable Socket Mode. This will
allow the Teleport Slack plugin to build a WebSocket connection with the Slack server in order to
process Access Request reviews from Slack", with an `xapp-…` app-level token scoped
`connections:write`. The docs then direct the cautious elsewhere: "Security-critical Teleport
deployments should follow the regular Slack plugin guide … which requires reviewers to
authenticate to Teleport before approving or denying requests."
https://goteleport.com/docs/identity-governance/access-requests/plugins/slack-review/

Firetower's destination — a mention *starts work* — is the aggressive direction on that axis,
and `notify.rs` plus a deep link is the conservative one the market mostly sits on. The survey
offers no reason not to go the aggressive way; it does say that what Firetower is building is
closer to the frontier than to the norm, which is an argument for the envelope-approval question
on the map being load-bearing rather than procedural.

### 5.5 Three traps the transport ticket should inherit, each found in somebody's documentation

Not reframings, but they are what a relay-or-socket decision will actually trip over, and each
one is written down by a vendor who hit it.

1. **A pull transport does not cover the pictures.** Lightdash is the only vendor honest about
   this: "Socket Mode only covers events and interactions. Slack still downloads chart images for
   link unfurls and AI agent replies from your instance's `SITE_URL`, under `/api/v1/slack/`, so
   those paths must be reachable from the internet over HTTPS for images to appear in Slack."
   Firetower posts *artifacts* — `docs/mentions.md` is a feature built on published pages — so a
   reply carrying anything but text runs into this immediately. Upload the bytes through the
   platform's own API rather than hand it a URL, or accept that the rich half of the reply needs
   reachability that the trigger did not.
   https://docs.lightdash.com/self-host/customize-deployment/configure-a-slack-app-for-lightdash
2. **One app's socket is one app's whole event stream, and sharing it splits it.** Slack fans
   events across *all* of an app's Socket Mode connections, so two processes holding the same app
   token silently each get half — documented by a community Slack node as "Do not connect another
   Socket Mode client … with the same app token", and by Langflow as the token being "the app's
   whole event stream: every workspace the app is installed in". A single control plane is fine;
   a control plane plus anything else holding the same token is not.
3. **Teams socket mode does not queue.** "ACS doesn't deliver activities in a region unless your
   agent has an active WebSocket connection in that region. It doesn't fall back to a previously
   saved HTTPS endpoint", there is no retry — "ACS sends each activity once, to one socket" — and
   the reply deadline is 25 seconds. A restart of the control plane therefore loses mentions
   outright rather than delaying them, which is a product behaviour to state in the spec rather
   than a bug to find later.

---

## 6. Not established

Recorded rather than guessed, because a guess written down as a fact is the worst outcome for a
ticket whose whole value is "what do other people actually do".

- **Sourcegraph's Slack Integration** (self-hosted 6.12+, Enterprise) consumes the Events API
  through a wizard-generated manifest, and its docs never say whether delivery is an HTTP request
  URL or Socket Mode, nor mention reachability, `externalURL`, firewalls or a relay. Checked the
  integration page, three self-hosted changelogs and the engineering blog post.
  https://sourcegraph.com/docs/slack-integration
- **GitHub Enterprise Server's chat integration** — whether the instance must be reachable from
  Slack. The docs describe the token exchange and the private-app registration and say nothing
  about the network. Slash commands imply it; the vendor does not state it.
- **What Teams socket mode does under load and over time.** It is eleven days old and in public
  preview; Microsoft recommends HTTPS for production and says preview features can change. Whether
  it is dependable enough to build the Teams provider on is **not established by documentation**
  and probably cannot be — it needs a running trial, which is a tracer-bullet ticket rather than a
  research answer.
- **Jenkins' position on inbound Slack** — no first-party plugin documents slash commands or an
  inbound Slack endpoint, so there is no vendor position to report.
- **Confluence Data Center with Teams** — Atlassian's official Teams app is Cloud-only; Data
  Center options are third-party. Jira DC has the relay; Confluence DC apparently does not.
- **What Grafana Cloud's relay received** from an OnCall OSS install. The docs never enumerate it.
- **Whether Jira/Confluence DC mobile push is on or off as shipped.** Atlassian's docs frame it
  both ways on different pages and never state the default.
- **A third-party audit or attestation of any relay in this survey.** None found, for any vendor.
- **Any vendor relay that forwards opaque, platform-signed bytes and lets the destination verify
  them end to end.** None found. See §5.3 — this is the one place the proposed Firetower design
  has no precedent to copy.

Two places where a vendor's documentation and its shipped code disagree, flagged because in both
cases the code is the more permissive: **Mattermost's push default** (the settings reference says
HPNS is the default, the mobile FAQ says push is disabled by default, and a fresh config in
`server/public/model/config.go` ships push *enabled* and pointed at the free TPNS), and
**Mattermost's push content default** (docs say generic, code says `full`). If Firetower's
settings copy is going to make a promise, this is the failure mode to design against: the
promise lived in the docs and the default lived in the code.

---

## 7. What this is and is not

Forty products, read from vendor documentation on 17 November 2026, one URL per claim. All of the
ticket's named products are here. Extended where the shape matched: GitHub Enterprise Server,
Bitbucket Data Center, Teleport, Bitwarden, Gitea/Forgejo, Nextcloud, Matrix/Element, and the
self-hosted AI tier the ticket asked for — OpenHands, OpenClaw, Onyx, Langflow, Letta, Switch,
Lightdash, Rasa, Activepieces, Dify, Windmill, Botpress, Goose, AnythingLLM, Khoj, Trigger.dev,
Mattermost Agents, and four products recorded for shipping no chat trigger at all. Google Chat was
added to the platform layer because the provider seam will meet it. Supabase was checked and has
no first-party chat integration of any kind.

Three of the sources are dated or dead and are quoted as such rather than as current practice:
**Grafana OnCall OSS** entered maintenance in March 2025 and was archived in 2026, so its docs now
live in `grafana-cold-storage/oncall`; **n8n's tunnel service** was discontinued on 2 March 2026;
**Gitpod's Kubernetes self-hosted edition** was withdrawn in 2022 and the product is now Ona. A
dead answer is still evidence of what was tried — n8n's retired tunnel in particular is the only
case in the survey of a vendor building an inbound relay for self-hosters and then switching it
off.

Not covered, deliberately: third-party relay products (Webhook Relay, ngrok, Hookdeck) beyond
noting that a market for them exists and that vendors reach for them when their own docs run out;
and anything about Firetower's own transport choice, which is #365–#371's work, not this ticket's.
