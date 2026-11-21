# FitCheck — virtual try-on

Upload a photo of yourself, paste a shirt link (or upload the shirt image), and see yourself wearing it.

## Run it

1. Install [Node.js](https://nodejs.org) 18 or newer.
2. Get an API token at https://replicate.com/account/api-tokens (add billing; each try-on costs a few cents).
3. In this folder:

   ```bash
   npm install
   REPLICATE_API_TOKEN=your_token_here npm start
   ```

   On Windows PowerShell: `$env:REPLICATE_API_TOKEN="your_token_here"; npm start`

4. Open http://localhost:3000

## How it works

- `public/` — the web page (HTML/CSS/JS). Photos are resized in the browser before upload.
- `server.js`
  - `POST /api/extract-shirt` — opens the shop link and finds the product image (Product data, `og:image`, or `twitter:image`). Links to private/internal addresses are refused.
  - `POST /api/tryon` — sends the photo and shirt to the IDM-VTON model on Replicate and returns the result.
- Nothing is saved to disk.

Set `TRYON_MODEL` to use a different Replicate try-on model with the same inputs.
