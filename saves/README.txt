saves/
======

GZDoom's save files do NOT get written here automatically.

A page opened from file:// is not allowed to write into this folder. While you
play, saves are kept in the browser's IndexedDB on that computer and listed in
the launcher's Save management panel.

To put saves here, use "Export saves" > "Download ZIP" and save the ZIP into
this folder or into backups/. On the next computer, use "Import saves" and pick
that ZIP; the saves are restored under their original names.

Folder layout inside an exported ZIP (one profile per engine and game):
  prof/gzdoom-doom2-<hash>/saves/doom.doom2/<slot>.zds
  prof/uzdoom-doom-<hash>/saves/uz-doom.doom/<slot>.zds
  prof/<profile>/config/gzdoom.ini        (if the engine wrote one)
  config/portable-settings.json          (launcher settings)
  prof/<profile>/screenshots/*.png

Keep the prof/ folders as they are: the launcher restores only the profile that
matches the engine and game you start, which is what keeps one game's slots out
of another's Load Game menu.
