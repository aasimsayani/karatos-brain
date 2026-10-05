# Why Brain A gets more valuable over time

Most business software is worth about the same on day 400 as on day 1. Brain A is designed so that each connected system, each department, each decision and each client makes every other part smarter. These are the mechanisms, and the code that carries each one.

## 1. Every source enriches every other source

All data becomes events, then canonical entities, before anything reasons about it (`BrainPipeline`). A customer from Shopify, the same person in HubSpot, and their repair ticket at the counter resolve to one entity (`linkIdentity`). That's why the second integration is worth more than the first: the third connector doesn't add one more silo, it adds context to everything already there.

| Connected | What becomes visible |
| --- | --- |
| Shopify only | What sold online |
| + POS | Total demand across channels, and in-store-only bestsellers |
| + repairs | Which customers come back, and which pieces fail |
| + bank statements | True margin after fees, refunds and metal costs |
| + messages | Why customers buy, and what they asked for that you didn't have |

## 2. Departments share signals

Each retail department module emits signals into one shared memory. Reasoners in one department read signals from others:

- A **repair** that keeps recurring on a style becomes a **buying** signal (talk to that vendor) and a **merchandising** signal (stop reordering it).
- A **clienteling** anniversary date plus **inventory** of the style they browsed becomes a **sales** recommendation.
- A **gold buying** spike plus the **metal price** feed becomes a **finance** cash-flow alert.

The number of useful cross-department combinations grows much faster than the number of departments.

## 3. Decisions teach the system

Every recommendation carries confidence and provenance. Every human accept, reject or override is stored (`feedback`, `decisions`), and so is what happened next (`outcomes`). That gives Brain A the data to calibrate its confidence, so a reasoner whose advice keeps getting overridden loses weight, and one that keeps paying off gains it. The owner's judgment becomes part of the system instead of staying in their head.

## 4. Memory compounds

`memories` keeps long-lived knowledge: customer preferences, vendor quirks, what worked last holiday season. Each reasoning run consults it, and each run's outcomes add to it. Year two reasons with year one's lessons.

## 5. Documentation keeps it honest

Reasoning checks the source-of-truth docs first, and marks itself degraded when they drift (`RegistryDocumentationSource`). As the business documents more of how it works, the reasoning gets more grounded, and nobody is misled by advice built on stale rules.

## 6. Every client improves the product

Each client runs an isolated instance (see [instances](../deployment/instances.md)), but they all share the same public code. A connector, department module or reasoner built for one jeweler ships to all of them. Later, clients who opt in could contribute anonymized, aggregated benchmarks, such as sell-through rate by category or repair turnaround, so every store can see how it compares. Raw client data never leaves its own instance.

## What this means for the build order

1. Get the data in, correctly and completely: connectors, identity resolution, dead letters.
2. Cover departments broadly, so cross-department signals exist.
3. Close the loop: decisions, outcomes, confidence calibration.
4. Then add more clients, which multiplies everything above.
