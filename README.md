# মনু — The Builder · Mission Barisal (VMAMA)

স্থানীয় AI অপারেটিং-স্ট্যাক: Node.js মাল্টি-এজেন্ট সার্ভার (api.js), MCP টুল-সেট,
লোকাল ও ক্লাউড প্রোভাইডার ইউনিফিকেশন, অ্যাডমিন প্যানেল।

## চালানো

```bash
node start.js --start-all
```

- সার্ভার: `127.0.0.1:3000` (ডোমেইন-নির্ভর বাইন্ড)
- UDS: `/tmp/zombiecoder/mcp.sock` (HTTP-মুক্ত JSON-RPC)
- অ্যাডমিন: `http://localhost:3000/admin.html`
- লোকাল MCP: ocr `:3100`, screen-recorder `:3101`, tts `:3102`

## গঠন

| ফাইল | কাজ |
|---|---|
| `api.js` | মূল সার্ভার: HTTP + UDS + H2C, এজেন্ট, ফলব্যাক, MCP |
| `start.js` | বুট: `.env` লোড, ক্লিনআপ, লোকাল MCP স্পন |
| `agent/*.js` | ৯টি পার্সোনা-এজেন্ট |
| `mcp-client.js` / `external-mcp.js` | এক্সটার্নাল MCP ক্লায়েন্ট |
| `domain-config.js` | ডোমেইন/বাইন্ড সিদ্ধান্ত |
| `public/` | অ্যাডমিন ও ড্যাশবোর্ড UI |

## নিরাপত্তা নোট

`.env`, `data/`, লগ — সব `.gitignore`-এ; **কখনও API-কী সহ ফাইল কমিট করো না।**

## লাইসেন্স

নিজের প্রোজেক্ট — অননুমোদিত ব্যবহার সীমিত।
