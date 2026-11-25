# Leyla'nın Midillisi

A game by Baba and Leyla. Leyla names her pony and looks after her. The pony asks for one thing at a time in Turkish, Leyla taps it, and everything she touches says its name out loud. There is nothing to read and no way to lose.

Play it: https://yavuz-ozkan.github.io/leyla-midilli/

On a tablet, open the link in the browser, then Add to Home screen. It opens fullscreen and works offline after the first visit.

## What is in here

- `index.html` is the game.
- `audio/lines.json` is the word list. `audio/` holds the recorded voice clips made from it.
- `tools/make-audio.mjs` makes missing clips with ElevenLabs and packs them all into `audio-pack.js`.
- `build-home-screen.mjs` turns all of it into `docs/`, the installable version that GitHub Pages serves.

## Adding words

1. Add the word to `audio/lines.json` and to the lists at the top of the script in `index.html`.
2. `node tools/make-audio.mjs` (needs an ElevenLabs key in `elevenlabs-key.txt` in the folder above this one).
3. `node build-home-screen.mjs`

## Notes

Baloo 2 and Nunito are under the SIL Open Font License. The voices were generated with ElevenLabs.
