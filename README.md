# FitCheck — virtual try-on

Upload a photo of yourself, paste a shirt link (or upload the shirt image), and see yourself wearing it.

It works with tops (shirts, t-shirts, sweaters, jackets). Two try-on services are supported:

- **Replicate** (used when `REPLICATE_API_TOKEN` is set): pay per try-on, a few cents each, no daily limit.
- **Hugging Face** (used otherwise): the free public [IDM-VTON demo](https://huggingface.co/spaces/yisol/IDM-VTON). Slower, with a small daily allowance.

## Put it online (Render, free)

1. Sign up at https://render.com with your GitHub account.
2. **New + → Blueprint**, pick this repository, click **Apply**.
3. Settings:
   - `REPLICATE_API_TOKEN` — from https://replicate.com/account/api-tokens (needs billing set up). Leave blank to use the free Hugging Face service.
   - `HF_TOKEN` — a free token from https://huggingface.co/settings/tokens (type "Read"). Gives a bigger daily allowance than using the demo anonymously.
   - `ACCESS_CODE` — a password visitors must enter. Leave blank for open access.
   - `TRYONS_PER_IP_PER_DAY` / `TRYONS_TOTAL_PER_DAY` — daily limits (default 10 and 100).

## Run it on your computer

```bash
npm install
npm start
```

Open http://localhost:3000

## How it works

- `public/` — the web page. Photos are resized in the browser before upload.
- `server.js`
  - `POST /api/extract-shirt` — opens the shop link and finds the product image (Product data, `og:image`, or `twitter:image`). Links to private/internal addresses are refused.
  - `POST /api/tryon` — sends the photo and shirt to the Hugging Face demo and returns the result.
- Nothing is saved to disk.
