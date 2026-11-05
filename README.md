# AI Voice Helpdesk

An AI agent that answers phone calls for a business, speaks the caller's language and hands the call to a person when it can't help.

**Status: Step 1 of 7.** `call-gateway` connects a real phone call to the OpenAI Realtime API. The agent has no business data yet, so for now it should say it doesn't know the answer to questions about the business.

## Run a real call

### 1. Get these ready

| You need | Where to get it |
|---|---|
| Docker Desktop, running | Already installed on this machine |
| OpenAI API key on a paid tier | [platform.openai.com](https://platform.openai.com/api-keys) (the free tier can't use the Realtime API) |
| Twilio account and a voice number | [twilio.com/console](https://console.twilio.com) (Phone Numbers > Buy a number) |
| ngrok auth token and free static domain | [dashboard.ngrok.com](https://dashboard.ngrok.com) |
| A phone that can take transfers | Yours |

Twilio trial accounts may add limits, so a paid account is the safer choice. If transfers fail, check Twilio's Voice Geographic Permissions for the country you're transferring to.

### 2. Fill in your settings

```powershell
Copy-Item .env.example .env
```

Open `.env` and fill in the values at the top. It's ignored by git, so your keys stay on your machine.

`TRANSFER_NUMBER` is your own phone, not the Twilio number. Use international format, like `+38344123456`.

### 3. Start it

```powershell
docker compose up --build
```

Wait for `call-gateway listening` in the output.

### 4. Point your Twilio number at it

In the Twilio Console, open **Phone Numbers > Active numbers > your number**. Under **Voice Configuration**, set:

- **A call comes in:** Webhook
- **URL:** `https://YOUR_NGROK_DOMAIN/incoming-call`
- **HTTP:** POST

Save, then call the number.

## What to test

Watch the logs in a second window:

```powershell
docker compose logs -f call-gateway
```

| Test | What should happen |
|---|---|
| Call the number | The agent greets you in Albanian and says it's an AI |
| Speak English, then German, then **Albanian** | It replies in the language you're speaking |
| Talk over it mid-sentence | It stops straight away and listens |
| Ask about prices or opening hours | It says it doesn't have that information and never makes one up |
| Ask for a person | It says it's connecting you, then your phone rings |
| Run the forged webhook below | It prints `403` |

Forged webhook test:

```powershell
curl.exe -s -o NUL -w "%{http_code}" -X POST https://YOUR_NGROK_DOMAIN/incoming-call -d "CallSid=fake"
```

**Judge the Albanian carefully.** OpenAI doesn't publish a supported language list for this model. With `LOG_TRANSCRIPTS=true`, the logs show what it heard and said. If Albanian is weak, set `REALTIME_MODEL=gpt-realtime-2.1` in `.env` and restart. Audio costs about 3x more on that model.

**Also note the `signedUrl` value** in the `media stream signature verified` log line. Twilio's docs don't say which URL form it signs, so this settles it.

## If something goes wrong

| What you see | Likely cause |
|---|---|
| The call says "an application error has occurred" | The webhook failed. Check that `NGROK_DOMAIN` matches the URL in Twilio and that `TWILIO_AUTH_TOKEN` is right. Requests are visible at <http://localhost:4040>. |
| `rejected webhook: bad signature` | Same as above. |
| `rejected media stream: bad signature` | Twilio signed a URL form we didn't expect. Send me the log line and I'll fix it. |
| Your phone rings instead of the agent answering | OpenAI failed, so the call fell back to you. Look for `AI session failed` or `session rejected`, which give the reason. |
| Noise on the line interrupts the agent | Raise `VAD_THRESHOLD` in `.env`, for example to `0.7`. |
| The agent cuts in while you pause | Raise `VAD_SILENCE_DURATION_MS`, for example to `800`. |
| Your phone never rings on a transfer | Check Voice Geographic Permissions in Twilio. |

**Known behaviour:** speaking over the greeting cuts it off, including the AI notice. It's worth trying "hello?" right as the call connects, to see how often this would happen for real callers.

## Using your real business

Edit `config/business.yaml` for the name, description, languages and greeting, then run `docker compose restart call-gateway`.

## Development

```powershell
npm install
npm run check    # lint, typecheck and tests
```

The tests use fake Twilio and OpenAI sockets, so they need no accounts or network access.

```
config/                  Business identity (name, languages, greeting)
packages/shared/         Config validation and logging
services/call-gateway/   Twilio webhook and the audio bridge to OpenAI
  src/callSession.ts     Per-call logic: audio, barge-in, transfer, time limit
  src/mediaStream.ts     WebSocket upgrade and signature check
  src/server.ts          HTTP routes
```
