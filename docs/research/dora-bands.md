# Do the DORA bands mean anything here?

Research for [#402](https://github.com/firetower-cloud/firetower/issues/402), on
the wayfinder map [#399](https://github.com/firetower-cloud/firetower/issues/399).
Written 2026-11-18. Every figure below carries the year of the edition it came
from, because the DORA numbers in general circulation are mostly stale.

**Recommendation, up front: leave the elite / high / medium / low bands off the
page, and compare against this repository's own 28-day trailing baseline.** The
reasoning is in [Recommendation](#recommendation); the short version is that
DORA stopped publishing those bands a year ago, that the newest edition tells
you in as many words to compare an application against itself over time, and
that the band this repository lands in turns out to be decided by a definitional
choice this map has not yet made rather than by anything about how well it
ships.

## 1. The current published thresholds

### Which edition is current, as of 2026-11-18

| Edition | Published | Bands published? |
|---|---|---|
| 2024 Accelerate State of DevOps Report (v.2024.3) | 22 Oct 2024 | **Yes** — elite / high / medium / low, four keys |
| 2025 State of AI-assisted Software Development (v.2025.2) | 24 Sep 2025 | **No** — replaced by seven archetypes + percentile distributions |
| ROI of AI-assisted Software Development (v.2026.1) | 22 Apr 2026 | No — an ROI framework, built on the 2025 survey, no new fieldwork |

There is **no 2026 State of DevOps / State of AI report from DORA**. As of
2026-11-18 the [DORA publications index](https://dora.dev/research/publications/)
lists the 2025 report as the most recent survey edition, and the most recent
DORA publication of any kind is the April 2026 ROI report, which reuses the 2025
data. Pages on the open web titled "DORA Metrics Benchmarks 2026" are SEO
content, not DORA — several of them reprint a mangled table that gives change
failure rate as "Elite 0–15%, High 0–15%", which appears in no DORA report.

**So the last numeric bands DORA ever published are the 2024 ones**, and the
2025 edition superseded the approach rather than updating the numbers.

### The 2024 bands — the last ones published

Verbatim from the **2024 Accelerate State of DevOps Report, v.2024.3, page 13**
("Performance levels"), verified against the rendered page:

| Performance level | Change lead time | Deployment frequency | Change fail rate | Failed deployment recovery time | % of respondents* |
|---|---|---|---|---|---|
| **Elite** | Less than one day | On demand (multiple deploys per day) | 5% | Less than one hour | 19% (18–20%) |
| **High** | Between one day and one week | Between once per day and once per week | 20% | Less than one day | 22% (21–23%) |
| **Medium** | Between one week and one month | Between once per week and once per month | 10% | Less than one day | 35% (33–36%) |
| **Low** | Between one month and six months | Between once per month and once every six months | 40% | Between one week and one month | 25% (23–26%) |

\* 89% uncertainty interval.

Two things in that table are worth staring at before anyone puts it on a
dashboard.

**The change fail rate column is not monotonic.** Medium (10%) is better than
High (20%). That is not a typo in this document — it is what the report prints,
and it falls out of how the clusters are derived. DORA addresses it directly on
page 14: *"We made a decision to call the faster teams 'high performers,' and
the slower but more stable teams 'medium performers.'"* A page that renders
these four names as an ordered scale would be misrepresenting the source.

**"Elite" lead time is *less than one day*, not less than one hour.** The
sub-hour figure that circulates widely is from older editions. Against the 2024
table, anything under 24 hours commit-to-production is already top band, with no
further credit for being faster.

### What the names changed to, and when

- **"Time to restore service" is gone.** The 2024 edition renamed it **failed
  deployment recovery time** and narrowed it: the clock runs from a *failed
  deployment*, not from any incident. A dashboard labelling a metric "time to
  restore service" in 2026 is quoting a definition at least two editions old.
- **A fifth metric exists.** [DORA's four-keys
  guide](https://dora.dev/guides/dora-metrics-four-keys/) now lists five —
  change lead time, deployment frequency, failed deployment recovery time,
  change fail rate, and **deployment rework rate**. The guide has no band table
  on it at all.
- **The four named bands were retired in 2025.** The 2025 report replaces them
  with **seven team archetypes** (cluster 1 "foundational challenges" through
  cluster 7 "harmonious high-achiever"), which are qualitative profiles across
  throughput, instability, burnout, friction and product performance. They carry
  **no numeric thresholds for the four keys**. The report hedges them: *"The
  names and descriptions for each of these clusters are an interpretation of the
  data. Your team may see similar performance levels as a given cluster but may
  not feel the cluster name or description describe your team well."* (2025,
  p.16)

### What 2025 publishes instead: percentile distributions

The 2025 report's answer to "how do you compare" is a distribution of that
year's survey responses, with a cumulative "Top %" column (2025, pp.20–21,
Figures 11–15). This is the most recent comparable material DORA has published,
and it is *percentiles of 2025 respondents*, not a performance grade.

**Lead time for changes** — survey question: *"What is your lead time for
changes (that is, how long does it take to go from code committed to code
successfully running in production)?"*

| Response | % at level | Top % |
|---|---|---|
| Less than one hour | 9.4% | **9.4%** |
| Less than one day | 15% | **24.4%** |
| Between one day and one week | 31.9% | 56.4% |
| Between one week and one month | 28.3% | 84.7% |
| Between one month and six months | 13.2% | 98% |
| More than six months | 2% | 100% |

**Deployment frequency** — survey question: *"How often does your organization
deploy code to production or release it to end users?"*

| Response | % at level | Top % |
|---|---|---|
| On demand (multiple deploys per day) | 16.2% | **16.2%** |
| Between once per hour and once per day | 6.5% | 22.7% |
| Between once per day and once per week | 21.9% | **44.6%** |
| Between once per week and once per month | 31.5% | 76.1% |
| Between once per month and once every six months | 20.3% | 96.4% |
| Fewer than once per six months | 3.6% | 100% |

**Change failure rate** — survey question: *"Approximately what percentage of
changes to production or releases to users result in degraded service … and
subsequently require remediation …?"*

| Response | % at level | Top % |
|---|---|---|
| 0–2% | 8.5% | **8.5%** |
| 2–4% | 8.1% | 16.7% |
| 4–8% | 19.6% | 36.2% |
| 8–16% | 26% | 62.2% |
| 16–32% | 19.5% | 81.6% |
| 32–64% | 12.5% | 94.1% |
| >64% | 5.9% | 100% |

**Failed deployment recovery time** — survey question: *"How long does it
generally take to restore service after a change to production or release to
users results in degraded service … and subsequently requires remediation …?"*

| Response | % at level | Top % |
|---|---|---|
| Less than one hour | 21.3% | **21.3%** |
| Less than one day | 35.3% | 56.5% |
| Between one day and one week | 28% | 84.5% |
| Between one week and one month | 9.4% | 93.9% |
| Between one month and six months | 4.9% | 98.8% |
| More than six months | 1% | 100% |

(The fifth metric, **rework rate**, asks *"Approximately what percentage of
deployments in the last six months were not planned but were performed to
address a user-facing bug in the application?"* — 2025 distribution: 0–2% is the
top 6.9%, 2–4% the top 12.8%, 4–8% the top 26.5%. It is the only one of the five
that is straightforwardly measurable in this repository, and the
failure/restore ticket may want it.)

## 2. What population the bands were fitted to

**They are clusters of survey self-reports, not measurements.** Every figure in
both tables above comes from a person picking a bucket on a questionnaire about
*"the primary application or service they work on"*. Nothing was instrumented.

The 2024 report is explicit that the bands are descriptive, not normative:

> We do not set these levels in advance, rather we let them emerge from the
> survey responses. This gives us a way to see a snapshot of software delivery
> performance across all respondents each year.
>
> — 2024 report, p.13

> The performance clusters provide benchmark data that show the software
> delivery performance of this year's survey respondents.
>
> — 2024 report, p.15

**Sample size and recruitment.** 2024: *"nearly 3,000 working professionals"*
(p.91). 2025: *"a total of 4,867 respondents"* (p.103), fielded 13 June – 21
July 2025. Recruitment is **non-probability**: the 2025 methodology (p.114)
describes *"organic"* channels — blog posts, email campaigns, social media, and
*"we ask people in the community to do the same (that is, snowball sampling)"* —
supplemented by a paid panel to *"recruit people who are traditionally
underrepresented in the broader technical community"*. The 2024 report defends
representativeness by benchmarking its demographics against the 2023 Stack
Overflow Developer Survey: *"there are no major discrepancies between our sample
and Stack Overflow's. This means we have every reason to believe that our sample
is reflective of the population."* (p.91)

**Organisation size — the part that matters here.** DORA asks organisation size,
never team size, and never breaks the bands out by it.

| 2025 (Fig. 63, p.108) | Share | | 2024 (p.92) | Share |
|---|---|---|---|---|
| Self-employed | **1.6%** | | solo | **2.0%** |
| 1–10 employees | **5.3%** | | 2 to 9 | 3.2% |
| 11–50 employees | 10.2% | | 10 to 19 | 4.3% |
| 51–200 employees | 16.2% | | 20 to 99 | 14.5% |
| 201–500 employees | 12.2% | | 100 to 499 | 18.5% |
| 501–1,000 employees | 8.8% | | 500 to 999 | 11.2% |
| 1,001–5,000 employees | 14.5% | | 1,000 to 4,999 | 15.6% |
| 5,001–10,000 employees | 8.7% | | 5,000 to 9,999 | 6.7% |
| 10,001+ employees | 22.4% | | 10,000 or more | 24.1% |

A one-person operation sits in a bucket holding **1.6% of the 2025 sample** (2%
in 2024). Roughly 38% of 2025 respondents work at organisations of 1,001 people
or more, and 38.0% work in Technology.

**Does either report address small teams or solo trunk-based development?**
**No.** Searching both full texts turns up nothing on team size, solo
development, or trunk-based solo work as a condition on the bands. The closest
either comes is Gene Kim's foreword to the 2025 report, arguing the opposite
direction — that elite practice was never confined to large or fashionable
organisations: *"you didn't have to be in a startup or in Silicon Valley. You
only needed great technical practices … an architecture that enabled
independence of action … and a culture of learning."* (2025, pp.8–9)

That is a fair reading in this repository's favour: DORA's position is that the
capabilities, not the headcount, drive the numbers. But it is an argument about
*causes*, not about whether the *bands* resolve anything at this end of the
scale. The report is silent on the latter, which is itself the finding — **there
is no published basis for claiming the bands were fitted to, or validated
against, anything shaped like this project.**

What the reports *do* say about comparison is consistent and emphatic:

> These metrics are meant to be applied at the application or service level. …
> Comparing metrics between vastly different applications (for example, a mobile
> app and a mainframe system) can be misleading.
>
> — [DORA four-keys guide](https://dora.dev/guides/dora-metrics-four-keys/),
>   retrieved 2026-11-18

## 3. Does "deployment frequency" mean here what it means there?

**Partly — and the parts that fail are not the ones you would guess.**

DORA's own wording is more accommodating of a self-hosted release than the
folklore suggests. The 2025 survey asks *"How often does your organization
deploy code to production **or release it to end users**?"*, and the change
failure and recovery questions both say *"a change to production **or release to
users**"*. A release-please tag is, on DORA's wording, a release to end users.
The clock DORA stops is **publication**, not installation; it never asks whether
a user took the upgrade. So "a tag a user may install days later" is not, by
itself, a disqualifier.

Taking the four keys one at a time against this repository:

**Deployment frequency — transfers, but the unit decides the answer.** This is
the real problem, and it is not about self-hosting. Three defensible units give
three different bands on the same 15 weeks of history:

| Unit counted | Rate | 2024 band |
|---|---|---|
| ~43 release *events* | 2.9/week, one every ~2.4 days | **High** |
| 129 package releases (`firetower` + `desktop` + `mobile` tags) | 8.6/week, ~1.2/day | **Elite** (boundary) |
| 504 commits reaching `main` | ~34/week, ~4.8/weekday | **Elite** |

The map has not yet settled which of these a deployment is — #399 records it as
an open question for the failure/restore ticket. So the band would be reporting
a decision nobody has made yet, dressed as a measurement. DORA's instruction to
measure *"at the application or service level"* argues for **43 release events**
(firetower is one product shipped as three packages), which reads **High** — not
elite. Three tags cut in the same second are one deployment by any honest
reading.

**Lead time for changes — does not transfer as the page would be tempted to use
it.** DORA's definition is *"from code committed to code successfully running in
production"*. The 40-minute median in #399 is PR-open to merge: it is neither
end of DORA's interval. The DORA-equivalent clock here runs **first commit on
the branch → release tag published**, which is the merge loop *plus* the
merge-to-release gap that #399 already decided to show as its own number. That
total is plausibly over a day, which would read **High**, not Elite — while the
40-minute figure placed next to an "Elite: less than one day" band would read
Elite by a factor of 36. Quoting the merge loop against a full-pipeline band is
the single most misleading thing this page could do.

**Change failure rate — does not transfer.** DORA asks what share of releases
*"result in degraded service … and subsequently require remediation"*. Degraded
service happens in environments this project does not run, cannot observe, and
receives no telemetry about. The remediation half is observable (a fix release
shortly after a release); the degradation half is not. #399 has already
established that neither reverts (four in the whole history) nor `label:bug`
(10 issues) can stand in.

**Failed deployment recovery time — does not transfer.** Same reason, worse:
both ends of the interval are in the user's environment, and the measurable
proxy (release → subsequent fix release) is additionally lagged by whenever each
user chose to install.

**What it would take to make the comparison honest.** For deployment frequency
and lead time, three things: fix the unit at one release event per
release-please run and say so on the page; start the lead-time clock at the
first commit on the branch and stop it at tag publication, not at merge; and
state on the page that the clock stops at publication because installation is
unobservable. For change failure rate and failed deployment recovery time, it
would take a signal this project does not have — error telemetry from installed
instances, which is out of scope under #399 and arguably at odds with
`backend/README.md`'s sealed-endpoint rule. **Two of the four keys cannot be
banded here at all**, which on its own makes a four-band row impossible to draw
without inventing two of it.

## 4. What DORA has published on AI-assisted development

This is the most directly relevant material in the whole report, and the finding
reversed between editions. Both are worth knowing, because the 2024 number is
still widely quoted as current.

**2024 (v.2024.3, pp.39–40) — AI made both worse:**

> We see that the effect on delivery throughput is small, but likely negative
> (an estimated 1.5% reduction for every 25% increase in AI adoption). The
> negative impact on delivery stability is larger (an estimated 7.2% reduction
> for every 25% increase in AI adoption).

The section is headed, flatly, *"AI is hurting delivery performance"*.

**2025 (v.2025.2) — throughput flipped, stability did not:**

> AI adoption now improves software delivery throughput, a key shift from last
> year. However, it still increases delivery instability. This suggests that
> while teams are adapting for speed, their underlying systems have not yet
> evolved to safely manage AI-accelerated development.
>
> — 2025 report, p.4 (Key findings)

> Despite all the benefits, friction remains unaffected, burnout stays flat, and
> delivery instability rises — unless the surrounding system and culture
> changes.
>
> — 2025 report, p.39

The framing device is amplification: *"AI's primary role in software development
is that of an amplifier. It magnifies the strengths of high-performing
organizations and the dysfunctions of struggling ones."* (p.3) The mechanism
offered in the launch post is that *"an increase in change volume leads to
instability"* absent *"strong automated testing, mature version control
practices, and fast feedback loops"*.

Adoption context from the same edition: 90% of respondents use AI at work, more
than 80% believe it has increased their productivity, and **30% report little or
no trust in the code it generates** (p.4).

One methodological caveat DORA attaches to its own 2025 numbers, worth carrying
onto any page that cites them — footnote 20: *"Last year, we spoke in terms of
'effects'. This year, however, we will speak in terms of comparisons … we don't
want to give false assurances that we understand the underlying causal
structure."* These are between-respondent comparisons, not measured
interventions.

### Why this matters for this dashboard specifically

This repository is near the extreme of the independent variable in that
research — not AI-assisted, AI-written. DORA's current published finding is that
as AI adoption rises, **throughput rises and delivery stability falls**.

Mapped onto the four keys: AI pushes *up* exactly the two metrics this project
can measure well (deployment frequency, lead time) and pushes *down* exactly the
two it cannot measure at all (change failure rate, failed deployment recovery
time). A page showing DORA bands would therefore show two flattering top-band
readings and two blanks — and the two blanks are the ones DORA's own research
predicts are where the cost is landing. That is not a neutral omission. It is a
dashboard that is structurally incapable of showing the bad news while being
well equipped to show the good.

This is the strongest argument in this document for not drawing the bands, and
it also sets a job for the failure/restore ticket: **the rework-rate-shaped
metric is not a nice-to-have here, it is the only one of the five that could
contradict the others.** DORA's rework question — the share of deployments that
were unplanned and made to fix a user-facing bug — is answerable from this
repository's own history, since conventional commits are enforced and `fix` is
trustworthy on `main`.

## 5. Recommendation

**Option 3: leave the bands off, and compare against this repository's own
trailing baseline.** Stated plainly for #406 to draw.

Five reasons, in descending order of weight:

1. **DORA says to.** Not as a caveat buried in an appendix — as the direct
   answer to the question this page is being built to ask:

   > You may be wondering how your team compares to the rest of the participants
   > in this year's research. … **the best, most insightful comparisons of
   > software delivery performance are for the same application or service over
   > time.** The goal is continuous learning and improvement, not necessarily
   > achieving top software delivery performance.
   >
   > — 2025 report, p.20

   And from 2024, p.14: *"Improving should be more important to a team than
   reaching a particular performance level. The best teams are those that
   achieve elite improvement, not necessarily elite performance."*

2. **There are no current bands to show.** The newest DORA survey edition
   doesn't publish them. Putting elite / high / medium / low on a page in
   November 2026 means shipping a 2024 artefact that the 2025 edition
   deliberately replaced, and it would need a "2024" label next to it forever.

3. **The band is decided by an unsettled definition, not by performance.** The
   deployment-frequency table in §3 moves between High and Elite depending on
   whether a deployment is a release event, a tag, or a merge. A number whose
   grade can be changed by a choice nobody has made yet is not a measurement of
   how well the project ships.

4. **Two of the four cannot be measured here**, so half the row would be
   permanently blank or fabricated — and per §4 they are the half where the
   risk is.

5. **The measurable two are saturated.** Lead time and deployment frequency will
   sit in the top band more or less permanently. A gauge that has read "Elite"
   for 15 weeks and will read "Elite" for the next 15 cannot answer "is this
   getting better or worse", which is the question in the destination statement
   of #399. The trailing baseline can.

### Against this recommendation, honestly

The ask in #402 was for a reference point, and "we are 12% slower than last
month" is a weaker motivator than "we are elite". A trailing baseline also has a
real failure mode the bands do not: **it cannot tell you that you are drifting
somewhere bad slowly**, because the thing you are compared against drifts with
you. Mitigations are in the spec below — keep the full 15-week series visible
behind every number, and anchor the variation band to all history rather than to
the previous window alone.

If an external anchor is wanted anyway, the honest form is **not** the 2024
bands but a single dated line of text under the two metrics that transfer, from
the 2025 percentile tables in §1 — "2025 DORA survey: a lead time under one day
was the top 24.4% of 4,867 respondents" — rendered as a sentence, not a gauge,
not a colour, and not a badge. A percentile of a named survey in a named year is
a claim that can be checked. "Elite" is not.

### The baseline, specified

**Window: 28 days, trailing, compared against the immediately preceding 28
days.** 28 rather than 30 because it is a whole number of weeks: this project
merges on a weekday rhythm, and a 30-day window contains four or five weekends
depending on where it starts, which at ~13 merges a week is a large source of
movement that means nothing. 28 is also long enough that one quiet week does not
dominate, and short enough that two windows fit inside the 15 weeks of history
twice over.

**Statistic: the median** for every duration (lead time, merge-to-release gap,
recovery proxy), not the mean. #399 records p90 at 19 hours against a 40-minute
median — a distribution that long-tailed makes the mean a report on the single
worst PR in the window. Counts and rates for frequency metrics.

**What is drawn per metric:**

- The **current value** — the 28-day trailing figure, with the window's dates.
- The **delta against the previous 28 days**, as direction and magnitude
  ("median lead time 2h 10m, up 18% on the previous 28 days"). No red/green, no
  arrows that imply a verdict — #399's standing warning about metrics as
  incentives applies hardest here, and "up" is not "bad" for every metric on the
  page.
- A **sparkline of the rolling 28-day value computed daily across all history**,
  so the trend is visible rather than inferred from one delta. This is the part
  that answers "better or worse over time"; the delta alone does not.
- A **shaded normal-variation band** behind the sparkline: the interquartile
  range of that metric's rolling 28-day values over all available history. This
  is the honest replacement for a performance band — it answers "is this number
  unusual *for us*", which is a question the data can actually support, where
  "is this number elite" is not.

**Guards:**

- **Suppress the comparison when the window is thin.** Below ~10 events in a
  28-day window, show the value and say "too few to compare" rather than a
  percentage. A 50% swing on four data points is noise rendered as news.
- **Backfill makes the first comparison available from day 56** of history.
  With a first commit on 2026-08-13, the whole series is drawable today; the
  variation band will be narrow and should widen honestly as history
  accumulates rather than being frozen at launch.
- **Label the window on the page**, not in a tooltip. "28 days to 2026-11-18"
  next to the number.

**One number that has no DORA analogue and should be first-class anyway:** the
merge-to-release gap. #399 already decided to show it. It is this project's most
honest "how well do we ship" signal, because it is entirely within the project's
control, entirely measurable, not saturated, and not gameable in an obviously
harmful direction.

## Sources

Primary, all retrieved 2026-11-18:

- **2024 Accelerate State of DevOps Report**, v.2024.3 —
  https://dora.dev/research/2024/dora-report/ · PDF:
  https://services.google.com/fh/files/misc/2024_final_dora_report.pdf
  (bands p.13, cluster caveats pp.14–15, AI effects pp.39–40, demographics
  pp.91–92). Errata: https://dora.dev/research/2024/errata/ — v.2024.3 is the
  final corrected text, and no erratum touches the figures quoted here.
- **2025 State of AI-assisted Software Development Report**, v.2025.2,
  published 24 Sep 2025 — PDF:
  https://services.google.com/fh/files/misc/2025_state_of_ai_assisted_software_development.pdf
  (foreword pp.8–9, archetypes pp.16–19, "How do you compare?" +
  distributions pp.20–21, AI outcomes pp.34–39, demographics pp.103–108,
  methodology pp.113–114)
- **DORA publications index** — https://dora.dev/research/publications/
- **DORA four-keys guide** —
  https://dora.dev/guides/dora-metrics-four-keys/
- **ROI of AI-assisted Software Development report**, v.2026.1, 22 Apr 2026 —
  https://dora.dev/ai/roi/report/ (gated; not quoted here beyond its date and
  that it reuses the 2025 survey)
- **Announcing the 2025 DORA Report**, Google Cloud blog, 24 Sep 2025 —
  https://cloud.google.com/blog/products/ai-machine-learning/announcing-the-2025-dora-report

Secondary, used only for the publication date and data basis of the April 2026
ROI report, which is behind a registration form:

- InfoQ, "New DORA Report Claims Strong Engineering Foundations Drive AI Return
  on Investment", May 2026 —
  https://www.infoq.com/news/2026/05/dora-roi-ai-assisted-dev-report/

Figures for this repository (215 merged PRs, 504 commits, ~43 release events,
129 package releases, 40-minute median PR, first commit 2026-08-13) are taken
from the Notes section of #399 and not re-derived here.
