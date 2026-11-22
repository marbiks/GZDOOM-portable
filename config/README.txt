config/
=======

Configuration that travels with a save archive lands here only if you save the
exported ZIP here.

Launcher settings (resolution, volume, key bindings, ...) are stored in the
browser and included in every export as config/portable-settings.json. The
browser cannot write that file into this folder by itself.

GZDoom's own gzdoom.ini is captured and exported when the engine writes one.
This WebAssembly build does not flush gzdoom.ini during shutdown, so the
launcher settings are the reliable configuration.
