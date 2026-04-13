---
title: "Arduino Wine Cooler"
summary: "A Peltier-based wine cooler with predictive temperature control."
date: 2021-06-03
tags: [project, hardware, arduino]
type: tech
draft: true
---

A Peltier-based wine cooler with predictive temperature control, built on an Arduino. It works, but Peltier physics impose a hard constraint: it can't maintain more than about 12–15°F difference from ambient. Fine for wine storage in a temperate room; not useful as a refrigerator.

Repo: [github.com/kaiwalya/arduino-wine-cooler](https://github.com/kaiwalya/arduino-wine-cooler)

### Hardware

```
Peltier module (TEC) — active cooling element
DHT11 ×2             — cabinet temperature, ambient temperature
Arduino              — reads sensors, drives Peltier relay
```

A [Peltier module](https://en.wikipedia.org/wiki/Thermoelectric_cooling) uses electricity to pump heat from one side of a ceramic plate to the other — one side gets cold, the other gets hot. No compressor, no moving parts, quiet. The trade-off is efficiency — Peltiers struggle against a large ambient-to-target delta. Fine for wine, which needs cooling, not freezing.

Two DHT11 sensors: one inside the cabinet, one outside. The difference between inside and outside matters for deciding how hard to run the cooler.

### The overshoot problem

The naive controller is obvious: too warm → on, cold enough → off. It does not work.

A Peltier module does not stop being cold the moment you cut power. The ceramic plates stay cold for a while — longer than you'd expect — and the cabinet keeps cooling past the target. I found this out by watching the temperature log after the first test run: the controller said "off" at the target, but the cabinet coasted below it before it started climbing again. Then the controller kicked back in, overshot again in the other direction. The first thing I tried was shortening the hysteresis window, which made it worse — the controller toggled faster and the oscillation got tighter, not smaller.

### Bang-bang control with hysteresis

The final controller uses a 55–58°F target band. If the cabinet is above 58°F and cooling is off, turn it on. If cooling is on and the temperature is at or below 55°F, turn it off. The 3-degree gap prevents rapid cycling.

The state check uses `gLast.cooling` — the controller only acts on transitions, not on every loop iteration:

```cpp
const float TARGET_LOW  = 55.0;
const float TARGET_HIGH = 58.0;

bool shouldCool(float temp, bool currentlyCooling) {
    if (!currentlyCooling && temp > TARGET_HIGH) return true;
    if (currentlyCooling  && temp <= TARGET_LOW)  return false;
    return currentlyCooling; // stay in current state
}
```

That `return currentlyCooling` is the hysteresis. Inside the band, do nothing. Without it, any reading between 55 and 58°F would cause the relay to chatter.

But hysteresis alone does not solve the coasting problem. The Peltier keeps cooling after the relay opens. The fix is to act earlier — before the temperature actually hits the floor — by projecting where it will be.

### Linear extrapolation

```cpp
float predictIterations = 2.0 * 60.0 * 1000.0 / delayTime;

float predict(float old, float recent) {
    return recent + (recent - old) * predictIterations;
}
```

`delayTime` is the loop delay in milliseconds. The math: 2 minutes × 60 seconds × 1000 ms ÷ loop delay gives the number of loop iterations in 2 minutes — 8 iterations at the chosen delay. The predictor takes the previous smoothed reading (`old`) and the current one (`recent`), extrapolates the trend 8 iterations forward, and returns where the temperature will be in 2 minutes if nothing changes.

The control loop checks both the current temperature and the predicted temperature:

```cpp
float predicted = predict(gLast.smooth, smooth);

bool cooling = shouldCool(smooth, gLast.cooling);
bool predictedCooling = shouldCool(predicted, gLast.cooling);

if (cooling != gLast.cooling || predictedCooling != gLast.cooling) {
    // state transition — act now
}
```

If either the current or the predicted value triggers a state change, act. This means the relay can open before the temperature hits 55°F, giving the coasting Peltier time to bleed off its stored cold. The 2-minute lookahead window was chosen empirically — enough to account for the thermal lag without causing undershoot.

### EMA smoothing — the IIR filter you already know

The DHT11 has 1°C resolution and non-trivial jitter. Raw readings flip the sign of `recent - old`, which makes the rate-of-change predictor useless. The fix is to smooth the sensor output before passing it to the predictor.

The actual implementation is not a moving average. It is an exponential moving average:

```cpp
float smooth(float g, float now, float smoothFactor) {
    return g * smoothFactor + (1.0 - smoothFactor) * now;
}

// Called each loop iteration with smoothFactor = 0.8:
float newSmooth = smooth(gLast.smooth, rawTemp, 0.8);
```

This is a single-pole IIR low-pass filter. The transfer function, if you unfold the recursion, is a geometric series that weights recent samples exponentially less as they age:

```
output[n] = 0.8 * output[n-1] + 0.2 * input[n]
           = 0.2 * input[n]
           + 0.2 * 0.8 * input[n-1]
           + 0.2 * 0.8² * input[n-2]
           + ...
```

An alpha of 0.8 means the current raw reading contributes only 20% to the output. New information is admitted slowly. The "memory" of the filter has a half-life of about `log(0.5) / log(0.8)` ≈ 3 iterations.

If this formula looks familiar, it is the same one used in TCP's RTT estimator (RFC 6298 uses the same exponential smoothing for SRTT), and in game engine frame-time smoothers. The same math shows up anywhere you want to track a noisy signal with bounded memory and O(1) per-sample cost.

### Why EMA and prediction compose well

This is the non-obvious part. The controller runs prediction on the smoothed value, not the raw sensor reading. That might seem like it defeats the purpose — if you're smoothing out the noise, are you also smoothing out real trend information?

Not exactly. EMA attenuates high-frequency noise while passing low-frequency trends. The temperature change rate across 2 minutes is low-frequency; DHT11 jitter is high-frequency. So the smoothed signal retains the trend the predictor cares about, with the noise removed.

If the predictor ran on raw readings, `recent - old` would include jitter, and the prediction would amplify that noise by a factor of 8 (the `predictIterations` multiplier). By smoothing first and predicting second, you amplify the signal instead of the noise. This is the deliberate design, not an accident of implementation order.

### initSensorOrStall

The startup sequence blocks until the sensor responds:

```cpp
void initSensorOrStall(DHT &sensor) {
    while (true) {
        sensor.begin();
        float t = sensor.readTemperature();
        if (!isnan(t)) break;
        delay(1000);
    }
}
```

This would be wrong in a web server — you cannot block a request thread waiting for hardware. On an Arduino with no OS and no other tasks, it is correct. The device has one job. If the sensor is not ready, the device should wait, not proceed with a NaN reading and drive the relay in an undefined state. The blocking retry is the right idiom.

### Everything is hardcoded

Target range, pin assignments, smoothing alpha, loop delay, prediction window — all compile-time constants. To change the target temperature, you reflash. For a wine cooler, this is fine. The device runs in one environment, against one set of sensors, for one purpose. Runtime configuration would add complexity with no benefit.

The total firmware is about 140 lines.
