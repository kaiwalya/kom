---
title: "Telescope Control Software and the INDI Protocol"
summary: "Building INDI telescope control clients in TypeScript and Rust."
date: 2022-03-15
tags: [project, typescript, rust, astronomy, indi]
type: astrophotography
draft: false
---

The first four photos on this site — Great Orion Nebula through Rosette Nebula — were captured with [Ekos](https://stellarmate.com/ekos.html). The Heart Nebula mosaic too, since my software can't do mosaics. Everything from the Crab Nebula onward was captured using the TypeScript system described here. Processing was done with [AstroPixelProcessor](https://www.astropixelprocessor.com/) throughout, except the last two images (Heart Nebula IC 1805 and Pelican Nebula) which used [PixInsight](https://pixinsight.com/). The Rust version (`rastro`) is an incomplete rewrite. This post covers both.

Repos: [github.com/kaiwalya/astro](https://github.com/kaiwalya/astro) (TypeScript) · [github.com/kaiwalya/rastro](https://github.com/kaiwalya/rastro) (Rust)

### What INDI is

[INDI](https://indilib.org/) (Instrument Neutral Distributed Interface) is an XML-based protocol for controlling astronomical instruments — mounts, cameras, filter wheels, focusers. Devices expose properties. Clients read and write them over a TCP socket between software running on a laptop and a server running on a Raspberry Pi attached to the scope.

It is old, text-heavy, and widely supported. Every serious piece of open-source astronomy software speaks it.

### INDI is CQRS in disguise

Before getting into the implementation, it is worth understanding the protocol's architecture — because it is not what you would expect, and getting it wrong is why writing against INDI feels strange at first.

Most hardware APIs work like function calls. You send a request, you wait, you get a response. `read(fd, buf, len)`. `GET /status`. Call, response, done. INDI does not work this way.

INDI has three classes of messages, with three different prefixes:

- `def` — the server defines a property and sends its current value (`defSwitchVector`, `defNumberVector`, ...)
- `set` — the server reports that a property changed (`setSwitchVector`, `setNumberVector`, ...)
- `new` — the client requests a change (`newSwitchVector`, `newNumberVector`, ...)

There is no `get`. There is no `getProperties` in the sense you might expect — `getProperties` is a subscription request. It tells the server "send me everything," and the server responds with a flood of `def` messages. From that point on, whenever anything changes, the server sends a `set`. You never pull state. You subscribe and receive.

This is [CQRS](https://martinfowler.com/bliki/CQRS.html) — Command Query Responsibility Segregation — at the protocol level, enforced by the wire format. The write path (commands: `newXxxVector`) and the read path (queries: `def`/`set` events) are completely separate channels. Commands do not return values. State arrives asynchronously, on the server's schedule.

**In the TypeScript client, the split is structural.** `IndiWriter` is a Transform stream in one direction — objects in, XML bytes out. `IndiReader` is a Transform stream in the other direction — XML bytes in, objects out. They share no code and no state. Calling `IndiWriter.send()` produces no response. The response, when it comes, arrives minutes later through `IndiReader`, triggered by the device itself.

`IndiContext` sits above both and maintains the materialized view — the projected state of all connected devices:

```typescript
class IndiContext extends EventEmitter {
    _devices: Record<string, {
        vectors: Record<string, IndiVector>
    }> = {};

    onDef(msg: IndiDefObject) {
        const dev = this._devices[msg.device] ??= { vectors: {} };
        dev.vectors[msg.name] = vectorFromDef(msg);
        this.emit("stateChanged");
    }

    onSet(msg: IndiSetObject) {
        const vec = this._devices[msg.device]?.vectors[msg.name];
        if (vec) {
            applySet(vec, msg);
            this.emit("stateChanged");
        }
    }
}
```

Every `def` or `set` message updates `_devices` and emits `stateChanged`. That is it. `_devices` is a projection of the event stream — the same concept as a read model in event sourcing. The `def`/`set` stream from the server is the event log. `_devices` is what you get when you replay it.

### The `mkIndiPromise` pattern

The combination of CQRS and asynchronous hardware creates an interesting problem: how do you write sequential-looking logic against a system that has no request-response semantics?

If you want to connect the camera and wait until it is connected, the imperative version looks like this:

```typescript
// What you wish you could write:
await camera.connect();
await camera.setTemperature(-10);
await camera.startExposure(300);
const file = await camera.getImage();
```

But INDI has no `await camera.connect()`. You send `newSwitchVector` with `CONNECT=On`, and then... you wait for the server to eventually send `setSwitchVector` with `CONNECTION.CONNECT=On`. The response is an event, not a return value. You cannot block on it.

The `mkIndiPromise` function bridges this gap:

```typescript
function mkIndiPromise<T>(
    ctx: IndiContext,
    f: (ctx: IndiContext, resolve: (v: T) => void, reject: (e: Error) => void) => void
): Promise<T> {
    return new Promise<T>((resolve, reject) => {
        const evalFunction = () => f(ctx, resolve, reject);
        ctx.on("stateChanged", evalFunction);
        evalFunction();  // evaluate immediately in case state already satisfies the condition
    });
}
```

The function `f` is called every time state changes. It receives the current context and the promise's resolve/reject. When conditions are met, it resolves. If state never reaches the target, it waits indefinitely (or until a timeout wrapper catches it).

If you know React, this pattern will feel familiar. The callback is a render function: it re-runs when state changes, reads current state synchronously from `_devices`, and decides what to do. `stateChanged` is the equivalent of `setState()` triggering a re-render. `_devices` is the store.

The analogy breaks down in two places. First, the callback fires side effects directly — it calls `ctx.controlClient.send()` inside the same pass that reads state. React separates these with `useEffect`; INDI's version freely mixes reading and writing. Second, `mkIndiPromise` resolves once and unsubscribes. A React component renders indefinitely. This is render-to-completion, not a persistent loop.

Here is what connecting the camera looks like with this pattern:

```typescript
async function connect(ctx: IndiContext, writer: IndiWriter, device: string) {
    // Fire the command — no response expected
    writer.send({
        semantics: "new",
        device,
        name: "CONNECTION",
        valueType: "switch",
        values: [{ name: "CONNECT", value: "On" }]
    });

    // Wait for state to reflect the change
    return mkIndiPromise(ctx, (ctx, resolve, reject) => {
        const vec = ctx._devices[device]?.vectors["CONNECTION"];
        if (vec?.elements["CONNECT"]?.value === "On") {
            resolve(undefined);
        }
    });
}
```

`writer.send()` is fire-and-forget. Then `mkIndiPromise` re-evaluates the condition on every `stateChanged` event until `CONNECT` flips to `On`. The promise resolves when the hardware confirms it.

### The capture state machine

The exposure sequence is where this pattern gets interesting. A capture is not one step — it is a sequence of state transitions, each triggered by the previous state change:

```typescript
type CaptureState =
    | "readyForNewCapture"
    | "willCapture"
    | "captureSent"
    | "captureStarted"
    | "captureStoring";

async function capture(ctx: IndiContext, writer: IndiWriter, device: string, seconds: number) {
    let state: CaptureState = "readyForNewCapture";

    return mkIndiPromise<FitsData>(ctx, (ctx, resolve, reject) => {
        const pExposure = ctx._devices[device]?.vectors["CCD_EXPOSURE"];
        const pBlob = ctx._devices[device]?.vectors["CCD1"];

        if (state === "readyForNewCapture") {
            // Send the exposure command and immediately return.
            // We won't know if it worked until the next stateChanged.
            writer.send({
                semantics: "new",
                device,
                name: "CCD_EXPOSURE",
                valueType: "number",
                values: [{ name: "CCD_EXPOSURE_VALUE", value: String(seconds) }]
            });
            state = "captureSent";
            return;  // exit and wait for next stateChanged
        }

        if (state === "captureSent") {
            // Camera is busy — exposure is running
            if (pExposure?.state === "Busy") {
                state = "captureStarted";
            }
            return;
        }

        if (state === "captureStarted") {
            // Exposure done, image is writing to disk on the Pi
            if (pExposure?.state === "Ok") {
                state = "captureStoring";
            }
            return;
        }

        if (state === "captureStoring") {
            // BLOB arrived — image transfer complete
            if (pBlob?.state === "Ok" && pBlob?.data) {
                resolve(pBlob.data);  // done
            }
            return;
        }
    });
}
```

Each time `stateChanged` fires, the function re-enters from the top, checks the current state, and either advances the state machine or returns. Advancing may involve sending another command (`captureSent`), or just watching (`captureStarted`). The exposure command is sent once. The rest of the function is pure observation.

This is what makes INDI programming unfamiliar if you come from synchronous I/O. You cannot write `value = read(fd)`. You write "when state looks like X, do Y, then exit." The next re-entry handles the consequence.

**If you have used reactive programming**, `mkIndiPromise` is essentially:

```typescript
// Conceptually equivalent:
stateChanged$.pipe(
    startWith(undefined),  // evaluate immediately
    filter(() => condition(ctx)),
    take(1)
).toPromise();
```

**If you have used event sourcing**, `_devices` is a projection and `stateChanged` is the notification that the projection was updated.

**If you have thought about the actor model**, each INDI device is an actor. You send it a message (`newXxxVector`). It does its thing asynchronously and broadcasts its new state to all subscribers. You are not calling a function — you are sending a message to an autonomous system and waiting for it to tell you what happened.

### What the architecture enforces

The CQRS split in INDI is not a design preference — it reflects physical reality. A camera does not respond to an exposure command instantly. The shutter opens, photons accumulate for 300 seconds, the sensor is read out, the data is compressed and sent over USB to the Pi, then transmitted over WiFi to the client. Each of those steps has its own timing, its own failure modes. Any API that pretended this was a function call would be lying.

The architecture forces you to acknowledge this. You cannot cheat by reading device state synchronously — there is no `getProperties` that returns a value. You must subscribe, receive, and tolerate uncertainty. `capture()` sends an exposure command and exits. It has no idea if the camera received it. The next `stateChanged` will tell.

This is what makes INDI hard to program against if you are used to `read()/write()`, but also what makes it correct for controlling hardware that has its own timing, its own state machine, and its own opinion about when things are done.

### First contact

The first commit was "Initial Commit." Then, immediately after: "Attempt to talk to mount."

That is the right mindset for this kind of project. No elaborate architecture. Just try to say something to the telescope and see if it answers. The INDI handshake is not complicated — open a socket, send a `getProperties` message, wait for XML to come back.

"Basic indi connection working" followed. Then "Things working." Those commits are short and the commit messages are almost triumphant. First contact with a piece of hardware has a different energy than fixing a bug.

### A working imaging pipeline

The TypeScript version grew over the following year. The flow looked like this:

```
INDI server (TCP)
  → INDI client (TypeScript)
  → capture pipeline
  → FITS file output
```

[FITS](https://en.wikipedia.org/wiki/FITS) (Flexible Image Transport System) is the standard format for astronomical images — 16-bit grayscale frames with embedded metadata. Exposure time, sensor temperature, timestamp, all in the header. It was designed for science, not photography, and every serious astronomy tool reads it.

Temperature-aware capture went in next: wait for the sensor to cool to a target temperature before starting a sequence. This sounds simple until the camera reports 18°C but the actual noise floor behaves like 25°C. The first implementation just polled a temperature property and started shooting when the number crossed a threshold. That worked until it didn't — a warm night meant the sensor never reached the target, and the sequence would hang indefinitely. The fix was a timeout with a configurable tolerance: if you're within two degrees and it's been five minutes, close enough. Thermal noise is real, especially with a cheap uncooled sensor. You learn to wait, and then you learn to stop waiting perfectly.

GPU-accelerated processing handled the heavier image operations — stacking multiple exposures and applying calibration frames, offloaded to the graphics card because operating on millions of pixels per frame is exactly the kind of parallel workload GPUs excel at. A [Jest](https://jestjs.io/) test suite covered the protocol parsing.

TypeScript moved fast here. The loose XML parsing was fine for getting things working.

### How the TypeScript XML parser works

INDI sends a continuous stream of XML over a TCP socket. There is no document root — just a sequence of messages that look like this:

```xml
<defSwitchVector device="Telescope Simulator" name="CONNECTION" ...>
    <defSwitch name="CONNECT" label="Connect">Off</defSwitch>
    <defSwitch name="DISCONNECT" label="Disconnect">On</defSwitch>
</defSwitchVector>
<setNumberVector device="Telescope Simulator" name="EQUATORIAL_EOD_COORD" ...>
    <oneNumber name="RA">12.345</oneNumber>
    <oneNumber name="DEC">45.678</oneNumber>
</setNumberVector>
```

Each top-level element is a self-contained message. The problem: a SAX parser needs a document root, and you cannot wait to collect the whole stream before parsing — messages arrive continuously for as long as the connection is open.

The solution in the TypeScript client is a hack that works: feed the parser a fake `<stream>` opening tag before any real data arrives. The parser thinks it is inside a document. Every real INDI message becomes a child element. The stream never closes, and neither does the parser's context.

```typescript
export class IndiReader extends Transform {
    parser: Parser;
    builder: XMLNodeBuilder;

    constructor() {
        super({
            writableObjectMode: false,
            readableObjectMode: true,  // bytes in, objects out
            transform: (chunk, encoding, callback) => {
                this.parser.parse(chunk);
                callback();
            }
        });

        this.parser = new Parser("UTF-8");
        // Wrap the infinite stream in a fake root element
        this.parser.parse("<stream>");

        ["startElement", "endElement", "text"].forEach(event => {
            this.parser.on(event, this._receiver.bind(this, event));
        });

        this.builder = new IndiRootBuilder("stream", {});
    }
```

`IndiReader` is a Node.js Transform stream — bytes flow in from the TCP socket, JavaScript objects flow out the other side. The SAX parser (node-expat, a binding to libexpat) fires callbacks for each XML event: element start, element end, text content. Those callbacks drive a builder stack.

The builder stack has three layers. `IndiRootBuilder` sits at the bottom — it never emits anything, it just waits for a top-level element to begin. When one does, it creates an `IndiVectorBuilder` and pushes it onto the stack. When the vector sees child elements, it creates `IndiElementBuilder` instances for each one. When a closing tag arrives, the current builder calls `build()`, pops itself off the stack, and hands the completed object to the parent.

```typescript
_receiver(event: string, tagOrData: string, attrs: Record<string, string>) {
    if (event === "startElement" && this.builder.startElement) {
        this.builder = this.builder.startElement(tagOrData, attrs);
    }
    else if (event === "endElement") {
        try {
            if (this.builder.build) {
                const update = this.builder.build();
                if (update) {
                    this.push(update);  // emit the completed object
                }
            }
        } finally {
            this.builder = this.builder.parent;  // pop the stack
        }
    }
    else if (event === "text" && tagOrData.trim().length > 0) {
        this.builder = this.builder.text(tagOrData);
    }
}
```

The `IndiVectorBuilder.build()` method is where routing happens. INDI tag names follow a convention: `defSwitchVector`, `setNumberVector`, `newTextVector`. The builder splits the name on camelCase boundaries using a regex, checks the prefix and suffix, and dispatches to the right `finalize_*` method:

```typescript
build(): IndiReadObject {
    const split = this.name
        .replace("BLOB", "Blob")
        // camelCaseSplit
        .split(/(?<=[a-zA-Z])(?=[A-Z])/);

    if (split[0] === "def" && split.length === 3 && split[2] === "Vector") {
        const valueType = split[1].toLowerCase() as ValueType;
        return this.finalize_DefVector(valueType);
    }
    else if (split[0] === "set" && split.length === 3 && split[2] === "Vector") {
        const valueType = split[1].toLowerCase() as ValueType;
        return this.finalize_SetVector(valueType);
    }
    else if (split[0] === "del" && split.length === 2 && split[1] === "Property") {
        return { semantics: "del", device: this.attrs.device, ... };
    }

    throw new Error(`Unknown Tag ${this.name}`);
}
```

That is about 300 lines total across the three builder classes, plus the Transform stream wrapper. It works, it is tested, and it is entirely manual — every tag name, every attribute, every dispatch branch written out explicitly.

The reverse direction, `IndiWriter`, is a Transform stream going the other way: objects in, bytes out. It serializes messages by hand using template strings:

```typescript
transform(chunk: IndiWriteObject, encoding, callback) {
    switch (chunk.semantics) {
        case "getProperties":
            this.push(`<getProperties version="${chunk.version}"/>`);
            break;
        case "new":
            const valueTypeCamel = chunk.valueType[0].toUpperCase() + chunk.valueType.slice(1);
            this.push(`<new${valueTypeCamel}Vector device="${chunk.device}" name="${chunk.name}" ...>`);
            chunk.values.forEach(v => {
                this.push(`<one${valueTypeCamel} name="${v.name}">${v.value}</one${valueTypeCamel}>`);
            });
            this.push(`</new${valueTypeCamel}Vector>`);
            break;
    }
    callback();
}
```

### Starting over in Rust

At some point the question shifts from "does this work" to "can I trust this." Loose XML parsing and callback-based socket I/O are hard to reason about when the telescope is outside in the cold and you are watching from inside.

The specific failure that pushed me toward Rust was a reconnection bug. The TypeScript client would occasionally lose the socket connection — a Pi rebooting, a network hiccup — and the reconnection logic would re-register event handlers without cleaning up the old ones. Suddenly every incoming message was processed twice. Tracking down which callback was a duplicate, in a tangle of closures registered across different modules, took longer than it should have. It wasn't hard to fix once found. It was hard to find.

The first Rust commit compiled. "Builds working." Then a sequence that shows the architecture forming: "Del Property," "refactor," "Actors."

### How Rust parses the same XML

The Rust version does not have a builder stack. It does not dispatch on camelCase-split tag names. Most of the routing logic is replaced with annotations on struct fields.

Here is the same `defSwitchVector` message, this time deserialized entirely through Serde:

```rust
#[derive(Debug, Deserialize, Serialize, PartialEq)]
pub struct DefSwitchValue {
    #[serde(rename = "@name")]
    pub name: String,

    #[serde(rename = "@label")]
    pub label: String,

    #[serde(rename = "$text")]
    pub value: IndiSwitch,  // "On" or "Off", parsed as an enum
}

#[derive(Debug, Deserialize, Serialize, PartialEq)]
pub struct DefSwitchVector {
    #[serde(rename = "@name")]
    pub name: String,
    #[serde(rename = "@device")]
    pub device: String,
    #[serde(rename = "@state")]
    pub state: IndiState,
    #[serde(rename = "@rule")]
    pub rule: IndiSwitchOptions,
    // ... more attributes ...

    #[serde(rename = "defSwitch")]
    pub switches: Vec<DefSwitchValue>,
}
```

The `@name` prefix tells the deserializer to look in the XML attributes. `$text` means the element's text content. `defSwitch` in the child field means: collect all `<defSwitch>` child elements into this Vec. That is the entire parser for this message type. No imperative dispatch, no string comparisons at runtime.

Routing between message types is a single enum with annotations:

```rust
#[derive(Debug, Deserialize, Serialize, PartialEq)]
pub enum IncomingMsg {
    #[serde(rename = "defSwitchVector")]
    DefSwitchVector(switch::DefSwitchVector),

    #[serde(rename = "setSwitchVector")]
    SetSwitchVector(switch::SetSwitchVector),

    #[serde(rename = "defNumberVector")]
    DefNumberVector(number::DefNumberVector),

    #[serde(rename = "setNumberVector")]
    SetNumberVector(number::SetNumberVector),

    // ... and so on for text, light, blob, message, del, getProperties ...

    #[serde(alias = "newNumberVector", alias = "newSwitchVector", ...)]
    Unparsed(BTreeMap<String, String>),
}
```

When the deserializer sees `<defSwitchVector ...>`, it looks through the enum's `rename` annotations, finds the match, and calls `DefSwitchVector::deserialize` on the element contents. Unknown tags fall through to `Unparsed`. The dispatch table is literally the source code — there is no runtime string matching loop.

The tradeoff is that getting Serde to handle INDI's attribute-and-text-content combination was not obvious. `serde-xml-rs` and `quick-xml`'s Serde integration each have their own quirks around when to use `@`, `$text`, `$value`. "Indi connection working with new serde adornments" is the commit message. That single line took about a day. Once it worked, it worked for every message type. The TypeScript version would have required adding another branch to the builder for every new type; the Rust version required defining a struct.

### The XML parsing comparison

This is the sharpest illustration of what declarative versus imperative means in practice.

The TypeScript approach is imperative: you write out the logic step by step. Open a tag? Push a builder. Close a tag? Call build, pop the stack, emit the result. Parse the tag name? Split on camelCase, check prefix, check suffix, dispatch. Every step is visible, every decision is explicit. It is easy to follow, easy to debug, and roughly proportional in code size to the number of things it handles.

The Rust approach is declarative: you describe the shape of the data, and the deserialization framework figures out the logic. `@name` in an annotation is a claim that the `name` field comes from an XML attribute; the framework handles the rest. The dispatch table is the enum definition itself. Adding a new message type means adding a variant and a struct — no new control flow anywhere.

Neither approach is always better. The imperative version is easier to customize — if INDI sends something nonstandard, you can handle it wherever you need to. The declarative version is harder to customize but far less code to maintain. When the data shapes are well-defined and unlikely to change, the declarative approach wins. INDI's protocol has not changed significantly in over a decade.

### The socket threading model

The TypeScript stream pipeline is elegant: `socket.pipe(indiReader)`. The TCP socket is a Readable; `IndiReader` is a Transform that turns bytes into objects; whatever consumes events reads from the Transform's output. Node.js's event loop handles the async I/O. There is no thread management because there are no threads.

Rust has no event loop built in and no equivalent of Node.js streams. The Rust client instead spawns a dedicated reader thread that owns the TCP connection and communicates with the rest of the program through a channel.

```rust
pub struct IndiConnection {
    stream: TcpStream,
    read_handle: IndiReaderLoopHandle,
    rx: std::sync::mpsc::Receiver<IncomingMsg>,
}
```

The `mpsc::channel` is Rust's standard multi-producer, single-consumer queue — a typed pipe between threads. The reader thread pushes `IncomingMsg` values in; the main thread calls `rx.try_recv()` to drain them. The types enforce the contract: only `IncomingMsg` values cross the boundary, and only in one direction.

```rust
impl IndiReaderLoop {
    fn create(stream: TcpStream, output: Sender<IncomingMsg>) -> IndiReaderLoopHandle {
        let unblock_stream = stream.try_clone().unwrap();
        let thread_stream = stream.try_clone().unwrap();

        let handle = std::thread::spawn(move || {
            let mut r_loop = IndiReaderLoop { stream: thread_stream, output };
            r_loop.reader_main();
        });

        IndiReaderLoopHandle {
            stream: unblock_stream,
            handle: Some(handle),
        }
    }
}
```

The `TcpStream::try_clone()` calls create separate handles to the same underlying socket. The reader thread gets one; the `IndiReaderLoopHandle` holds another one specifically so it can shut the socket down from outside the thread.

### RAII and the Drop pattern

When the `IndiConnection` goes out of scope in Rust — when the variable holding it is dropped — the language calls `Drop::drop` automatically on every field. `IndiReaderLoopHandle` implements `Drop`:

```rust
impl Drop for IndiReaderLoopHandle {
    fn drop(&mut self) {
        self.on_drop()
    }
}

impl IndiReaderLoopHandle {
    fn on_drop(&mut self) {
        let handle = self.handle.take().unwrap();
        self.stream.flush().unwrap();
        self.stream.shutdown(Shutdown::Both).unwrap(); // unblocks the reader thread
        handle.join().unwrap();                         // wait for it to exit cleanly
    }
}
```

The sequence: shut down the socket, which causes the reader thread's blocking read to return an error, which causes the reader's loop to exit, which allows `join()` to return. The whole teardown — shutdown, wait — is guaranteed to happen whenever the connection goes away, whether that is a normal exit, an early return, or a panic unwinding the stack.

This is RAII (Resource Acquisition Is Initialization), a pattern from C++ that Rust enforces through the type system. In TypeScript, you need to remember to call `socket.destroy()`. In Rust, you cannot forget — the language calls it for you.

The TypeScript reconnection bug that triggered the Rust rewrite was fundamentally a resource management failure: the old connection's handlers were not cleaned up before registering the new ones. Rust's Drop would have caught this at compile time, or at least made the cleanup path impossible to skip.

### Dual connections: one for control, one for images

INDI has a mechanism called `enableBLOB` (Binary Large OBject) that controls whether a server sends image data over a connection. The three modes are `None`, `Only`, and `Also`. Image files from a camera can be several megabytes each, and sending them on the same connection as property updates creates a problem: a large FITS file transfer blocks property messages from arriving while it is in transit.

The Rust client's architecture opens two connections to the same INDI server:

```rust
let mut conn_control = Some(IndiConnection::connect(connection_spec)?);
let mut conn_blob    = Some(IndiConnection::connect(connection_spec)?);

if let Some(conn) = conn_control.as_mut() {
    init_connection(conn, EnableBLOBValue::None)?;  // no images on this one
}
if let Some(conn) = conn_blob.as_mut() {
    init_connection(conn, EnableBLOBValue::Only)?;  // only images on this one
}
```

The control connection gets `EnableBLOB::None` — it will never receive image data, only property definitions and updates. The blob connection gets `EnableBLOB::Only` — it receives nothing but image transfers. Because they are separate TCP connections, a five-megabyte FITS file arriving on the blob connection does not delay a mount position update on the control connection.

INDI explicitly supports this pattern. The `enableBLOB` command was designed for it. The Rust client is the first of the two that actually implements it — the TypeScript version uses a single connection.

The `EnableBLOB` struct itself is a small example of how Serde handles text content:

```rust
#[derive(Debug, Deserialize, Serialize, PartialEq)]
pub enum EnableBLOBValue {
    #[serde(rename = "None")] None,
    #[serde(rename = "Only")] Only,
    #[serde(rename = "Also")] Also,
}

#[derive(Debug, Deserialize, Serialize, PartialEq)]
pub struct EnableBLOB {
    #[serde(rename = "$text")]
    pub value: EnableBLOBValue,
}
```

The enum variants map directly to the protocol's string values. `$text` means the value is the element's text content. Serializing this produces `<enableBLOB>Only</enableBLOB>`. No template strings, no string concatenation.

### Debayering by hand

Raw camera sensors are monochrome. The sensor captures a single intensity value per pixel. To get color, camera manufacturers place a Bayer filter over the sensor — a repeating 2×2 grid of colored filters, typically arranged as RGGB: one red, two green, one blue. Each pixel only sees one color. The other colors must be inferred from neighbors.

Debayering (also called demosaicing) is the process of reconstructing a full RGB image from this mosaic. The `fits` crate in rastro implements it by hand:

```rust
pub fn debayer(hdu: &ParsedFitsFileHDU) -> Option<Array<f32, Ix3>> {
    let array = hdu.data_copy_f32()?;
    let shape = array.shape();

    // Each "virtual pixel" sits at the junction of four sensor pixels.
    // Those four form an RGBG square (clockwise from top-left).
    // The output image has one fewer row and column than the sensor.
    let rgb_shape: [usize; 3] = [shape[0] - 1, shape[1] - 1, 3];
    let mut rgb_array = Array::<f32, Ix3>::zeros(rgb_shape);

    let mut x = 0usize;
    let mut x_is_even = true;

    while x < rgb_shape[0] {
        let mut y = 0usize;
        let mut y_is_even = true;

        let mut surrounding_clock_wise: [f32; 4] = [
            array[[x + 0, y + 0]] as f32,  // top-left
            array[[x + 0, y + 1]] as f32,  // top-right
            array[[x + 1, y + 1]] as f32,  // bottom-right
            array[[x + 1, y + 0]] as f32,  // bottom-left
        ];

        while y < rgb_shape[1] {
            // Update only the two rightmost values; left side was cached from previous iteration
            surrounding_clock_wise[1] = array[[x + 0, y + 1]] as f32;
            surrounding_clock_wise[2] = array[[x + 1, y + 1]] as f32;

            // The four surrounding pixels are always RGBG in clockwise order.
            // The offset into that ring depends on whether we're at an even or odd x,y position.
            let r_offset: usize =
                if x_is_even { if y_is_even { 0 } else { 1 } }
                else         { if y_is_even { 3 } else { 2 } };

            let rr = surrounding_clock_wise[(r_offset + 0) % 4];
            let g0 = surrounding_clock_wise[(r_offset + 1) % 4];
            let bb = surrounding_clock_wise[(r_offset + 2) % 4];
            let g1 = surrounding_clock_wise[(r_offset + 3) % 4];

            rgb_array[[x, y, 0]] = rr;
            rgb_array[[x, y, 1]] = (g0 + g1) * 0.5;  // average the two greens
            rgb_array[[x, y, 2]] = bb;

            y += 1;
            y_is_even = !y_is_even;
            // Shift the ring: right side becomes left side for the next column
            surrounding_clock_wise[0] = surrounding_clock_wise[1];
            surrounding_clock_wise[3] = surrounding_clock_wise[2];
        }

        x += 1;
        x_is_even = !x_is_even;
    }

    Some(rgb_array)
}
```

The key insight is the comment about "virtual pixels." The output image does not have the same dimensions as the sensor — it has one fewer row and column. Each output pixel lives at the junction of a 2×2 block of sensor pixels. That junction is always surrounded by one red, one blue, and two green pixels, in clockwise order — because that is how the Bayer grid tiles. The only thing that changes between positions is where in the clockwise ring the red pixel falls. The `r_offset` calculation encodes that.

Green is averaged from two samples. Human eyes are more sensitive to green, so the RGGB pattern gives green twice the sampling density. Averaging the two greens is the simplest possible reconstruction; more sophisticated debayer algorithms interpolate from a larger neighborhood, but for an initial implementation this is correct and fast.

The loop also reuses the left edge of each 2×2 window from the previous iteration's right edge. `surrounding_clock_wise[0] = surrounding_clock_wise[1]` at the end of each column step avoids reading the same array positions twice.

### Where things stand

The TypeScript client is the one that actually got used. It handled single-panel captures with temperature control, filter wheel automation, and multi-frame sequencing (lights, darks, biases, flats). It cannot do mosaics — no panel planning, no coordinate offsets between frames. The Heart Nebula mosaic was the last image taken with Ekos before switching over.

The gap in photos between the Western Veil Nebula (September 2022) and the Iris Nebula (October 2024) was home renovations and weather, not a software problem. The system picked back up where it left off.

The Rust version (`rastro`) has working INDI protocol parsing and the dual-connection architecture, but the capture pipeline was never completed. The INDI protocol is straightforward — the hard part is everything else: plate solving, guiding, meridian flips, sequencing across multiple targets. Each of those is its own rabbit hole, and the Rust rewrite stopped before reaching them.
