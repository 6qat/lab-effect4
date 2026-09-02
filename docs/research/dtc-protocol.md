# Data and Trading Communications (DTC) Protocol

## 1. Overview
The Data and Trading Communications (DTC) Protocol is an open, non-proprietary communications protocol standard designed for the financial market trading community. It enables reliable, plug-and-play interoperability between clients (manual trading platforms, algorithmic trading systems, charting/market analysis software) and servers (data providers, trading services, exchanges). The protocol standardizes the exchange of financial market data, trade orders, and historical price data.

**Source:** [DTC Protocol Main Page](https://www.sierrachart.com/index.php?page=doc/DTCProtocol.php)

## 2. Architecture & Key Features
DTC is built upon a Client-Server architecture operating over network sockets (typically TCP/IP over the internet). It does not mandate a specific transport layer, though it is usually TCP/IP, and supports TLS (Transport Layer Security) which is strictly required when the connection is used for trading. 

**Key Features:**
- **Neutral & Open Specification:** The protocol is completely in the public domain with no patents or licenses. It is designed to be straightforward and free to implement for both servers and clients.
- **Multiple Connections:** Clients can open multiple simultaneous connections for different purposes. For instance, one connection for streaming market data, one for trading, and one for historical data requests.
- **Customizable/Expandable:** Designed to be a tight protocol but supports the addition of new message types and fields. Proprietary or nonstandard messages are supported using Message Type IDs in the 10000+ range.
- **Symbol Handling:** It supports any symbol format (with optional Exchange specifiers) natively without requiring the client to map arbitrary numerical identifiers to symbols.
- **Unified Order Updating:** Instead of varying implementation models, DTC defines a single `ORDER_UPDATE` message (similar to FIX Execution Report) for communicating order states, executions, and rejections clearly.
- **Bracket Orders Support:** Robust handling of parent and child (OCO) orders, ensuring complex trade structures are linked and appropriately tracked.
- **Historical Data:** Built-in support for historical price and tick data with ZLib compression for efficiency.

**Sources:** 
- [DTC Protocol Main Page](https://www.sierrachart.com/index.php?page=doc/DTCProtocol.php)
- [DTC Messages and Procedures](https://www.sierrachart.com/index.php?page=doc/DTCMessageDocumentation.php)

## 3. Message Format and Encodings
DTC aims to solve the overhead issues of protocols like FIX by allowing multiple efficient encodings. The encoding is negotiated during the initial connection handshake.

1. **Binary Encoding:** Uses fixed-size binary data structures with embedded fixed-length strings. It begins with a 4-byte header (2 bytes for Size, 2 bytes for Type) and is highly efficient and fast.
2. **Binary With Variable Length Strings:** Similar to standard Binary, but replaces fixed-length strings with a 16-bit offset and 16-bit length indicator. The strings are appended to the end of the fixed structure.
3. **JSON Encoding:** Encodes messages as JSON objects with name-value pairs, separated by null terminators in the network stream. It is highly flexible.
4. **Compact JSON Encoding:** An optimized version of JSON used for high-frequency messages (like market depth and ticks). Instead of key-value pairs, fields are passed as an ordered array inside an `"F"` property.
5. **Google Protocol Buffers (GPB):** Leverages Google's Protocol Buffers (version 3) for serialization. Messages are preceded by a 4-byte header (Size and Type) to allow for stream decoding.

**Source:** [DTC Protocol Message Format and Encoding](https://www.sierrachart.com/index.php?page=doc/DTCProtocol.php#MessageFormatEncoding)

## 4. Connection Flow & Procedures
The connection flow establishes the communication protocol, verifies credentials, and sets up heartbeats to keep the connection alive.

1. **Connection & Encoding Request:**
   - The Client establishes a TCP/IP connection.
   - The Client sends an `ENCODING_REQUEST` (using Binary Encoding by default) specifying its preferred encoding.
   - The Server responds with an `ENCODING_RESPONSE` accepting or rejecting the encoding. All subsequent messages use the established encoding.
2. **Logon Sequence:**
   - The Client sends a `LOGON_REQUEST` with authentication details and a proposed heartbeat interval.
   - The Server responds with a `LOGON_RESPONSE`. The result indicates success, error (with/without reconnect), or a redirect to a new address. The response also includes flags indicating which capabilities the server supports (e.g., market depth, historical data).
3. **Heartbeats:**
   - Both sides exchange `HEARTBEAT` messages at the interval established during logon to maintain the connection.
4. **Market Data & Trading Operations:**
   - **Market Data:** Client sends a `MARKET_DATA_REQUEST` with a unique `SymbolID`. The Server responds with a `MARKET_DATA_SNAPSHOT` followed by updates (`MARKET_DATA_UPDATE_TRADE`, `MARKET_DATA_UPDATE_BID_ASK`, etc.).
   - **Trading:** Client requests accounts, open orders, and positions. New orders (`SUBMIT_NEW_SINGLE_ORDER`, `SUBMIT_NEW_OCO_ORDER`) are tracked using unique client order IDs. The server replies with `ORDER_UPDATE` for all lifecycle events (accepted, filled, canceled, rejected).
5. **Logoff:**
   - Disconnection is handled gracefully by sending a `LOGOFF` message and closing the socket.

**Source:** [DTC Protocol Procedures](https://www.sierrachart.com/index.php?page=doc/DTCMessageDocumentation.php#DTCProtocolProcedures)

