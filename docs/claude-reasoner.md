# The Claude reasoner

After the department rules run, Claude can read what they saw and found and add findings they miss: a pattern across several signals or rules, a likely shared cause, a risk no single rule names. It is **off by default**. It runs only when `CLAUDE_REASONER=on` **and** `ANTHROPIC_API_KEY` is set; with either missing the instance logs why at startup (never the key) and reasons with the rules alone.

## What it sends

One request per reasoning run, to Claude Opus 5.5 (`claude-opus-5-5`), with fixed instructions and a compact JSON summary of the run:

- **Signals**: the most recent ones, those the rules cite first, up to 150, each with its kind, subject, value, confidence and up to 5 of the events it came from.
- **The rules' recommendations**: up to 50, each with its rule, confidence, any dollar impact (kind and cents), whether it is degraded, and the signals and events it rests on.

Ids are replaced by short references (`S1`, `E1`, `R1`), so nothing inside an id (a mail message id can hold an address) is sent; the instance keeps the map from reference back to id. **No customer names, emails or phone numbers are sent**:

- Recommendation text (`summary`, `expectedImpact`) is never sent, because it can name a customer. The organization id isn't sent either.
- A value field whose name can hold a person's details (`name`, `customerName`, `email`, `phone`, `mobile`, `address`, `note`, `message`, `description`, `contact` and the like) is left out. Fields ending in `Ref`, `Refs` or `Hash` are kept: those are the hashed customer references the connectors already write.
- Any other string that could be contact details or free text is replaced with `"[redacted]"`: one with spaces or an `@`, a run of 7 or more digits that reads as a phone or card number, a capitalized word that could be a name, or anything over 64 characters.
- Values are cut at 3 levels deep, 10 items a list and 20 fields an object.

The model gets no tools. It reads the summary and answers; it can't call a vendor, write anything or reach other data. Writes still go only through the `WriteGate` (see [security](security.md)).

## What comes back

JSON in a fixed schema, through structured outputs: at most 8 findings, each with a `topic`, a `summary` for the owner, an `expectedImpact` sentence, a `confidence` from 0 to 1 and `cites`, the references it rests on. Then:

- **Provenance is mandatory.** A finding is dropped when it cites nothing, or when any reference it cites isn't in the summary. A kept finding's provenance lists the signals, events and rule recommendations it cites (as `provenance.recommendationIds`), with the events and signals behind those, and the run's documents.
- **Confidence is capped below the rules'.** A finding that cites no rule recommendation is capped at 0.5 and 0.05 below the lowest rule confidence in the run (never below 0.01). One that cites a rule recommendation is corroborated and may reach the highest confidence among those it cites, never more.
- **It is a rule like any other to the feedback loop.** Findings are recommendations with `rule: "claude"` and ids `rec_claude_<topic>_<day>`, so the same topic keeps its subject from day to day. A dismissed one waits out the [cooldown](feedback-loop.md), and dismissals and measured value rank the `claude` rule like any rule. Feedback can lower a finding but never lift it past its cap. They follow the rules' recommendations in the run.
- **A finding is marked degraded** when the documentation layer says the docs are stale, like any recommendation.

## Cost and limits

| Setting | Default | What it does |
| --- | --- | --- |
| `CLAUDE_REASONER` | `off` | `on` runs it after the rules when `ANTHROPIC_API_KEY` is set |
| `CLAUDE_REASONER_MAX_TOKENS` | `40000` | The most tokens, in and out, one run may spend, 8000 to 200000. 40000 is about 30 cents at Claude Opus 5.5's list price |
| `CLAUDE_REASONER_TIMEOUT_SECONDS` | `90` | Seconds to wait for the answer, 5 to 300 |

Before calling, the summary is estimated on the high side (three characters a token). If it and at least 2000 output tokens don't fit the cap, older signals and recommendations are left out, halving until they do; the answer may use at most 8000 output tokens, thinking included, and never more than the cap leaves. If even an empty summary can't fit, the call is skipped. The instructions are marked for prompt caching, so repeated runs can read them from the cache; the summary changes every run.

The request opts into the API's server-side fallback (`server-side-fallback-2026-07-01`, `fallbacks: "default"`), so a request Claude Opus 5.5 declines can be answered by the API's default fallback model. The model that answered is what the run records.

## It never breaks a run

A time-out, an API error, a refusal, an answer cut off at its token limit, or output that isn't JSON in the schema ends the Claude pass with no findings. The rules' recommendations are saved and returned as always, and the run records why. One log line per pass, with counts and codes only, such as:

```
reasoning (claude): succeeded, 2 findings kept, 1 dropped, 6120 tokens in, 1480 out
reasoning (claude): failed (timeout), 0 findings kept, 0 dropped
```

## What the run records

Each `reasoning_runs` row has `model_reasoning` (migration `20261128000001_reasoning_run_model.sql`), and `ReasoningRun.modelReasoning` in code, with `claude` added to its `reasoners`:

```json
{
  "reasoner": "claude",
  "model": "claude-opus-5-5",
  "promptVersion": "claude-reasoner-v1",
  "status": "succeeded",
  "reason": null,
  "tokenCap": 40000,
  "usage": { "inputTokens": 6120, "outputTokens": 1480, "cacheReadInputTokens": 1100, "cacheCreationInputTokens": 0 },
  "sent": { "signals": 150, "recommendations": 12, "omittedSignals": 50, "omittedRecommendations": 0 },
  "findings": 2,
  "dropped": 1
}
```

`status` is `succeeded`, `skipped` (not called: `token_cap`) or `failed`, with `reason` one of `timeout`, `refusal`, `truncated`, `malformed_output` or `error:<ErrorClass>`. It holds counts and codes, never the summary or the answer's text. The prompt version changes whenever the instructions or schema do.

## In code

`ClaudeReasoner` in `@karatos/core` takes a `ClaudeClient`, a function that sends one request, so it has no SDK of its own and tests use a mocked client. `@karatos/server`'s `anthropicClaudeClient` is that client over the Anthropic SDK, and `instanceClaudeReasoner(config, env)` builds the reasoner from the settings, or returns null with why it is off. `BrainPipeline`'s `modelReasoner` option runs any `ModelReasoner` after the rules and the feedback loop.
