# Hotel Kohinoor Palace — demo homepage

A single-page sales demo for Hotel Kohinoor Palace, Pakhowal Road, Ludhiana. It opens with a scroll-driven 3D walkthrough of the hotel, followed by rooms, banquets, Groove Restobar, reviews, amenities and location.

**This is a demo.** Prices, reviews, the Google rating, hall names and timings are placeholders. Photos are free Unsplash images. There is no real phone number or email: every contact button opens a "Contact number will be added soon" popup.

## Files

```
index.html        page markup, title and meta description
css/styles.css    design tokens (maroon / gold / cream), layout, responsive rules
js/main.js        header, mobile menu, popups, date validation, scroll reveals
js/tour.js        walkthrough controller: picks the mode, maps scroll to progress, captions, skip, dots
js/timeline.js    the 7 scenes and how scroll progress is split between them
js/scene3d.js     the Three.js world (built only from primitives, no model downloads)
netlify.toml      static hosting config
```

No build step. Three.js r160 is loaded from jsDelivr only when the 3D tour runs; Google Fonts load Cormorant Garamond and Manrope.

## Deploy on Netlify

1. In Netlify choose **Add new site → Import an existing project**, pick this repository.
2. Leave the build command empty and set the publish directory to `/` (already set in `netlify.toml`).
3. Deploy. Or drag the folder onto https://app.netlify.com/drop.

To preview locally: `python3 -m http.server 8080` and open http://localhost:8080 (ES modules need a server, not `file://`).

## How the walkthrough works

- The tour section is tall (about 8 screens); the canvas is pinned with `position: sticky` and the camera glides between scenes as you scroll: exterior at dusk → lobby → corridor (the door opens) → guest room → banquet hall → Groove Restobar → pull back to the exterior with the **Check Availability** bar.
- Scenes 1–4 are one continuous camera path through the building; the later scenes use a short fade through dark.
- **Skip tour** jumps straight to the Rooms section; the dots on the right jump to each scene.

### Performance and fallbacks

| Situation | What visitors get |
|---|---|
| Desktop | Full quality: soft shadows, anti-aliasing, pixel ratio up to 2 |
| Phones / tablets | Mid quality: smaller shadow map, pixel ratio up to 1.5 |
| Low-power devices (≤4 cores, ≤2 GB memory, Data Saver) | Light version: simpler materials, no shadows, fewer lights |
| Frame rate drops while scrolling | Quality steps down automatically (resolution, then shadows) |
| No WebGL, slow load (15 s) or the 3D fails | Static hero image with headline and availability bar |
| `prefers-reduced-motion` | Fading image + text sequence, no camera movement |

Rendering pauses when the tour is off-screen and when the camera is still. Point lights come from a fixed pool of 4 (2 on low-power devices), so shaders compile once during the loading screen.

For testing, add `?tour=static`, `?tour=images`, `?tour=lite` or `?tier=high|mid|low` to the URL.

## Before going live

- Replace Unsplash images with the hotel's own photos (`index.html`, search for `images.unsplash.com`).
- Add the real phone, WhatsApp and email (popups in `js/main.js`, footer in `index.html`).
- Replace placeholder prices, hall names, timings and sample reviews; embed real Google reviews and a Google Map in the `#location` box.
- Remove `<meta name="robots" content="noindex">` from `index.html`.
- Remove the "Demo website" label in the footer.
