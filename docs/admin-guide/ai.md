# Local AI

SelfPhoneNG can use AI that runs on your own server: voicemail transcripts, and transcripts and
summaries of recorded calls. More later (typed prompts, an AI receptionist). Nothing is sent to an AI company. The
addresses in Settings → AI must be this server or your local network, and SelfPhoneNG refuses
anything else.

## What you need

- **Speech to text and text to speech:** the AI stack in `deploy/ai`. It runs Speaches (Whisper
  and Kokoro).
- **The language model** (for later features): Ollama. Install it on the server, or uncomment it in
  `deploy/ai/compose.yml`.
- **A GPU** makes it fast: an NVIDIA card with 8 GB holds Whisper and a small language model.
  Without one, voicemail transcripts still work on the CPU, only slower. The GPU needs the
  [NVIDIA Container Toolkit](https://docs.nvidia.com/datacenter/cloud-native/container-toolkit/latest/install-guide.html).

## 1. Start the AI stack

On the PBX server:

```sh
docker compose -f deploy/ai/compose.yml up -d
```

(In Portainer: a second stack from `deploy/ai/compose.yml`.) No NVIDIA GPU: change the image to
`ghcr.io/speaches-ai/speaches:0.8.3-cpu` and remove the `deploy:` block.

Download the models once (they're kept in a volume):

```sh
curl -X POST http://127.0.0.1:8000/v1/models/Systran/faster-whisper-small
curl -X POST http://127.0.0.1:8000/v1/models/speaches-ai/Kokoro-82M-v1.0-ONNX
```

`faster-whisper-small` is quick everywhere. With a GPU, `Systran/faster-whisper-large-v3` is
more accurate on phone audio.

For Ollama: `ollama pull qwen3:4b`, and set `OLLAMA_KEEP_ALIVE=-1` so the model stays loaded.

## 2. Settings → AI

| Part | Address | Model | Voice |
|---|---|---|---|
| Language model | `http://127.0.0.1:11434/v1` | `qwen3:4b` | |
| Speech to text | `http://127.0.0.1:8000/v1` | `Systran/faster-whisper-small` | |
| Text to speech | `http://127.0.0.1:8000/v1` | `speaches-ai/Kokoro-82M-v1.0-ONNX` | `af_heart` |

Click **Test** beside each. The first test can take a while: it loads the model. The text to
speech test plays the voice. Then turn on **Voicemail transcripts** and **Save**.

Instead of the page, a new install can start with `AI_LLM_URL`, `AI_LLM_MODEL`, `AI_STT_URL`,
`AI_STT_MODEL`, `AI_TTS_URL`, `AI_TTS_MODEL` and `AI_TTS_VOICE` in `.env` (see `.env.example`).
Once you save the page, the page wins.

## Voicemail transcripts

Each new message is written out before its email goes, and the words are in the email and on the
voicemail page. A transcript is a machine's guess: names and numbers are the usual mistakes. If
the AI stack is down, the email goes without one.

Transcripts are kept with the voicemail in the database, and are in your backups.

## Call transcripts and summaries

Turn on **Call transcripts** (and **Call summaries and action items**) in Settings → AI. From then
on, each recorded call is also recorded one side at a time, and a minute or two after it ends:

- both sides are written out and put together in time order, as **Caller** and **Other side**, so
  you see who said what;
- the language model writes a short summary with the action items;
- the two one-side files are deleted. The normal recording stays.

On the **Recordings** page each call shows its summary, **Show transcript**, and the search box
finds calls by what was said. People who were on a call can read its transcript too, like they can
play its recording.

- Only calls that are recorded are written out (user record modes, phone numbers, queues and
  conference rooms set to record), and only those recorded while it's on.
- If the AI stack is down, calls wait and are done when it's back (up to two days old).
- A long call's summary only covers its first 15 minutes or so (a small model's limit); the
  transcript has all of it.
- Transcripts and summaries are part of the recording: deleting the recording (or the retention in
  Settings → Recording) deletes them too. The recording notice and the [legal page](legal.md)
  apply to them as much as to the audio.
