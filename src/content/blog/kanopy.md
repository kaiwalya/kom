---
title: "Kanopy — Automating Telescope Rain Protection"
summary: "An Arduino-based system that automatically protects a telescope from rain."
date: 2025-09-10
tags: [project, hardware, arduino, astronomy, automation]
type: [tech, astrophotography]
draft: false
---

Imaging sessions run overnight. If it starts raining at 2am, you find out the next morning when you go to close the session.

That's the problem. The telescope and mount are exposed. Water in the optics or electronics ends the session and potentially the equipment.

The software is complete. The canopy was never deployed — the carbon fibre tubes I had were too thin to handle wind load, and the physical design is still the blocker. This post is about the software architecture.

Repo: [github.com/kaiwalya/kanopy](https://github.com/kaiwalya/kanopy)

### The prototype

An Arduino drives a motor controller that opens and closes a protective canopy over the mount. A rain sensor triggers the close sequence. When rain stops and conditions clear, the canopy opens again.

The first version worked, more or less. Rain detected, canopy closes. The problem was the motor travel distance: I had hardcoded the pulse count that corresponded to "fully closed" by running the motor until it stalled, timing it, and baking that number in. It worked for my mount. On a shorter canopy travel it would have driven the motor into the stop, and on a longer one it would have left the canopy half-open. I caught this only because I happened to test with a different extension arm attached, which changed the geometry enough that the canopy stopped six inches short. The fix was a dedicated config value, but that exposed a larger problem — everything was hardcoded.

### Why the first version wasn't good enough

The initial firmware was flat. Configuration — travel distance, motor speed, limit thresholds — was scattered through the code. The hardware access was mixed in with the logic.

That's fine for one mount with one configuration. But different mounts have different canopy geometries. If I ever wanted to run this on a second setup, or if someone else wanted to use it, changing hardware meant editing control logic, which means bugs in the part that matters most.

A rain canopy has exactly one job. A firmware bug means water in the optics. The code needed to be structured so that the parts that could go wrong were clearly separated from the parts that controlled hardware.

### The architectural overhaul

All 18 commits landed the same day — the prototype followed immediately by a full restructuring.

```
app/    — state machine, open/close decisions
core/   — motor control, configuration management
hal/    — GPIO, timing, sensor reads
```

The key design decision was three layers of vtables.

### Vtables in C

In C++, when you call a virtual method, the compiler generates a hidden table of function pointers for each class — the vtable. The object holds a pointer to that table, and method calls go through it. This is how polymorphism works under the hood.

C has no classes, but you can implement the same pattern manually. Kanopy has three:

```c
// HAL vtable: hardware primitives
typedef struct HALVTable {
    void (*pin_mode)(void* impl, Pin pin, PinMode mode);
    void (*digital_write)(void* impl, Pin pin, PinState state);
    PinState (*digital_read)(void* impl, Pin pin);
    uint16_t (*analog_read)(void* impl, Pin pin);
    void (*delay_ms)(void* impl, uint16_t milliseconds);
    void (*delay_us)(void* impl, uint16_t microseconds);
} HALVTable;

typedef struct {
    void* impl;
    const HALVTable* vtable;
} HALInterface;
```

`HALInterface` pairs a `void* impl` (the implementation-specific state) with a `const HALVTable*` (the function table). Every call goes through `hal->vtable->digital_write(hal->impl, pin, state)`. The caller doesn't know or care whether `impl` points to an Arduino register layout or a no-op stub struct.

The same pattern repeats for `MotorVTable` (enable, step, move_smooth, calculate_step_delay) and `CanopyVTable` (open, close, process_automatic_control, error_loop). Three layers, each depending only on the interface above it, never on the implementation.

The `main.c` entry point shows how the layers compose at runtime:

```c
int main(void) {
    HALInterface hal;
    hal_interface_init(&hal, 1023, 5000);  // ADC_MAX_VALUE, VCC_MILLIVOLTS

    CanopyConfig canopyConfig = create_canopy_config();

    Canopy controller;
    canopy_init(&controller, &hal, &canopyConfig);

    if (!controller.vtable->is_initialized(controller.impl)) {
        controller.vtable->error_loop(controller.impl);
    }

    while (true) {
        controller.vtable->process_automatic_control(controller.impl);
    }
}
```

`main` initializes a HAL, builds config, hands them to `canopy_init`, and enters an infinite loop calling `process_automatic_control`. If init fails, it calls `error_loop` — which never returns. The control logic never references `PORTD` or `ADCSRA` or any register name. That detail is entirely inside the HAL layer.

### The stub HAL

Swapping hardware targets is the payoff. The xmake build file detects the platform:

```lua
if is_plat("arduino") then
    add_files("src/hal/arduino/*.c")
    add_files("src/hal/arduino/**/*.c")
else
    add_files("src/hal/stub/*.c")
end
```

On a desktop build, the stub HAL is linked in. Every function is a no-op — `pin_mode` ignores its arguments, `delay_ms` returns immediately, `analog_read` returns the midpoint of the ADC range. The control logic builds and runs on macOS without any hardware attached. You can step through the state machine in a debugger, run it under valgrind, write unit tests against it.

This matters more than it sounds. Most embedded projects become impossible to test because hardware calls are scattered everywhere. The vtable seam makes testing possible as a first-class concern, not an afterthought.

### The state machine

`process_automatic_control` is a two-state machine. The full implementation:

```c
static void canopy_impl_process_automatic_control(void* impl) {
    CanopyImplementation* ctrl = (CanopyImplementation*)impl;
    if (ctrl == NULL || !ctrl->initialized) return;

    bool waterDetected = canopy_impl_is_water_detected(ctrl);

    if (ctrl->currentState == CANOPY_OPEN && waterDetected) {
        canopy_impl_close(ctrl);
    } else if (ctrl->currentState == CANOPY_CLOSED && !waterDetected) {
        canopy_impl_open(ctrl);
    }
}
```

Two states (OPEN, CLOSED), one sensor, four transitions — but only two of them do anything. Open and dry: stay open. Closed and wet: stay closed. Open and wet: close. Closed and dry: open. Rain detected during motor travel is the interesting edge case: the state variable only flips after the move completes, so the motor won't reverse mid-travel.

The error path is intentionally terminal:

```c
static void canopy_impl_error_loop(void* impl) {
    while (true) {
        PinState current = hal->vtable->digital_read(hal->impl, ledPin);
        PinState next = (current == PIN_HIGH) ? PIN_LOW : PIN_HIGH;
        hal->vtable->digital_write(hal->impl, ledPin, next);
        hal->vtable->delay_ms(hal->impl, 500);
    }
}
```

If initialization fails, the firmware blinks the status LED at 1 Hz and loops forever. There's no recovery path, no retry. The canopy stays in whatever position it was in when the error occurred. This is intentional — failing safely is better than failing silently and leaving the logic in an undefined state.

### Sinusoidal motor acceleration

Stepper motors stall if you ramp speed too aggressively. The naive approach — constant delay between steps — works but produces a mechanical jerk at start and stop that puts stress on the gearbox and sounds bad.

The better approach is to vary the inter-step delay across the move. `motor_impl_calculate_step_delay` does this with a sine curve:

```c
static uint16_t motor_impl_calculate_step_delay(
    const void* impl, uint16_t step, uint16_t totalSteps)
{
    float position = (float)step / (float)totalSteps;
    float sineValue = sin(M_PI * position);
    float accelerationFactor = sineValue * sineValue;  // sin²

    uint16_t delay = delaySlow
        - (delaySlow - delayFast) * accelerationFactor;

    return delay;
}
```

`position` goes from 0.0 to 1.0 over the move. `sin(π * position)` is a half-sine that peaks at 1.0 at the midpoint and returns to 0.0 at the end. Squaring it — `sin²` — sharpens the peak into something closer to a trapezoid: slow ramp at the start, full speed through the middle, slow ramp at the end.

The delay units are microseconds. `delaySlow` (20,000 µs = 20 ms/step) at the edges, `delayFast` (5,000 µs = 5 ms/step) at the midpoint. The motor accelerates smoothly, runs at full speed through the bulk of the travel, then decelerates before reaching the stop. No stall, no jerk, no wasted time.

### Raw AVR register access

The Arduino SDK abstracts `pinMode`, `digitalWrite`, `analogRead` into easy function calls. It's convenient and fine for most projects. Kanopy bypasses it entirely — the Arduino HAL talks directly to AVR peripheral registers.

For GPIO:

```c
void hal_gpio_pin_mode(HALGpio* gpio, Pin pin, PinMode mode) {
    volatile uint8_t* ddrReg =
        hal_gpio_get_port_register((Port)pin.port, REG_DDR);

    if (mode == PIN_OUTPUT) {
        *ddrReg |= (1 << pin.bit);   // set bit
    } else {
        *ddrReg &= ~(1 << pin.bit);  // clear bit
    }
}
```

On the ATmega328p, every GPIO port has three 8-bit registers: `DDRx` (data direction — 1 for output, 0 for input), `PORTx` (output value), and `PINx` (input read). Setting a pin as output is a single bit-set on the DDR register. Writing a value is a bit-set or bit-clear on the PORT register. No function call overhead, no abstraction layer, direct memory-mapped I/O.

For the ADC:

```c
void hal_adc_init(HALAdc* adc, uint16_t adcMaxValue, uint16_t vccMillivolts) {
    ADCSRA |= (1 << ADPS2) | (1 << ADPS1) | (1 << ADPS0);  // prescaler = 128
    ADCSRA |= (1 << ADEN);   // enable ADC
    ADCSRA &= ~(1 << ADIE);  // disable interrupt
}

uint16_t hal_adc_analog_read(HALAdc* adc, Pin pin) {
    ADMUX = (1 << REFS0) | (1 << ADLAR) | (pin.bit & 0x0F);
    ADCSRA |= (1 << ADSC);          // start conversion
    while (ADCSRA & (1 << ADSC)) {} // wait for completion
    return ADC;
}
```

`ADCSRA` is the ADC control and status register. Setting `ADPS2|ADPS1|ADPS0` configures the prescaler to 128 — on a 16 MHz clock, that clocks the ADC at 125 kHz, which is inside the 50–200 kHz range the hardware requires for accurate conversions. `ADEN` enables the peripheral. `ADLAR` in `ADMUX` left-adjusts the result, so the 8 most significant bits land in `ADCH` if you only need 8-bit precision; reading the full 16-bit `ADC` register gives 10-bit precision. `REFS0` selects AVcc (the supply voltage) as the reference.

This is what firmware looks like without a framework in the way. Every register bit has a purpose documented in the ATmega328p datasheet. Nothing is hidden.

### Configuration

`create_canopy_config` in `main.c` centralizes everything about the physical setup:

```c
CanopyConfig config = {
    .waterSensorPin         = {PORT_C, 0},
    .waterSensorThreshold   = 20,

    .gearboxLoadShaftRotationDegrees = 180,
    .gearboxStepsPerRevolution       = 200,
    .gearboxReductionRatio           = 3,
    .gearboxStepperSubsteps          = 8,

    .motorDelaySlow = 20000,
    .motorDelayFast = 5000,
    .motorMaxSteps  = 1000,
};
```

The gearbox parameters deserve explanation. `calculate_steps` in `canopy.c` derives motor steps from physical geometry at runtime:

```c
float loadShaftRotations = config.gearboxLoadShaftRotationDegrees / 360.0;
uint16_t motorSteps = loadShaftRotations
    * config.gearboxStepsPerRevolution
    * config.gearboxReductionRatio;
```

The canopy arm needs 180° of rotation. The motor is a 200-step/rev stepper. The gearbox has a 3:1 reduction. So: `(180/360) × 200 × 3 = 300` motor revolutions worth of steps, and with 8x microstepping that's 2400 microsteps per open/close cycle. A different gearbox or arm length is one config change — the motor control loop doesn't need to know.

### The build system

The Arduino IDE's build system is a black box. xmake replaces it with an explicit, reproducible build:

```lua
target("kanopy")
    set_kind("binary")
    add_deps("kanopy_hal", "kanopy_core")

    if is_plat("arduino") then
        add_cxflags("-mmcu=atmega328p", "-DF_CPU=16000000UL", "-Os")
        add_ldflags("-mmcu=atmega328p", "-lm")
        add_rules("install_with_avrdude")
    end
```

Three targets: `kanopy_hal` and `kanopy_core` as static libraries, `kanopy` as the final binary that links them. The `install_with_avrdude` rule runs `avr-objcopy` to produce the flash binary, then invokes `avrdude` to program the chip over USB. Platform detection at build time selects the right HAL — Arduino or stub — without any source changes.

### What the day looked like

First the prototype, then the full architectural overhaul: flatten the config, extract the HAL, reorganize into app/core/hal, convert to static libraries, wire it back together, test. The vtable seam also forced confronting failure modes the prototype had been hiding — two of those edge cases turned out to be real bugs that only showed up when rain hit the sensor during motor travel.
