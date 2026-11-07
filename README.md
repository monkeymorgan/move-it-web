# Move It

A static single-page app: movement break reminders during work hours, plus a
library of exercises and the flows (routines) you like. No build step, no
server — just files. Everything personal (settings, log, ratings) lives in
your browser's localStorage.

## Run locally

```bash
python3 -m http.server 8765
```

Then open http://localhost:8765. (Opening `index.html` straight from disk
won't work: the browser blocks loading the YAML data files.)

## Deploy

Push to `main`. `.github/workflows/pages.yml` publishes the site to GitHub
Pages. One-time setup: repo **Settings → Pages → Source: GitHub Actions**.
Any static host works too (Netlify, Cloudflare Pages, a folder on a server).

## Using it at work

- Keep the tab open, ideally pinned. Browsers can't run reminders after the
  tab is closed.
- Allow notifications when asked, so a reminder reaches you while you're in
  another app. The chime and the flashing tab title work without them.
- Set your work hours and interval under **Settings**. Outside those hours
  it stays quiet.

## Editing the data

| File | What |
| --- | --- |
| `data/exercises.yaml` | The exercise library. `desk: true` makes an exercise eligible for break reminders. |
| `data/flows.yaml` | Your routines. Steps are exercise ids or `{ text: ..., seconds: ... }`. `starred: true` shows a flow on the Now page. |
| `data/curation.yaml` | Your star / keep / drop lists. Best edited through the **Curate** tab, then exported. |
| `data/tips.yaml` | Posture cues shown on the Now page. |
| `img/` | Exercise images, referenced by filename from `images:`. |

### Curation workflow

1. Open **Curate**. Rate each exercise: <kbd>S</kbd> star, <kbd>K</kbd> keep,
   <kbd>D</kbd> drop, <kbd>→</kbd> skip.
2. Click **Download curation.yaml** and replace `data/curation.yaml`
   with the download.
3. Commit. Once you've sorted enough, turn on **Only suggest starred / kept**
   in Settings.

Break suggestions are weighted: starred ×6, kept ×3, unsorted ×1, dropped
never. Anything suggested recently is pushed down the list.
