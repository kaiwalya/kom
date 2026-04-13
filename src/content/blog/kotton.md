---
title: "Kotton — A Fiber Scheduler with Hand-Rolled Assembly"
summary: "Writing a user-space fiber scheduler with x86 assembly for context switching."
date: 2013-10-25
tags: [project, systems, cpp, assembly, concurrency]
type: tech
draft: true
---

Kotton is a user-space fiber scheduler written in October 2013 as an educational exercise. The goal was understanding what the OS actually does when it switches between threads — not building something for production use.

Repo: [github.com/kaiwalya/kotton](https://github.com/kaiwalya/kotton)

### Day 1: Basic fibers working

A fiber is like a thread, but lighter: it has its own stack and its own execution state, but it's scheduled cooperatively in user space rather than preemptively by the OS. Where a thread can be interrupted at any time by the kernel, a fiber only switches when your code explicitly says to.

The key question is: what does it actually mean to "switch" execution from one fiber to another?

On x86-64, the currently-executing code is described entirely by registers — the instruction pointer (RIP), the stack pointer (RSP), and a handful of general-purpose registers. Switching execution from fiber A to fiber B means saving A's registers somewhere, then loading B's previously-saved registers. The CPU resumes wherever B's instruction pointer says, on B's stack, with B's registers — it has no idea anything happened.

#### Establishing the stack

The first problem: a new fiber's stack doesn't exist yet. You have to allocate a buffer on the heap and point RSP at it before you can call anything on that stack.

This is the only place assembly is strictly necessary. `execution::enter()` does exactly this:

```asm
pushq %rbp;
movq  %rsp, %rbp;        // save caller's stack pointer in rbp
movq  %[stackTopR], %rsp; // POINT RSP TO THE NEW STACK
```

After this, any function calls use the new heap-allocated stack. The original RSP is sitting in `%rbp`, and the function restores it on return. Stack top is aligned to 16 bytes (`stackTop & ~15`) — required by the x86-64 System V ABI, which guarantees that `%rsp % 16 == 0` at every call boundary.

Both 32-bit and 64-bit paths exist. Rather than `#ifdef`, the implementation uses a `constexpr bool`:

```cpp
constexpr bool is64Bit = sizeof(void*) == 8;
```

The right assembly block is selected at compile time. On 32-bit x86, the ABI is completely different — arguments are passed on the stack rather than in registers, the callee-saved register set is smaller, and the stack alignment rule is less strict — so there is no sharing: two separate assembly blocks.

#### State machine: setjmp/longjmp

Inline assembly is only needed to establish the new stack. After that first entry, all subsequent context switches use `setjmp` and `longjmp`.

The fiber has four states:

```
notReady → paused → playing → finished
```

`swap()` is symmetric: both sides of the switch call the same function. The first time a new fiber is entered via `enter()`, it calls `return_barrier()` — a function that runs on the new stack and exists only to catch the fiber function's return and mark the fiber `finished`. On every yield after that, `swap()` runs:

```cpp
if (setjmp(here) == 0) {
    longjmp(there, 1);
}
// ... resume here
```

`setjmp` captures the current register state and stack pointer into a `jmp_buf`. `longjmp` restores a previously-saved `jmp_buf`. Together they implement the same save/restore that a full context-switch routine does, without hand-rolled assembly for every register.

The symmetry matters: because both the fiber and the scheduler call the same `swap()`, neither is privileged. The scheduler itself is just another execution context that happens to be the one currently running. When a fiber yields, it `longjmp`s to wherever the scheduler last called `swap()`. When the scheduler resumes a fiber, it `longjmp`s to wherever that fiber last called `swap()`. The illusion is maintained by two `jmp_buf` structures pointing at each other.

#### Stack guard canary

Stack overflows are silent and catastrophic: the fiber quietly corrupts whatever memory lives below its stack. Kotton writes a canary at the bottom of every allocated stack:

```
"kotton!" (8 bytes, repeated to fill the guard region)
```

The canary is checked on fiber destruction and after every `proceed()` call. If the pattern has been overwritten, the fiber's stack overflowed into the guard. It doesn't prevent the overflow, but it detects it at the earliest possible moment rather than letting corruption propagate silently.

#### `isCurrent()`: which stack am I on?

There's a neat trick for asking "is this fiber currently executing?" that avoids any global state:

```cpp
bool isCurrent() const {
    char local;
    uintptr_t addr = reinterpret_cast<uintptr_t>(&local);
    return addr >= stackBottom && addr < stackTop;
}
```

Take the address of a local variable. Local variables live on the stack. If that address falls within the range of this fiber's heap-allocated stack buffer, then the current call is happening on this fiber's stack — which means this fiber is currently executing. The OS uses a similar trick to check whether a fault address falls within a known stack region.

### Day 2: 32-bit and 128-fiber test

The second day adds 32-bit support and a proper stress test.

The 32-bit port isn't a tweak to the existing code. x86-64 has eight additional general-purpose registers that don't exist on 32-bit x86, the callee-saved register set is different, and the calling convention is entirely different — arguments go on the stack in 32-bit, in registers in 64-bit. The assembly can't be shared. Two separate implementations, both paths maintained independently.

The stress test creates 128 independent fibers, each yielding twice:

```
fiber_0: yield → yield → done
fiber_1: yield → yield → done
...
fiber_127: yield → yield → done
```

The test scheduler round-robins through all 128, calling `proceed()` on each in turn. Every fiber maintains its own stack; no fiber should ever see another fiber's data. If any fiber's stack pointer bleeds into a neighbor's allocation, the canary at the bottom catches it. If any fiber resumes at the wrong instruction, the test fails on a bad state assertion.

128 fibers, each with its own stack, all switching correctly — that's the proof that the design is sound. A single fiber working could be a coincidence. 128 working simultaneously means the save/restore is correct, the stack allocations don't alias, and the state machine transitions cleanly under repeated switching.
