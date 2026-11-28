# Genre recipes (derived genres) — and EDM shown as "Dance"

Owner, 2026-11-28: "let's rename EDM globally to Dance … add a new genre called Casperaki Pop, which should be like
bright pop but only with Dr. Luke drums and an electric guitar on every track and hip-hop drum patterns in the verse.
Otherwise like brightPop." Then: "come up with a scalable solution for this since we may want to add others." Approved
as proposed ("Yes, go ahead").

## Why recipes

A genre key is copied into ~40 places (banks, mix tables, sample tags, guards). A derived genre is instead one data entry
(`packages/song-schema/src/genres.ts`, `GENRE_RECIPES`): its label and blurb, a **base** genre, and only what differs.
The generator runs as the base genre (banks, catalogue tags, mix tables, engine untouched); the song keeps the derived
key (`Song.genre`, `generator.params.genre`, so regenerating replays the recipe). Three hooks read the recipe:

1. **Drum samples** (`drums/kit.ts defaultDrumEntry`): families whose default sound comes from one sample library
   (`drumLibrary`), e.g. kick, snare and clap from `drLuke`. The renderer, the brain's drum-kit route and the generator
   all use this one function.
2. **Drum styles per section type** (`patterns/drums.ts`, `selectDrumBlueprint` with an explicit style list): e.g. the
   verses use the Urban hip-hop styles.
3. **Tracks that always play** (`selection/index.ts`): e.g. a clean electric guitar, essential in every section.

Everything else that needs a genre for the base's tables uses `baseGenre(genre)`: tempo ranges, the engine's mix config
(engine-adapter), the brain's artwork, lyric and title prompts (with the recipe's label), pattern and sound routes.

## Casperaki Pop

`casperakiPop`: base `brightPop`; drums kick/snare/clap from `drLuke` (32 kicks, 24 snares, 1 clap in the library;
hats, cymbals, toms stay Bright Pop's); verses drum styles = Urban's (`urban`, `authored-urban-boom-bap`,
`authored-urban-trap-hats`, `authored-gmd-urban-boom-bap`, `authored-gmd-urban-soul-funk-pocket`); a clean electric
guitar in every section. Tempo as Bright Pop (95-129; hip-hop patterns are usually 60-100: listen for busy verses).

## Dance

The label of `edm` is "Dance" everywhere users see it (genre tiles, placeholder titles "Dance in C", landing page, the
assistant's replies). The key stays `edm` (catalogue tags, banks, saved songs).
