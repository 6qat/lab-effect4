# Cedro Crystal: Times & Trades (`GQT`) Message Format

**Source:** [API Socket – Documentação Técnica](https://www.marketdatacloud.com.br/wp-content/uploads/2025/12/API-Socket-Documentacao-Tecnica.pdf) (Cedro Crystal SERVER spec, revised 08/05/2025), section "GQT – Get Quote Trade".

## Request

- Subscribe: `GQT <ativo> S [<quantidade negócios>] [<identificador do negócio>] [ASC|DESC] [C]`
- Snapshot: `GQT <ativo> N <quantidade negócios> <offset> <identificador requisição> [ASC|DESC] [C]`
- Unsubscribe: `UQT <ativo>`
- `<identificador do negócio>` acts as "greater than": only later trades are returned (sending `0` returns trades `10, 20, 30, ...`; sending `10` returns `20, 30, ...`).
- Requesting by `<identificador do negócio>` requires `<quantidade negócios>`; `ASC`/`DESC` and `C` require the trade or request identifier.
- `C` returns the snapshot compressed.

Examples from the spec:

```text
GQT PETR4 S
GQT PETR4 S 10
GQT DI1F11 S 10 2020
GQT PETR4 S 10 10 DESC C
GQT PETR4 N 2 50 XXX
```

## Messages

Functional header: `V:<ativo>:`, fields separated by `:`.

| Type | Body |
| :--- | :--- |
| Trade (subscribe) | `<op>:<horário>:<preço>:<corretora compra>:<corretora venda>:<quantidade>:<id negócio>:<condição>:<agressor>:<condição original>` |
| Trade (snapshot) | `<op>:<horário>:<preço>:<corretora compra>:<corretora venda>:<quantidade>:<id negócio>:<id requisição>:<condição>:<agressor>:<condição original>` |
| Trade removal | `D:<id negócio>` |
| Remove all trades | `R` |
| End of messages | `E` |
| End of snapshot | `E:<id requisição>` |

> [!CAUTION]
> If the time field is sent with `:` separators (e.g. `10:15:32`), a naive `split(":")` will misalign every later field. Confirm the exact time encoding against captured live lines before relying on field indexes.

## Field values

| Field | Meaning | Values |
| :--- | :--- | :--- |
| `op` | Operation | `A` add trade, `D` remove trade, `R` remove all trades |
| `horário` | Time the trade occurred | |
| `preço` | Trade price | |
| `corretora compra` | Buying broker identifier | Numeric B3 broker code |
| `corretora venda` | Selling broker identifier | Numeric B3 broker code |
| `quantidade` | Trade quantity | |
| `id negócio` | Unique trade identifier | |
| `id requisição` | Unique request identifier (snapshot only) | |
| `condição` | Trade condition | `0` not direct, `1` direct, `2` RLP, `3` RFQ, `4` midpoint trade, `5` opening price (auction), `6` point-in-time auction |
| `agressor` | Aggressor side | `A` buyer, `V` seller, `I` undefined |
| `condição original` | Original trade condition (space-delimited list) | `0` default, `R` opening price, `X` crossed, `L` last trade at same price, `P` imbalance more buyers, `Q` imbalance more sellers, `U` exchange last, `3` multi-asset trade (termo vista), `1` leg trade, `2` marketplace entered trade (on behalf), `IM` implied, `PT` block book trade, `RF` equities RFQ trade, `RL` RLP trade, `MP` midpoint trade, `TC` trade at close, `TA` trade at average, `SW` sweep |
