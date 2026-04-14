---
title: "Kaansen — Building a Whole-Home Audio System"
summary: "Designing a multi-zone audio distribution system with custom PCBs, ESP32, STM32, and DSP matrix mixing."
date: 2026-02-05
tags: [project, hardware, esp32, stm32, audio, dsp, kicad]
type: tech
draft: false
---

Kaansen is a whole-home audio system I'm building from scratch — Bluetooth receiver, custom PCBs, and an STM32-based DAC chain. The prototype path (phone → ESP32 → STM32 → DAC) produces audio. The custom PCB is designed but not yet integrated, and there are known issues with the noise floor and occasional clicks on the prototype.

Repo: [github.com/kaiwalya/kaansen](https://github.com/kaiwalya/kaansen)

### Start simple

An [ESP32](https://en.wikipedia.org/wiki/ESP32) receives audio over A2DP and outputs it over [I2S](https://en.wikipedia.org/wiki/I%C2%B2S) — a simple serial protocol for sending digital audio between chips. The [Moon build system](https://moonrepo.dev) handles the monorepo structure from day one because I knew more firmware targets were coming.

Moon deserves a sentence on its own here. The repo eventually needs to compile firmware for two completely different processor architectures — Xtensa (the ESP32) and ARM Cortex-M7 (the STM32H7) — with completely different toolchains, compilers, and SDKs. A single `moon run :build` orchestrates both. You don't have to think about which directory you're in or which compiler to invoke. That abstraction paid for itself the first time I added the STM32 target.

The first version worked. Phone connects, audio plays. Simple enough that I should have stopped there, but I wanted real fidelity.

### The STM32 problem

The next step was adding an [STM32H723ZG](https://www.st.com/en/microcontrollers-microprocessors/stm32h723zg.html) as the receiving end — takes I2S in, drives a DAC. The onboard 12-bit DAC was the first thing that had to go. It has an audible noise floor — a baseline hiss present even when nothing is playing. Not faint, not acceptable. Measuring it confirmed the problem: the analog output section on the STM32 isn't really designed for audio fidelity. Switched to an external ES9038Q2M and the noise floor dropped to nothing.

The I2S connection between the two chips has an asymmetry that matters. The ESP32 is the I2S master — it generates the clock signals (BCLK and LRCLK) that define the timing for the whole link. The STM32 is configured as `I2S_MODE_SLAVE_RX`: it listens on those clocks and samples on their edges. They share only three wires plus ground. This master/slave arrangement is fundamental to digital audio; you cannot have two devices independently generating clocks on the same bus or they will fight each other.

Then clock drift showed up.

The ESP32 generates its I2S clock from its own crystal oscillator. The STM32 drives its DAC from TIM6 — a hardware timer ticking from a completely different crystal. Both crystals nominally run at the same frequency, but "nominally" is doing a lot of work in that sentence. Every crystal has tolerance, and those tolerances don't cancel. Over minutes of playback, the two clocks diverge, and the I2S buffer slowly fills or drains. Fill it too much and samples get dropped. Drain it to empty and you get silence or a click at the moment of underrun.

My first attempt was to just make the buffer bigger. That delayed the problem by maybe 30 seconds. The real fix was a [PI controller](https://en.wikipedia.org/wiki/Proportional%E2%80%93integral%E2%80%93derivative_controller) running on the STM32 that continuously measures the fill level of the receive buffer and nudges TIM6's auto-reload register to compensate.

The buffer is a 4-segment ring. DMA writes incoming I2S samples into it; the DAC reads out the other end. The PI controller measures the distance between the write and read cursors and adjusts TIM6's `ARR` register — the value that determines how long each timer tick takes, and therefore how fast the DAC consumes samples — to keep that distance near a target:

```c
int32_t distance_error = target_distance - actual_distance;
distance_error_sum += distance_error;
// Clamp to prevent integral windup
if (distance_error_sum > max_sum) distance_error_sum = max_sum;
int32_t adjustment = (Kp * distance_error + Ki * distance_error_sum) >> 8;
TIM6->ARR = base_period + adjustment;
```

The integral term (`distance_error_sum`) is what makes this a PI controller rather than a plain proportional one. A proportional controller can reduce drift but leaves a steady-state offset — it only corrects when there's an error, so the error never fully reaches zero. The integral accumulates past errors, allowing the controller to zero out even small persistent drift. The clamp on `distance_error_sum` prevents integral windup: without it, if the buffer fills briefly for some unrelated reason, the accumulated integral could drive the DAC so fast it takes seconds to settle back down. With the clamp, the integral can't grow beyond a safe bound.

The `>> 8` at the end is fixed-point arithmetic — `Kp` and `Ki` are scaled up by 256 in the constants so you get fractional corrections without floating point on a microcontroller. Tuning those constants took a day. Too aggressive and it oscillates — you hear a warbling effect as the rate hunts. Too slow and drift accumulates between corrections. The values that worked were far smaller than I expected.

Also added [PSRAM](https://en.wikipedia.org/wiki/Dynamic_random-access_memory#Pseudo-static_RAM) support for the ESP32 audio buffer. Without it, the buffer you can fit in internal SRAM is tight enough that any network jitter causes an underrun. The PSRAM lets you hold several seconds of audio, which makes the PI controller's job easier and makes dropouts essentially impossible under normal conditions.

### DMA and the two-halves trick

Moving audio data from the I2S peripheral into memory without involving the CPU is exactly what DMA is for. The I2S receiver is wired to a DMA channel, which writes incoming samples into a contiguous buffer in memory — continuously, in a circle, at 44.1kHz. The CPU never touches the transfer itself.

The trick is treating that one circular buffer as two halves. DMA fires one interrupt when it reaches the halfway point and another when it wraps around to the beginning. While DMA is filling the first half, the CPU processes the second half — and vice versa. You always have a safe half to work with.

What makes this worth thinking carefully about is that the CPU and DMA are genuinely concurrent hardware actors. This isn't two threads sharing a lock. DMA is a separate hardware engine with direct access to the memory bus. If the CPU reads from the half that DMA is currently writing to, the result is unpredictable. The half-buffer interrupt discipline is the protocol that keeps them out of each other's way — it's the hardware equivalent of a mutex, except it's enforced by wiring, not software.

### 16-bit in, 12-bit out

The STM32's DAC is 12 bits. The incoming I2S samples are 16 bits. The obvious approach — shift right by 4 — works, but it throws away everything below the noise floor of the DAC anyway. The less obvious problem is the rails.

A 12-bit DAC with a 3.3V reference spans 0 to 4095. Values near 0 and 4095 — the rails — tend to be nonlinear. The analog output stage isn't flat at the extremes. Audio at full scale can push into that nonlinear region and produce harmonic distortion that doesn't exist in the original signal.

The fix is to attenuate before converting. The sample conversion in the code does `((int32_t)sample * 3) >> 2`, which multiplies by 3/4 — 75% of full scale. Shifting right by 2 is a divide by 4. This keeps the DAC working in its linear region and the headroom is imperceptible in listening. It's the kind of detail you'd never find in a datasheet; it shows up empirically when you put an oscilloscope on the output and compare a full-scale sine to the spec.

### One codebase, two chips

There's a specific problem that shows up when you want the same audio firmware to run on multiple ESP32 variants. Bluetooth Classic (A2DP) is supported on the original ESP32 but not on the ESP32-S3. The S3 has a different radio architecture. If you try to call the Bluetooth Classic stack on an S3, it won't compile — the symbols don't exist.

The firmware handles this at compile time rather than runtime:

```c
#if SOC_BT_CLASSIC_SUPPORTED
    // A2DP sink using Classic Bluetooth
    esp_a2d_sink_init();
    esp_a2d_sink_register_data_callback(bt_data_callback);
#else
    // BLE or alternative audio path for ESP32-S3
    ble_audio_init();
#endif
```

`SOC_BT_CLASSIC_SUPPORTED` is defined (or not) by the ESP-IDF SDK based on which chip you're building for. The compiler sees the appropriate block and discards the other — the binary for the S3 never contains any reference to the A2DP stack. No runtime checks, no dead code paths, no possibility of calling a missing function.

platformio.ini defines two board environments — one for the ESP32, one for the S3 — so `moon run :build` compiles both without any manual configuration. The macro is the right tool here: it lets a single source file serve both targets without a pile of `if` statements that would need to stay in sync.

### The wiring problem

The system now worked in one room. The next problem: how do you get audio to other rooms?

Running I2S directly doesn't scale — it's a short-range parallel bus, fine across a PCB, unusable across a house. Ethernet is overkill and adds latency. Then the obvious answer: HDMI cables are everywhere, cheap, available in 10m+ runs, and they carry differential pairs designed for high-frequency signaling.

Differential signaling ([LVDS](https://en.wikipedia.org/wiki/Low-voltage_differential_signaling)) encodes each signal as a voltage difference across a twisted pair. Electrical noise hits both wires equally and cancels out on the receiver side. It's how HDMI carries video data over meters of cable — the video just isn't involved here.

I designed a custom PCB in [KiCad](https://www.kicad.org) that converts I2S signals to LVDS differential pairs and maps them onto the HDMI cable's data lanes. The first layout had the LVDS termination resistors in the wrong place — the receiver was seeing reflections and the signal eye diagram looked terrible. Moved them to the far end of the trace, got a clean signal. The receiver board converts back to I2S. The HDMI connector is just a mechanical and electrical convenience.

The output stage also uses a resistor-divider trick to get something approaching balanced signaling out of the DAC's single-ended 0–3.3V output. A true differential output requires the analog design to be rethought from scratch. The resistor divider creates a pseudo-balanced signal that's compatible with XLR connectors — it won't reject noise as well as a real balanced line, but it's far better than single-ended over any length of cable, and it costs a handful of passive components.

```
Source (phone/line in)
  → Bluetooth A2DP (ESP32)
  → I2S
  → DSP matrix mixer (ADAU1452 / ADAU1701 / CS47048)
  → I2S-to-LVDS (custom PCB, over HDMI cable)
  → STM32H723ZG receiver
  → DAC (ES9038Q2M / PCM5102A)
  → Amplifier (IcePower / Hypex)
  → Speakers
```

A DSP sits in the middle to handle mixing and per-zone routing. That part isn't in hardware yet — it's where the design is heading.

### Where things are

The I2S-to-LVDS board went through layout iteration and was sent to manufacturing. The working prototype is still the simpler path:

```
Phone → Bluetooth → ESP32 (A2DP sink) → I2S → STM32H723ZG → DAC → Audio out
```

The PCB has not been integrated yet, and the prototype path has a noise floor and occasional clicks that haven't been resolved. The DSP integration is the next step.

### What's next

- Spin and test the I2S-to-LVDS PCB over real cable lengths
- Integrate a DSP evaluation board (ADAU1452 or CS47048) for mixing
- Per-room volume control
