# Video Sampler: editor contract

The editor is a web page (`app/`) talking to a local Python server (`engine/server.py`) on
`http://127.0.0.1:8770`. The server also serves the page itself at `/`. Later the same page runs
inside Electron unchanged. This file is the contract between the two. If either side needs to
change it, change this file too.

All times are seconds of song time. Beat positions are floats on a half-beat grid (2.5 is halfway
between beat 2 and beat 3). JSON everywhere. Errors are `{"error": "plain sentence"}` with a 4xx
or 5xx status.

## Folders

```
library/<id>/     analysis.json, clips.js, thumbs/<clip>.jpg, proxy.mp4   (made by analyse.py)
songs/<id>.json   + the audio file it points at                           (made by song.py)
projects/<id>/    project.json, cache/ (rendered cuts), preview/ (joined previews), exports/
app/              index.html, css, js. No build step, plain ES modules.
```

## Things that already exist (reuse, do not rewrite)

- `engine/analyse.py` film -> library. `engine/song.py` song -> beats, bars, sections.
- `engine/find_snippet.py` cuts the liveliest stretch out of a long mix.
- `engine/auto.py` `plan(library_dir, song, settings, seed)` -> segments. `pick_new`,
  `pick_effects`, `FX_WEIGHTS`, `MIN_SPEED`, `MIN_MOTION` hold the taste rules.
- `engine/render.py` renders one cut per ffmpeg call (`render_segment`), joins them, adds the song.

## Objects

### Project (GET /api/projects/{id})

```json
{
  "id": "neon-afterhours", "name": "Neon Afterhours",
  "version": 12,
  "can_undo": true, "can_redo": false,
  "library": {"id": "neon-demon", "film": "The.Neon.Demon...mkv", "aspect": 2.388,
               "proxy_url": "/media/library/neon-demon/proxy.mp4",
               "thumb_url": "/media/library/neon-demon/thumbs/{clip}.jpg"},
  "song": {"id": "afterhours", "name": "afterhours", "url": "/media/song/afterhours",
           "duration": 179.27, "tempo": 136.0,
           "beats": [{"t": 0.03, "downbeat": true}],
           "sections": [{"t0": 0.0, "t1": 29.0, "label": "A", "energy": 0.35}],
           "peaks": [0.12, 0.4]},
  "settings": {"cut_speed": 0.5, "repetition": 0.35, "effects": 0.5,
               "colour": 0.3, "motion": 0.4, "strange": 0.3,
               "fx_weights": {"kaleidoscope": 3.5, "mirror": 3.0}},
  "seed": 3,
  "effects_available": [{"id": "kaleidoscope", "name": "4-way mirror", "kind": "picture"},
                        {"id": "stutter", "name": "Stutter", "kind": "time"}],
  "cuts": [
    {"id": "k7f2", "t0": 0.0, "t1": 1.35, "beat0": 0.0, "beats": 3,
     "section": 0, "label": "A",
     "clip": "c05712", "src": 3710.19, "speed": 1.0,
     "effects": ["kaleido8", "pingpong"],
     "locked": false}
  ],
  "preview": {"version": 12, "status": "ready", "pending": 0,
              "url": "/media/preview/neon-afterhours/12.mp4"}
}
```

- `peaks`: about 2000 values from 0 to 1, the song's loudness outline for drawing the waveform.
- `cuts` are in order and cover the whole song with no gaps: `cuts[0].t0 == 0`, each `t1` equals
  the next `t0`, the last `t1` equals `song.duration`.
- `cut.id` is stable for the life of the cut. A split makes one new id.
- `cut.src` is the second of the film where the clip starts. `clip` is the crate clip it came from.
- `locked`: the user made or approved this cut by hand. Rerolls leave it alone. Any hand edit to
  a cut sets `locked` true. The user can unlock it.
- `preview.status` is `ready` or `rendering`. `pending` is how many cuts still need rendering.
  `preview.version` is the project version the preview file shows. While rendering, `url` still
  points at the last finished preview, so the player always has something to play.

### Clip (GET /api/libraries/{id}/clips)

```json
{"clips": [{"id": "c05712", "shot": 512, "start": 3710.08, "end": 3712.08,
            "shot_start": 3706.4, "shot_end": 3715.9,
            "colour": 0.99, "motion": 0.85, "strange": 0.97, "quality": 1.0,
            "hue": 312.0, "hue_strength": 0.4, "tags": ["neon lights", "spinning"]}],
 "tags": ["dancing", "crowd"]}
```

Scores are 0 to 1 within the film. The crate ranks with the same formula as the existing crate
page: `quality * (wc*colour + wm*motion + ws*strange) / (wc+wm+ws)`.

## Endpoints

### Browse and create

| Method | Path | Body | Returns |
|---|---|---|---|
| GET | /api/libraries | | `[{id, film, duration, clips, thumb}]` |
| POST | /api/libraries | `{path}` | `{job}` analyses a new film, several minutes |
| GET | /api/libraries/{id}/clips | | clips, above |
| GET | /api/songs | | `[{id, name, duration, tempo}]` |
| POST | /api/songs | `{path, snippet?: bool, length?: 180}` | `{job}`. `snippet` true cuts the liveliest stretch out of a long mix first |
| GET | /api/projects | | `[{id, name, library, song, modified, thumb}]` |
| POST | /api/projects | `{name, library, song, seed?, settings?}` | Project, planned by auto mode |
| GET | /api/projects/{id} | | Project |
| DELETE | /api/projects/{id} | | `{ok: true}` |
| GET | /api/jobs/{job} | | `{status: "running"|"done"|"failed", progress: 0..1, message, result?}` |

### Editing. Every one returns the updated Project straight away

The server changes the edit, bumps `version`, answers at once, and renders the changed cuts in
the background. The page polls `GET /api/projects/{id}/preview` (returns just the `preview`
object) about twice a second while `status` is `rendering`.

| Method | Path | Body | What it does |
|---|---|---|---|
| POST | /api/projects/{id}/cuts/{cut}/delete | | Removes the cut. The cut before it stretches to cover the gap (the cut after, if it was the first). The stretched cut keeps its clip and start point. |
| POST | /api/projects/{id}/cuts/{cut}/split | `{beat}` | Splits at a beat position strictly inside the cut. The first part keeps the id. The second part is a new cut, same clip carrying on from where the first stops, same effects. |
| POST | /api/projects/{id}/cuts/{cut}/move_start | `{beat}` | Moves the boundary between this cut and the one before it. Must stay strictly between the previous cut's start and this cut's end. Not allowed on the first cut. |
| POST | /api/projects/{id}/cuts/{cut}/clip | `{clip}` | Swaps in a crate clip. Server picks `src` and `speed` so it fills the cut. Locks the cut. |
| POST | /api/projects/{id}/cuts/{cut}/reroll | | Auto mode picks a different clip and effects for this one cut, by the usual rules. Does not lock. |
| PATCH | /api/projects/{id}/cuts/{cut} | any of `{src, speed, effects, locked}` | Hand adjustment. `src` is clamped to the clip's shot. `speed` 0.25 to 2. Locks the cut unless the body only sets `locked`. |
| POST | /api/projects/{id}/reroll | `{seed?}` | Re-plans every unlocked cut. Locked cuts stay exactly as they are, at the same times. Without `seed`, the server picks a new one. |
| PATCH | /api/projects/{id}/settings | partial settings | Saves settings. Does not re-plan by itself, the page calls reroll when the user asks. |
| POST | /api/projects/{id}/undo | | Steps back one edit. |
| POST | /api/projects/{id}/redo | | |
| GET | /api/projects/{id}/preview | | The `preview` object. |
| POST | /api/projects/{id}/export | `{width?: 1920}` | `{job}`. Full-quality render from the original film. `result` is `{path, url}`. |

### Media. All must support HTTP Range requests, the player seeks constantly

| Path | What |
|---|---|
| /media/library/{id}/proxy.mp4 | the film's small copy, for crate hover previews |
| /media/library/{id}/thumbs/{clip}.jpg | crate and timeline thumbnails |
| /media/song/{id} | the song audio |
| /media/preview/{project}/{version}.mp4 | the edit, draft quality (960 wide), song included |
| /media/export/{project}/{file} | finished exports |

## How the preview stays fast

Each cut renders to its own file in `projects/<id>/cache/`, named by a hash of everything that
affects its picture: source path, `src`, `speed`, effects, frame count, size. Unchanged cuts are
never rendered twice. A preview is those files joined without re-encoding plus the song, which
takes well under a second. So after one edit the wait is one cut's render, about a second.

Frame grid: cut points are rounded to 24 fps frames once (`round(t * 24)`), and each cut gets
the frames between its two points. Same rule as `render.py`, so timing never drifts.
