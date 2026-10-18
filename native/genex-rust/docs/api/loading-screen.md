# Loading screen

From the first paint until the game's first lit frame every destination shows the game's loading
screen: its title, a spinner that keeps turning while shaders compile, a bar and the stage in words
(downloading the game, loading assets, starting the graphics, preparing shaders n of m, drawing the
first frame). The web page, Live, a desktop window and a phone all draw it; a game never draws its own. Style
it in `genex.toml`, never in code:

```toml
[render.loading]            # every key optional
title = "Harbour Nights"    # default: [game] title; 1..=60 characters
background = "#1b2233"      # sRGB #rrggbb (the default)
accent = "#7fb2ec"          # the spinner and the bar
text = "#eceae4"            # the title and the stage
logo = "ui/logo.png"        # a PNG, JPEG or WebP under assets/ (shown on the web page)
```

Pick colours from the game's palette with the text readable on the background. A value outside these
rules is refused `invalid-render-loading`. A first-ever web start compiles every shader (a few
seconds); later starts take the browser's cache. A start that stops progressing for two minutes
shows a card with the typed code `boot-timeout` naming the stage it stopped at.
