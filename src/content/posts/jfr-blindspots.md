---
title: JFR Blindspots
pubDatetime: 2026-08-19T14:10:50+05:30
draft: false
tags:
  - jfr
  - performance
  - jvm
description: Why Java Flight Recorder's default CPU-sampling profile can miss queue backpressure and fast blocking calls entirely — and four ways to get the missing signal back.
---
## TL;DR

Java Flight Recorder's default profiling configuration (the `profile` template — what you get from JMC's "Start Flight Recording" wizard, most "attach and capture" tooling, and JFR-mode `async-profiler` runs out of the box) is CPU-sampling biased. It's great at answering *"what is the CPU busy doing"* and borderline useless at answering *"what is this thread actually waiting on,"* because every blocking or duration-based event — thread parks, monitor waits, socket reads, file writes — is threshold-gated, typically at 10–20ms. Anything faster than that threshold is treated as beneath notice and never gets recorded. Which is a problem, because backpressure, fast retries, and hot-but-brief locks all live comfortably under that threshold, having a party JFR doesn't know is happening.

Here's the genuinely annoying part: the recording doesn't look broken. You get a real file, non-zero size, opens fine in JMC, no errors. You look at the thread you care about, see low CPU and a whole lot of nothing else, and conclude it's basically idle. It isn't. It's busy — just busy doing something the recording was configured not to see. Below: how that happens, what it looks like when it bites you, the exact commands to reproduce it and then fix it, and four ways to get the missing signal back (spoiler: none of them are free).

## A concrete scenario

Picture a classic producer/consumer setup: one thread reads from a source — a socket, a file, a queue, doesn't matter — and pushes items onto a fixed-size in-memory buffer; a pool of worker threads drains that buffer and does the real work. Log shippers, stream processors, ETL jobs, anything with a "read fast, process slower" split — this shape is everywhere.

Throughput has fallen off a cliff. It used to cruise at ~50,000 items/sec; now it's stuck around 17,000/sec under what looks like identical load. You reach for a JFR recording to find out why. It comes back clean — legit multi-megabyte file, no complaints. You pull up the producer thread specifically, since that's the one reading off the source, and here's what greets you:

- ~22% CPU utilization
- **Zero** `ThreadPark` events
- **Zero** `ThreadSleep` events
- **Zero** `JavaMonitorWait` events
- 3 `SocketRead` events, in a multi-minute window

Nothing here screams "blocked." Nothing whispers "waiting on a lock" either. By the numbers in the file, this thread looks basically like it's taking a nap. So where did the other ~78% of its wall-clock time actually go? Honest answer: **you don't know yet.** You have a throughput graph yelling that something is wrong and a profiler shrugging. Those two things aren't in conflict — they're both consistent with a full queue throttling the producer — but the JFR file hasn't *proven* anything. "The queue must be backpressuring it" is the obvious story, and it might even be the right one, but right now it's a guess dressed up as a finding.

## Why the recording missed it

Worth being precise about what the two families of JFR events actually measure, because they're answering different questions and it's easy to assume one covers for the other:

★ Insight ──────────────────────────────────────
jdk.ExecutionSample — the event behind every CPU flamegraph — only fires for a thread that's RUNNABLE and physically on a core at the instant of the sample. If the thread is parked, blocked, or waiting, there is no sample to take, full stop. Duration events (ThreadPark, JavaMonitorEnter, SocketRead, and friends) are the *only* mechanism JFR has for pinning off-CPU wall-clock time to a cause. A CPU profile and a "where does the wall-clock actually go" profile are two different instruments, and the default template only reliably builds the first one.
 ───────────────────────────────────────────

So the producer's low CPU% is entirely consistent with it spending most of its life off-CPU. The real question is why none of the duration events caught it — and here's the actual mechanism: **a bounded queue's backpressure is fast by design.** A decent implementation doesn't block a producer for tens of milliseconds at a stretch when the queue's full; it uses something like `LockSupport.parkNanos()` with a short timeout, or a tight backoff, and checks again almost immediately. The producer ends up flapping between "briefly parked" and "briefly running" possibly thousands of times a second — but each individual park lasts a fraction of a millisecond, comfortably under the ~10–20ms bar `ThreadPark` needs to clear by default. Every single park is real. Every single one is invisible to the recording, because none of them alone is big enough to earn a spot in the file.

This isn't JFR being lazy — it's a deliberate tradeoff. Record every `JavaMonitorEnter` and `ThreadPark` unconditionally with a full stack trace, and a busy service doing fine-grained backpressure could spray hundreds of thousands of events a second at the recorder. JFR is built to be cheap enough to leave running in production all the time, so the JDK engineers gated these events on the assumption that anything shorter than the threshold is normal scheduling noise, not a diagnostic signal. That assumption happens to be exactly backwards for backpressure and lock contention, which live *by design* in the sub-millisecond-to-low-millisecond range — precisely the range the default threshold treats as noise.

## What else falls into the same crack

The queue-backpressure story above is one instance of a wider pattern. Anything fast-but-frequent, rather than slow-but-rare, tends to slip through the same gap:

| What you don't see | Why | What it looks like instead |
|---|---|---|
| Sub-threshold queue backpressure (`parkNanos` on enqueue/dequeue) | `ThreadPark` gated at ~10–20ms by default | Low CPU%, zero blocking events — indistinguishable from genuinely idle |
| Tight retry/backoff loops | Same threshold gate on `ThreadSleep`/`ThreadPark` | Looks exactly like an idle thread |
| Lock contention that's frequent but each hold is brief | `JavaMonitorEnter` gated by hold duration | Invisible unless one particular acquire happens to run long enough to trip the threshold |
| Lots of small, fast I/O (thousands of tiny reads/sec, each sub-millisecond) | `SocketRead`/`FileWrite` gated per-event by duration | A socket doing 20k+ tiny reads a second, each a few dozen microseconds, can eat most of the wall-clock budget while showing almost nothing in the recording |
| Off-CPU wall-clock time in general | No event fires unless *some* duration event on that thread crosses its own threshold | The missing time isn't flagged as an error — it's just not in the file, so the recording looks complete while being blind to the dominant cost |

That last row is the real trap. A JFR summary will never say "78% of this thread's time is unaccounted for" — there's no event for "nothing else fired." The time just isn't there, and a recording silently missing the dominant cost looks, on the surface, exactly like a recording of a system that's genuinely fine.

## Try it yourself: reproducing the blind spot

You don't need our exact scenario to see this — you can watch a default JFR go blind on a contended lock in about two minutes. Here's the loop.

**1. Start the JVM with JFR ready to go, and grab a PID.**

```bash
java -XX:+FlightRecorder -jar your-app.jar &
jps -l          # find your app's PID
```

**2. Kick off a plain-vanilla `profile`-template recording via `jcmd` — no custom settings, just the default.**

```bash
jcmd <pid> JFR.start name=baseline settings=profile duration=60s filename=baseline.jfr
```

Let it run its 60 seconds, or stop it early:

```bash
jcmd <pid> JFR.stop name=baseline
```

**3. Print the events that matter for our story and admire the silence.**

```bash
jfr print --events jdk.ThreadPark,jdk.JavaMonitorEnter,jdk.JavaMonitorWait baseline.jfr | head -50
jfr summary baseline.jfr | grep -E "ThreadPark|JavaMonitorEnter|JavaMonitorWait|ExecutionSample"
```

On a service with fast, frequent locking or backpressure, don't be surprised if `ThreadPark`/`JavaMonitorEnter` show up as zero, or close to it, while `ExecutionSample` looks perfectly normal. That gap between "CPU profile looks fine" and "throughput is in the toilet" is the whole post in one command.

**4. Now build a version of the template with the thresholds ripped out, and run it again.**

The cleanest way is to export the built-in `profile` template, edit two lines, and load your edited copy back in. `JAVA_HOME` should point at your JDK install:

```bash
# grab the stock template as a starting point
cp "$JAVA_HOME/lib/jfr/profile.jfc" ./contention.jfc
```

Open `contention.jfc` and find the settings for the events you care about — they look like this:

```xml
<event name="jdk.JavaMonitorEnter">
  <setting name="enabled">true</setting>
  <setting name="threshold">10 ms</setting>
  <setting name="stackTrace">true</setting>
</event>

<event name="jdk.ThreadPark">
  <setting name="enabled">true</setting>
  <setting name="threshold">10 ms</setting>
  <setting name="stackTrace">true</setting>
</event>
```

Change `threshold` to `0 ms` on `jdk.JavaMonitorEnter`, `jdk.ThreadPark`, and `jdk.JavaMonitorWait` (and, if you suspect chatty I/O, `jdk.SocketRead`/`jdk.SocketWrite`/`jdk.FileRead`/`jdk.FileWrite` too), save it, then run a **short** capture with it — this configuration is going to record *a lot*:

```bash
jcmd <pid> JFR.start name=contention settings=./contention.jfc duration=60s filename=contention.jfr
jcmd <pid> JFR.stop name=contention
```

**5. Compare the two files.**

```bash
jfr summary contention.jfr | grep -E "ThreadPark|JavaMonitorEnter|JavaMonitorWait"
```

Where `baseline.jfr` showed zero or near-zero, `contention.jfr` should show real counts — potentially a lot of them — with full stack traces telling you exactly which call site is doing the parking. That's the signal that was there all along, just filtered out by the default threshold.

## The other three ways to get the signal back

Editing a `.jfc` and re-running is the most direct fix, but it's not the only lever, and it's not always the cheapest one.

### Measure the suspected resource directly, skip the profiler entirely

If the thing you suspect already exposes its own instrumentation — plenty of queue implementations, connection pools, and thread pools publish current occupancy via JMX or an equivalent metrics endpoint — just read that number. A queue pinned near-full means the producer keeps getting stuffed back on enqueue (bottleneck downstream); pinned near-empty means consumers are starving (bottleneck upstream). No sampling, no thresholds, no guessing — just a number you read straight off the object.

```bash
# quick one-liner if you have jmxterm or similar on hand
echo 'get -b your.domain:type=Queue,name=main RemainingCapacity TotalCapacity' | java -jar jmxterm.jar -l localhost:9010
```

**Cost:** basically free — it's a metrics read, not a recording. **Do this first**, before reaching for any of the heavier profiling options, whenever the component in question already exposes what you need.

### Use wall-clock profiling instead of CPU profiling

Tools that support wall-clock sampling (rather than CPU-time sampling) — `async-profiler` in `-e wall` mode is the standard example — sample *every* thread on a fixed real-time interval regardless of whether it's running, blocked, or parked, and attribute the sample to whatever frame it's in. Off-CPU time shows up as named stack frames instead of vanishing.

```bash
./profiler.sh -e wall -d 60 -f wall-profile.jfr <pid>
```

**Cost:** somewhat more overhead than CPU-only sampling (you're now sampling threads a CPU profiler would skip entirely), and it's a different tool/mode than a default JFR capture — though many of these emit standard JFR-format output, so you can still crack it open in JMC.

### Build busy/blocked accounting into the application itself

If this class of bottleneck — queueing, backpressure, handoffs between pipeline stages — is one you expect to keep chasing, the most durable answer is to stop asking a profiler after the fact and instead have the application track its own busy-vs-blocked time per thread/stage, with queue occupancy exposed as a standing metric. It's the permanent, purpose-built version of "just read the gauge" above.

**Cost:** real upfront engineering effort, near-zero runtime overhead once it's in — it's counters, not a profiler.

## The practical takeaway

Don't read "low CPU%, no blocking events, no obvious hot method" as proof a thread is idle. Under a default-configuration JFR, that exact signature is *also* what a sub-threshold backpressure bottleneck looks like, and the file gives you no way to tell the two apart. The default template is tuned to be cheap enough to run everywhere, and it buys that cheapness by throwing away precisely the class of event that queueing and lock-contention problems live in. So when a recording insists a thread is idle but your throughput graph says otherwise, treat that mismatch as the finding — and go get the zero-threshold capture, the direct queue metric, or the wall-clock profile that actually answers the question you're asking.
