# Bench jobs

The first manufacturing department follows every piece at the bench, from design and CAD through casting, stone setting, finishing and quality control to ready. It lives in [`@karatos/manufacturing`](../../packages/manufacturing) and uses the same department contract as retail: payload schemas, normalizers, extractors and reasoners. Turn it on with the id `bench` in `ENABLED_DEPARTMENTS` (an empty list runs it with every other department).

Production planning and labor cost per piece are a later step on the [roadmap](../roadmap.md#phase-28-manufacturing-departments). This department doesn't schedule the bench or put a labor cost on a job.

## Events it owns

| Event | What it is | Kept as |
| --- | --- | --- |
| `bench_job.opened` | A job and what it is for: `jobId`, and optionally `description`, `promisedBy` (YYYY-MM-DD), `repairTicketId`, `customOrderId`, `metal` (gold, silver, platinum, palladium) and `karat` | A `bench_job` entity and a `bench.job` signal. A later event for the same job replaces it |
| `bench_job.stage_recorded` | The job entered a stage at the event's `occurredAt`: `jobId`, `stage`, and optionally `jeweler`, `metalInGrams`, `metalOutGrams`, `qcResult` (pass or fail) and `failedStage` | A `bench.stage` signal per record |

The stages are `design` (design and CAD), `casting`, `setting` (stone setting), `finishing` (finishing and polish), `qc` (quality control), `ready`, `on_hold` and `cancelled`. Only a `qc` record has a `qcResult`, and only a failed one names the `failedStage` it sends the work back to (design, casting, setting or finishing). A record that breaks these rules, names an unknown stage or has a weight of zero or less is dead-lettered with the reason.

`metalInGrams` is the metal issued to the bench for the stage; `metalOutGrams` is what came back from it, the piece and any filings, sprue or scrap returned. Weigh metal only: weigh a piece before its stones go in, or take their weight off.

## Using what repairs and custom orders already know

- A job that names a `repairTicketId` or `customOrderId` takes its promised date and description from that ticket or order when it has none of its own. It is closed once the ticket is ready, picked up or cancelled, or the order is ready, delivered or cancelled.
- A custom order no bench job names is followed through its own `custom_order.stage_changed` stages: design and CAD are design, approval is on hold (waiting on the customer isn't bench time), and ready and delivered are ready. Its stages also count toward the store's typical times.
- Repair statuses (`at_bench`, `sent_out`) don't say which bench stage a ticket is in, so a repair is followed here only through a bench job that names it.
- Spot prices from the metals department value lost metal.

These need the repairs, custom orders and metals departments turned on to have anything to read.

## What it raises

| Rule | Raises | Dollar figure |
| --- | --- | --- |
| `bench.stuck` | A job in one stage for more whole days than that stage's limit: design 7, casting 4, setting 4, finishing 3, quality control 2, on hold 14. Days count from the first of the job's latest records in a row in that stage, so a hand-over between jewelers doesn't restart the clock, and the recommendation names whoever had it last | None |
| `bench.promised-date` | A job the store's own history says will miss its promised date, and one already past it that no other department follows | None |
| `bench.rework` | A stage, or a jeweler, whose work quality control sends back too often | None |
| `bench.metal-loss` | A job that lost more metal across its stages than the tolerance, 3% of the most metal issued to it | `protects`: the metal lost above the tolerance, at the latest spot price |

### Promised dates from the store's own history

For every job that finished, the time from first entering each stage to reaching ready is one sample; rework, waits and stages skipped are part of it, so none of them is guessed. A stage's typical time is the median of its samples once there are 3 or more (`BENCH_HISTORY_MIN_JOBS`). An open job's likely ready day is its first time in its current stage plus that stage's typical time. When that day is after its promised day, it is raised with the median, how many finished jobs it comes from and how many days late it is likely to be. A stage with too little history raises nothing, rather than a guess.

A job past its promised date is raised as late, unless it is for a repair ticket or custom order, whose own department already raises it. A custom order no bench job names that is due within 7 days and hasn't reached finishing is left to custom orders, which raises it, and one stuck 14 days or more in one stage is left to custom orders too.

### Rework from quality control

Each quality control record checks every work stage the job went through since its last check, against the jeweler who last worked that stage. A failed check counts against the stage it names, else the earlier stage the job moves to next, else the last stage worked before the check. A check with no result is read from what happens next: back to an earlier stage is a fail, on to anything else a pass, and nothing yet isn't counted.

Over the last 90 days (`BENCH_REWORK_LOOKBACK_DAYS`), a stage or a jeweler is raised when 5 or more of their pieces were checked (`BENCH_REWORK_MIN_CHECKED`), 2 or more failed (`BENCH_REWORK_MIN_FAILED`) and the share failing is 20% or more (`BENCH_REWORK_RATE`). A stage's recommendation names the jeweler with the most of its failures; a jeweler's names the stage most of theirs were at. Work recorded without a jeweler counts toward its stage only.

### Metal loss per job

A job's loss is the sum of metal in less metal out over its records that have both weights, so a stage that gained weight (solder, a sizing stock) offsets one that lost. It is compared with the tolerance times the most metal issued to the job in one record, to the milligram. A job is checked while it was last weighed within 30 days. The recommendation names the stage that lost the most and who worked it.

The dollar figure is the metal lost above the tolerance at its melt value: grams, times the alloy's purity (karat over 24 for gold, 92.5% for silver, 95% for platinum and palladium), times the latest spot price of that metal from the last 30 days. A job with no metal, gold with no karat, or no recent spot price is raised without one.

Why only metal loss has a dollar figure: a stuck or late job isn't money lost, and what rework costs is bench time, which needs the labor cost that is a later step. Like late repairs and stalled custom work, these carry no `impact`.

## Settings

| Setting | Default | What it does |
| --- | --- | --- |
| `BENCH_STAGE_LIMIT_DAYS` | design 7, casting 4, setting 4, finishing 3, qc 2, on_hold 14 | Whole days, 1 to 365, a job can be in a stage before it is raised: one number for every stage (`5`), stages of their own (`casting=5, setting=3`), or both (`5, qc=1`) |
| `BENCH_METAL_LOSS_PERCENT` | `3` | The metal a job may lose across its stages, as a percent of the most issued to it, above 0 and up to 50 |

Both are checked when the instance starts, which won't start with one it can't read. In code, `benchDepartment({ stageLimitDays, metalLossShare })` builds the department with them, and `parseStageLimits` reads the first.

## Bench jobs from a CSV export

The [POS CSV import](../integrations/inventory_pos.md) reads bench exports: files whose name contains `bench`, `job bag`, `work order` or `production`, one row per stage a job enters.

| Column | Required | What it holds |
| --- | --- | --- |
| Job (or Job Number, Job ID, Job Bag, Work Order) | yes | The job's id |
| Stage (or Step, Process) | yes | The stage, read by keyword: CAD or design; wax, print or casting; setting or mounting; polish, finishing, plating or engraving; QC, quality or inspection; ready or complete; hold, waiting or approval; cancelled or scrapped |
| Date (or Time, Stage Date, Timestamp) | yes | When the job entered the stage, with its time when the export has one |
| Jeweler (or Bench Jeweler, Worker) | | Who worked it |
| Metal In (g), Metal Out (g) (or Weight In, Weight Out, Issued (g), Returned (g)) | | Grams issued and returned |
| QC Result (or QC, Inspection) | | Pass, OK or approved; fail, rejected, rework or sent back |
| Sent Back To (or Failed Stage, Rework Stage) | | On a failed check, the stage the work goes back to |
| Description (or Item, Piece), Promised (or Due Date), Repair Ticket, Custom Order, Metal | | The job's own details. They may repeat on every row or appear on some; the last filled value wins |

Each row is one `bench_job.stage_recorded`, keyed by job, stage and time, so a nightly export of every job's history stores each step once. Each job in a file is one `bench_job.opened`, keyed by a hash of its details, so a changed promise date is a new event and the same export again is not. A word that names no stage or result, or a weight that isn't a number of grams, is dead-lettered with the row kept.

## What the records allow, and what they don't

- A job is only as current as its last record. A job finished but never recorded as ready reads as stuck until it is.
- Typical times come from the jobs in the reasoning window, so in a busy workshop they are the most recent jobs'.
- Rework is counted from quality control records. Work sent back without a QC record (straight from setting back to casting) isn't counted.
- A job for a custom order that is also followed by custom orders can be raised by both: custom orders on its own stage and due date, bench on the store's history.
- Metal loss is only as good as the weighing: a stage that doesn't weigh back its filings and scrap shows them as lost.
