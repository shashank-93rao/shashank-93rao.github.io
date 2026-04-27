---
title: I Was Staring At Code That Looked Fine — JFR Said Optimise Every Line
date: 2026-04-25T20:08:01+05:30
draft: "false"
tags:
  - Java
  - performance
  - jvm
  - jit
---
I'm an engineer at [Hevo](https://hevodata.com/), and a big part of my job is making sure our data processing pipelines are fast. As part of an initiative to improve the throughput of our pipelines, I was profiling our code to figure out the components that were the bottlenecks. The serialization layer stood out — it's the component responsible for converting every field of every row from our internal typed object model into string representations for CSV output.

This kind of pattern shows up everywhere, by the way. Any system that takes typed records and serializes them — REST APIs building JSON responses, exporters writing metrics, message producers, report generators — they all hit the same conversion bottleneck. So while the context here is data pipelines, the optimization lessons apply universally.

So I attached a **JFR** (Java Flight Recorder) recording to the process. JFR is a low-overhead profiling tool built into the JVM — it records heap allocations, GC events, and CPU hot spots with almost no runtime cost. The allocation flame graph pointed straight at the data conversion loop.

The code looked completely fine. Clean, readable, easy to follow. The kind of code you'd approve in a PR without a second thought.

That's usually when things get interesting.

---

## The Code We Started With

Here's a simplified version of what we had. Read through it — it looks reasonable, right?

```java
class DataConverter {
    private final List<FieldSchema> schema;

    DataConverter(List<FieldSchema> schema) {
        this.schema = schema;
    }

    // Called for every row — this is the hot path
    List<String> convert(List<Datum> row) {
        List<String> result = new ArrayList<>(row.size());   // (A)

        for (int i = 0; i < row.size(); i++) {
            Datum datum = row.get(i);
            FieldSchema field = schema.get(i);               // (B)

            String converted = switch (field.sourceType()) { // (C)
                case DATE    -> convertDate((DateDatum) datum, field);
                case INTEGER -> convertInt((IntDatum) datum, field);
                case VARCHAR -> convertVarchar((VarcharDatum) datum, field);
                // ... more cases
            };

            result.add(converted);
        }

        return result;
    }

    private String convertDate(DateDatum datum, FieldSchema field) {
        LocalDate d = datum.value();
        if (d == null) return null;
        if (field.maxYear().isPresent() && d.getYear() > field.maxYear().get()) { // (D)
            throw new ValidationException("year out of range");
        }
        return DateTimeFormatter.ISO_LOCAL_DATE.format(d);   // (E)
    }

    private String convertInt(IntDatum datum, FieldSchema field) {
        Integer v = datum.value();
        if (v == null) return null;
        if (field.maxLength().isPresent() && String.valueOf(v).length() > field.maxLength().get()) { // (D)
            throw new ValidationException("too long");
        }
        return String.valueOf(v);
    }

    private String convertVarchar(VarcharDatum datum, FieldSchema field) {
        String s = datum.value();
        if (s == null) return null;
        if (field.maxLength().isPresent() && s.length() > field.maxLength().get()) { // (D)
            throw new ValidationException("too long");
        }
        return s;
    }
}
```

I've tagged five spots — `(A)` through `(E)`. Every single one of them is a problem. Let's go through them.

---

## Problem 1 — The Schema Never Changes, So Why Are We Checking It Every Row?

Look at `(B)` and `(C)`.

`field.sourceType()` returns the type of this field — `DATE`, `INTEGER`, `VARCHAR`, etc. The switch then figures out which conversion function to call. This runs for every field, in every row.

But here's the thing: **the schema doesn't change during a processing run.** If column 3 is a DATE column in row 1, it's still a DATE column in row 500,000. The schema is set when the converter is created. The conversion operation for each field is completely determined by the schema alone.

So we're rediscovering the same answer millions of times. It's like checking whether your front door is locked by walking to it every five minutes, even though you haven't opened it since you left.

### The Fix — Precompile the Schema Into Integer Tags

Separate the "figure out what to do" step from the "actually do it" step. At construction time, resolve each field's conversion to a simple integer (a "tag"). At row time, just look the tag up and dispatch off it.

```java
// Tag constants — one per conversion operation, continuous integers starting at 0
static final int TAG_DATE    = 0;
static final int TAG_INTEGER = 1;
static final int TAG_VARCHAR = 2;
// ...

class DataConverter {
    private final int[] tags;  // computed once at construction, read every row

    DataConverter(List<FieldSchema> schema) {
        tags = new int[schema.size()];
        for (int i = 0; i < schema.size(); i++) {
            tags[i] = resolveTag(schema.get(i));  // figure it out once
        }
    }

    private static int resolveTag(FieldSchema field) {
        return switch (field.sourceType()) {
            case DATE    -> TAG_DATE;
            case INTEGER -> TAG_INTEGER;
            case VARCHAR -> TAG_VARCHAR;
            // ...
        };
    }

    List<String> convert(List<Datum> row) {
        for (int i = 0; i < tags.length; i++) {
            results[i] = convertField(tags[i], row.get(i));
        }
        return resultView;
    }

    private String convertField(int tag, Datum datum) {
        return switch (tag) {
            case TAG_DATE    -> convertDate((DateDatum) datum);
            case TAG_INTEGER -> convertInt((IntDatum) datum);
            case TAG_VARCHAR -> convertVarchar((VarcharDatum) datum);
            // ...
        };
    }
}
```

### Why Integers Specifically?

This is where it gets interesting. When you write `switch(tag)` with case values `0, 1, 2, 3...` — contiguous integers — the JVM compiles it to something called a **tableswitch**. Here's what that actually means.

The JVM builds a lookup array where:
- index 0 holds the address of the `case 0` code
- index 1 holds the address of the `case 1` code
- index 2 holds the address of the `case 2` code
- ...

When it sees `switch(tag)`, it just does: "jump to the address at `jumpTable[tag]`." One array lookup. O(1). About 1 CPU cycle. No comparisons. No branching.

Compare that to the original `switch(field.sourceType())` on an enum. Enum switches go through an additional indirection of mapping the enum to their ordinal value. The compiler generates this mapping  behind the scenes. And if the case values aren't contiguous (enum ordinals can have gaps), the JVM falls back to a `lookupswitch` instruction instead, which does binary search. (worth [reading about](https://www.objectos.com.br/blog/java-switch-internals-tableswitch-lookupswitch-instructions.html) if you haven't seen it before)

**Contiguous integers starting at 0 are the JVM's fast path.**

If you want to go deeper on how `tableswitch` and `lookupswitch` actually work, you can go read the JVM Spec [here](https://docs.oracle.com/javase/specs/jvms/se21/html/jvms-6.html#jvms-6.5.tableswitch) and [here](https://docs.oracle.com/javase/specs/jvms/se21/html/jvms-6.html#jvms-6.5.lookupswitch).

Try it yourself: compile your class and run `javap -c MyClass.class`. Look for `tableswitch` vs `lookupswitch` in the bytecode output. `tableswitch` is what you want.

```
// What you want to see in javap output:
7: tableswitch   { // 0 to 2
       0: 40        // TAG_DATE   → jump to offset 40
       1: 52        // TAG_INTEGER → jump to offset 52
       2: 64        // TAG_VARCHAR → jump to offset 64
  default: 76
}
```

---

## Aside — "Why Not Just Store a Lambda Per Field?"

When I first thought about precompiling the conversions, my instinct was: store a `Function<Datum, String>` per field. One lambda per field, call it at row time. Clean and functional-looking:

```java
Function<Datum, String>[] converters = new Function[schema.size()];
converters[0] = datum -> convertDate((DateDatum) datum);
converters[1] = datum -> convertInt((IntDatum) datum);
// ...

// At row time:
for (int i = 0; i < converters.length; i++) {
    results[i] = converters[i].apply(row.get(i));  // looks fine, right?
}
```

This has a subtle and painful problem. Let me explain.

Java has a **JIT compiler** — the part of the JVM that watches your code run, identifies the hot paths, and compiles them down to native machine code. One of its most important tricks is **inlining**: instead of actually jumping into a method when you call it, it copies the method's body directly into the call site. This eliminates the call overhead and lets the JIT see more context, which unlocks further optimizations. Oracle has a [good overview of HotSpot's performance optimizations](https://docs.oracle.com/en/java/javase/21/vm/java-hotspot-virtual-machine-performance-enhancements.html) if you want to understand what else the JIT is doing under the hood.

But the JIT only inlines if it can figure out *which* method to inline. It profiles call sites. If `converters[i].apply(datum)` is always called with the same concrete class — say, always the same lambda type — the JIT marks it **monomorphic** ("one shape") and inlines. Great.

If it sees 2 different classes, it's **bimorphic** — still manageable, it inlines both with a type check.

If it sees **more than ~2-3 different concrete classes** — the call site becomes **megamorphic**. The JIT throws up its hands, stops trying to inline anything, and emits a generic virtual method dispatch. Slow. Aleksey Shipilev's post [The Black Magic of (Java) Method Dispatch](https://shipilev.net/blog/2015/black-magic-method-dispatch/) goes deep on exactly this — highly recommended if you want to understand how the JVM decides what to inline and when it gives up. (All of his blogs are highly recommended BTW!)

With an array of N different lambdas, that call site at `converters[i].apply()` sees N different classes. Guaranteed megamorphic. The JIT bails out on exactly the code you most want it to optimise.

```
Lambda array  → megamorphic call site → JIT stops inlining → slow virtual dispatch
Integer switch → one concrete class   → monomorphic        → JIT inlines everything
```

The integer switch approach — one concrete class, one call site, always the same class — keeps the JIT happy. It inlines the entire `convertField()` body, sees all the cases, and optimises the whole thing together.

---

## Problem 2 — That `new ArrayList<>()` Per Row

Back to the original code. Look at `(A)`:

```java
List<String> result = new ArrayList<>(row.size());
```

This runs for every row. It allocates a new `ArrayList` object *and* a new backing `Object[]` on every call. At 500,000 rows, that's 1 million heap allocations just for result containers that hold data for about 50 microseconds before being discarded.

The field count per row is fixed — it's determined by the schema, which doesn't change. The result always has the same number of entries. There's no reason to allocate a fresh container on every row.

### The Fix — Pre-Allocate at Construction Time

```java
class DataConverter {
    private final int[] tags;
    private final String[] results;       // allocated once, reused every row
    private final List<String> resultView;

    DataConverter(List<FieldSchema> schema) {
        int n = schema.size();
        tags = new int[n];
        results = new String[n];
        resultView = Arrays.asList(results);  // thin wrapper, no data copy
        // resolve tags...
    }

    List<String> convert(List<Datum> row) {
        for (int i = 0; i < tags.length; i++) {
            results[i] = convertField(tags[i], row.get(i));
        }
        return resultView;  // same object returned on every call
    }
}
```

`Arrays.asList(results)` is worth a closer look. It returns a private class called `java.util.Arrays$ArrayList` — not a real `java.util.ArrayList`. It's a thin wrapper around the array you give it. No data is copied. Reads from the list read directly from `results`. The list's `set()` method writes directly into `results`. Constructing it is O(1).

The catch: it doesn't support `add()` or `remove()` (those throw `UnsupportedOperationException`). Which is perfect here — the size never changes.

**Caveat that matters:** this only works safely if the caller finishes using the returned list before `convert()` is called again — otherwise you'd overwrite `results` while someone's still reading it. In a single-threaded "convert → emit → repeat" loop, that's always guaranteed. Know your consumption pattern.

---

## Problem 3 — Optional Unwrapping on Every Field of Every Row

Look at `(D)` across all three conversion methods:

```java
if (field.maxLength().isPresent() && s.length() > field.maxLength().get()) {
    throw new ValidationException("too long");
}
```

Validation limits — max field length, year range, decimal precision — are properties of the schema. They don't change between rows. But this code calls `.isPresent()` and `.get()` on every field of every row.

`Optional.isPresent()` is a method call. `Optional.get()` is another. The JIT *can* inline these — but whether it does depends on whether the call site is monomorphic or megamorphic. You don't want to depend on JIT charity on your hot path.

More importantly: the answer never changes. Why recalculate it?

### The Fix — Flat Primitive Arrays, Resolved at Construction

```java
int[] maxLength   = new int[schema.size()];
boolean[] validateYear = new boolean[schema.size()];
Arrays.fill(maxLength, -1);  // sentinel: -1 means "no limit"

for (int i = 0; i < schema.size(); i++) {
    maxLength[i]   = schema.get(i).maxLength().orElse(-1);
    validateYear[i] = schema.get(i).isTemporalDestType();
}
```

At row time:

```java
// In convertVarchar:
if (maxLength[i] >= 0 && s.length() > maxLength[i]) {
    throw new ValidationException("too long");
}

// In convertDate:
if (validateYear[i] && d.getYear() > 9999) {
    throw new ValidationException("year out of range");
}
```

Why this is faster than Optional per row:

- `maxLength[i]` is an array index read — the CPU can predict it and the JIT can pull the whole array into a register for the inner loop
- `int >= 0` is a single `cmp` instruction — as cheap as any operation gets
- No method calls, no Optional objects, no lambdas passed to `ifPresent`
- `boolean[]` reads are often represented as single-bit operations in compiled native code

You resolved the hard part (checking the schema) once at construction. Now the hot loop just reads from flat arrays.

---

## Problem 4 — `DateTimeFormatter` Is Hiding a Lot of Allocations

After fixing the first three problems, I profiled again. Still showing significant allocation pressure on rows with date and datetime fields. Time to look at `(E)`:

```java
return DateTimeFormatter.ISO_LOCAL_DATE.format(d);
```

Looks like one method call. Let's see what `DateTimeFormatter.format()` actually does under the hood:

```
DateTimeFormatter.format(date)
  → allocates a DateTimePrintContext object
  → allocates a new StringBuilder internally
  → delegates to a chain of printer objects:
      YearPrinter → appends year
      LiteralPrinter('-') → appends '-'
      MonthPrinter → appends month
      LiteralPrinter('-') → appends '-'
      DayPrinter → appends day
  → calls sb.toString() → allocates a new String
  → DateTimePrintContext goes out of scope → garbage
  → internal StringBuilder goes out of scope → garbage
```

That's 3-5 object allocations for formatting `"2024-04-15"`. At 500,000 rows with a date column, that's 1.5 to 2.5 million short-lived objects being handed to the garbage collector.

`DateTimeFormatter` is flexible and handles a ton of edge cases — locales, optional sections, custom patterns. But that flexibility has a cost. For a hot path with a fixed format and known types, it's doing a lot of work you don't need.

### The Fix — Write the Formatter Yourself

Date formatting isn't actually complicated. `yyyy-MM-dd` is: four-digit year, dash, two-digit month, dash, two-digit day. You can write that directly.

```java
static String formatDate(int year, int month, int day) {
    StringBuilder sb = new StringBuilder(10);  // "yyyy-MM-dd" is exactly 10 chars
    appendPadded4(sb, year);
    sb.append('-');
    appendPadded2(sb, month);
    sb.append('-');
    appendPadded2(sb, day);
    return sb.toString();
}

// Zero-pad to 2 digits: 4 → "04", 11 → "11"
static void appendPadded2(StringBuilder sb, int v) {
    if (v < 10) sb.append('0');
    sb.append(v);
}

// Zero-pad to 4 digits: 24 → "0024", 2024 → "2024"
static void appendPadded4(StringBuilder sb, int v) {
    if (v < 1000) sb.append('0');
    if (v < 100)  sb.append('0');
    if (v < 10)   sb.append('0');
    sb.append(v);
}
```

No `DateTimePrintContext`. No printer chain. No delegation. Just integer arithmetic and direct `append` calls.

Allocation count per call now: 1 `StringBuilder` + its backing `char[]` + 1 `String` = 3 objects. Down from ~5-6.

Better. But that `new StringBuilder(10)` on every call is still unnecessary. The buffer size is always 10. The content is always overwritten. There's no reason to allocate a new one each time.

---

## Problem 5 — That `new StringBuilder()` per Call

Every `new StringBuilder(10)` allocates a new object on the heap plus a new `char[]` backing array. At 500,000 date fields per batch, you're creating 1 million heap objects to hold data for about 10 nanoseconds.

A `StringBuilder` isn't inherently tied to a single call. It has a method called `setLength(0)` that resets the content without touching the underlying buffer. You can reuse the same `StringBuilder` across calls as long as you reset it between them.

The problem is thread safety — `StringBuilder` is not thread-safe. You can't just make it a `static` field and share it across threads.

Enter `ThreadLocal<T>`.

### The Fix — One StringBuilder Per Thread, Reused Forever

`ThreadLocal<T>` gives each thread its own private instance of T. Thread A gets its own `StringBuilder`, thread B gets its own. They never see each other's. No locks, no contention, no shared state. The [official Java docs for ThreadLocal](https://docs.oracle.com/en/java/javase/21/docs/api/java.base/java/lang/ThreadLocal.html) are worth a read — particularly the warning about memory leaks in thread-pooled environments, which is a real gotcha.

```java
private static final ThreadLocal<StringBuilder> THREAD_SB =
    ThreadLocal.withInitial(() -> new StringBuilder(32));
    // The lambda runs once per thread.
    // After that, .get() just returns the same StringBuilder every time.

static String formatDate(int year, int month, int day) {
    StringBuilder sb = THREAD_SB.get();  // this thread's StringBuilder — 0 allocations
    sb.setLength(0);                      // reset — 0 allocations
    appendPadded4(sb, year);
    sb.append('-');
    appendPadded2(sb, month);
    sb.append('-');
    appendPadded2(sb, day);
    return sb.toString();                 // 1 String allocation — genuinely unavoidable
}
```

### The Key Detail — `setLength(0)` vs `new StringBuilder()`

`StringBuilder` internally holds two things: a `char[]` array and an integer `count` that tracks how many characters are currently written.

When you call `setLength(0)`:
- `count` is set to `0`
- That's it. The `char[]` stays where it is. Untouched.

When you call `new StringBuilder(10)`:
- A new object is allocated on the heap
- A new `char[]` of size 10 is allocated on the heap
- The old ones become garbage for the GC to collect

Think of it this way: `setLength(0)` is erasing a whiteboard. `new StringBuilder()` is throwing the whiteboard out the window and buying a new one every time you want to write something. Same result. Wildly different cost.

**Allocation count per `formatDate` call now:**
- `THREAD_SB.get()` → 0 allocations
- `sb.setLength(0)` → 0 allocations
- Every `append()` → 0 allocations (writing into the existing buffer)
- `sb.toString()` → 1 String — the only unavoidable allocation

**One allocation per date format call.** Down from 3 with the manual `new StringBuilder()`, down from ~6 with `DateTimeFormatter`.

If you have JFR running, take an allocation recording before and after this change and compare the two in JDK Mission Control. The `StringBuilder` entries in the allocation view should essentially disappear.

---

## Bonus — The Nanosecond Formatter (Going All the Way Down)

For datetime fields with sub-second precision, you need to format nanoseconds. The value is an integer from 0 to 999,999,999, and the formatted output should have trailing zeros stripped: `123000000` → `"123"`, `100000000` → `"1"`, `123456789` → `"123456789"`.

The obvious approach:

```java
String.format("%09d", nano)  // format as 9-digit zero-padded integer, then strip trailing zeros
```

This boxes `nano` from `int` to `Integer` as part of the varargs `Object[]`, creates a `Formatter` object internally, does the work, and returns a `String`. Three allocations, minimum. On a hot path formatting nanoseconds for millions of datetime fields — not ideal.

### The Fill-From-Right Trick

Instead of formatting left-to-right and reversing (or using `String.format`), fill directly into reserved positions in the `StringBuilder` from right to left using repeated `% 10` and `/ 10`. Then strip trailing zeros in-place.

```java
static void appendNanos(StringBuilder sb, int nano) {
    int pos = sb.length();
    sb.setLength(pos + 9);     // reserve 9 character slots all at once

    int n = nano;
    for (int i = pos + 8; i >= pos; i--) {
        // n % 10 extracts the rightmost decimal digit (0-9)
        // Adding '0' (ASCII 48) converts it to the character '0'..'9'
        sb.setCharAt(i, (char) ('0' + n % 10));
        n /= 10;   // drop the rightmost digit, shift everything right
    }

    // Strip trailing zeros: "123000000" → "123"
    int end = pos + 9;
    while (end > pos + 1 && sb.charAt(end - 1) == '0') {
        end--;
    }
    sb.setLength(end);
}
```

**Walking through `nano = 123000000`:**
- Reserve positions `pos+0` through `pos+8`
- `i = pos+8`: `123000000 % 10 = 0` → write `'0'`
- `i = pos+7`: `12300000 % 10 = 0` → write `'0'`
- `i = pos+6`: `1230000 % 10 = 0` → write `'0'`
- `i = pos+5`: `123000 % 10 = 0` → write `'0'`
- `i = pos+4`: `12300 % 10 = 0` → write `'0'`
- `i = pos+3`: `1230 % 10 = 0` → write `'0'`
- `i = pos+2`: `123 % 10 = 3` → write `'3'`
- `i = pos+1`: `12 % 10 = 2` → write `'2'`
- `i = pos+0`: `1 % 10 = 1` → write `'1'`
- Buffer contains: `"123000000"`
- Strip trailing zeros: `end` moves from 9 to 3
- Final result: `"123"` ✓

**Why `sb.setLength(pos + 9)` up front:** It reserves all 9 positions in one shot — one internal capacity check, one possible reallocation. After that, `setCharAt()` writes directly into already-allocated memory with no further checks. Contrast with appending 9 times one by one, each of which has to check capacity.

**The JIT surprise with `n /= 10`:** Integer division is slow — a `div` CPU instruction takes 20-90 cycles depending on the processor ([Agner Fog's instruction tables](https://www.agner.org/optimize/instruction_tables.pdf) document this per microarchitecture if you want the exact numbers). But when the divisor is a **compile-time constant** (which `10` is here), the JIT replaces it with a **multiply-shift sequence** — a mathematical trick using the multiplicative inverse ([Wikipedia has a good breakdown](https://en.wikipedia.org/wiki/Division_algorithm#Division_by_a_constant)). For division by 10, it compiles to roughly: `(n * 0xCCCCCCCD) >>> 35` — a multiply and a right shift. That's about 3-5 cycles instead of 20-90. The JIT only makes this substitution when the divisor is constant at compile time. Here it is, so you get the fast version automatically, for free. 

Zero intermediate allocations for the entire nanosecond formatting operation.

---

## What the Code Looks Like Now — Before and After

Let me put the scoreboard up. Assume a 10-field schema where 2 fields are dates, processing 500,000 rows.

| What we're paying for | V0 (original) | V3 (after all fixes) |
|---|---|---|
| Schema type lookups | 10 per row | 0 |
| Type dispatch (switch evaluation) | 10 per row (enum switch) | 10 per row (tableswitch ~1 cycle each) |
| Result list allocations | 1 `ArrayList` + `Object[]` per row | 0 (pre-allocated) |
| Validation limit lookups | ~10 `Optional` unwraps per row | 0 (flat array reads) |
| `DateTimeFormatter` allocations | ~12 per row (2 fields × ~6) | 0 |
| `StringBuilder` allocations | ~12 per row (if manual) | 0 (ThreadLocal reuse) |
| Unavoidable `String` allocations | ~12 per row | 2 per row (one per date — that's the actual output) |

Across 500,000 rows, the difference in the "unavoidable" column alone is about 5 million fewer `String` allocations. The GC has correspondingly less work to do.

---

## The Results

After rolling all of these changes — precompiled tags, pre-allocated result container, flat validation arrays, custom datetime formatting, and ThreadLocal StringBuilder — I ran the JFR recording again.

The allocation rate for the conversion layer dropped dramatically. The `StringBuilder`, `ArrayList`, `DateTimePrintContext` entries that were dominating the allocation flame graph were essentially gone. GC pause frequency came down with it.

But the headline number: **iterations per second on the conversion loop went up by 10x.**

Not 10%. Ten times. The same code, doing the same thing, on the same hardware.

That number surprised me too, honestly. But it makes sense when you think about it. Every optimization here eliminated work that was running on every single field of every single row. The effects compound. You eliminate the schema lookup, and the JIT can now see a monomorphic call site and inline more aggressively. You eliminate the allocations, and the GC runs less, which means fewer stop-the-world pauses disrupting the loop. Each fix made the next fix more impactful.

---

## So What Did We Actually Learn?

Let me boil it down:

**1. Move invariant work out of the loop.**
If a computation's inputs don't change between iterations, compute it once before the loop. This sounds obvious but it's easy to miss when the "invariant input" is a schema or a type — something that feels like metadata rather than data.

**2. Contiguous integer switches compile to jump tables.**
`switch` on enum or string is not the same as `switch` on a contiguous integers. Design your dispatch tags as `0, 1, 2, 3...` and the JVM will give you O(1) dispatch via tableswitch. Verify with `javap -c`.

**3. Lambda arrays create megamorphic call sites.**
When a single call site sees more than ~2 concrete types, the JIT stops inlining. An array of N different lambdas is guaranteed megamorphic. One concrete class with an internal integer switch is monomorphic — the JIT can inline the whole thing.

**4. Pre-allocate fixed-size result containers.**
`Arrays.asList(yourArray)` returns a zero-copy, fixed-size list view. Allocate once at construction, return the same view every time.

**5. Resolve schema-derived limits at construction time into flat primitive arrays.**
No `Optional` unwrapping, no method calls, no boxing per row. Just array reads and integer comparisons. The JIT loves flat `int[]` and `boolean[]`.

**6. Convenience APIs allocate more than they look like.**
`DateTimeFormatter` hides 5-6 allocations per format call. `String.format()` with `%d` boxes your `int`. These are fine in normal code. On a hot path they add up fast.

**7. `setLength(0)` reuses the buffer. `new StringBuilder()` doesn't.**
One resets a counter. The other throws away the backing array and allocates a new one. `ThreadLocal` makes reuse safe across threads without locks.

**8. Compile-time constant divisors in integer loops are optimised to multiply-shift.**
`n /= 10` where `10` is a constant gets compiled to a fast multiply-shift by the JIT. Free speed — just keep the divisor constant.

---

## A Note on When to Do This

Not everywhere. This stuff is worth it when:

- You've profiled and confirmed the code is actually hot
- The loop runs millions of times per second
- GC pause time or CPU usage is measurable and affecting real users

The right tool for finding this: **JFR** (Java Flight Recorder). Enable it with `-XX:StartFlightRecording` or attach it to a running process with `jcmd`. Open the recording in JDK Mission Control and go straight to the allocation profiling view — it shows you exactly which call sites are allocating the most, sorted by bytes. The CPU flame graph sits right next to it. Nothing else gives you this much signal with this little overhead. `async-profiler` with `-e alloc` is a great alternative if you're already using it; both will tell you the same story. Without a profiler, you're guessing — and you'll usually guess wrong.

Write readable code first. Measure. Optimise where the numbers say to.

The thing that surprised me most going through this: none of these are exotic JVM tricks. They're all about not making the JVM redo work it already did, and not creating objects the GC has to clean up. The JVM is very good at running optimised code. The job is to write code that lets it do that.
