# Getting Started

<cite>
**Referenced Files in This Document**
- [package.json](file://package.json)
- [README.md](file://README.md)
- [packages/tcp/package.json](file://packages/tcp/package.json)
- [packages/lab/package.json](file://packages/lab/package.json)
- [packages/tcp/src/tcp-connection-http-example.ts](file://packages/tcp/src/tcp-connection-http-example.ts)
- [docs/adr/0009-private-lab-and-tcp-workspaces.md](file://docs/adr/0009-private-lab-and-tcp-workspaces.md)
</cite>

## Update Summary
**Changes Made**
- Updated installation instructions to use Bun instead of pnpm
- Updated package manager references throughout the document
- Added workspace-aware script examples using bun run --workspaces
- Updated example execution commands to use bun directly
- Added information about the Bun monorepo structure and lock file

## Table of Contents
1. Introduction
2. Environment Requirements
3. Installation
4. Project Structure
5. Core Components
6. Architecture Overview
7. Detailed Component Analysis
8. Dependency Analysis
9. Performance Considerations
10. Troubleshooting Guide
11. Conclusion

## Introduction
This guide helps you get started with the TCP stream library that provides a unified, Effect-based API for connecting to TCP servers across multiple runtimes: Bun, Node.js, and the Effect Platform. You will learn environment requirements, installation steps, basic configuration, and step-by-step examples ranging from a simple TCP connection to an HTTP client built over raw TCP.

The library exposes:
- A runtime-agnostic TcpStream service for sending data and reading responses as streams
- Engine-specific implementations for Bun, Node.js, and the Effect Platform
- An example program that performs HTTP GET requests over raw TCP using any supported engine

## Environment Requirements
- **Runtime**: Bun 1.4.2+ or Node.js (for different adapters)
- **Package Manager**: Bun (primary), with workspace support
- **TypeScript**: Compatible with TypeScript 7.x
- **Effect**: Effect v4 ecosystem packages

**Section sources**
- [package.json:6-27](file://package.json#L6-L27)
- [docs/adr/0009-private-lab-and-tcp-workspaces.md:5](file://docs/adr/0009-private-lab-and-tcp-workspaces.md#L5)

## Installation
**Updated** The project now uses Bun as the primary package manager with workspace support.

### Prerequisites
1. Install Bun 1.4.2+ from https://bun.sh
2. Ensure you have TypeScript installed (included in devDependencies)

### Installation Steps
1. Clone the repository
2. Navigate to the repository root
3. Install dependencies using Bun:

```bash
bun install
```

This creates a single `bun.lock` file at the repository root that manages dependencies for both workspace packages (`packages/lab` and `packages/tcp`).

### Workspace Scripts
The repository provides workspace-aware scripts that run across both packages:

```bash
# Run tests for all workspaces
bun run test

# Type check all workspaces  
bun run typecheck

# Format all workspaces
bun run format

# Check formatting across all workspaces
bun run format:check

# Lint all workspaces
bun run lint
```

**Section sources**
- [package.json:6-16](file://package.json#L6-L16)
- [README.md:12-38](file://README.md#L12-L38)

## Project Structure
At a high level:
- Common types, errors, and configuration live in the shared module
- The engine orchestrator wires platform adapters into a unified interface
- Each platform adapter implements low-level socket operations
- An example demonstrates building an HTTP client on top of the library

```mermaid
graph TB
A["App code"] --> B["TcpStream (service)"]
B --> C["TcpStreamEngine (orchestrator)"]
C --> D["Bun adapter"]
C --> E["Node.js adapter"]
C --> F["Platform adapter"]
D --> G["Bun.connect / Bun.Socket"]
E --> H["node:net / node:tls"]
F --> I["@effect/platform Socket"]
```

**Diagram sources**
- [packages/tcp/src/tcp-connection-http-example.ts:1-10](file://packages/tcp/src/tcp-connection-http-example.ts#L1-L10)

**Section sources**
- [package.json:7-9](file://package.json#L7-L9)

## Core Components
- TcpStream: The main service your application uses to send bytes or text and read incoming data as a stream. It also exposes close for graceful shutdown.
- ConnectionConfigShape: Describes host, port, optional TLS settings, retry policy, and connect timeout.
- TcpStreamError: A typed error class used throughout the library to report failures during connect, read, or write operations.
- TcpStreamEngine: The core orchestrator that manages connection lifecycle, events, timeouts, retries, and backpressure.
- Platform Adapters: Concrete implementations for Bun, Node.js, and the Effect Platform that translate their native sockets into the common engine protocol.

Key capabilities:
- Connect to TCP or TLS endpoints with configurable timeouts and retries
- Send binary or text payloads safely with backpressure handling
- Read incoming data incrementally via a stream
- Graceful close and cleanup under interruption

## Architecture Overview
The library separates concerns between a stable public API and pluggable platform adapters:

```mermaid
sequenceDiagram
participant App as "Your Program"
participant Stream as "TcpStream"
participant Engine as "TcpStreamEngine"
participant Adapter as "Platform Adapter"
participant OS as "OS Socket"
App->>Stream : Provide layer with ConnectionConfig
App->>Stream : sendText(request)
Stream->>Engine : connect(config)
Engine->>Adapter : create socket + event bridge
Adapter->>OS : connect(host, port, tls?)
OS-->>Adapter : Ready/Data/Drain/Close/Error
Adapter-->>Engine : events mapped to internal queue
Engine-->>Stream : EstablishedConnection(socket, events)
Stream->>Adapter : write(chunk)
Adapter->>OS : write + flush/drain handling
OS-->>Adapter : bytesWritten / drain
Adapter-->>Stream : success or error
Stream-->>App : stream of incoming chunks
App->>Stream : close()
Stream->>Adapter : close()
```

## Detailed Component Analysis

### First Connection Example: Establish, Send, Receive
This example shows how to:
- Provide an engine layer and connection configuration
- Acquire TcpStream
- Send a request
- Collect incoming data as a stream
- Close the connection

Conceptual flow:
```mermaid
flowchart TD
Start(["Start"]) --> Provide["Provide engine layer + config"]
Provide --> Connect["Acquire TcpStream"]
Connect --> Send["Send request bytes/text"]
Send --> Read["Read response stream"]
Read --> Close["Close connection"]
Close --> End(["Done"])
```

Implementation references:
- Provide engine layer and config: see the convenience layer factory and configuration layer usage in the example program.
- Acquire TcpStream and perform I/O: see the shared HTTP request execution logic that sends and collects data.
- Close: call the close method when done.

**Section sources**
- [packages/tcp/src/tcp-connection-http-example.ts:176-200](file://packages/tcp/src/tcp-connection-http-example.ts#L176-L200)

### HTTP Client Implementation Over Raw TCP
The repository includes a ready-to-run HTTP client that demonstrates building an HTTP GET request over raw TCP using the library's TcpStream. It supports three engines: Bun, Node.js, and the Effect Platform.

How it works:
- Parse CLI arguments to select engine and URL
- Build a ConnectionConfigShape from the URL (including TLS for https)
- Send a minimal HTTP/1.1 GET request
- Collect the response stream and decode UTF-8 text
- Print the response

Run instructions:
- Choose an engine flag and pass an http or https URL.
- For Bun: run the example file with Bun.
- For Node.js: ensure the Node.js adapter is selected.
- For the Effect Platform: select the platform engine.

Example invocation patterns:
- Bun: run the example with --engine=bun and a URL
- Node.js: run with --engine=nodejs and a URL
- Platform: run with --engine=platform and a URL

**Section sources**
- [packages/tcp/src/tcp-connection-http-example.ts:49-116](file://packages/tcp/src/tcp-connection-http-example.ts#L49-L116)
- [packages/tcp/src/tcp-connection-http-example.ts:152-170](file://packages/tcp/src/tcp-connection-http-example.ts#L152-L170)
- [packages/tcp/src/tcp-connection-http-example.ts:176-200](file://packages/tcp/src/tcp-connection-http-example.ts#L176-L200)

### Platform-Specific Setup

#### Bun
- Use the Bun adapter which wraps Bun.connect and Bun.Socket.
- Provide the Bun engine layer and configuration to your program.
- Run your program with Bun.

Key exports:
- Engine layer and convenience layer for Bun

**Section sources**
- [packages/tcp/src/tcp-connection-http-example.ts:1-4](file://packages/tcp/src/tcp-connection-http-example.ts#L1-L4)

#### Node.js
- Use the Node.js adapter which wraps node:net and node:tls.
- Provide the Node.js engine layer and configuration to your program.
- Run your program with Node.js.

Key exports:
- Engine layer and convenience layer for Node.js

**Section sources**
- [packages/tcp/src/tcp-connection-http-example.ts:9-10](file://packages/tcp/src/tcp-connection-http-example.ts#L9-L10)

#### Effect Platform
- Use the Effect Platform adapter which leverages @effect/platform Socket abstractions.
- Provide the platform engine layer and configuration to your program.
- Run your program with your chosen runtime that supports Effect Platform.

Key exports:
- Engine layer and convenience layer for the platform

**Section sources**
- [packages/tcp/src/tcp-connection-http-example.ts:10-11](file://packages/tcp/src/tcp-connection-http-example.ts#L10-L11)

## Dependency Analysis
The library composes a small set of modules:
- Common module defines shared types, errors, and configuration
- Engine orchestrator coordinates connection lifecycle and events
- Platform adapters implement concrete socket operations
- Example program ties everything together for end-to-end testing

```mermaid
graph LR
Common["tcp-connection-common.ts"] --> Engine["tcp-stream-engine.ts"]
Engine --> Bun["tcp-connection-bun.ts"]
Engine --> Node["tcp-connection-nodejs.ts"]
Engine --> Platform["tcp-connection-platform.ts"]
Example["tcp-connection-http-example.ts"] --> Bun
Example --> Node
Example --> Platform
```

**Diagram sources**
- [packages/tcp/src/tcp-connection-http-example.ts:1-10](file://packages/tcp/src/tcp-connection-http-example.ts#L1-L10)

## Performance Considerations
- Backpressure: Writes may be partial; the engine handles draining and ensures ordered writes. Avoid sending large payloads without considering downstream consumption.
- Timeouts: Configure connectTimeout to avoid hanging on slow networks.
- Retries: Use retry policies for transient failures; disable retries for immediate failure semantics when needed.
- Streams: Prefer streaming reads to process data incrementally and reduce memory pressure.

## Troubleshooting Guide
Common setup issues and resolutions:
- **Unsupported engine selection**: Ensure the engine flag is one of bun, nodejs, or platform.
- **Invalid URL or unsupported protocol**: Only http and https URLs are accepted by the HTTP example.
- **Missing CLI argument**: Provide a URL when running the example.
- **Connection failures**: Check host, port, firewall rules, and TLS configuration. Inspect TcpStreamError details for operation and message.
- **TLS handshake issues**: Verify server name, certificate trust, and ALPN settings when using https.
- **Bun installation issues**: Ensure you're using Bun 1.4.2+ and that the bun.lock file is present at the repository root.

Where to look:
- CLI parsing and validation for engine and URL
- Error handling and logging in the example program
- Engine-specific adapters for platform differences

**Section sources**
- [packages/tcp/src/tcp-connection-http-example.ts:49-116](file://packages/tcp/src/tcp-connection-http-example.ts#L49-L116)

## Conclusion
You now have the essentials to install, configure, and run TCP connections across Bun, Node.js, and the Effect Platform using Bun as the primary package manager. Start with a simple connection, then progress to the included HTTP client example to see the library in action. Use the provided layers and configuration to integrate TcpStream into your applications, and rely on the built-in timeouts, retries, and stream-based I/O for robust networking.

The workspace structure allows you to run checks and examples across both the lab and tcp packages using Bun's workspace capabilities, making development efficient and consistent.