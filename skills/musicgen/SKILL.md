---
name: musicgen
description: Generate music tracks via BlockRun's audio API. Trigger when the user asks to generate, create, compose, or make music, a song, a beat, a track, or audio.
metadata: { "openclaw": { "emoji": "🎵", "requires": { "config": ["models.providers.blockrun"] } } }
---

# Music Generation

Generate music tracks through ClawRouter using MiniMax models. Payment is automatic via x402.

---

## Generate Music

POST to `http://localhost:8402/v1/audio/generations`:

```json
{
  "model": "minimax/music-2.5+",
  "prompt": "upbeat electronic dance track with heavy bass",
  "instrumental": true,
  "duration_seconds": 60
}
```

Response:

```json
{
  "created": 1741460000,
  "model": "minimax/music-2.5+",
  "data": [
    {
      "url": "http://localhost:8402/audio/1741460000-abc123.mp3",
      "duration_seconds": 60
    }
  ]
}
```

The audio file is saved locally and served from the proxy. Share the URL directly with the user.

### Request Parameters

| Parameter          | Type    | Required | Description                                     |
| ------------------ | ------- | -------- | ----------------------------------------------- |
| `model`            | string  | No       | Default: `minimax/music-2.5+`                   |
| `prompt`           | string  | Yes      | Description of the music style, mood, genre      |
| `lyrics`           | string  | No       | Song lyrics (for vocal tracks)                   |
| `instrumental`     | boolean | No       | `true` = no vocals, `false` = with vocals        |
| `duration_seconds` | number  | No       | Track length in seconds (max 240, default ~30)   |

### Model Selection

| Model           | Full ID              | Price | Best for                      |
| --------------- | -------------------- | ----- | ----------------------------- |
| `music-2.5+`    | `minimax/music-2.5+` | $0.15 | Higher quality, default       |
| `music-2.5`     | `minimax/music-2.5`  | $0.10 | Budget option, still good     |

---

## Example Interactions

**User:** Make me an upbeat workout song
→ POST with `"prompt": "energetic workout music with fast tempo and driving beats"`, `"instrumental": true`, `"duration_seconds": 60`

**User:** Compose a jazz ballad with lyrics about the rain
→ POST with `"prompt": "smooth jazz ballad, saxophone, piano"`, `"lyrics": "Rain falls on the window pane..."`, `"instrumental": false`

**User:** Generate a 30-second jingle for a tech startup
→ POST with `"prompt": "modern corporate jingle, uplifting, clean synth"`, `"instrumental": true`, `"duration_seconds": 30`

**User:** Create a lo-fi hip hop beat for studying
→ POST with `"prompt": "lo-fi hip hop, chill, vinyl crackle, mellow piano chords"`, `"instrumental": true`, `"duration_seconds": 120`

---

## Notes

- Generation takes 1-3 minutes — inform the user it may take a moment
- Payment is automatic via x402 — deducted from the user's BlockRun wallet
- Max duration is 240 seconds (4 minutes) per track
- Output format is MP3
- Audio files are cached locally at `~/.openclaw/blockrun/audio/`
- If the call fails with a payment error, tell the user to fund their wallet at [blockrun.ai](https://blockrun.ai)
