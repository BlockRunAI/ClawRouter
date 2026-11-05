# mpp-client: an outside payer, local completion

This example installs the published ClawRouter fork
(`@twzrd1111/clawrouter@0.12.306`) and its MPP rail (`@twzrd1111/clawrouter-mpp@0.1.0`).
The local proxy is pointed at the fixture seller `https://openrouter.mpp.tempo.xyz`
and model `openai/gpt-4o-mini`.

No key is needed. The payer is a throwaway account generated in memory on every run
and never saved. `createMppFetch` is given a fetch that answers from memory: HTTP 200,
a chat completion whose message content is `ok`, and a `Payment-Receipt` header.
The process does not open a socket except the local proxy port.

## Run

```bash
npm install && npm start
```

The script prints the completion text and exits 0 when that text is non-empty.

## Live Tempo payment (operator only)

A live Tempo payment is a separate operator step. It spends real funds and is not
part of this example. Only the operator runs it, with their own funded wallet and
a key supplied out of band. Agents never run it, and this repository holds no key.
