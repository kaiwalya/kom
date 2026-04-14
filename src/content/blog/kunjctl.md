---
title: "Kunjctl — Home Automation with Thread and Matter"
summary: "Building a Thread mesh network with ESP32 devices and bridging it to Matter."
date: 2026-01-18
tags: [project, hardware, esp32, thread, matter, home-automation, iot]
type: tech
draft: false
---

This project started with BLE. Then I deleted all of it.

Repo: [github.com/kaiwalya/kunjctl](https://github.com/kaiwalya/kunjctl)

### Why BLE didn't last

BLE works fine for one device in one room. The moment you want a mesh — sensors and switches across multiple rooms, all talking to a single controller — BLE's topology gets painful. You either run a hub that everything pairs to, or you use BLE mesh, which adds significant complexity for marginal range improvement.

The commit that marks the shift is blunt: "Remove BLE projects in favor of Thread." No gradual migration. Replaced the firmware from scratch.

### Thread end devices

[Thread](https://en.wikipedia.org/wiki/Thread_(network_protocol)) is a mesh protocol built on IEEE 802.15.4. Devices route traffic for each other — the network self-heals, and adding a node extends coverage rather than adding load to a central hub. Unlike Zigbee, Thread runs IPv6 natively, which matters for what comes later.

The [ESP32-H2](https://www.espressif.com/en/products/socs/esp32-h2) handles the end device role. It joins the Thread mesh, reports state, and accepts commands.

#### Joining the mesh

Before an H2 can talk to anything, it has to join the Thread network. That requires configuring an OpenThread dataset — a bundle of parameters that identify the network: its name, the radio channel (1–26 in the 2.4GHz band), a PAN ID, and a 128-bit network key used for AES encryption of all traffic. Get any of these wrong and the device can't hear the network even if it's right next to the border router.

After configuring the dataset, the code blocks waiting for the device role to reach `OT_DEVICE_ROLE_CHILD`. Child means the mesh accepted you. Router means you're routing for others. Leader means you won the election to manage the network. For a battery-powered sensor, Child is where you want to stay:

```c
otOperationalDataset dataset = {};
otDatasetCreateNewNetwork(instance, &dataset);
dataset.mNetworkName = ...; // "kunjctl"
dataset.mChannel = 15;
dataset.mPanId = 0xBEEF;
// ... network key, etc.
otDatasetSetActive(instance, &dataset);
otThreadSetEnabled(instance, true);

// Block until we're on the mesh
while (otThreadGetDeviceRole(instance) != OT_DEVICE_ROLE_CHILD) {
    vTaskDelay(pdMS_TO_TICKS(100));
}
```

Once joined, the device reconfigures as a Sleepy End Device. The key flag is `mRxOnWhenIdle = false`. With that set, the radio physically powers off between polls. The poll period is 2 seconds: the device wakes, checks for pending messages from its parent, then goes dark again. From the network's perspective, it's still a participant. From a power perspective, it's off 99% of the time.

```c
otLinkModeConfig mode = {};
mode.mRxOnWhenIdle = false;   // radio off between polls
mode.mDeviceType   = false;   // end device, not router
mode.mNetworkData  = false;
otThreadSetLinkMode(instance, mode);

otLinkSetPollPeriod(instance, 2000); // ms
```

#### Power management

The SED radio schedule is just one layer. The H2 also runs three software-level power strategies:

- **Tickless idle** — the RTOS scheduler skips timer interrupts entirely when there's nothing to do, instead of waking up just to go back to sleep
- **Deep sleep** — the processor fully powers down for 15 seconds at a time, waking for a 3-second active window to take a sensor reading and transmit it
- **[DFS](https://en.wikipedia.org/wiki/Dynamic_frequency_scaling)** — CPU clock speed drops under low load

The 3s active / 15s deep sleep duty cycle came out of profiling: 3 seconds is enough to join the mesh, grab a reading, send the UDP packet, and confirm receipt. Measuring with a current probe showed the CPU running at its minimum 32MHz frequency 91% of the awake time — the radio is the bottleneck, not the processor. DFS was essentially free power savings once the radio timing was sorted.

GPIO state and relay position survive the deep sleep via two mechanisms. `RTC_DATA_ATTR` marks a variable as stored in the RTC slow memory, which stays powered during deep sleep:

```c
RTC_DATA_ATTR static bool relay_state = false;
```

And `gpio_hold_en()` latches the physical pin level before sleep so the output doesn't float:

```c
gpio_hold_en(RELAY_GPIO);
esp_deep_sleep_start();
// on wake: gpio_hold_dis(RELAY_GPIO) to allow changes
```

Without `gpio_hold_en`, the relay would click on every wake-up as the GPIO initializes to its reset state before the firmware has a chance to restore the saved value.

One thing that didn't work: light sleep. It's a lower-power mode than tickless idle but doesn't fully shut down the processor. The intent was to use it as an intermediate state during the active window. In practice, light sleep broke Thread messaging entirely — the stack's timer callbacks would fire late, and the device would miss its poll window, causing it to detach from the network. Deep sleep was the right call; there's no in-between on this hardware.

#### The OpenThread lock

OpenThread has a strict threading model: every call into its API must be made while holding the OpenThread mutex. This is not a soft guideline — violating it causes data corruption in the protocol stack, which manifests as intermittent watchdog resets. The failure is almost impossible to reproduce reliably, which makes it brutal to debug.

The initial send path was acquiring the lock before `otUdpSend` but not before `otUdpNewMessage` or `otMessageAppend`, which allocate and populate the message buffer before sending. Those calls also touch OpenThread-internal state:

```c
// Wrong: lock only covers the send, not the allocation
otMessage *msg = otUdpNewMessage(instance, NULL); // not locked
otMessageAppend(msg, buf, len);                   // not locked
esp_openthread_lock_acquire(portMAX_DELAY);
otUdpSend(instance, &socket, msg, &peer_addr);
esp_openthread_lock_release();
```

The fix was to widen the lock to cover the entire message lifecycle, and then restructure the send path so it happens in a dedicated FreeRTOS task rather than inline in whatever task detected a state change:

```c
// Right: post to ot_send_task which holds the lock for the full sequence
xQueueSend(ot_send_queue, &payload, portMAX_DELAY);

// In ot_send_task:
esp_openthread_lock_acquire(portMAX_DELAY);
otMessage *msg = otUdpNewMessage(instance, NULL);
otMessageAppend(msg, buf, len);
otUdpSend(instance, &socket, msg, &peer_addr);
esp_openthread_lock_release();
```

The watchdog resets stopped entirely after this change. It had been happening roughly once every 6–8 hours, which is exactly the kind of rate that makes you doubt yourself — long enough between failures to make you think whatever you last changed might have fixed it.

#### The multicast bug

UDP multicast is how the border router sends commands back to end devices — one packet, all devices receive it. OpenThread supports multicast, but the group address matters. The initial code used `ff03::1`, a site-local multicast address. The problem: Sleepy End Devices silently never receive multicast. The spec says this. The radio-off-between-polls model is fundamentally incompatible with receiving unsolicited multicast — you can't receive a packet when your radio is off.

This is one of those bugs where nothing is broken at the protocol level. The border router successfully sends. OpenThread on the device successfully processes the multicast subscription. Packets are transmitted on the wire. They just don't arrive, ever, and there's no error anywhere in the stack to tell you why.

The fix was switching to unicast commands addressed to each device's individual IPv6 address. The border router now tracks each end device's address from its join announcement and sends commands directly. The end device polls its parent, the parent buffers the unicast packet, and the device receives it on the next poll. Slower than multicast would have been (if it worked), but reliable.

#### Deterministic device names

Every H2 gets a human-readable name at first boot, derived from its MAC address. The format is `adjective-noun-hex` — something like `vivid-falcon-a3f2`. No user configuration, no UUIDs in logs:

```c
// Last two bytes of MAC → hex suffix
// Remaining bytes seed into adjective + noun wordlists
uint8_t mac[6];
esp_read_mac(mac, ESP_MAC_IEEE802154);

uint16_t adj_idx  = (mac[0] ^ mac[1] ^ mac[2]) % NUM_ADJECTIVES;
uint16_t noun_idx = (mac[3] ^ mac[4])           % NUM_NOUNS;
uint16_t hex_sfx  = mac[5] << 8 | mac[4];

snprintf(name, sizeof(name), "%s-%s-%04x",
         adjectives[adj_idx], nouns[noun_idx], hex_sfx);
```

The same MAC always produces the same name, so the name is stable across resets. When you see `vivid-falcon-a3f2` in a log, you can physically find the board. With UUIDs you can't.

### Border router

A Thread mesh is isolated by default — it can't talk to your IP network without a border router. The [ESP32-S3](https://www.espressif.com/en/products/socs/esp32-s3) runs Thread [RCP](https://openthread.io/platforms/co-processor) (Radio Co-Processor) firmware alongside the border router application. In RCP mode, the S3 acts as a dedicated radio controlled by the host processor. This bridges the Thread mesh onto the home network and makes the IPv6 addresses routable from the rest of the LAN.

```
ESP32-H2  — Thread end device (sensor/actuator nodes)
ESP32-S3  — Border router + Matter bridge

IEEE 802.15.4 radio (H2)
  → Thread mesh
  → Border router (S3)
  → IP network
  → Matter controller (phone, hub)
```

The H2 and S3 communicate over UART using the [spinel](https://openthread.io/reference/spinel-protocol-guide) protocol — a binary framing format OpenThread uses to drive an RCP. There's one non-obvious hardware requirement here: the UART clock source must be set to `UART_SCLK_XTAL`, not the default APB clock:

```c
uart_config_t uart_config = {
    .baud_rate  = 460800,
    .source_clk = UART_SCLK_XTAL, // critical — APB causes garbled spinel frames
    // ...
};
```

The APB clock frequency changes when DFS adjusts the CPU speed. The UART baud rate is derived from it, so when DFS kicks in, the baud rate shifts slightly and the spinel frames become garbage. `UART_SCLK_XTAL` uses the crystal oscillator, which is independent of DFS. Every spinel frame corruption and "RCP not responding" error I saw before this fix was actually a baud rate drift from DFS adjusting the APB clock.

### Hardware iteration

After the first board layout was assembled and flashed, pin conflicts appeared that only showed up once the full firmware stack was running — not during bring-up, when I was testing peripherals one at a time. The SPI bus for the display and the pins OpenThread's radio driver wanted for its internal state overlapped in a way the datasheet made look fine. Finding it meant bisecting the initialization sequence until I could isolate which `esp_err_t` was returning `ESP_ERR_INVALID_STATE` and why. Revised the pin assignments, updated the board layout, and reflashed. A second-spin board is on order.

### Protobuf on the MCU

Message serialization between the border router and end devices uses [nanopb](https://jpa.kapsi.fi/nanopb/) — a Protocol Buffers implementation small enough to run on a microcontroller. The key property is that nanopb generates fixed-size C structs from the `.proto` schema. There's no heap allocation, no dynamic memory, no `malloc`. On a device with 320KB of RAM where you're also running a Thread stack and FreeRTOS, this matters.

The schema is 15 lines:

```protobuf
syntax = "proto3";

message Report {
  uint32 device_id  = 1;
  uint32 message_id = 2;  // 16-bit timestamp | 16-bit random
  float  temperature = 3;
  float  humidity    = 4;
  bool   occupied    = 5;
}

message RelayCommand {
  uint32 device_id = 1;
  bool   state     = 2;
}

message Envelope {
  oneof payload {
    Report       report  = 1;
    RelayCommand command = 2;
  }
}
```

The `oneof` field means both message types travel over the same UDP socket — the border router inspects the `payload` case to decide what it received. This keeps the end device firmware simpler: one socket, one send path, one receive path.

The `message_id` field packs a 16-bit timestamp and a 16-bit random value into a single `uint32`. This is for log correlation: when you see a message ID in the border router log, you can find the corresponding transmission log on the end device. The timestamp component lets you order messages even if they arrive out of sequence; the random component prevents ID collisions in the unlikely event two messages are sent in the same millisecond.

```c
uint32_t make_message_id(void) {
    uint16_t ts  = (uint16_t)(esp_timer_get_time() / 1000); // ms, wraps
    uint16_t rnd = esp_random() & 0xFFFF;
    return ((uint32_t)ts << 16) | rnd;
}
```

### The Matter bridge

Thread on its own is invisible to Apple Home, Google Home, or any standard controller. [Matter](https://en.wikipedia.org/wiki/Matter_(standard)) is a smart home interoperability standard — any certified controller can talk to any certified device, regardless of brand. But Matter assumes it's talking directly to devices. It doesn't know about Thread.

The bridge solves this in three phases:

**Phase 1 — Device registry.** Each Thread end device gets a record in [NVS](https://docs.espressif.com/projects/esp-idf/en/latest/esp32/api-reference/storage/nvs_flash.html) (a key-value store in flash that survives reboots). Without this, every power cycle forgets which devices exist.

**Phase 2 — Runtime state manager.** At startup, the bridge reads NVS, reconstructs per-device state objects, and holds them in memory for the Matter stack to read from.

**Phase 3 — Aggregator endpoints.** The Matter stack is told about each Thread device via aggregator endpoints. From the controller's perspective, it sees native Matter devices. Thread is invisible.

```
NVS device registry
  → runtime state objects
  → Matter aggregator endpoints
  → bridged device endpoints
```

#### Dynamic endpoints and the first-report pattern

Matter endpoints are usually static — you declare them at compile time and they don't change. The bridge can't do that because it doesn't know which devices will join the mesh ahead of time. It uses dynamic endpoints, which Matter supports but makes more complicated.

The key behavior: the first report from an H2 triggers endpoint creation. Before that report, the bridge doesn't know the device exists. After it, there's a Matter endpoint for it and a state object in NVS. Subsequent reports update the existing endpoint.

Dynamic endpoints require manual cluster callback initialization. Normally `provider::Startup()` handles this when the device boots and endpoints are registered — but that method only runs once, at startup. Any endpoint created after startup has to initialize its own cluster callbacks explicitly:

```cpp
// Static endpoint path (runs at boot via provider::Startup)
emberAfInit(); // registers all cluster callbacks automatically

// Dynamic endpoint path (must do this manually after creation)
new_endpoint->cluster_callbacks.on_off.get  = on_off_get_cb;
new_endpoint->cluster_callbacks.on_off.set  = on_off_set_cb;
// ... for each cluster the endpoint exposes
emberAfEndpointEnableDisable(endpoint_id, true);
```

Miss this and the Matter controller can discover the endpoint but gets empty responses to attribute reads — it looks like the device is online but not reporting.

#### Preventing feedback loops

When the border router receives a Thread report and updates its state, it also needs to push that update to the Matter stack. But the Matter stack sometimes writes back to the same state object when a controller sets an attribute. Without guards, you get a loop: Thread report → state update → Matter write → state update → spurious Thread command.

Two flags break the cycle:

```cpp
bool cmd_pending        = false; // a command is queued to send down to Thread
bool updating_from_thread = false; // currently processing a Thread report

void on_thread_report(Report *r) {
    updating_from_thread = true;
    update_matter_attribute(r->device_id, r->temperature, ...);
    updating_from_thread = false;
}

void on_matter_attribute_write(uint16_t endpoint, ...) {
    if (updating_from_thread) return; // ignore writes caused by our own update
    cmd_pending = true;
    queue_thread_command(endpoint, ...);
}
```

`updating_from_thread` prevents the Matter write-back during a report update. `cmd_pending` prevents duplicate commands if the controller writes the attribute multiple times before the Thread device has a chance to respond.

### Cleanup

The stale state update bug was subtle. When a Thread end device reconnected after a sleep cycle, it would send its current state — but the bridge was also replaying the last cached state from NVS at startup. For a brief window, both updates were in flight, and whichever arrived second won. That meant a sensor that had been off for hours could momentarily report its pre-sleep value on reconnect, triggering a spurious notification on the controller. I saw this as phantom "motion detected" alerts at 3am. The fix was using the `message_id` timestamp component as a sequence number and dropping any update older than what the bridge already had in memory. I also reduced the reporting interval on end devices that were polling more frequently than necessary — the mesh was healthy enough that the redundancy wasn't buying anything.

The system is running and connected to a fireplace. It shows up in the Matter controller, survives node failures, and the end devices run on battery. One known issue: wires periodically pop out of the relay connection on the actuator node. The plan is to resolder everything onto a better PCB and build a wooden enclosure.
