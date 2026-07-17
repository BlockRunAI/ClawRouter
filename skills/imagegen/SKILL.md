---
name: imagegen
description: Generate or edit images via BlockRun's image API. Trigger when the user asks to generate, create, draw, make an image — or to edit, modify, change, or retouch an existing image.
triggers:
  - "blockrun image"
  - "blockrun image generation"
  - "clawrouter image"
  - "generate image via blockrun"
  - "blockrun ai art"
  - "blockrun seedream"
  - "blockrun nano banana"
  - "blockrun cogview"
  - "blockrun grok imagine"
  - "edit image via blockrun"
  - "inpainting via blockrun"
  - "x402 image generation"
  - "usdc image generation"
metadata: { "openclaw": { "emoji": "🖼️", "requires": { "config": ["models.providers.blockrun"] } } }
---

# Image Generation & Editing

Generate or edit images through ClawRouter. Payment is automatic via x402.

**Shortcuts:**

- Slash: `/cr-imagegen <prompt> [--model=<alias>] [--size=1024x1024] [--n=1]` (`/imagegen` still accepted in chat for backward compatibility)
- Partner tool: `blockrun_image_generation` (LLM-callable) / `blockrun_image_edit` (inpainting)

---

## Generate an Image

POST to `http://localhost:8402/v1/images/generations`:

```json
{
  "model": "google/nano-banana",
  "prompt": "a golden retriever surfing on a wave",
  "size": "1024x1024",
  "n": 1
}
```

Response:

```json
{
  "created": 1741460000,
  "data": [{ "url": "http://localhost:8402/images/abc123.png" }]
}
```

Display inline: `![generated image](http://localhost:8402/images/abc123.png)`

### Model Selection

| Alias              | Full ID                      | Price        | Sizes                           | Best for                                                         |
| ------------------ | ---------------------------- | ------------ | ------------------------------- | ---------------------------------------------------------------- |
| `nano-banana`      | `google/nano-banana`         | $0.05        | 1024×1024, 1216×832, 1024×1792  | Default — fast, cheap, good quality                              |
| `banana-pro`       | `google/nano-banana-pro`     | $0.10–$0.15  | up to 4096×4096                 | High-res, large format                                           |
| `gpt-image`        | `openai/gpt-image-1`         | $0.02–$0.04  | 1024×1024, 1536×1024, 1024×1536 | Budget option; supports editing                                  |
| `gpt-image-2`      | `openai/gpt-image-2`         | $0.06–$0.12  | 1024×1024, 1536×1024, 1024×1536 | Photorealistic, reasoning-driven, text rendering (slow — proxy polls up to 5min); legacy `dalle` alias routes here |
| `seedream`         | `bytedance/seedream-5-pro`   | $0.045–$0.09 | up to 2848×1600 / 2304×1728     | Flagship quality, reference-image support                        |
| `grok-imagine`     | `xai/grok-imagine-image`     | $0.02        | 1024×1024                       | xAI Grok image style                                             |
| `grok-imagine-pro` | `xai/grok-imagine-image-pro` | $0.07        | 1024×1024                       | Grok high-quality                                                |
| `cogview`          | `zai/cogview-4`              | $0.015–$0.02 | 512×512 to 1440×1440            | Cheapest — Zhipu CogView                                         |

**Choosing a model:**

- Default → `nano-banana`
- "high res" / "large" → `banana-pro`
- "photorealistic" / complex scenes → `gpt-image-2`
- "flagship quality" / reference image → `seedream`
- "budget" / "cheap" → `cogview`
- "editable" / "inpainting" → `gpt-image` (only edit-capable model)
- "artistic" / flexible content → `grok-imagine`
- "grok style" → `grok-imagine` or `grok-imagine-pro`

**Choosing a size:**

- Default: `1024x1024`
- Portrait: `1024x1792`
- Landscape: `1536x1024` (gpt-image / gpt-image-2) or `1216x832` (nano-banana)
- High-res: `2048x2048` or `4096x4096` with `banana-pro` only

---

## Edit an Existing Image

POST to `http://localhost:8402/v1/images/image2image`:

```json
{
  "model": "openai/gpt-image-1",
  "prompt": "make the background a snowy mountain landscape",
  "image": "https://example.com/photo.jpg",
  "size": "1024x1024",
  "n": 1
}
```

ClawRouter automatically downloads URLs and reads local file paths — pass them directly, no manual base64 conversion needed.

Optional `mask` field: a second image (URL or path) that marks which areas to edit (white = edit, black = keep).

Response is identical to generation:

```json
{
  "created": 1741460000,
  "data": [{ "url": "http://localhost:8402/images/xyz456.png", "revised_prompt": "..." }]
}
```

**Supported models for editing:** `openai/gpt-image-1` only ($0.02)

---

## Example Interactions

**User:** Draw me a cyberpunk city at night
→ POST to `/v1/images/generations`, model `nano-banana`, prompt as given.

**User:** Generate a high-res portrait of a samurai
→ POST to `/v1/images/generations`, model `banana-pro`, size `1024x1792`.

**User:** Edit this photo to add a sunset background: https://example.com/portrait.jpg
→ POST to `/v1/images/image2image`, model `gpt-image`, image = the URL, prompt = "add a warm sunset background".

**User:** Change the background in my image to a beach (attaches local file)
→ POST to `/v1/images/image2image`, image = the local file path, prompt describes the change.

---

## Notes

- Payment is automatic via x402 — deducted from the user's BlockRun wallet
- If the call fails with a payment error, tell the user to fund their wallet at [blockrun.ai](https://blockrun.ai)
- Google models may return base64 internally — ClawRouter uploads automatically and returns a hosted URL
- OpenAI image models enforce OpenAI content policy; use `nano-banana` or `grok-imagine` for more flexibility
- Image editing is only available with `gpt-image-1`; generation supports all listed models
