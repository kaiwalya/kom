---
title: "Hifi — Audio Processing in Zig"
summary: "Experimenting with audio signal processing using Zig's low-level control."
date: 2024-03-13
tags: [project, zig, audio, dsp]
type: tech
draft: false
---

Hifi is an exploration of audio signal processing in [Zig](https://ziglang.org/). Audio I/O works — sound flows from input through the processor chain to output. It's an intro-to-Zig project, not a finished tool.

Repo: [github.com/kaiwalya/hifi](https://github.com/kaiwalya/hifi)

### Why Zig

Audio processing has hard constraints. Fixed buffer sizes — typically 256 or 512 frames at a time. No garbage collection pauses mid-frame. No surprise allocations from a library you did not write. Languages that hide memory tend to hide latency too.

Zig is a systems programming language in the same space as C and Rust — manual memory management, no hidden control flow, compiles to native code. What makes it distinct: [allocators](https://ziglang.org/documentation/master/#Allocators) are passed explicitly into every function that needs memory, rather than being a global ambient thing. This means you always know who owns memory and where allocations happen — critical when a surprise heap allocation mid-audio-callback would cause a dropout. [Comptime](https://ziglang.org/documentation/master/#comptime) evaluation handles static configuration without macros or runtime overhead. The error handling is unambiguous: no exceptions, no implicit panics.

It is lower-level than Rust but with less ceremony. For a one-day exploration that is the right trade-off.

### The type problem

The second commit was "Include the vscode files till IDEs have good support for zig." Pragmatic. The Zig language server exists but at the time it would regularly fail to resolve comptime-generated types — hovering over a node in the pipeline would show `unknown` or crash the LSP entirely. I gave up on inference and leaned on explicit annotations everywhere, which meant the types themselves had to be right before the tooling would be useful at all.

Then three consecutive commits: "Type cleanup," "Some more types refactoring," "More type refactoring."

The problem was composing processors with comptime generics. My first attempt parameterized each processor on its sample type — `f32`, `f64`, whatever. That works fine until you try to connect two processors and the compiler needs to unify their types at the call site. I kept getting errors about mismatched comptime parameters that pointed to the wrong line, because the actual mismatch was two levels of generic instantiation up. The fix was to move the sample type parameter up to the grid level rather than the processor level, so each processor inherits it from the graph it belongs to rather than carrying its own copy.

### GridStore: comptime generics as struct factories

The core storage abstraction is `GridStore` — a flat memory block that can be sliced in multiple dimensions. The declaration looks like this:

```zig
pub fn GridStore(comptime T: type, comptime _alignment: ?usize) type {
    return struct {
        const Self = @This();
        const alignment = _alignment;
        // ...
    };
}
```

`GridStore` is not a generic type — it is a function that returns a type. Every call with a distinct `T` or `alignment` produces a completely new struct definition at compile time. `GridStore(f32, 32)` and `GridStore(f32, null)` are unrelated types; the compiler generates separate machine code for each.

This is worth contrasting with C++ templates, which many CS curricula use to introduce generics. In C++, `template<typename T> struct GridStore` declares one template and the compiler implicitly instantiates it for each `T` it encounters — you never see that instantiation happen, and when something goes wrong the error messages describe internal template machinery you did not write. In Zig, the generics are just regular functions. `GridStore(f32, 32)` is a function call that happens to return a `type`. The return value is a struct literal. You can put a `@compileLog` in there, return early, do arithmetic on the parameters, anything. There is no separate template system to learn.

The optional alignment parameter matters for audio specifically. SIMD instructions — the CPU instructions that operate on vectors of floats simultaneously — require their input buffers to start at a specific memory address boundary, typically 16 or 32 bytes. `GridStore(f32, 32)` ensures the underlying allocation is 32-byte aligned, so SIMD loads never straddle a cache line.

`GridStore` also supports `GridSlice` views — projections over a row, a column, or a transposed layout — all backed by the same flat buffer with no copies. A processor that needs to iterate columns gets a `GridSlice` and works through the column stride; the memory layout never changes underneath it.

### Hand-rolled vtables

Zig has no interfaces, no traits, no virtual methods. The compiler does not generate vtables for you. If you want runtime polymorphism — which an audio graph needs, because you want to wire up processors at runtime without the caller knowing their concrete types — you build the vtable yourself.

```zig
pub const VTable = struct {
    writeSpec: *const fn (*anyopaque, *ConnectionSpec) void,
    process:   *const fn (*anyopaque, IOHead) anyerror!void,
    leadFrames: ?*const fn (*anyopaque) usize,
};
```

`*anyopaque` is Zig's type-erased pointer — equivalent to `void *` in C. A `Processor` node in the graph holds two fields: a `*anyopaque` pointing at the concrete processor struct, and a `*const VTable` pointing at that type's vtable. Calling `process` on any node looks like:

```zig
try node.vtable.process(node.ptr, io_head);
```

Each concrete processor type — the sweep generator, the FFT stage, the output sink — defines a static `VTable` instance at comptime:

```zig
pub const vtable = VTable{
    .writeSpec  = writeSpec,
    .process    = process,
    .leadFrames = leadFrames,
};
```

And each implementation casts `*anyopaque` back to its own type at the top of the function:

```zig
fn process(ptr: *anyopaque, io: IOHead) anyerror!void {
    const self: *SweepGenerator = @ptrCast(@alignCast(ptr));
    // ...
}
```

This is exactly how Go interfaces work internally, and exactly how Rust `dyn Trait` objects work internally — a data pointer and a vtable pointer traveling together. The difference is that in Go and Rust those details are hidden; here you see every byte. The `leadFrames` field is `?*const fn(...)` rather than `*const fn(...)` because not every processor type needs to implement it — it is an optional method, expressed as a nullable function pointer rather than a separate optional protocol.

Implementing this yourself removes the abstraction tax. You know the size of a `Processor` node (two pointers). You know the call overhead (one pointer dereference to reach the vtable, one to reach the function). You know there is no hidden dynamic dispatch machinery.

### SIMD audio processing

The sample chunk size is fixed:

```zig
pub const SignalSlice = @Vector(32, f32);
```

`@Vector(32, f32)` is a 32-wide SIMD float vector — 32 samples processed in a single instruction. The CPU's SIMD unit operates on all 32 values simultaneously; no loop, no per-sample branching.

The sweep generator — which produces a sine wave sweeping from 20 Hz to 20 kHz, the audible frequency range — uses this directly:

```zig
const phases: @Vector(32, f32) = base_phase + phase_offsets;
const samples: SignalSlice = @sin(phases);
```

`@sin` applied to a `@Vector` lowers to SIMD trigonometry instructions. The frequency sweep — moving from 20 Hz upward over time — uses `@mod` across the vector to keep phase values in `[0, 2π)` without branching on individual samples.

For a fresh CS graduate: imagine you have 32 floats and you want to compute `sin` on each. The obvious implementation is a loop that calls `sin` 32 times. SIMD does it in one instruction — the CPU has 256-bit or 512-bit wide registers, and a single instruction loads 8 or 16 floats, applies the operation to all of them at once, and writes them back. `@Vector(32, f32)` tells the compiler "treat these 32 floats as one unit." The compiler maps operations on that unit to SIMD instructions. The optional 32-byte alignment in `GridStore` is what ensures these vectors can be loaded without crossing a cache line boundary, which would stall the pipeline.

### Zero-copy signal graph

Four `SignalSlice` buffers sit on the stack at the top of the audio callback:

```zig
var buf_a: SignalSlice = undefined;
var buf_b: SignalSlice = undefined;
var buf_c: SignalSlice = undefined;
var buf_d: SignalSlice = undefined;
```

Each processor receives an `IOHead` — a struct of pointers to slices:

```zig
pub const IOHead = struct {
    in:  *const SignalSlice,
    out: *SignalSlice,
};
```

Wiring up the graph means assigning pointer addresses, not copying data:

```zig
const sweep_io = IOHead{ .in = &buf_a, .out = &buf_b };
const fft_io   = IOHead{ .in = &buf_b, .out = &buf_c };
```

The sweep generator writes into `buf_b`. The FFT stage reads from `buf_b` without the graph having transferred ownership or copied bytes. Each stage moves a pointer forward. Stack allocation guarantees these buffers live exactly as long as the callback frame — no heap lifetime to manage, no deallocation to remember.

### C interop without FFI

Zig treats C headers as first-class imports:

```zig
const soundio = @cImport({
    @cInclude("soundio/soundio.h");
});
const zmq = @cImport({
    @cInclude("zmq.h");
});
const fftw = @cImport({
    @cInclude("fftw3.h");
});
```

`@cImport` runs the C preprocessor on the header and translates the resulting declarations into Zig types. The translated types are then used directly — `soundio.SoundIo`, `fftw.fftw_plan`, and so on — with no binding layer, no generated glue code, no separate FFI crate.

Callbacks passed to C libraries need to be actual C function pointers. Zig's `callconv(.C)` attribute marks a function as using the C calling convention:

```zig
fn writeCallback(
    out_stream: ?*soundio.SoundIoOutStream,
    frame_count_min: c_int,
    frame_count_max: c_int,
) callconv(.C) void {
    // audio callback body
}
```

That function can be passed directly to `soundio_outstream_open` as the `write_callback` field — no adapter, no wrapper struct.

Format negotiation happens at comptime. When the stream opens, the code selects a sample format with a `switch` that has comptime-known arms:

```zig
const format = switch (out_stream.format) {
    soundio.SoundIoFormatFloat32NE => f32,
    soundio.SoundIoFormatFloat64NE => f64,
    else => @compileError("unsupported format"),
};
```

If the device reports an unsupported format, this fails at compile time rather than panicking at runtime. There is no runtime format detection path to test.

Three libraries — libsoundio for audio I/O, libzmq for inter-process messaging, FFTW3 for the Fast Fourier Transform — are all pulled in this way. No binding packages, no generated C wrappers.

### Unicode spectrum visualizer

The FFT output is 512 frequency bins. Each bin's magnitude maps to one of eight Unicode block characters:

```
' ' '▁' '▂' '▃' '▄' '▅' '▆' '▇' '█'
```

The spectrum prints as a single line in the terminal, updated each frame. This is a debugging tool, not a UI — but it is the kind of thing that takes ten minutes in Zig and would take an hour in a language where terminal output requires a library, and where computing the FFT would require wrapping C anyway. The C interop being zero-friction means FFTW is just available the moment you write `@cInclude("fftw3.h")`.

### Allocator discipline

Every struct in the codebase takes `std.mem.Allocator` as an explicit argument to `init`:

```zig
pub fn init(allocator: std.mem.Allocator) !Self {
    // ...
}
```

There is no global allocator, no thread-local default. If a function allocates, its signature says so. If a function does not take an allocator, it does not allocate — that is an unconditional guarantee, not a convention.

Tests use `std.testing.allocator`, which is a leak-detecting allocator. Any allocation that is not freed before the test returns causes the test to fail. This catches leaks immediately rather than through a separate tool run.

### "Input and Output both working"

Six commits in, audio flows from input through the processor chain to output. Audible results. The grid wiring, vtable dispatch, SIMD processing, and C interop are all in place.

The sweep processor is there but limited. Merge and split work for simple cases. No README, no tests beyond allocator discipline. It is a proof of concept for one question: whether Zig's comptime and explicit allocation model are a reasonable fit for a [DSP](https://en.wikipedia.org/wiki/Digital_signal_processing) graph — the same underlying approach used in professional DAWs and audio plugins.

They are. And building it surfaces the implementation details that other languages abstract away: vtable layout, SIMD alignment requirements, calling conventions, allocator lifetimes. Working in Zig means those details are not hidden — they are just part of the code.
