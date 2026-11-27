# Production planning

The second manufacturing department reads what [bench jobs](bench.md) records and answers three questions: what each piece cost to make, whether the shop is losing more metal than it used to, and whether the work in hand fits the bench's hours before it is promised. It lives in [`@karatos/manufacturing`](../../packages/manufacturing) beside bench jobs. Turn it on with the id `production` in `ENABLED_DEPARTMENTS` (an empty list runs it with every other department). It owns no events, so it needs `bench` turned on to have anything to read.

## What it reads

| From | What |
| --- | --- |
| `bench_job.stage_recorded` | Each stage's jeweler, metal in and out, and `laborMinutes`: the bench minutes worked on that stage. A stage worked over several records adds them up |
| `bench_job.opened` | The job's metal and karat, promised date, and the repair ticket or custom order it is for |
| `repair.received` | The repair's `estimateCents`, the price of a job for that ticket |
| `custom_order.created` | The order's `quotedCents`, the price of a job for that order. It wins over a repair's estimate when a job names both |
| `metal.price_updated` | The latest spot price of each metal from the last 30 days, to value metal |

`laborMinutes` is optional: any number above 0 and up to 10,000. Record it on the stage record the minutes were worked in, or on a later record of the same stage. The time between two records isn't used as labor: a job waits in a queue, overnight and at the caster, and none of that is bench time. A job with no minutes recorded has no labor cost and doesn't teach planning anything.

## What it raises

| Rule | Raises | Dollar figure |
| --- | --- | --- |
| `production.labor-cost` | A piece whose labor and metal so far come to more than 60% of its repair estimate or custom order quote (`PRODUCTION_COST_SHARE`), while bench time was last recorded on it within 30 days | `saves`: the cost above 60% of the price, the margin quoting work like it from its bench time keeps |
| `production.loss-trend` | An alloy, or a jeweler, losing at least one point more of the metal issued in the last 30 days than over the 90 days before | `protects`: the rise in loss rate times the metal issued in the last 30 days, at melt value |
| `production.capacity` | A jeweler with more work queued than their hours over the next 7 days, or the whole bench when everyone together is over, naming the promised jobs the queue pushes past their dates | None as `impact`; the summary says what the hours over cost at the bench rate |

### Labor and metal cost per piece

Each record's minutes are priced at its jeweler's hourly rate (`BENCH_LABOR_RATE`, default $45), so a piece set by one jeweler and polished by another costs each one's time at their own rate. Minutes with no jeweler use the rate for everyone.

The metal that is the shop's is valued at melt (grams, times the alloy's purity, times the latest spot price):

- For a repair, only the metal lost across its stages (metal in less metal out), since the piece is the customer's. A repair that gained weight adds nothing.
- For anything else, the most metal issued to it in one record, which is what the piece took from stock, losses included.

A job with no metal, gold with no karat, or no spot price from the last 30 days is costed on labor alone.

`pieceCosts` gives every job with bench minutes its labor minutes by jeweler, labor cost, metal and total, finished or not. The rule raises those with a price, finished or still at the bench: a finished one says to check how such work is quoted, an open one to talk to the customer or the jeweler before more time goes in. A job made for stock has no price here and is never raised.

### Shop-wide metal loss trends

Bench jobs raises one job that lost too much. This rule looks at the whole shop over time. Every weighing (a record with metal in and out) counts toward its job's alloy (metal and karat, such as 14K gold) and toward the jeweler who worked it. For each, the loss rate is the metal lost over the metal issued, a gain offsetting a loss, in two windows:

- the last 30 days (`PRODUCTION_TREND_RECENT_DAYS`), and
- the 90 days before them (`PRODUCTION_TREND_BASELINE_DAYS`). A weighing exactly 30 days old is in the earlier window.

It is raised when each window has 5 weighings or more (`PRODUCTION_TREND_MIN_RECORDS`) and the recent rate is at least one point higher (`PRODUCTION_TREND_RISE`, 1% to 2% is a rise of one). An alloy's recommendation names the jeweler who lost the most of it recently, and a jeweler's the alloy they lost the most of.

The dollar figure is the rise in loss rate times the metal issued in the last 30 days, alloy by alloy at each one's own spot price: what the shop lost beyond its own usual rate. Metal with no karat or recent spot price is left out of it, and the basis says how many grams.

### Planning the bench against its hours

The plan is worked out from the store's own finished jobs, deterministically, so each figure can be checked:

1. **Typical bench minutes per stage.** For each stage, the median over finished jobs of each job's total minutes in it, rework included. A stage needs 3 finished jobs with minutes in it (`BENCH_HISTORY_MIN_JOBS`).
2. **What follows each stage.** A later stage is planned for a job when at least half of the finished jobs that went through its current stage went on to it (`PRODUCTION_FOLLOW_SHARE`).
3. **What's left.** An open job in design, casting, setting, finishing or quality control needs the rest of its current stage's typical minutes (less what is already recorded on it, never below zero) and the typical minutes of each later stage it is likely to go through. Jobs on hold, ready or cancelled aren't planned.
4. **Who does it.** The current stage goes to whoever has the job; a later one to whoever did that stage most in the last 30 days (`PRODUCTION_ACTIVE_DAYS`), else whoever has the job. A job with work no one can be given isn't planned.
5. **When.** Jobs are taken earliest promise first, then jobs with no promise, oldest first. Each stage starts once the one before it ends and its jeweler is free, and takes its hours at the jeweler's hours a day (`BENCH_DAILY_HOURS`, default 6). Days are the store's working days from the start of today, from `STORE_HOURS` and `STORE_CLOSED_DATES` on the store's clock.

The bench is everyone with a stage recorded in the last 30 days, and anyone named in `BENCH_DAILY_HOURS`. Each one's hours over the next 7 calendar days (`PRODUCTION_PLAN_DAYS`) are their hours a day times the working days in them.

A jeweler is raised when the work planned for them is more than their hours over those days, by stage, with who else has hours free and what the hours over cost at the jeweler's rate (overtime or sending work out costs at least that). When the whole bench is over, one recommendation is raised for it instead, since moving work between benches won't clear it.

A promised job is named as at risk when it finishes after its promised date with the queue ahead of it, though its own work alone would finish by then. A job already past its date, or one whose own work doesn't fit before it, is late whatever the queue does; bench jobs raises those.

Why the capacity rule has no `impact`: a late job isn't money lost, and the cost of the hours over is what acting costs, not what it brings back. The summary carries that figure so the owner can weigh it.

## Settings

| Setting | Default | What it does |
| --- | --- | --- |
| `BENCH_LABOR_RATE` | `45` | What an hour of bench time costs the shop, in dollars from 1 to 1000 with up to two decimals: one figure for everyone (`45`), jewelers' own (`Ana=55`), or both (`45, Ana=55, Ben Ortiz=40`). Count wages and what comes with them |
| `BENCH_DAILY_HOURS` | `6` | Hours of bench work a jeweler does in a working day, 0.5 to 24, written the same way (`6, Ben=4`). Count the hours at the bench, not the hours in the building |

Names match whatever their case, and a jeweler named twice, a second figure for everyone, or a figure out of range stops the instance at start, naming the part that's wrong. The working days come from the store's hours (`STORE_TIME_ZONE`, `STORE_HOURS`, `STORE_CLOSED_DATES`; see [store hours](../deployment/instances.md#store-hours)). In code, `productionDepartment({ laborRateCents, dailyHours, storeHours })` builds the department with them, and `parseLaborRates` and `parseDailyHours` read the first two.

## Bench minutes from a CSV export

The [bench export](bench.md#bench-jobs-from-a-csv-export) reads bench time from a `Labor Minutes` column (or `Labor (min)`, `Bench Minutes`, `Minutes`), or a `Labor Hours` column (or `Labor (h)`, `Bench Hours`, `Hours`), turned into minutes. Minutes win when a row has both. A value that isn't a number above 0 is dead-lettered with the row kept.

## What the records allow, and what they don't

- Labor cost is only as good as the minutes recorded. A stage worked but not timed costs nothing here, and planning learns nothing from it.
- The price is the repair's estimate or the custom order's quote. A piece made for stock, or sold through the POS without either, has no price to compare with.
- Metal is valued at melt, the shop's cost of replacing it, not what it sells for in a finished piece.
- Typical minutes, what follows each stage, and the loss windows come from the signals in the reasoning window, so in a busy workshop they are the most recent jobs'.
- The plan counts bench hours only. Time at the caster, waiting on stones and waiting on the customer aren't in it; bench jobs' promised-date rule covers those from the store's typical stage-to-ready times.
- Each stage is planned on one jeweler. A stage two jewelers share is planned on whoever has it.
- Today counts as a full working day, whatever the hour.
